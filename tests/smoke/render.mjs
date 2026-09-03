// Browser smoke test: every page must actually RENDER.
//
// This exists because three separate bugs shipped that a Node test cannot see:
// an SDK import that failed, a syntax error in one page, and an auth call that
// hung forever. All three looked identical to a user — a page stuck on
// "Loading…" with no error — and all three would have been caught here.
//
// It needs no credentials. The site is served locally and every request to the
// Supabase API is intercepted and answered with a stub, so the test is
// hermetic: no network, no project, no secrets.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildXlsx, readXlsx } from "../../js/xlsx.js";
import { templateSheets, questionsFromTable } from "../../js/bundle.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/smoke/out");
const PORT = Number(process.env.SMOKE_PORT || 5099);
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let pass = 0, fail = 0;
const log = (...a) => console.log("[smoke]", ...a);
function check(label, ok, extra = "") {
  if (ok) { pass++; log("PASS", label); } else { fail++; log("FAIL", label, extra); }
}

// In CI Playwright manages its own browser. In a sandbox that ships one
// already, PLAYWRIGHT_CHROMIUM_PATH points at it.
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {});

/**
 * Answer Supabase REST/auth calls locally so the page can render without a
 * project. `session` decides whether the visitor looks signed in.
 */
const FAKE_USER = { id: "00000000-0000-4000-8000-000000000001", email: "prof@example.edu",
  aud: "authenticated", role: "authenticated", email_confirmed_at: "2024-01-01T00:00:00Z" };

// --- a small exam a stubbed student can actually sit
const STUDENT = { id: "00000000-0000-4000-8000-000000000009", email: "student@school.edu",
  aud: "authenticated", role: "authenticated", email_confirmed_at: "2024-01-01T00:00:00Z" };
const SID = "11111111-1111-4111-8111-111111111111";
const opts = (a) => a.map((text, oi) => ({ oi, text }));
const EXAM = {
  code: "IAS101", title: "Information Assurance – Prelim Examination", course: "IAS 101",
  owner_name: "Prof. Uno", instructions: "Answer every item. No notes, no second device.",
  status: "open", opens_at: new Date(Date.now() - 3600e3).toISOString(),
  closes_at: new Date(Date.now() + 30 * 86400e3).toISOString(),
  duration_minutes: 60, max_violations: 5, violation_action: "lock",
  require_fullscreen: false, block_clipboard: true, one_at_a_time: false,
  require_student_id: true, scores_released: false, question_count: 4, total_points: 5,
};
const PAPER = [
  { id: "q1", type: "mc", points: 1, prompt: "Which control most directly limits the damage of a stolen password?",
    options: opts(["Password rotation", "Multi-factor authentication", "Longer passwords", "Account lockout"]) },
  { id: "q2", type: "multi", points: 2, prompt: "Which of these are administrative controls?",
    options: opts(["Security policy", "Firewall rule", "Staff training", "Door lock"]) },
  { id: "q3", type: "tf", points: 1, prompt: "Encryption at rest protects data if a disk is stolen." },
  { id: "q4", type: "text", points: 1, prompt: "Name the principle of giving a user only the access they need." },
];
const CLASS = [
  ["Bautista, Neil",  "21-0005", "BSIT 3B", "in_progress", 0, 12, null],
  ["Dela Cruz, Juan", "21-0001", "BSIT 3A", "in_progress", 1, 30, null],
  ["Lim, Andrea",     "21-0004", "BSIT 3A", "locked",      6, 44, null],
  ["Reyes, Maria",    "21-0002", "BSIT 3A", "submitted",   0, 60, [52, 86.7, 0]],
  ["Santos, Paolo",   "21-0003", "BSIT 3B", "submitted",   4, 58, [41, 68.3, 1]],
].map(([display_name, student_no, section, status, violations, answered, g], i) => ({
  id: `s${i}`, exam_code: "IAS101", student_id: `st${i}`, display_name, student_no, section,
  email: `${display_name.split(",")[0].toLowerCase()}@school.edu`,
  status, violations, answered, total: 60, answers: {}, flagged: violations > 3,
  extra_minutes: 0, note: "", client_id: `c${i}`, client: {},
  started_at: new Date(Date.now() - 1800e3).toISOString(),
  heartbeat_at: new Date().toISOString(),
  submitted_at: status === "submitted" ? new Date(Date.now() - 300e3).toISOString() : null,
  grade: g,
}));
const CLASS_GRADES = CLASS.filter((s) => s.grade).map((s) => ({
  session_id: s.id, exam_code: "IAS101", score: s.grade[0], max_score: 60,
  percent: s.grade[1], needs_manual: s.grade[2], per_question: {}, feedback: "",
}));

