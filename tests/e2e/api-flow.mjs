// End-to-end test against a REAL Supabase project, over the same REST API the
// browser uses. It walks the whole exam lifecycle and then attacks the server
// as an ordinary signed-in student.
//
//   SUPABASE_SERVICE_KEY=... node tests/e2e/api-flow.mjs
//
// The service key is used ONLY to create and confirm throwaway test accounts
// and to clean up afterwards. Every assertion below runs as an ordinary user.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cfg = readFileSync(path.join(ROOT, "js/config.js"), "utf8");
const URL_ = process.env.SUPABASE_URL || cfg.match(/url:\s*"([^"]+)"/)[1];
const ANON = process.env.SUPABASE_ANON_KEY || cfg.match(/publishableKey:\s*"([^"]+)"/)[1];
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

const REUSE = process.env.REUSE_TEST_USERS === "1";
if (!SERVICE && !REUSE) {
  console.error("SUPABASE_SERVICE_KEY is required (Dashboard -> Project Settings -> API -> service_role).");
  console.error("It is only used to create, confirm and delete throwaway test accounts.");
  process.exit(2);
}

const admin = SERVICE
  ? createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;
const anon = () => createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

const stamp = Date.now();
const PROF = REUSE ? "apitest.prof@example.test" : `prof.${stamp}@example.test`;
const STU1 = REUSE ? "apitest.stu1@example.test" : `stu1.${stamp}@example.test`;
const STU2 = REUSE ? "apitest.stu2@example.test" : `stu2.${stamp}@example.test`;
const PASS = "test-password-123";
const CODE = "T" + String(stamp).slice(-5);

let pass = 0, fail = 0;
const log = (...a) => console.log("[api]", ...a);
function check(label, cond, extra = "") {
  if (cond) { pass++; log("PASS", label); }
  else { fail++; log("FAIL", label, extra); }
}
/** A blocked write shows up either as an error or as zero rows changed. */
async function denied(label, promise) {
  const { data, error } = await promise;
  const rows = Array.isArray(data) ? data.length : data ? 1 : 0;
  check(label, !!error || rows === 0, error ? "" : `touched ${rows} row(s)`);
}
async function allowed(label, promise) {
  const { data, error } = await promise;
  check(label, !error, error?.message || "");
  return data;
}

