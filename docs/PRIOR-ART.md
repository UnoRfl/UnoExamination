# Prior art: online exam / quiz projects on GitHub Pages, Firebase and Supabase

Research done while designing UnoExamination (September 2026). Only public
README / rules files were consulted; nothing below was run.

## Projects reviewed

| Project | What it is | Exam / answer storage & grading | Anti-cheat signals | Key weaknesses |
|---|---|---|---|---|
| [Mwelwa-cyber/Zedexams](https://github.com/Mwelwa-cyber/Zedexams) | React + Firebase (Auth, Firestore, Cloud Functions v2) | Questions served and graded by Cloud Functions; attempts client-creatable but **never client-updatable**; raw answers in an owner-only `private/` subcollection | none | Needs Cloud Functions (paid Blaze plan). Best public reference for "rules give real server-side enforcement". |
| [Romansko/QuizApp](https://github.com/Romansko/QuizApp) | HTML/JS quiz on Firebase Realtime DB | Questions **including correct answers** fetched by the client; scoring client-side; README tells you to set `read: true` | none | No auth, public DB, key visible in network tab. |
| [PRKille/Firebase-Quiz-App](https://github.com/PRKille/Firebase-Quiz-App) | React quiz, Firebase Auth + Firestore | Answers readable by any signed-in user; scoring client-side | none | Answer key readable by students. |
| [Pranavshinde678/CyberSecurityAssessment](https://github.com/Pranavshinde678/CyberSecurityAssessment) | Static HTML on Netlify + Firestore | Scored client-side; only the result row is written to Firestore | question order randomisation, no back-navigation, per-question timing | Student can write any score directly; questions and answers in client JS. |
| [vanpariyar/quiz-from-sheets](https://github.com/vanpariyar/quiz-from-sheets) | GitHub Pages + Google Apps Script + Google Sheets | Questions from a Sheet via Apps Script; answers written back | none; home-rolled login | Correct answers reach the client; three Apps Script URLs to configure. |
| [ansh-saini/react-proctoring](https://github.com/ansh-saini/react-proctoring) | Headless React hook `useProctoring` | n/a (library) | `visibilitychange` + `blur`, Fullscreen API, `contextmenu`, `copy` / user-select blocking | README admits DevTools detection is unreliable. Warns, does not prevent. |
| [tsujit74/online-quiz-maker](https://github.com/tsujit74/online-quiz-maker) | MERN app | MongoDB, Express grades | fullscreen, tab-switch, "DevTools prevention", copy/paste blocking | Requires a Node server; violation handling undocumented. |
| [Kreliannn/Secure-Quiz-Management-System](https://github.com/Kreliannn/Secure-Quiz-Management-System) | PHP/MySQL | server-side | Alt-Tab / blur => **auto-submit as "cheating"** | Single blur = instant fail: high false-positive rate. |
| [shahhilag4/Proctored_Based_Exam_System](https://github.com/shahhilag4/Proctored_Based_Exam_System) | Flask + MongoDB + OpenCV | server-side | face-match login, live face detection, forced fullscreen, shortcut blocking | Heavy CV stack; OS-level switching bypasses shortcut blocks. |
| [bhavyamistry/Testwise](https://github.com/bhavyamistry/Testwise-OnlineExamPortal-with-AntiCheating) | Flask + MySQL, Google SSO | server-side auto-grading | tab-switch prevention, fullscreen | Server required. |

Also seen, thin documentation: `ankosoftware/openquiz-firebase`, `tejasnayak25/aula`, `kamlendras/OpenProctor`.

No public project was found that combines **GitHub Pages hosting + Firebase + browser proctoring** without leaking the answer key. Every static/Firebase quiz found ships the correct answers to the client and computes the score client-side.

## Common patterns

**Proctoring signals everyone uses** (same handful of browser APIs): `document.visibilitychange` and `window.blur` for tab/app switching; `fullscreenchange` + `requestFullscreen()` (needs a click); `contextmenu` / `copy` / `paste` suppression; key-down blocking of F12 / Ctrl-Shift-I / Ctrl-U; window-size heuristics for DevTools.

**Trivially bypassable**: DevTools detection (undock the panel, or open it before the page loads); keyboard-shortcut blocking (Alt-Tab is handled by the OS); fullscreen enforcement (a second monitor, a phone, or split screen leave no signal); `blur` also fires on harmless events (notifications, IME popups) so single-strike auto-fail produces false positives. Nothing in a browser can see a second device.

**Where answer keys leak**: correct answers in client JS or in a student-readable collection; score computed client-side and then written to a database the client can also write to; Firebase "test mode" rules.

**Tricks that actually hold**:

- *Zedexams pattern*: questions without answers in one place, answer key in a collection with `allow read: if false` (for students), attempt documents that are client-creatable but never client-updatable, score written only by trusted code.
- Firestore `request.time` for trustworthy start/end timestamps.
- Grading in a trusted context. Zedexams uses a Cloud Function; **UnoExamination uses the professor's own authenticated browser instead**, which is compatible with rules-only Firestore (`allow read: if isOwner()` on the key) and needs no paid plan. This pattern was not found in any public project.

## What this project ended up doing

The first version of UnoExamination used the Zedexams pattern on Firestore:
key in an owner-only document, grading in the professor's browser. It then
moved to Supabase Postgres, which allows something none of the projects above
manage without a paid function runtime — **grading inside the database**. A
`SECURITY DEFINER` function reads the key server-side and returns only the
score, so the key never reaches a browser at all, professor's included.

## Lessons applied in UnoExamination

1. The answer key lives in `answer_keys`, which has no student-facing RLS policy at all.
2. Sessions are write-once for identity/start fields; students can only add answers, heartbeats and violations, and only until the server-side deadline.
3. Grades are a separate table, written only by `grade_session()` and readable by the student only after release.
4. `visibilitychange` / `blur` / `fullscreenchange` etc. are recorded as timestamped evidence with a configurable strike policy (warn / lock / auto-submit); the professor decides.
5. DevTools detection and shortcut blocking are kept only as friction and evidence, never as security.
6. Questions are served per attempt by `get_paper()` — a deterministic shuffle computed in the database, so a student cannot reroll for an easier subset — and only after their session exists.
7. GitHub Pages hosting is fine; the publishable key is public by design, and RLS plus the auth redirect list are the actual perimeter.
