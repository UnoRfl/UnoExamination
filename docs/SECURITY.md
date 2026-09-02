# Security model & threat analysis

UnoExamination has **no server code of its own**. The static pages can be
hosted anywhere (GitHub Pages, Netlify, Supabase Storage…). All state lives in
Supabase Postgres, and all enforcement is done by row level security, by
`BEFORE` triggers and by `SECURITY DEFINER` functions, evaluated on Supabase's
servers on every request. Understanding what that can and cannot guarantee is
the point of this document.

## 1. Why a purely static site cannot be made cheat-proof

The professor's original single-file quiz had four structural problems that no
amount of client-side JavaScript can fix:

| Problem | Why it is unfixable client-side |
|---|---|
| The answer key is inside the page | Anyone can press *View source* (or read the network tab). Even hashing the answers only slows a dictionary attack on short answers. |
| The score is computed in the browser | The student controls the browser, so the student controls the score. Whatever is "sent" afterwards can be forged. |
| The timer runs on the student's clock | Reload the page, change the system clock, or pause JavaScript. |
| "Terminated" is just DOM manipulation | Reload the page and you have five fresh strikes. |

Any design that keeps *all* data on the client inherits these. Some trusted
party must hold the key, keep time, and record the score. Postgres is that
trusted party here — and because grading is a database function, the key never
reaches *any* browser, including the professor's.

## 2. What the server (Postgres) enforces

These hold even against a student who has fully reverse-engineered the client
and talks to the REST API directly with their own credentials. Every row is
verified by `tests/e2e/api-flow.mjs`, which attacks the live project as an
ordinary signed-in student.

| Guarantee | Mechanism |
|---|---|
| Students never see the answer key | `answer_keys` has RLS enabled and **no student policy at all**; the only policy requires `private.owns_exam()`. Reading it by join, by subquery or directly returns zero rows. |
| Nobody's browser sees the key — not even the professor's | Grading is `public.grade_session()`, a `SECURITY DEFINER` function. The key is read inside the database and only the score comes back. |
| Students never see questions before starting | The `questions` select policy requires `private.has_session()`, and creating that session is what starts the clock. |
| Exactly one attempt per student | `unique (exam_code, student_id)` on `sessions`. `start_exam()` returns the existing session instead of creating a second one. Only the owner may delete it (reset). |
| Identity | Supabase Auth. `start_exam()` refuses an unconfirmed address, and the optional domain / roster check runs in `private.student_allowed()`, not in the UI. |
| Trusted start time | A `before insert` trigger overwrites `started_at` with `now()`. A `before update` trigger makes it immutable thereafter. |
| Trusted deadline | Every student write is gated by `private.session_writable()`: `now() <= started_at + duration + extra_minutes + 90s` and `now() <= closes_at + 90s`. Changing the device clock, reloading, or replaying a request achieves nothing. |
| Frozen after submit / lock | The update trigger allows only `in_progress → submitted \| locked`, and stamps the timestamp from the server so it cannot be back-dated. Only the owner can move `locked → in_progress`. |
| Violation counts only rise | The trigger rejects any update where `violations` decreases. |
| Column-level immutability | The trigger rejects student changes to `extra_minutes`, `flagged`, `reviewed`, `note`, `student_id`, `exam_code`, `started_at`. It also rejects a *professor* changing `answers`. |
| Events are append-only | Insert policy requires owning the session; the timestamp is stamped by a trigger; there is **no update policy**; delete is owner-only. |
| Grades are professor-only | The write policy requires `private.owns_exam()` and `graded_by = auth.uid()`. A student sees their own grade only when `exams.scores_released` is true, and never another student's. |
| Role escalation | A trigger forces `role = 'student'` on self-insert, forbids changing your own role, and lets a professor change only the `role` column of another account — nothing else. |
| Isolation between professors | Every owner check compares `exams.owner_id` to `auth.uid()`. Professors cannot read each other's exams, keys, sessions or grades. |
| The bootstrap secret | Lives in `private.config`, which has no grants to `anon` or `authenticated`. Reading it from the API is denied at the schema level. |

## 3. What is only *evidence* (client-side signals)