async function makeUser(email) {
  if (REUSE) {
    const c = await signIn(email);
    const { data: { user } } = await c.auth.getUser();
    return user;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASS, email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user;
}
async function signIn(email) {
  const c = anon();
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return c;
}

const created = [];
try {
  // ------------------------------------------------------------------ setup
  const profU = await makeUser(PROF); created.push(profU.id);
  const stu1U = await makeUser(STU1); created.push(stu1U.id);
  const stu2U = await makeUser(STU2); created.push(stu2U.id);
  log(`created 3 confirmed test users, exam code ${CODE}`);

  // the signup trigger must have made profiles
  if (admin) {
    const { data: profs } = await admin.from("profiles").select("id,role").in("id", created);
    check("signup trigger created a profile for each user", profs?.length === 3, `got ${profs?.length}`);
    check("new accounts default to the student role", profs?.every((p) => p.role === "student"));
    await admin.from("profiles").update({ role: "professor" }).eq("id", profU.id);
  } else {
    log("SKIP signup-trigger checks (no service key; reusing prepared accounts)");
  }

  const prof = await signIn(PROF);
  const stu = await signIn(STU1);
  const other = await signIn(STU2);

  // ------------------------------------------------------- professor builds
  await allowed("professor creates an exam", prof.from("exams").insert({
    code: CODE, owner_id: profU.id, owner_name: "Prof", title: "API flow exam",
    status: "open",
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 3600_000).toISOString(),
    duration_minutes: 30, max_violations: 5, question_count: 4, total_points: 9,
    show_correct_answers: true,
  }));

  const qs = await allowed("professor adds questions", prof.from("questions").insert([
    { exam_code: CODE, position: 1, type: "mc", prompt: "Capital of France?", options: ["Paris", "Berlin", "Rome"], points: 1 },
    { exam_code: CODE, position: 2, type: "text", prompt: "Due _____ is the plan.", options: [], points: 2 },
    { exam_code: CODE, position: 3, type: "multi", prompt: "Pick the vowels", options: ["a", "b", "e"], points: 2 },
    { exam_code: CODE, position: 4, type: "essay", prompt: "Discuss.", options: [], points: 4 },
  ]).select("id,position,type"));
  const byPos = Object.fromEntries(qs.map((q) => [q.position, q]));

  await allowed("professor stores the answer key", prof.from("answer_keys").insert([
    { question_id: byPos[1].id, exam_code: CODE, key: { correct: 0 } },
    { question_id: byPos[2].id, exam_code: CODE, key: { accepted: ["care", "diligence"], caseSensitive: false } },
    { question_id: byPos[3].id, exam_code: CODE, key: { correct: [0, 2], partialCredit: true } },
    { question_id: byPos[4].id, exam_code: CODE, key: {} },
  ]));

  // ----------------------------------------------- student cannot peek early
  await denied("student cannot read questions before starting",
    stu.from("questions").select("prompt").eq("exam_code", CODE));
  await denied("student cannot read the answer key",
    stu.from("answer_keys").select("key").eq("exam_code", CODE));

  const intro = await allowed("student can read the public exam intro", stu.rpc("exam_intro", { p_code: CODE }));
  check("intro carries no answer key", !JSON.stringify(intro || {}).match(/accepted|"correct"/));

  // -------------------------------------------------------- student sits it
  const sid = await allowed("student starts the exam", stu.rpc("start_exam", {
    p_code: CODE, p_name: "Dela Cruz, Juan", p_student_no: "21-0001", p_section: "A",
  }));
  const paper = await allowed("student fetches the paper", stu.rpc("get_paper", { p_session: sid }));
  check("paper has all 4 questions", paper?.length === 4, `got ${paper?.length}`);
  check("paper leaks no answer key", !JSON.stringify(paper).match(/accepted|"correct"|caseSensitive/));
  check("paper options carry their original index", paper.every((q) =>
    q.type === "mc" || q.type === "multi" ? q.options.every((o) => typeof o.oi === "number") : true));

  await allowed("student can read questions now that a session exists",
    stu.from("questions").select("prompt").eq("exam_code", CODE));

  const answers = {
    [byPos[1].id]: 0,                 // correct
    [byPos[2].id]: "Care.",           // correct after normalisation
    [byPos[3].id]: [0],               // half of [0,2] -> partial credit
    [byPos[4].id]: "An essay answer.",// manual
  };
  await allowed("student saves answers",
    stu.from("sessions").update({ answers, answered: 4, total: 4 }).eq("id", sid));

  const idem = await allowed("start_exam is idempotent (no second attempt)", stu.rpc("start_exam", { p_code: CODE }));
  check("start_exam returned the same session", idem === sid);

  // ------------------------------------------------------------- the attacks
  log("--- attacks as an ordinary signed-in student ---");
  await denied("read the answer key by join",
    stu.from("answer_keys").select("key,questions(prompt)").eq("exam_code", CODE));
  await denied("read another student's session",
    other.from("sessions").select("*").eq("id", sid));
  await denied("write another student's answers",
    other.from("sessions").update({ answers: { x: 1 } }).eq("id", sid));
  await denied("grant myself extra time",
    stu.from("sessions").update({ extra_minutes: 600 }).eq("id", sid));
  await denied("lower my violation count",
    stu.from("sessions").update({ violations: -5 }).eq("id", sid));
  await denied("clear the professor's flag/note",
    stu.from("sessions").update({ flagged: false, note: "" }).eq("id", sid));
  await denied("restart my clock",
    stu.from("sessions").update({ started_at: new Date().toISOString() }).eq("id", sid));
  await denied("promote myself to professor",
    stu.from("profiles").update({ role: "professor" }).eq("id", stu1U.id));
  await denied("promote myself through the RPC",
    stu.rpc("set_role_by_email", { p_email: STU1, p_role: "professor" }));
  await denied("write my own grade",
    stu.from("grades").insert({ session_id: sid, exam_code: CODE, student_id: stu1U.id, score: 99, max_score: 99, percent: 100, graded_by: stu1U.id }));
  await denied("call the grader myself", stu.rpc("grade_session", { p_session: sid }));
  await denied("call grade_exam myself", stu.rpc("grade_exam", { p_code: CODE }));
  await denied("edit the professor's exam",
    stu.from("exams").update({ closes_at: new Date(Date.now() + 9e9).toISOString() }).eq("code", CODE));
  await denied("delete the exam", stu.from("exams").delete().eq("code", CODE));
  await denied("edit a question", stu.from("questions").update({ prompt: "hacked" }).eq("exam_code", CODE));
  await denied("claim professor with a wrong bootstrap code", stu.rpc("claim_professor", { p_secret: "NOPE-NOPE-NOPE" }));
  await denied("list every session in the table", other.from("sessions").select("id").neq("id", sid));
  await denied("start someone else's exam as them",
    other.from("sessions").insert({ exam_code: CODE, student_id: stu1U.id }));

  // ------------------------------------------------------------ submit+grade
  log("--- submit and grade ---");
  await allowed("student submits", stu.from("sessions").update({ status: "submitted" }).eq("id", sid));
  await denied("student edits answers after submitting",
    stu.from("sessions").update({ answers: { cheat: 1 } }).eq("id", sid));
  await denied("student reopens a submitted attempt",
    stu.from("sessions").update({ status: "in_progress" }).eq("id", sid));

  const n = await allowed("professor grades the exam", prof.rpc("grade_exam", { p_code: CODE, p_regrade: false }));
  check("one submission graded", n === 1, `got ${n}`);

  const [g] = await allowed("professor reads the grade", prof.from("grades").select("*").eq("session_id", sid));
  // mc 1 + text 2 + multi partial 1 (one of two correct picks) + essay 0 = 4 of 9
  check("auto-grade totalled correctly", Number(g.score) === 4 && Number(g.max_score) === 9,
    `got ${g?.score}/${g?.max_score}`);
  check("essay is queued for manual grading", g.needs_manual === 1, `got ${g.needs_manual}`);
  const pq = g.per_question;
  check("mc marked correct", pq[byPos[1].id].verdict === "correct");
  check("text normalisation matched 'Care.' to 'care'", pq[byPos[2].id].verdict === "correct");
  check("multi got partial credit", pq[byPos[3].id].verdict === "partial", pq[byPos[3].id].verdict);
  check("essay marked manual", pq[byPos[4].id].verdict === "manual");

  await denied("student cannot see the grade before release",
    stu.from("grades").select("score").eq("session_id", sid));

  const g2 = await allowed("professor awards essay points",
    prof.rpc("set_override", { p_session: sid, p_question: byPos[4].id, p_earned: 3, p_comment: "Good." }));
  check("override raised the score to 7", Number(g2.score) === 7, `got ${g2?.score}`);
  check("nothing left to grade by hand", g2.needs_manual === 0, `got ${g2.needs_manual}`);

  await allowed("professor releases scores", prof.from("exams").update({ scores_released: true }).eq("code", CODE));
  const [mine] = await allowed("student now sees their own grade", stu.from("grades").select("*").eq("session_id", sid));
  check("released score is visible to the student", Number(mine?.score) === 7, `got ${mine?.score}`);
  await denied("student still cannot see another student's grade",
    other.from("grades").select("*").eq("session_id", sid));

  // ------------------------------------------------------- professor powers
  log("--- professor controls ---");
  await allowed("professor flags and annotates", prof.from("sessions").update({ flagged: true, note: "looked away" }).eq("id", sid));
  await denied("professor cannot rewrite a student's answers",
    prof.from("sessions").update({ answers: { tampered: 1 } }).eq("id", sid));
  await allowed("professor grants extra time", prof.from("sessions").update({ extra_minutes: 15 }).eq("id", sid));

  // ------------------------------------------------------- the server clock
  log("--- server-side deadline ---");
  if (admin) {
    await admin.from("sessions").update({
      status: "in_progress", submitted_at: null,
      started_at: new Date(Date.now() - 120 * 60_000).toISOString(),  // 2h ago; 30m exam +15m
    }).eq("id", sid);
    await denied("saving long after the deadline is refused",
      stu.from("sessions").update({ answers: { late: 1 } }).eq("id", sid));
    await denied("submitting long after the deadline is refused",
      stu.from("sessions").update({ status: "submitted" }).eq("id", sid));
  } else {
    log("SKIP deadline test (needs the service key to backdate a start time)");
    await admin_free_reopen(prof, sid);
  }

  const events = await allowed("student appends a proctoring event",
    stu.from("session_events").insert({ session_id: sid, type: "tab_hidden", detail: { ms: 1200 } }).select());
  await denied("events cannot be edited", stu.from("session_events").update({ type: "clean" }).eq("session_id", sid));
  await denied("events cannot be deleted by the student", stu.from("session_events").delete().eq("session_id", sid));
  await allowed("professor reads the event log", prof.from("session_events").select("*").eq("session_id", sid));
  await denied("another student cannot read the event log", other.from("session_events").select("*").eq("session_id", sid));
} catch (e) {
  fail++;
  log("ERROR", e.message, e.stack?.split("\n")[1] || "");
} finally {
  try {
    const cleaner = admin || await signIn(PROF);
    await cleaner.from("exams").delete().eq("code", CODE);
  } catch {}
  if (admin) for (const id of created) { try { await admin.auth.admin.deleteUser(id); } catch {} }
  log("cleaned up test data");
}

/** Reopen the attempt through the professor so later steps still exercise. */
async function admin_free_reopen(prof, sid) {
  await prof.from("sessions").update({ status: "in_progress" }).eq("id", sid);
}

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
