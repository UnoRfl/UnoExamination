# Security model & threat analysis

UnoExamination has **no server of its own**. The static pages can be hosted
anywhere (GitHub Pages, Firebase Hosting, Netlify…). All state lives in
Firestore, and all enforcement is done by `firestore.rules`, which Google
evaluates on their servers on every read and write. Understanding what that
can and cannot guarantee is the point of this document.

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
party must hold the key, keep time, and record the score. Firestore's rules
engine is that trusted party here, and it is free.

## 2. What the server (Firestore rules) enforces

These hold even against a student who has fully reverse-engineered the client
and talks to Firestore directly with their own credentials.

| Guarantee | Mechanism |
|---|---|
| Students never see the answer key | `exams/{code}/private/answerKey` is readable only when `ownerUid == request.auth.uid` and the account has the professor role. |
| Students never see questions before starting | `exams/{code}/content/questions` is readable only if `sessions/{code}_{uid}` exists, and creating that document starts the clock. |
| Exactly one attempt per student | The session id is `{code}_{uid}`; the create rule requires that exact id and `create` fails if it exists. Only the exam owner can delete it (reset). |
| Identity | Firebase Auth. Session e-mail must equal the token e-mail and `email_verified` must be true, so nobody can register someone else's address. Optional domain and roster restrictions are checked in the rule, not the UI. |
| Trusted start time | `startedAt == request.time` (server clock) is required on create; `startedAt` can never be updated by the student. |
| Trusted deadline | Every student write must satisfy `request.time <= startedAt + duration + extraMinutes + 90s` **and** `request.time <= exam.closesAt + 90s`. After that the session is frozen with whatever was saved. |
| Frozen after submit / lock | Student updates require `status == 'in_progress'`. Moving to `submitted` or `locked` requires `submittedAt`/`lockedAt == request.time`, so timestamps cannot be back-dated. Only the owner can move `locked -> in_progress`. |
| Violation count only rises | `request.resource.data.violations >= resource.data.violations`. |
| Whitelisted fields | Students may only change `answers, lastSavedAt, heartbeatAt, violations, status, submittedAt, lockedAt, clientId, progress`. Everything else (uid, examCode, extraMinutes, grade…) is immutable from the student side. |
| Events are append-only with server time | `events/{id}` create requires `at == request.time`; update is denied for everyone; delete only by the owner. |
| Grades are professor-only | `grades/{sid}` writable only by the exam owner with `gradedBy == uid`; readable by the student only when `exam.scoresReleased == true`, and never another student's. |
| Isolation between professors | Every owner check compares `exam.ownerUid` to the caller; professors cannot list or read each other's exams, sessions, keys or grades. |
| Role escalation | A user may create their profile only with `role == 'student'`. Only an existing professor may change someone else's role. The single bootstrap professor is an e-mail hard-coded in the rules and must be verified. |

`tests/rules/firestore.rules.test.js` exercises all of the above against the
Firestore emulator (`npm run test:rules`).

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

1. **Rules first.** Never switch Firestore to "test mode". Deploy
   `firestore.rules` before sharing any exam code.
2. **Auth providers.** Prefer Google sign-in restricted to the school's
   domain (`allowedDomain` per exam) so every identity is a real school
   account. If you enable e-mail/password, keep e-mail verification (it is
   required by the rules).
3. **Authorized domains.** In Firebase Console → Authentication → Settings →
   Authorized domains, list only your hosting domains (e.g. `you.github.io`).
4. **API key restrictions** (optional). In Google Cloud Console → Credentials
   you can restrict the web API key to your site's HTTP referrers. The key is
   not a secret, but this reduces abuse of your free quota.
5. **App Check** (optional, still free). Enabling Firebase App Check with
   reCAPTCHA v3 for Firestore blocks scripts that talk to your database from
   outside a real browser session on your site. It raises the bar for
   "fake heartbeats from a script" style tampering.
6. **Quota.** The Spark plan gives 50k reads / 20k writes per day. A 60-student
   exam of 60 minutes uses roughly 60 × (150 heartbeats + ~120 autosaves +
   events) ≈ 20k writes and far fewer reads. For very large cohorts on one
   day, raise the heartbeat interval in `js/student.js` or split exams across
   days. Firebase shows usage in the console.
7. **Backups.** Export grades to CSV from the dashboard after each exam.

## 6. Privacy

The platform stores: name, e-mail, student id, section, answers, timestamps,
violation events, and a browser fingerprint (user agent, platform, language,
screen size, time zone). It does **not** access camera, microphone, or the
public IP address. Tell students what is recorded (the pre-exam rules page
does) and follow your institution's data policy for retention. Deleting an
exam from the dashboard deletes all its sessions, events and grades.
