# UnoExamination

A free, serverless, proctored online examination platform that any number of
professors can share. Static HTML/JS (host it on GitHub Pages) + Firebase
Authentication + Firestore **security rules** as the backend. No Cloud
Functions, no paid plan, no server to maintain.

|                     | Professors                                                        | Students                                                   |
|---------------------|-------------------------------------------------------------------|------------------------------------------------------------|
| Build exams         | multiple choice, multi-select, true/false, short answer, essay; import the old single-file quiz format or JSON | sign in with Google or e-mail, enter a 6-character code |
| Anti-cheat          | fullscreen, tab/window/blur, copy-paste, devtools, reload, second-tab, offline detection; configurable strike limit → warn / lock / auto-submit | clear rules page, live strike counter, autosave, resume after crash |
| Live monitor        | who is online, progress, time left, violations, risk score; unlock, add time, force-submit, terminate, reset | server-side timer — closing the page does not pause it |
| Grading             | auto-graded in the professor's browser with the private key; manual points for essays; release scores; CSV export | see score & feedback once released |

Read [`docs/SECURITY.md`](docs/SECURITY.md) for what is enforced by the
server versus what is only evidence, and [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md)
for the GitHub projects this design learned from.

## Why Firebase and not "no database at all"?

A purely static site must ship the answer key to the browser and compute the
score there, so a student can read the key from *View source* and forge the
score. Somebody trusted has to hold the key, keep the clock and record the
result. Firestore's rules engine does exactly that on Google's servers, and
the Spark (free) plan is enough: 1 GiB storage, 50 000 reads and 20 000 writes
per day. There is no custom backend code at all.

## Setup (about 15 minutes)

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project** (Analytics
   off is fine). Stay on the free **Spark** plan.
2. **Build → Authentication → Get started.** Enable **Google** and (optionally)
   **Email/Password**.
   *Authentication → Settings → Authorized domains*: add the domain you will
   host on (e.g. `yourname.github.io`).
3. **Build → Firestore Database → Create database.** Choose a location and
   **production mode** (rules are deployed in the next step).
4. **Project settings (gear) → Your apps → Web (</>)**. Register the app; copy
   the `firebaseConfig` object.

### 2. Configure the site

1. Paste the config into [`js/firebase-config.js`](js/firebase-config.js) and
   set `siteConfig.institutionName` (optional banner image, colours in
   `css/style.css`).
2. Open [`firestore.rules`](firestore.rules) and change the line

   ```
   function BOOTSTRAP_ADMIN_EMAIL() { return 'professor@example.edu'; }
   ```

   to the e-mail of the first professor. That account can promote colleagues
   later from the dashboard's **Access** tab.
3. Deploy the rules, either
   * **Console:** Firestore → *Rules* tab → paste the whole file → Publish, or
   * **CLI:** `npm i -g firebase-tools && firebase login && firebase use <project-id> && npm run deploy:rules`

### 3. Host the static files

* **GitHub Pages:** push this repository, then *Settings → Pages → Build and
  deployment → Source: Deploy from a branch* → your branch, folder `/ (root)`.
  Your site is `https://<user>.github.io/<repo>/`. Commit
  `js/firebase-config.js` – the Firebase web config is public by design; all
  security is in the rules.

  This serves the whole repository, so `docs/`, `tests/` and `firestore.rules`
  are reachable too. That exposes nothing secret (the rules are meant to be
  auditable and the config is public), but if you would rather publish only the
  four pages plus `js/` and `css/`, switch *Source* to **GitHub Actions** and
  add a workflow that stages just those files.
* **Firebase Hosting (alternative, also free):** `npm run deploy:hosting`.
* **Locally:** `npm run serve` and open <http://localhost:5000> (add
  `localhost` to authorized domains).

### 4. Check the setup

Open **`/setup.html`** and sign in. It tests the whole chain and names the exact
console screen to fix anything that is wrong:

* config pasted, SDK loading, Firestore reachable
* **whether your rules are actually deployed** — it detects a database left in
  test mode, which is the mistake that would expose your answer keys
* e-mail verified, professor role (it self-promotes the bootstrap admin), and a
  real create-exam / read-key / delete round-trip
* the authorized-domain reminder for this hostname

Delete `setup.html` and `js/setup.js` once everything passes, or leave them —
the page grants no access of its own.

### 5. First login

Open `/professor.html`, sign in with the bootstrap e-mail (Google, or e-mail +
password and click the verification link first). You land on the dashboard.
Use **Access** to promote other professors after they have signed in once.

## Running an exam

1. **New exam** → fill details, timing and anti-cheat settings → add questions
   or **Import** (`examples/sample-mixed-types.json` shows every question type;
   to bring in an existing quiz, paste its old `baseQuizData = [...]` array
   straight into the Import box — it is converted for you).

   > **Keep real answer keys out of git.** Import them through the dashboard so
   > the key is stored in Firestore where only you can read it. A key committed
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
| Shuffle questions / options | Deterministic per student; the professor's grader reproduces the same order. |
| Questions per student | Random subset from the pool (e.g. 40 of 60), also deterministic per student. |
| One at a time | Single-question view with a navigator instead of one long page. |
| Restrict to e-mail domain / roster | Enforced by the rules when a session is created. |
| Show correct answers | Included in the student's review page once released. |
| Auto-grade | Grade in the monitor as soon as a student submits. |

## Data model (Firestore)

```
users/{uid}                          role: student | professor
exams/{CODE}                         title, settings, status, opensAt, closesAt, scoresReleased …
exams/{CODE}/content/questions       question text/options — NO answers
exams/{CODE}/private/answerKey       owner-only
sessions/{CODE}_{uid}                one attempt per student; answers, status, violations, heartbeat
sessions/{CODE}_{uid}/events/{id}    append-only proctoring log with server timestamps
grades/{CODE}_{uid}                  written by the professor's browser; visible to the student after release
```

## Development

```bash
npm install            # emulator + test tooling (Java required for the Firestore emulator)
npm test               # unit tests: grading, paper shuffling, import (node --test)
npm run test:rules     # 19 security-rule tests against the Firestore emulator
npm run test:e2e       # full browser run-through against the Auth+Firestore emulators
npm run test:all       # all three
npm run emulators      # local Auth + Firestore + Hosting emulators
```

The end-to-end test drives real Chromium through the whole lifecycle — publish,
sit the exam, trigger a violation, submit, auto-grade, grade an essay, release
scores, lock and unlock a student — and asserts that ten different direct
Firestore attacks from the student's own browser session are all denied. It
needs Chromium (`npx playwright install chromium`); in a network-restricted
sandbox add `E2E_VENDOR_SDK=1` so the Firebase SDK is fetched by node and
served locally.

The site is plain ES modules loaded from Google's CDN; there is no build step.

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
