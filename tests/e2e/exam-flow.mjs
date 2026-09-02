// End-to-end test: a real Chromium browser driving the real pages against the
// Firebase Auth + Firestore emulators.
//
//   npm run test:e2e
//
// It copies the site into a temp directory, points firebase-config.js at the
// emulators, serves it over HTTP (Firebase Auth refuses file://) and walks the
// whole exam lifecycle, including attempts to bypass the security rules.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.E2E_PORT || 5055);
const BASE = `http://localhost:${PORT}`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099"}`;
const PROF = "professor@example.edu"; // must match BOOTSTRAP_ADMIN_EMAIL in firestore.rules
const STU1 = "student1@school.edu";
const STU2 = "student2@school.edu";
const PASS = "password123";

// ---------------------------------------------------------------- static site
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), "uno-e2e-"));
for (const entry of ["index.html", "exam.html", "professor.html", "js", "css"]) {
  fs.cpSync(path.join(ROOT, entry), path.join(SITE, entry), { recursive: true });
}
{
  const p = path.join(SITE, "js/firebase-config.js");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8")
    .replace(/apiKey: "[^"]*"/, 'apiKey: "fake-api-key"')
    .replace(/authDomain: "[^"]*"/, 'authDomain: "demo-uno.firebaseapp.com"')
    .replace(/projectId: "[^"]*"/, 'projectId: "demo-uno"')
    .replace(/useEmulators: false/, "useEmulators: true"));
}
// In sandboxes where the browser cannot reach www.gstatic.com directly, fetch
// the SDK with node (which can) and serve it from the temp site instead.
if (process.env.E2E_VENDOR_SDK === "1") {
  const initPath = path.join(SITE, "js/firebase-init.js");
  let init = fs.readFileSync(initPath, "utf8");
  const base = init.match(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\//)[0];
  fs.mkdirSync(path.join(SITE, "js/vendor"), { recursive: true });
  for (const f of ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"]) {
    const res = await fetch(base + f);
    if (!res.ok) throw new Error(`could not vendor ${f}: HTTP ${res.status}`);
    const body = (await res.text()).replaceAll(base + "firebase-app.js", "./firebase-app.js");
    fs.writeFileSync(path.join(SITE, "js/vendor", f), body);
  }
  fs.writeFileSync(initPath, init.replaceAll(base, "./vendor/"));
  console.log("[e2e] vendored the Firebase SDK from", base);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(SITE, p);
  if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

// ---------------------------------------------------------------- helpers
let failures = 0;
const log = (...a) => console.log("[e2e]", ...a);
async function step(name, fn) {
  try { await fn(); log("PASS", name); }
  catch (e) { failures++; log("FAIL", name, "\n      ", e.message.split("\n")[0]); throw e; }
}
async function createVerifiedUser(email) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASS, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.localId) throw new Error(`signUp failed: ${JSON.stringify(j)}`);
  const u = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:update`,
    { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner" }, body: JSON.stringify({ localId: j.localId, emailVerified: true }) });
  if (!u.ok) throw new Error(`emailVerified update failed: ${await u.text()}`);
}

const browser = await chromium.launch();
const pageErrors = [];
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::/i.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
  return page;
}
const signIn = async (page, email) => {
  await page.waitForSelector("input[name=email]");
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASS);
  await page.click("button[type=submit]");
};
async function publishExam(prof, { title, violationLimit }) {
  await prof.goto(`${BASE}/professor.html#new`);
  await prof.waitForSelector("text=New exam");
  await prof.fill('input[placeholder^="e.g. Information Assurance"]', title);
  if (violationLimit != null) await prof.fill('.field:has-text("Violation limit") input', String(violationLimit));
  await prof.click("text=⬆ Import");
  await prof.fill(".modal-card textarea", fs.readFileSync(path.join(ROOT, "examples/sample-mixed-types.json"), "utf8"));
  await prof.click(".modal-card button:has-text('Import')");
  await prof.waitForSelector("text=5 questions · 10 points");
  await prof.click("text=🚀 Publish (open)");
  await prof.click(".modal-card button:has-text('Publish')");
  await prof.waitForFunction(() => /#exam\/[A-Z0-9]{6}\/edit/.test(location.hash), null, { timeout: 20000 });
  return prof.url().match(/#exam\/([A-Z0-9]{6})/)[1];
}
async function startExam(page, code, name) {
  await page.goto(`${BASE}/exam.html?code=${code}`);
  await signIn(page, name.email);
  await page.waitForSelector("text=Examination rules", { timeout: 20000 });
  await page.fill('input[placeholder="Last Name, First Name"]', name.display);
  await page.fill('input[placeholder="Student number"]', name.sid);
  await page.fill('input[placeholder="Section code"]', name.section);
  await page.check("label.check input[type=checkbox]");
  await page.click("text=Start examination");
  await page.waitForSelector(".q-card", { timeout: 20000 });
}
/** Run a Firestore call from inside the page as the signed-in user. */
const asUser = (page, fn, arg) => page.evaluate(async ([a, src]) => {
  const m = await import("./js/firebase-init.js");
  const run = new Function("m", "arg", `return (${src})(m, arg);`);
  try { const v = await run(m, a); return v ?? "ALLOWED"; } catch (e) { return e.code || e.message; }
}, [arg, fn.toString()]);

let code1, code2;
try {
  await step("Auth emulator: create verified professor and two students", async () => {
    for (const e of [PROF, STU1, STU2]) await createVerifiedUser(e);
  });

  const prof = await newPage();
  await step("bootstrap professor signs in and reaches the dashboard", async () => {
    await prof.goto(`${BASE}/professor.html`);
    await signIn(prof, PROF);
    await prof.waitForSelector("text=My exams", { timeout: 20000 });
  });

  await step("professor imports questions and publishes an exam", async () => {
    code1 = await publishExam(prof, { title: "E2E Exam" });
    await prof.waitForSelector(".badge:has-text('Open')");
    log("      exam code:", code1);
  });

  const stu = await newPage();
  await step("student signs in, accepts the rules and starts the exam", async () => {
    await startExam(stu, code1, { email: STU1, display: "Dela Cruz, Juan", sid: "21-0001", section: "50015" });
    const n = await stu.locator(".q-card").count();
    if (n !== 5) throw new Error(`expected 5 question cards, got ${n}`);
  });

  await step("security rules block every direct-access attempt from the student", async () => {
    const attempts = {
      "read answer key": (m, c) => m.getDoc(m.doc(m.db, "exams", c, "private", "answerKey")),
      "list all sessions": (m) => m.getDocs(m.collection(m.db, "sessions")),
      "read another student's session": (m, c) => m.getDoc(m.doc(m.db, "sessions", `${c}_someoneelse`)),
      "restart the clock": (m, c) => m.updateDoc(m.doc(m.db, "sessions", `${c}_${m.auth.currentUser.uid}`), { startedAt: m.serverTimestamp() }),
      "grant self extra time": (m, c) => m.updateDoc(m.doc(m.db, "sessions", `${c}_${m.auth.currentUser.uid}`), { extraMinutes: 500 }),
      "lower the violation count": (m, c) => m.updateDoc(m.doc(m.db, "sessions", `${c}_${m.auth.currentUser.uid}`), { violations: -10 }),
      "write own grade": (m, c) => m.setDoc(m.doc(m.db, "grades", `${c}_${m.auth.currentUser.uid}`), { examCode: c, uid: m.auth.currentUser.uid, score: 10, max: 10, percent: 100, gradedBy: m.auth.currentUser.uid }),
      "become a professor": (m) => m.updateDoc(m.doc(m.db, "users", m.auth.currentUser.uid), { role: "professor" }),
      "open another exam's key": (m) => m.getDoc(m.doc(m.db, "exams", "ZZZZZZ", "private", "answerKey")),
      "backdate an event": (m, c) => m.addDoc(m.collection(m.db, "sessions", `${c}_${m.auth.currentUser.uid}`, "events"), { type: "started", at: m.Timestamp.fromMillis(0) }),
    };
    const results = {};
    for (const [label, fn] of Object.entries(attempts)) results[label] = await asUser(stu, fn, code1);
    log("      ", JSON.stringify(results));
    const allowed = Object.entries(results).filter(([, v]) => v !== "permission-denied");
    if (allowed.length) throw new Error(`not denied: ${allowed.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  });

  await step("student answers every question type and autosave completes", async () => {
    const cards = stu.locator(".q-card");
    for (let i = 0; i < 5; i++) {
      const card = cards.nth(i);
      const kind = await card.evaluate((el) => el.querySelector("textarea") ? "essay"
        : el.querySelector("input.input") ? "text"
        : el.querySelectorAll("input[type=checkbox]").length ? "multi" : "radio");
      if (kind === "essay") await card.locator("textarea").fill("Due care is the plan; due diligence is following it every day.");
      else if (kind === "text") await card.locator("input.input").fill("Liability.");
      else if (kind === "multi") { await card.locator("label.option").nth(0).click(); await card.locator("label.option").nth(1).click(); }
      else await card.locator("label.option").first().click();
    }
    await stu.waitForSelector("#saveState:has-text('All changes saved')", { timeout: 15000 });
  });

  await step("pasting raises a warning, a strike and a logged event", async () => {
    await stu.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text", "smuggled answer text");
      document.querySelector(".q-card input.input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await stu.waitForSelector("text=Security warning");
    await stu.click(".modal-card button");
    const on = await stu.locator(".strike-bar i.on").count();
    if (on !== 1) throw new Error(`expected 1 strike lit, got ${on}`);
  });

  await step("student submits and is then frozen by the rules", async () => {
    await stu.click(".exam-head button:has-text('Submit')");
    await stu.click(".modal-card button:has-text('Submit now')");
    await stu.waitForSelector("text=Examination submitted", { timeout: 20000 });
    const r = await asUser(stu, (m, c) => m.updateDoc(m.doc(m.db, "sessions", `${c}_${m.auth.currentUser.uid}`), { answers: { q001: 0 } }), code1);
    if (r !== "permission-denied") throw new Error(`post-submit answer edit was ${r}`);
  });

  await step("live monitor shows the submission, the violation and an automatic grade", async () => {
    await prof.goto(`${BASE}/professor.html#exam/${code1}/monitor`);
    const row = prof.locator("tr:has-text('Dela Cruz, Juan')");
    await row.waitFor({ timeout: 20000 });
    await prof.waitForSelector("tr:has-text('Dela Cruz, Juan') .badge:has-text('Submitted')", { timeout: 20000 });
    await prof.waitForSelector("tr:has-text('Dela Cruz, Juan') td:nth-child(7) strong", { timeout: 20000 });
    const text = (await row.innerText()).replace(/\s+/g, " ");
    log("      monitor row:", text);
    if (!/\b1 \/ 5\b/.test(text)) throw new Error("violation count 1 / 5 not shown");
    if (!/manual/i.test(text)) throw new Error("essay was not marked as needing manual grading");
  });

  await step("risk analysis and the event timeline are available to the professor", async () => {
    await prof.click("text=🔍 Analyse risk");
    await prof.waitForSelector("tr:has-text('Dela Cruz, Juan') .badge:has-text('low'), tr:has-text('Dela Cruz, Juan') .badge:has-text('medium'), tr:has-text('Dela Cruz, Juan') .badge:has-text('high')", { timeout: 20000 });
    await prof.click("tr:has-text('Dela Cruz, Juan') button:has-text('View')");
    await prof.waitForSelector(".drawer");
    await prof.click(".drawer .tabs button:has-text('Event log')");
    await prof.waitForSelector(".drawer .timeline li:has-text('paste')");
    await prof.waitForSelector(".drawer .timeline li:has-text('started')");
    await prof.click(".drawer .tabs button:has-text('Device')");
    await prof.waitForSelector(".drawer:has-text('Browser')");
  });

  await step("professor grades the essay manually and saves feedback", async () => {
    await prof.click(".drawer .tabs button:has-text('Answers')");
    await prof.fill(".drawer .ar:has-text('Essay') input[type=number]", "4");
    await prof.fill(".drawer textarea[placeholder^='Feedback']", "Well argued.");
    await prof.fill(".drawer textarea[placeholder^='Private note']", "paste attempt on one item");
    await prof.click(".drawer button:has-text('Save grade')");
    await prof.waitForSelector(".drawer", { state: "detached" });
  });

  await step("grades view totals the score and releases it", async () => {
    await prof.goto(`${BASE}/professor.html#exam/${code1}/grades`);
    await prof.waitForSelector("tr:has-text('Dela Cruz, Juan')", { timeout: 20000 });
    const text = (await prof.locator("tr:has-text('Dela Cruz, Juan')").innerText()).replace(/\s+/g, " ");
    log("      grades row:", text);
    if (!/ \/ 10/.test(text)) throw new Error("no score out of 10 in the grades table");
    await prof.click("text=📢 Release scores");
    await prof.click(".modal-card button:has-text('Release')");
    await prof.waitForSelector(".badge:has-text('Released')", { timeout: 20000 });
  });

  await step("student sees the released score, feedback and per-question review", async () => {
    await stu.goto(`${BASE}/index.html`);
    await stu.waitForSelector("#results tbody tr", { timeout: 20000 });
    const text = (await stu.locator("#results").innerText()).replace(/\s+/g, " ");
    log("      student results:", text);
    if (!/\/ 10/.test(text)) throw new Error("score not visible to the student after release");
    await stu.goto(`${BASE}/exam.html?code=${code1}&review=1`);
    await stu.waitForSelector("text=Well argued.", { timeout: 20000 });
    if (!(await stu.locator(".ar").count())) throw new Error("no per-question review rows");
  });

  await step("a second attempt is impossible", async () => {
    await stu.goto(`${BASE}/exam.html?code=${code1}`);
    await stu.waitForSelector("text=Examination submitted", { timeout: 20000 });
  });

  await step("violation limit locks a student, and only the professor can unlock", async () => {
    code2 = await publishExam(prof, { title: "E2E Lock Test", violationLimit: 1 });
    const stu2 = await newPage();
    await startExam(stu2, code2, { email: STU2, display: "Reyes, Ana", sid: "21-0002", section: "50015" });
    // one strike is enough: simulate the tab being hidden and shown again
    await stu2.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await stu2.waitForSelector("text=EXAMINATION LOCKED", { timeout: 20000 });
    // the student cannot unlock themselves
    const r = await asUser(stu2, (m, c) => m.updateDoc(m.doc(m.db, "sessions", `${c}_${m.auth.currentUser.uid}`), { status: "in_progress" }), code2);
    if (r !== "permission-denied") throw new Error(`self-unlock was ${r}`);
    // the professor unlocks from the monitor and the student page recovers live
    await prof.goto(`${BASE}/professor.html#exam/${code2}/monitor`);
    await prof.waitForSelector("tr:has-text('Reyes, Ana') .badge:has-text('Locked')", { timeout: 20000 });
    await prof.click("tr:has-text('Reyes, Ana') button:has-text('Unlock')");
    await stu2.waitForSelector("text=Resume examination", { timeout: 20000 });
    // professor grants extra time, then force-submits
    await prof.waitForSelector("tr:has-text('Reyes, Ana') button:has-text('Submit')", { timeout: 20000 });
    await prof.click("tr:has-text('Reyes, Ana') button:has-text('Submit')");
    await prof.click(".modal-card button:has-text('Submit')");
    await prof.waitForSelector("tr:has-text('Reyes, Ana') .badge:has-text('Submitted')", { timeout: 20000 });
  });

  if (pageErrors.length) {
    log("page/console errors:");
    pageErrors.forEach((e) => log("      ", e));
    throw new Error(`${pageErrors.length} page/console error(s)`);
  }
  log("ALL STEPS PASSED with no page or console errors");
} catch (e) {
  log("E2E FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  fs.rmSync(SITE, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
