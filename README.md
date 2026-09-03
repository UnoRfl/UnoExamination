# UnoExamination

A free, serverless, proctored online examination platform that any number of
professors can share. Static HTML/JS (hosted on GitHub Pages) + Supabase
Postgres with **row level security** as the backend. No server code, no paid
plan, nothing to maintain.

**Live:** <https://unorfl.github.io/UnoExamination/>

|                     | Professors                                                        | Students                                                   |
|---------------------|-------------------------------------------------------------------|------------------------------------------------------------|
| Build exams         | multiple choice, multi-select, true/false, short answer, essay; generate a whole paper from a Word/PDF document, or import Excel, CSV or JSON | sign in with Google or e-mail, enter a 6-character code |
| Anti-cheat          | fullscreen, tab/window/blur, copy-paste, devtools, reload, second-tab, offline detection; configurable strike limit → warn / lock / auto-submit | clear rules page, live strike counter, autosave, resume after crash |
| Live monitor        | who is online, progress, time left, violations, risk score; unlock, add time, force-submit, terminate, reset | server-side timer — closing the page does not pause it |
| Grading             | auto-graded **inside the database**, so the answer key never reaches any browser; manual points for essays; release scores; Excel export | see score & feedback once released |

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

1. **New exam** → pick a preset (Practice / Standard quiz / Strict proctored),
   adjust anything you want, then add questions — or skip all of it and use
   **Import an exam** on the *My exams* page to turn one file into a complete
   draft. See [Importing a whole exam](#importing-a-whole-exam).

   > **Keep real answer keys out of git.** Import them through the dashboard so
   > the key is stored in the database where only you can read it. A key committed
   > to a public repository is readable by anyone who finds the repo.
2. **Publish** → you get a code like `K7M2XQ`. Students go to the site, sign
   in, type the code (or use *Copy student link*).
3. Keep **Live monitor** open during the exam. Submissions are auto-graded as
   they arrive. Click a student to see answers, the full event timeline and
   risk reasons; unlock / add time / force-submit / terminate / reset as needed.
4. **Grades** → grade essays, **Release scores**, **Export to Excel** (a
   workbook with a summary sheet, one row per student, and an item analysis
   showing which questions the class found hard).

### Roles

| Role | Can |
|---|---|
| **Student** | Sit an exam they have the code for, and see their own score once released. |
| **Professor** | Create and run their own exams; be added as a co-teacher on someone else's; invite a colleague to become a professor. |
| **Administrator** | Everything a professor can, plus: see every exam on the site, and set anyone's role — including making another administrator. Gets an extra **Admin** tab. |

A professor can invite a *student* to become a professor and nothing more —
they cannot demote a colleague or create an administrator. Every role change
is checked in the database, not just in the page.

**Co-teachers.** Open an exam → **Teachers** → *Add a teacher*. They can monitor,
grade, export and edit it. They cannot delete it, hand it to someone else, or
add further teachers — that stays with the owner (or an administrator).

### The roster: who may sit the exam

Editor → **Who is allowed in** → **Roster**. Add students one at a time, or drop
in a class list (Excel, CSV, or four columns pasted in). Column order does not
matter and headers are optional — the e-mail column is found either way.

A roster does two jobs:

1. Only those accounts can start the exam.
2. Their **student number and section come from the roster**, not from whatever
   they type at the gate. That is what makes the score-per-section report
   trustworthy — otherwise half the class writes `3-A`, the other half `BSIT 3A`,
   and the report is nonsense.

Re-importing a corrected list updates students rather than duplicating them.

### Score by section

The **Grades** tab shows every section's headcount, average, highest, lowest,
pass rate against the exam's pass mark, and flag count — computed in the
database, so it covers every student rather than the rows on screen. It is also
a sheet in the Excel export.

### Resetting attempts

Tick the rows on the **Live monitor** and use *Reset attempts*. Resetting deletes
the attempt — answers, event log and grade — so the student starts clean. The
same bar sets extra time for several students at once.

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

The site is plain ES modules. The Supabase SDK is vendored into
`js/vendor/supabase-js.js` (`npm run vendor` to rebuild), so the page makes no
request to any CDN. Excel files are written and read by `js/xlsx.js`, which
builds the ZIP and SheetML by hand — again, no dependency to load.

## Importing a whole exam

Three ways in, all from the same button. **My exams → Import an exam** turns a
file into a complete draft; **Import a file** inside an editor adds to or
replaces the paper you are working on.

### 1. A document you already wrote (Word, PDF, text)

Drop in the paper itself. The importer reads the numbered questions, their
options and the answer key straight out of it:

```
PART I. MULTIPLE CHOICE

1. Which control limits the damage of a stolen password?
A. Password rotation
B. Multi-factor authentication
C. Longer passwords
Answer: B

PART II. TRUE OR FALSE

2. Encryption at rest protects a stolen disk. [Answer: True]

3. Name the principle of least access. (2 pts)
Answer: least privilege | POLP
```

It copes with `1.`, `1)` and `Q1.`; options as `A.`, `a)` or `(A)`; answers on
their own line or in brackets on the prompt; `Answer:`, `Ans:` or `Key:`;
points written as `(2 pts)`; prompts that wrap; and `PART …` headings between
sections — a `TRUE OR FALSE` heading makes the items under it true/false. An
answer can be a letter, a number, several letters (`A and C`), or the option's
own words.

Formats: **.docx**, **.pdf**, **.txt**, **.md**, **.html**, or pasted straight in.
A scanned PDF holds pictures rather than text, so it cannot be read — save it as
.docx from Word first. Old `.doc` is not supported.

This is a parser, not a model: nothing leaves your browser, there is no API key,
and the same file always gives the same result. Anything it had to guess is
listed before you commit, and unfinished questions are flagged amber in the
editor.

### 2. An Excel or CSV question sheet

Download the template from either import dialog — it ships with one worked
example of every question type and a sheet explaining each column. One row per
question:

| Type | Points | Question | Option A | Option B | Option C | Correct | Case sensitive | Partial credit |
|---|---|---|---|---|---|---|---|---|
| mc | 1 | Which control limits the damage of a stolen password? | Rotation | MFA | Longer passwords | `B` | | |
| multi | 2 | Which are administrative controls? | Policy | Firewall rule | Training | `A, C` | | `TRUE` |
| tf | 1 | Encryption at rest protects a stolen disk. | | | | `TRUE` | | |
| text | 1 | Giving a user only the access they need is called…? | | | | `least privilege \| POLP` | `FALSE` | |
| essay | 10 | Explain defence in depth. | | | | | | |

- **Correct** is a letter (`B`) or a number (`2`) for `mc`; several letters for
  `multi`; `TRUE`/`FALSE` for `tf`; every accepted answer separated by `|` for
  `text`; blank for `essay`.
- Column order does not matter and extra columns are ignored, so your existing
  question bank probably imports as-is.
- Leave **Type** blank and it is inferred from the shape of the row.
- Add as many `Option …` columns as you need.
- An optional second sheet named **Settings** carries duration, violation limit
  and the rest; anything you leave blank keeps the exam's current value.

Anything the importer could not read with confidence is reported *before* you
commit — it never guesses silently.

**Export → Excel** writes this exact format back out, so you can edit a live
exam in Excel and import it again.

### 3. A JSON bundle (exact round-trip)

**Export → JSON** produces this, and it is the format to hand-write if you
prefer. The answer key sits on the question:

```json
{
  "format": "unoexamination.exam",
  "version": 1,
  "exam": { "title": "Prelim", "duration_minutes": 60, "shuffle_questions": true },
  "questions": [
    { "type": "mc",    "prompt": "…", "options": ["a","b","c"], "points": 1, "correct": 1 },
    { "type": "multi", "prompt": "…", "options": ["a","b","c"], "points": 2, "correct": [0,2], "partialCredit": true },
    { "type": "tf",    "prompt": "…", "points": 1, "correct": false },
    { "type": "text",  "prompt": "…", "points": 1, "accepted": ["liability","legal liability"], "caseSensitive": false },
    { "type": "essay", "prompt": "…", "points": 5 }
  ]
}
```

`exam` is optional, and only the settings listed in `js/bundle.js` are read —
a file can never release scores, change ownership or publish an exam.

Two ready-made samples live in [`examples/`](examples/):
[`sample-exam.json`](examples/sample-exam.json) and
[`sample-questions.csv`](examples/sample-questions.csv) — the same five-question
paper in both formats. Both are checked by the test suite, so they always import.

### 4. The older shapes

The split `{questions, answers}` export from earlier versions and the legacy
`baseQuizData = [{ "type": "text", "q": "…", "a": ["…"] }]` array both still
import unchanged.

> **Keep real answer keys out of git.** Import them through the dashboard so the
> key is stored in the database where only you can read it. A key committed to a
> public repository is readable by anyone who finds the repo.

## Exporting

Everything leaves as a real `.xlsx` workbook — never CSV.

| Where | Sheets |
|---|---|
| Live monitor / Grades → **Export to Excel** | *Summary* (exam, class average, counts), *Students* (one row each, with risk, score and note), *Item analysis* (correct/partial/wrong per question) |
| Editor → **Excel** | *Questions*, *Settings*, *How to fill this in* — the importable format |
| Student drawer → **Event log** | every recorded event with its timestamp, seconds into the exam and weight |

Dates are real dates and scores are real numbers, so sorting and averaging work
without cleaning the file first.

## Limitations (read before a high-stakes exam)

Browser-based proctoring cannot see a second device or a person in the room;
everything the student's browser reports can in principle be suppressed by a
determined student. The platform makes the *server-side* parts airtight
(identity, one attempt, timer, hidden key, frozen submissions, grades) and
turns the *client-side* parts into timestamped evidence with a risk score for
the professor to judge. Details in [`docs/SECURITY.md`](docs/SECURITY.md).

## License

MIT