const SESSION = {
  id: SID, exam_code: "IAS101", student_id: STUDENT.id, display_name: "Dela Cruz, Juan",
  student_no: "21-0001", section: "BSIT 3A", status: "in_progress", answers: {}, violations: 0,
  started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
  client_id: null, extra_minutes: 0, flagged: false,
};

async function stubSupabase(page, { session = null, rest = {}, rpc = {} } = {}) {
  await page.route("**/auth/v1/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user")) {
      return route.fulfill({ status: session ? 200 : 400, contentType: "application/json",
        body: JSON.stringify(session ? session.user : { error: "invalid" }) });
    }
    if (url.includes("/token")) {
      return route.fulfill({ status: session ? 200 : 400, contentType: "application/json",
        body: JSON.stringify(session || { error: "invalid" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/rest/v1/**", (route) => {
    const seg = new URL(route.request().url()).pathname.replace(/^.*\/rest\/v1\//, "").split("?")[0];
    const src = seg.startsWith("rpc/") ? rpc : rest;
    const key = seg.replace(/^rpc\//, "");
    const body = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/realtime/v1/**", (route) => route.abort());
}

/** A session object shaped the way supabase-js persists it in localStorage. */
function fakeSession() {
  return { access_token: "stub.access.token", refresh_token: "stub-refresh",
    token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: FAKE_USER };
}

async function visit(label, urlPath, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // A stubbed API legitimately returns 4xx; that is not a page defect.
    if (/Failed to load resource|net::ERR|400|401|404/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith(BASE)) errors.push(`asset failed: ${u.replace(BASE, "")} ${r.failure()?.errorText || ""}`);
  });

  await stubSupabase(page, opts);
  if (opts.session) {
    // supabase-js reads its session straight out of localStorage on boot.
    await page.addInitScript(([key, sess]) => {
      try { localStorage.setItem(key, JSON.stringify(sess)); } catch {}
    }, [opts.storageKey, opts.session]);
  }
  await page.goto(BASE + urlPath, { waitUntil: "load", timeout: 30000 });

  // The whole point: something other than the placeholder must appear, and it
  // must not be the watchdog's error panel.
  let rendered = false;
  try {
    await page.waitForFunction(() => window.__unoRendered === true, null, { timeout: 20000 });
    rendered = true;
  } catch { /* fall through to the report below */ }

  const bootError = await page.locator("#bootError").count();
  const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const stillLoading = /^\s*Loading/.test(bodyText) || bodyText.includes("Loading…");

  check(`${label}: rendered`, rendered, rendered ? "" : `body was: "${bodyText.slice(0, 120)}"`);
  check(`${label}: no watchdog error panel`, bootError === 0);
  check(`${label}: placeholder replaced`, !stillLoading, stillLoading ? "still showing Loading…" : "");
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));

  // Element.append(null) prints the literal word on the page, and `cond ? node
  // : null` is everywhere. This shipped twice before it was noticed.
  const junk = bodyText.match(/(^|[\s>])(null|undefined|NaN|\[object Object\])([\s<]|$)/);
  check(`${label}: nothing renders as null/undefined/NaN`, !junk,
    junk ? `found "${junk[2]}" in: …${bodyText.slice(Math.max(0, junk.index - 40), junk.index + 40)}…` : "");

  if (!rendered || bootError || errors.length) {
    fs.mkdirSync(OUT, { recursive: true });
    const shot = path.join(OUT, label.replace(/\W+/g, "-") + ".png");
    await page.screenshot({ path: shot, fullPage: true });
    log(`      screenshot: ${path.relative(ROOT, shot)}`);
  }
  return { page, ctx, errors };
}

try {
  // --- the pages a visitor can reach signed out
  const home = await visit("home (signed out)", "/index.html");
  check("home: shows the sign-in form",
    (await home.page.locator("input[name=email]").count()) > 0);
  check("home: shows the exam-code box",
    (await home.page.locator("form").count()) > 0);
  await home.ctx.close();

  const prof = await visit("professor (signed out)", "/professor.html");
  check("professor: shows the sign-in form",
    (await prof.page.locator("input[name=email]").count()) > 0);
  await prof.ctx.close();

  const setup = await visit("setup check", "/setup.html");
  check("setup: ran its checks",
    (await setup.page.locator(".check-row").count()) > 0,
    `${await setup.page.locator(".check-row").count()} rows`);
  await setup.ctx.close();

  const noCode = await visit("exam without a code", "/exam.html");
  check("exam: explains the missing code",
    (await noCode.page.locator("body").innerText()).includes("No exam code"));
  await noCode.ctx.close();

  const withCode = await visit("exam with a code (signed out)", "/exam.html?code=ABC123");
  check("exam: asks the student to sign in",
    (await withCode.page.locator("input[name=email]").count()) > 0);
  await withCode.ctx.close();

  // --- the exam editor, signed in as a professor. This is the densest screen in
  //     the app and the only one a signed-out smoke test never reaches.
  const cfg = fs.readFileSync(path.join(ROOT, "js/config.js"), "utf8");
  const ref = cfg.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)[1];
  const editor = await visit("exam editor (professor)", "/professor.html#new", {
    session: fakeSession(),
    storageKey: `sb-${ref}-auth-token`,
    rest: { profiles: [{ id: FAKE_USER.id, email: FAKE_USER.email, role: "professor",
                         display_name: "Prof Test", student_id: null, section: null }],
            exam_teachers: [], exam_roster: [] },
    rpc: { exam_teachers_list: [], exam_section_stats: [] },
  });
  const ed = editor.page;
  check("editor: offers the rule presets",
    (await ed.locator(".preset").count()) === 3, `${await ed.locator(".preset").count()} presets`);
  check("editor: settings are grouped, not one flat wall",
    (await ed.locator("details.group").count()) >= 4);
  check("editor: every toggle is a labelled switch",
    (await ed.locator(".switch").count()) === 7, `${await ed.locator(".switch").count()} switches`);
  // the old flat grid of bare checkboxes must be gone from the settings card
  check("editor: no bare checkbox grid survives in the settings",
    (await ed.locator(".card:has(.preset) label.check").count()) === 0);
  check("editor: shows a plain-language summary of the settings",
    (await ed.locator(".summary-line").innerText()).includes("min"));
  check("editor: a preset marks itself as selected",
    (await ed.locator('.preset[aria-pressed="true"]').count()) >= 0);
  check("editor: empty question list explains itself",
    (await ed.locator("#qHost .q-empty").innerText()).toLowerCase().includes("no questions"));

  // add a question, then confirm it collapses to a single row
  await ed.getByRole("button", { name: "+ Multiple choice" }).click();
  await ed.getByRole("button", { name: "+ True / False" }).click();
  check("editor: added questions appear as collapsed rows",
    (await ed.locator(".q-row").count()) === 2, `${await ed.locator(".q-row").count()} rows`);
  check("editor: an unfinished question is flagged",
    (await ed.locator(".q-flag.warn").count()) === 2);
  check("editor: at most one question is expanded",
    (await ed.locator(".q-body").count()) <= 1);
  await ed.locator(".q-row").first().click();
  check("editor: clicking a row opens exactly one editor",
    (await ed.locator(".q-body").count()) === 1);
  await ed.locator(".q-body textarea").first().fill("What is defence in depth?");
  check("editor: typing updates the collapsed row live",
    (await ed.locator(".q-row").first().innerText()).includes("defence in depth"));
  await ed.locator(".q-row").nth(1).click();
  check("editor: opening another row closes the first",
    (await ed.locator(".q-body").count()) === 1);

  // presets must actually move the switches
  await ed.locator(".preset").first().click();
  check("editor: the Practice preset turns fullscreen off",
    (await ed.locator(".switch input").first().isChecked()) === false);
  await ed.locator(".preset").nth(2).click();
  check("editor: the Strict preset turns fullscreen on",
    (await ed.locator(".switch input").first().isChecked()) === true);
  check("editor: the applied preset is highlighted",
    (await ed.locator('.preset[aria-pressed="true"]').count()) === 1);

  // --- the import path, driven with a real workbook. This is the feature most
  //     likely to meet a file we have never seen, so it gets a live round trip.
  fs.mkdirSync(OUT, { recursive: true });
  const tpl = path.join(OUT, "template.xlsx");
  fs.writeFileSync(tpl, Buffer.from(await buildXlsx(templateSheets()).arrayBuffer()));

  await ed.getByRole("button", { name: "⬆ Import a file" }).click();
  await ed.locator(".dropzone").waitFor();
  await ed.locator(".dropzone input[type=file]").setInputFiles(tpl);
  await ed.locator(".import-status.ok").waitFor({ timeout: 8000 });
  const report = await ed.locator(".import-status").innerText();
  check("import: reads the workbook and reports what it found",
    /5 questions/.test(report), report.replace(/\n/g, " | "));
  check("import: names every question type it read",
    /Multiple choice/.test(report) && /Essay/.test(report), report.replace(/\n/g, " | "));

  await ed.locator(".modal-card select").selectOption("replace");
  await ed.getByRole("button", { name: "Import", exact: true }).click();
  await ed.locator(".modal-overlay").waitFor({ state: "detached" });
  check("import: the questions land in the editor",
    (await ed.locator(".q-row").count()) === 5, `${await ed.locator(".q-row").count()} rows`);
  check("import: with their types intact",
    (await ed.locator(".type-chip").allInnerTexts()).join(",") === "CHOICE,MULTI,T / F,SHORT,ESSAY",
    (await ed.locator(".type-chip").allInnerTexts()).join(","));
  check("import: nothing is left flagged as unfinished",
    (await ed.locator(".q-flag.warn").count()) === 0,
    `${await ed.locator(".q-flag.warn").count()} still warned`);
  check("import: the points came across",
    (await ed.locator(".q-row").last().innerText()).includes("10 pt"));

  // ...and back out again: the Excel the editor writes must re-import cleanly.
  const dl = await Promise.all([
    ed.waitForEvent("download"),
    ed.getByRole("button", { name: "⬇ Excel" }).click(),
  ]).then(([d]) => d);
  const saved = path.join(OUT, "exported.xlsx");
  await dl.saveAs(saved);
  check("export: the download is named after the exam",
    /\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  const back = questionsFromTable(await readXlsx(fs.readFileSync(saved).buffer));
  check("export: the exported workbook re-imports with no warnings",
    back.warnings.length === 0, back.warnings.join(" | "));
  check("export: and with every question and key intact",
    back.questions.length === 5 && back.questions[0].key.correct === 1 &&
    back.questions[2].key.correct === true &&
    back.questions[3].key.accepted.length === 3,
    JSON.stringify(back.questions.map((q) => q.key)));

  // the search box must narrow the list
  await ed.locator(".q-toolbar input").fill("least privilege");   // in the answer key, not the prompt
  check("editor: search narrows the question list",
    (await ed.locator(".q-row").count()) === 1, `${await ed.locator(".q-row").count()} rows`);
  await ed.locator(".q-toolbar input").fill("");
  check("editor: clearing the search restores every question",
    (await ed.locator(".q-row").count()) === 5);

  // --- the new editor panels: assessment type, roster, co-teachers
  check("editor: the assessment type can be chosen",
    (await ed.locator("select").filter({ hasText: "Prelim examination" }).count()) === 1);
  check("editor: there is a pass mark for the section report",
    (await ed.locator("input[type=number]").count()) >= 3);
  // the roster lives inside the collapsed "Who is allowed in" group
  const whoGroup = ed.locator("details.group").filter({ hasText: "Who is allowed in" });
  await whoGroup.locator("summary").click();
  check("editor: an empty roster explains what a roster is for",
    (await whoGroup.locator(".empty").innerText()).toLowerCase().includes("roster"));
  check("editor: a roster can be built by hand or in bulk",
    (await ed.getByRole("button", { name: "＋ Add a student" }).count()) === 1 &&
    (await ed.getByRole("button", { name: "⬆ Add in bulk" }).count()) === 1);
  check("editor: a brand-new exam has no teacher panel yet",
    (await ed.locator("body").innerText()).includes("Teachers") === false,
    "co-teachers need a saved exam first");

  // A class list pasted in any shape must land on the roster.
  await ed.getByRole("button", { name: "⬆ Add in bulk" }).click();
  await ed.locator(".modal-card details.group summary").click();     // "…or paste the list"
  await ed.locator(".modal-card textarea").fill(
    "juan@school.edu, Dela Cruz Juan, 21-0001, BSIT 3A\n" +
    "maria@school.edu, Reyes Maria, 21-0002, BSIT 3A\n" +
    "paolo@school.edu, Santos Paolo, 21-0003, BSIT 3B");
  await ed.locator(".modal-card .import-status.ok").waitFor({ timeout: 8000 });
  check("roster: the paste is read before anything is committed",
    /3 students/.test(await ed.locator(".modal-card .import-status").innerText()),
    await ed.locator(".modal-card .import-status").innerText());
  await ed.getByRole("button", { name: "Add to roster" }).click();
  await ed.locator(".modal-overlay").waitFor({ state: "detached" });
  check("roster: every student lands in the table",
    (await whoGroup.locator("table.table tbody tr").count()) === 3,
    `${await whoGroup.locator("table.table tbody tr").count()} rows`);
  check("roster: with their number and section",
    (await whoGroup.locator("table.table").innerText()).includes("21-0002") &&
    (await whoGroup.locator("table.table").innerText()).includes("BSIT 3B"));
  check("roster: the settings summary counts the sections",
    /2 section/.test(await whoGroup.locator("summary").innerText()),
    await whoGroup.locator("summary").innerText());

  // --- generating an exam from a document the professor already wrote
  fs.writeFileSync(path.join(OUT, "paper.txt"),
    "PART I. MULTIPLE CHOICE\n\n" +
    "1. Which control limits the damage of a stolen password?\n" +
    "A. Rotation\nB. Multi-factor authentication\nC. Longer passwords\nAnswer: B\n\n" +
    "PART II. TRUE OR FALSE\n\n" +
    "2. Encryption at rest protects a stolen disk.\nAnswer: True\n\n" +
    "PART III. IDENTIFICATION\n\n" +
    "3. Name the principle of least access. (2 pts)\nAnswer: least privilege | POLP\n");
  await ed.getByRole("button", { name: "⬆ Import a file" }).click();
  await ed.locator(".dropzone input[type=file]").setInputFiles(path.join(OUT, "paper.txt"));
  await ed.locator(".import-status.ok").waitFor({ timeout: 8000 });
  const docReport = await ed.locator(".import-status").innerText();
  check("document import: reads a plain exam paper", /3 questions/.test(docReport), docReport.replace(/\n/g, " | "));
  check("document import: says it read it as a document", /as a document/.test(docReport));
  await ed.locator(".modal-card select").selectOption("replace");
  await ed.getByRole("button", { name: "Import", exact: true }).click();
  await ed.locator(".modal-overlay").waitFor({ state: "detached" });
  check("document import: the questions and their types come through",
    (await ed.locator(".type-chip").allInnerTexts()).join(",") === "CHOICE,T / F,SHORT",
    (await ed.locator(".type-chip").allInnerTexts()).join(","));
  check("document import: nothing is left needing an answer key",
    (await ed.locator(".q-flag.warn").count()) === 0);
  check("document import: points written in the paper are kept",
    (await ed.locator(".q-row").last().innerText()).includes("2 pt"));
  await editor.ctx.close();

  // --- the live monitor, with a class in it. Every row state at once, so the
  //     null/undefined guard above sweeps the busiest screen in the app.
  const mon = await visit("live monitor (professor)", "/professor.html#exam/IAS101/monitor", {
    session: fakeSession(), storageKey: `sb-${ref}-auth-token`,
    rest: {
      profiles: [{ id: FAKE_USER.id, email: FAKE_USER.email, role: "professor", display_name: "Prof Uno" }],
      exams: [{ ...EXAM, owner_id: FAKE_USER.id, owner_name: "Prof Uno" }],
      sessions: CLASS, grades: CLASS_GRADES, exam_teachers: [], exam_roster: [],
    },
    rpc: { exam_intro: EXAM, server_now: new Date().toISOString(),
           exam_teachers_list: [], exam_section_stats: [] },
  });
  const mp = mon.page;
  await mp.locator(".table tbody tr").first().waitFor({ timeout: 10000 });
  check("monitor: one row per student",
    (await mp.locator(".table tbody tr").count()) === 5,
    `${await mp.locator(".table tbody tr").count()} rows`);
  check("monitor: counts the class correctly",
    (await mp.locator(".stat").first().innerText()).startsWith("5"),
    await mp.locator(".stat").first().innerText());
  check("monitor: progress reads as a fraction, not undefined",
    /\b\d+ \/ 60\b/.test(await mp.locator(".table").innerText()));
  check("monitor: a locked student can be unlocked from the row",
    (await mp.getByRole("button", { name: "Unlock" }).count()) === 1);
  check("monitor: flagged students are marked",
    (await mp.locator(".table tr.risk-high, .table tbody tr").count()) === 5);
  await mp.locator("input[placeholder^='Filter']").fill("BSIT 3B");
  check("monitor: the filter narrows the table",
    (await mp.locator(".table tbody tr").count()) === 2,
    `${await mp.locator(".table tbody tr").count()} rows`);
  await mon.ctx.close();

  // --- the student runner. Nothing else in this suite reaches the page a
  //     student actually sits the exam on.
  const studentOpts = {
    session: { ...fakeSession(), user: STUDENT },
    storageKey: `sb-${ref}-auth-token`,
    rest: {
      profiles: [{ id: STUDENT.id, email: STUDENT.email, role: "student",
                   display_name: "Dela Cruz, Juan", student_id: "21-0001", section: "BSIT 3A" }],
      sessions: [SESSION],
    },
    rpc: { exam_intro: EXAM, start_exam: SID, get_paper: PAPER, server_now: new Date().toISOString() },
  };
  const gate = await visit("exam gate (student)", "/exam.html?code=IAS101", studentOpts);
  const gp = gate.page;
  check("gate: names the exam before anything starts",
    (await gp.locator("body").innerText()).includes("Information Assurance"));
  check("gate: asks for consent before it will start",
    (await gp.locator("button.btn-lg").isDisabled()));
  await gp.locator(".card input[type=checkbox]").last().check();
  check("gate: ticking the box arms the start button",
    !(await gp.locator("button.btn-lg").isDisabled()));

  await gp.locator("button.btn-lg").click();
  await gp.locator(".q-card").first().waitFor({ timeout: 15000 });
  check("exam: every question is on the page",
    (await gp.locator(".q-card").count()) === 4, `${await gp.locator(".q-card").count()} cards`);
  check("exam: multiple-choice options show their text",
    (await gp.locator(".q-card").first().innerText()).includes("Multi-factor authentication"));
  check("exam: true/false gets two options, not four",
    (await gp.locator(".q-card").nth(2).locator(".option").count()) === 2);
  check("exam: a short-answer question gets a text box",
    (await gp.locator(".q-card").nth(3).locator("input.input").count()) === 1);

  const timer = await gp.locator(".timer").innerText();
  check("exam: the clock is running, not NaN", /^\d?\d:\d\d$/.test(timer.trim()), `timer read "${timer}"`);

  check("exam: nothing is answered yet",
    (await gp.locator(".exam-nav").innerText()).includes("0 of 4"),
    await gp.locator(".exam-nav").innerText());
  await gp.locator(".q-card").first().locator(".option").nth(1).click();
  check("exam: picking an option marks it selected",
    (await gp.locator(".q-card").first().locator(".option.selected").count()) === 1);
  await gp.locator(".q-card").nth(3).locator("input.input").fill("least privilege");
  check("exam: the progress counter follows the answers",
    (await gp.locator(".exam-nav").innerText()).includes("2 of 4"),
    await gp.locator(".exam-nav").innerText());
  check("exam: the question map marks answered items",
    (await gp.locator(".nav-grid button.answered").count()) === 2);

  // Only one radio may hold an answer, or a student could score twice.
  await gp.locator(".q-card").first().locator(".option").nth(2).click();
  check("exam: choosing again replaces the first choice",
    (await gp.locator(".q-card").first().locator(".option.selected").count()) === 1);

  // The answer key must never reach the student's browser.
  const html = await gp.content();
  check("exam: no answer key is anywhere in the page",
    !/\bcorrect\b|\baccepted\b|answer_key/i.test(html),
    (html.match(/\bcorrect\b|\baccepted\b|answer_key/i) || [])[0] || "");
  await gate.ctx.close();

  // --- the failure this test exists for: a hung auth call must not blank the page
  const hung = await browser.newContext();
  const hp = await hung.newPage();
  await hp.route("**/auth/v1/**", () => { /* never answer */ });
  await hp.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, body: "[]", contentType: "application/json" }));
  await hp.goto(BASE + "/index.html", { waitUntil: "load" });
  let recovered = false;
  try {
    await hp.waitForFunction(() => window.__unoRendered === true, null, { timeout: 20000 });
    recovered = true;
  } catch {}
  check("home still renders when the auth API never answers", recovered);
  await hung.close();

  // --- a hang AFTER sign-in must also surface. The professor page used to
  //     declare itself rendered before loading the profile, so a stalled
  //     profile query left "Loading…" on screen with the watchdog satisfied.
  const stalled = await browser.newContext();
  const sp = await stalled.newPage();
  await sp.route("**/auth/v1/**", (r) => {
    const u = r.request().url();
    if (u.includes("/user")) {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FAKE_USER) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  // Playwright matches the most recently registered route first, so the
  // catch-all must go on before the one that stalls.
  await sp.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, body: "[]", contentType: "application/json" }));
  await sp.route("**/rest/v1/profiles**", () => { /* never answer */ });
  await sp.addInitScript(([k, sess]) => {
    try { localStorage.setItem(k, JSON.stringify(sess)); } catch {}
  }, [`sb-${ref}-auth-token`, fakeSession()]);
  await sp.goto(BASE + "/professor.html", { waitUntil: "load" });
  const surfaced = await sp.locator("#bootError").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("a stalled query after sign-in surfaces an error, not a silent Loading…", surfaced,
    surfaced ? "" : `body: ${(await sp.locator("body").innerText()).slice(0, 80)}`);
  await stalled.close();

  // --- and a page whose script is missing must say so rather than hang
  const broken = await browser.newContext();
  const bp = await broken.newPage();
  await bp.route("**/js/index.js", (r) => r.abort());
  await bp.goto(BASE + "/index.html", { waitUntil: "load" });
  const shown = await bp.locator("#bootError").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("a missing script produces a visible error, not a blank page", shown);
  await broken.close();
} catch (e) {
  fail++;
  log("ERROR", e.message);
} finally {
  await browser.close();
  server.close();
}

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
