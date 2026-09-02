# UnoExamination

A free, serverless, proctored online examination platform that any number of
professors can share. Static HTML/JS (hosted on GitHub Pages) + Supabase
Postgres with **row level security** as the backend. No server code, no paid
plan, nothing to maintain.

**Live:** <https://unorfl.github.io/UnoExamination/>

|                     | Professors                                                        | Students                                                   |
|---------------------|-------------------------------------------------------------------|------------------------------------------------------------|
| Build exams         | multiple choice, multi-select, true/false, short answer, essay; import the old single-file quiz format or JSON | sign in with Google or e-mail, enter a 6-character code |
| Anti-cheat          | fullscreen, tab/window/blur, copy-paste, devtools, reload, second-tab, offline detection; configurable strike limit → warn / lock / auto-submit | clear rules page, live strike counter, autosave, resume after crash |
| Live monitor        | who is online, progress, time left, violations, risk score; unlock, add time, force-submit, terminate, reset | server-side timer — closing the page does not pause it |
| Grading             | auto-graded **inside the database**, so the answer key never reaches any browser; manual points for essays; release scores; CSV export | see score & feedback once released |

Read [`docs/SECURITY.md`](docs/SECURITY.md) for what is enforced by the
server versus what is only evidence, and [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md)
for the GitHub projects this design learned from.

## Why a database and not "no database at all"?

A purely static site must ship the answer key to the browser and compute the
score there, so a student can read the key from *View source* and forge the
score. Somebody trusted has to hold the key, keep the clock and record the
result.

Postgres does all three. Row level security decides which rows a request may
touch, `SECURITY DEFINER` functions decide what it may do, and `grade_session()`
scores the paper server-side — so the key is never sent anywhere, not even to
the professor's browser. Supabase's free tier covers it, and there is still no
backend code to write.

## Setup

The live deployment is already configured. To stand up your own copy:

1. **Create a Supabase project** at <https://supabase.com> (free tier is fine).
2. **Apply the schema** — see [`supabase/README.md`](supabase/README.md). Either
   run `supabase/dump-schema.sql` on an existing copy and paste the output, or
   use `supabase db dump` / `psql`.
3. **Set a bootstrap code** so the first professor can promote themself:
   ```sql
   insert into private.config (key, value)
   values ('bootstrap_secret', 'PICK-A-LONG-RANDOM-STRING')
   on conflict (key) do update set value = excluded.value;
   ```
4. **Configure the site** — put your project URL and *publishable* (anon) key in
   [`js/config.js`](js/config.js). Both are public by design; all security is in
   the database.
5. **Authentication → URL Configuration** — set *Site URL* to your site and add
   `https://your-site/**` to *Redirect URLs*. Enable the Google provider if you
   want school-account sign-in.
6. **Host the files.** GitHub Pages: *Settings → Pages → Deploy from a branch*,
   root. Or `npm run serve` for local use.
7. **Open `/setup.html`** and sign in. It tests the whole chain and names the
   exact dashboard screen to fix anything that is wrong — including whether RLS
   is actually protecting your answer keys.

## Running an exam

1. **New exam** → fill details, timing and anti-cheat settings → add questions
   or **Import** (`examples/sample-mixed-types.json` shows every question type;
   to bring in an existing quiz, paste its old `baseQuizData = [...]` array
   straight into the Import box — it is converted for you).

   > **Keep real answer keys out of git.** Import them through the dashboard so
   > the key is stored in the database where only you can read it. A key committed
   > to a public repository is readable by anyone who finds the repo.
2. **Publish** → you get a code like `K7M2XQ`. Students go to the site, sign
   in, type the code (or use *Copy student link*).
3. Keep **Live monitor** open during the exam. Submissions are auto-graded as
   they arrive. Click a student to see answers, the full event timeline and
   risk reasons; unlock / add time / force-submit / terminate / reset as needed.
4. **Grades** → grade essays, **Release scores**, **Export CSV**.

### Exam settings explained

| Setting | Effect |
|---|---|
| Duration | Server-enforced: start + duration (+ per-student extra time). |
| Opens / Closes | Students can only start inside this window; *Closes* is also a hard cut-off for in-progress sessions. |
| Violation limit / action | After N strikes: *warn* (report only), *lock* (black screen until you unlock), *auto-submit*. |
| Require fullscreen | Leaving fullscreen is a strike. |
| Block copy/paste | Paste is a strike; copy/cut/right-click are logged. Turn off for essay-heavy exams if you prefer. |
| Shuffle questions / options | Deterministic per student, computed in the database, so nobody can reroll for an easier paper. |
| Questions per student | Random subset from the pool (e.g. 40 of 60), also deterministic per student. |
| One at a time | Single-question view with a navigator instead of one long page. |
| Restrict to e-mail domain / roster | Checked by `start_exam()` on the server. |
| Show correct answers | Included in the student's review once scores are released. |

## Data model (Postgres)

```
profiles         one row per account; role = student | professor
exams            code (PK), owner, schedule, and every anti-cheat setting
questions        prompt, options, points  — no answers here
answer_keys      the key, with NO student-facing RLS policy at all
sessions         one attempt per student: unique (exam_code, student_id)
session_events   append-only proctoring log, server-timestamped
grades           written only by grade_session(); visible to the student after release
```

Anything a student may do goes through a function that checks them
server-side: `start_exam`, `get_paper`, `exam_intro`, `claim_professor`.

## Development

```bash
npm install        # test tooling
npm test           # unit tests: risk model, importer, editor validation
npm run test:e2e   # 62 assertions against a real project over the REST API
npm run serve      # serve the static site on :5000
```

The end-to-end test signs in as a real professor and two real students and
drives the REST API exactly as the browser does — the whole lifecycle, then
**18 attacks** from an ordinary student session (read the key by join, restart
the clock, grant themselves time, write their own grade, promote themselves,
read another student's work). It needs a service-role key, used only to create,
confirm and delete throwaway accounts:

```bash
SUPABASE_SERVICE_KEY=... npm run test:e2e
```

The site is plain ES modules; the Supabase SDK loads from a CDN. There is no build step.

## Import format

```json
{
  "questions": [
    { "id": "q001", "type": "mc",    "prompt": "…", "options": ["a","b","c"], "points": 1 },
    { "id": "q002", "type": "multi", "prompt": "…", "options": ["a","b","c"], "points": 2 },
    { "id": "q003", "type": "tf",    "prompt": "…", "points": 1 },
    { "id": "q004", "type": "text",  "prompt": "…", "points": 1 },
    { "id": "q005", "type": "essay", "prompt": "…", "points": 5 }
  ],
  "answers": {
    "q001": { "correct": 1 },
    "q002": { "correct": [0, 2], "partialCredit": true },
    "q003": { "correct": false },
    "q004": { "accepted": ["liability", "legal liability"], "caseSensitive": false },
    "q005": {}
  }
}
```

The legacy `[{ "type": "text", "q": "…", "a": ["…"] }]` array is accepted as-is.

## Limitations (read before a high-stakes exam)

Browser-based proctoring cannot see a second device or a person in the room;
everything the student's browser reports can in principle be suppressed by a
determined student. The platform makes the *server-side* parts airtight
(identity, one attempt, timer, hidden key, frozen submissions, grades) and
turns the *client-side* parts into timestamped evidence with a risk score for
the professor to judge. Details in [`docs/SECURITY.md`](docs/SECURITY.md).

## License

MIT