Everything in `js/proctor.js` runs on the student's machine. A determined
student can suppress any of it (block the network calls, patch the JavaScript,
use a second device). Therefore these signals are **logged, weighted and shown
to the professor**, never used as the sole basis for a grade.

| Signal | Detects | Blind spots / false positives |
|---|---|---|
| `visibilitychange` (tab hidden) | switching tabs, minimising | none as a detector; duration recorded |
| `window.blur` | another app/window took focus, second monitor | OS notifications, IME popups; we ignore blurs under 400 ms |
| `fullscreenchange` | leaving fullscreen | fullscreen must be started by a click (browser rule) |
| `paste` / `copy` / `cut` / context menu | clipboard use | blocked by default; can be disabled per exam for essays |
| blocked shortcuts (F12, Ctrl-Shift-I/J/C, Ctrl-U/S/P, F5, Ctrl-R) | attempts to open devtools / print / reload | logged as informational only |
| DevTools heuristic (outer − inner window size) | *docked* devtools | undocked devtools invisible; some window managers trigger false positives |
| `PrintScreen` key-up | screenshots via the key | OS-level capture tools |
| second-tab detection | same account open twice | detected via `clientId` conflicts and heartbeat freshness |
| heartbeat every 25 s | going offline, suspended tab, blocked network | laptop sleep looks the same |
| `page_reload`, `resumed` | reloading / returning | legitimate crashes |
| clock skew | device clock far from server | irrelevant for enforcement (server time rules) |
| `screen.isExtended` | more than one display | Chromium only |
| completion speed | finishing far too fast | strong students |

The **risk score** (`js/grading.js → riskScore`) is a weighted sum with
diminishing returns per event type plus time-away and speed heuristics. It is
a triage tool: *high* means "look at this event log", not "cheated".

### Strike policy

The professor picks a violation limit and an action: **warn** (log only),
**lock** (student sees a black screen until the professor clicks Unlock) or
**auto-submit**. Locking rather than terminating avoids punishing false
positives irreversibly; the professor can unlock, add time, or terminate.

## 4. Things this platform cannot do

* See a phone, a second computer, or a friend in the room. Pair it with a
  human proctor, a video call with cameras on, or a lockdown browser for
  high-stakes exams.
* Stop a student photographing the screen.
* Prevent collusion between students taking the exam at the same time
  (mitigated by per-student shuffling and random subsets from a larger pool).
* Detect a student who never triggers a browser event (e.g. reads notes on
  paper).

## 5. Hardening the deployment

1. **Never disable RLS.** Every table has it enabled. `/setup.html` probes
   `answer_keys` on load and reports loudly if it is ever readable — that check
   exists because a disabled policy looks completely normal from the UI.
2. **Auth providers.** Prefer Google sign-in and set `allowed_domain` per exam,
   so every identity is a real school account. With e-mail/password, keep
   "Confirm email" on — `start_exam()` refuses an unconfirmed address.
3. **URL configuration.** Supabase dashboard → Authentication → URL
   Configuration: set *Site URL* to your site and list only your own origins
   under *Redirect URLs*.
4. **Keep the service_role key out of the browser.** It bypasses RLS entirely.
   It belongs in your terminal (for `npm run test:e2e`) and nowhere else. The
   *publishable* key in `js/config.js` is the one that is safe to ship.
5. **Rotate the bootstrap code.** `claim_professor()` deletes it after a single
   use. If you ever re-seed `private.config`, use a long random value.
6. **Quota.** The free tier gives 500 MB of database and 5 GB egress. A
   60-student, one-hour exam writes roughly 60 × (150 heartbeats + ~120
   autosaves + events) rows-worth of updates — comfortably inside it. If you
   run several large exams a day, raise the heartbeat interval in
   `js/student.js` (`startHeartbeat`, currently 25 s).
7. **Backups.** Export grades to CSV after each exam, and take a
   `supabase db dump` before schema changes.

## 6. Privacy

The platform stores: name, e-mail, student id, section, answers, timestamps,
violation events, and a browser fingerprint (user agent, platform, language,
screen size, time zone). It does **not** access camera or microphone. Supabase
sees the request IP as any web host would, but the application never reads or
stores it. Tell students what is recorded (the pre-exam rules page
does) and follow your institution's data policy for retention. Deleting an exam
deletes all its sessions, events and grades with it (`on delete cascade`).
