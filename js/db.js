// ============================================================================
//  Every database call the app makes, in one place.
//  Nothing here can grant itself access: reads go through row level security
//  and privileged actions go through SECURITY DEFINER functions that check the
//  caller server-side. See docs/SECURITY.md.
// ============================================================================
import { sb, unwrap, asError } from "./supabase.js";

// ------------------------------------------------------------------ profile
export async function myProfile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw asError(error);
  // The signup trigger creates this row; if replication is a beat behind, wait once.
  if (!data) {
    await new Promise((r) => setTimeout(r, 600));
    return unwrap(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  }
  return data;
}

export const updateMyProfile = (fields) =>
  sb.auth.getUser().then(({ data: { user } }) =>
    unwrap(sb.from("profiles").update(fields).eq("id", user.id).select().single()));

export const claimProfessor = (secret) =>
  sb.rpc("claim_professor", { p_secret: secret }).then(unwrap);

export const setRoleByEmail = (email, role) =>
  sb.rpc("set_role_by_email", { p_email: email, p_role: role }).then(unwrap);

export const listProfessors = () =>
  sb.from("profiles").select("id,email,display_name,role").eq("role", "professor")
    .order("email").then(unwrap);

// -------------------------------------------------------------------- exams
export const myExams = () =>
  sb.from("exams").select("*").order("updated_at", { ascending: false }).then(unwrap);

export const getExam = (code) =>
  sb.from("exams").select("*").eq("code", code).maybeSingle().then(unwrap);

/** What a student may see before starting. Returns null if not visible. */
export const examIntro = (code) =>
  sb.rpc("exam_intro", { p_code: code }).then(unwrap);

export const saveExam = (row) =>
  sb.from("exams").upsert(row).select().single().then(unwrap);

export const deleteExam = (code) =>
  sb.from("exams").delete().eq("code", code).then(unwrap);

// ---------------------------------------------------------------- questions
export const examQuestions = (code) =>
  sb.from("questions").select("*").eq("exam_code", code).order("position").then(unwrap);

/** Owner-only: questions WITH their answer keys, for the editor. */
export async function examQuestionsWithKeys(code) {
  const [qs, keys] = await Promise.all([
    examQuestions(code),
    sb.from("answer_keys").select("question_id,key").eq("exam_code", code).then(unwrap),
  ]);
  const byId = Object.fromEntries(keys.map((k) => [k.question_id, k.key]));
  return qs.map((q) => ({ ...q, key: byId[q.id] || {} }));
}

/** Replace the whole question set for an exam, keys included. */
export async function replaceQuestions(code, questions) {
  await sb.from("questions").delete().eq("exam_code", code).then(unwrap);
  if (!questions.length) return [];
  const rows = questions.map((q, i) => ({
    exam_code: code, position: i + 1, type: q.type,
    prompt: q.prompt, options: q.options || [], points: Number(q.points) || 1,
  }));
  const saved = unwrap(await sb.from("questions").insert(rows).select("id,position"));
  const keys = saved.map((s) => ({
    question_id: s.id, exam_code: code,
    key: questions[s.position - 1].key || {},
  }));
  await sb.from("answer_keys").upsert(keys).then(unwrap);
  return saved;
}

// ----------------------------------------------------------------- sessions
export const startExam = (code, name, studentNo, section) =>
  sb.rpc("start_exam", {
    p_code: code, p_name: name || null,
    p_student_no: studentNo || null, p_section: section || null,
  }).then(unwrap);

export const getPaper = (sessionId) =>
  sb.rpc("get_paper", { p_session: sessionId }).then(unwrap);

export const mySession = (code) =>
  sb.auth.getUser().then(({ data: { user } }) =>
    sb.from("sessions").select("*").eq("exam_code", code).eq("student_id", user.id)
      .maybeSingle().then(unwrap));

export const getSession = (id) =>
  sb.from("sessions").select("*").eq("id", id).maybeSingle().then(unwrap);

export const mySessions = () =>
  sb.auth.getUser().then(({ data: { user } }) =>
    sb.from("sessions").select("*").eq("student_id", user.id)
      .order("started_at", { ascending: false }).then(unwrap));

export const examSessions = (code) =>
  sb.from("sessions").select("*").eq("exam_code", code).order("display_name").then(unwrap);

/** Student autosave. The server rewrites the timestamps and rejects late writes. */
export const saveAnswers = (id, answers, answered, total) =>
  sb.from("sessions").update({ answers, answered, total }).eq("id", id).then(unwrap);

export const heartbeat = (id, clientId) =>
  sb.from("sessions").update({ client_id: clientId }).eq("id", id).then(unwrap);

export const bumpViolations = (id, to) =>
  sb.from("sessions").update({ violations: to }).eq("id", id).then(unwrap);

export const submitSession = (id, answers, answered, total) =>
  sb.from("sessions").update({ status: "submitted", answers, answered, total })
    .eq("id", id).then(unwrap);

export const lockSession = (id) =>
  sb.from("sessions").update({ status: "locked" }).eq("id", id).then(unwrap);

// professor controls
export const profUpdateSession = (id, patch) =>
  sb.from("sessions").update(patch).eq("id", id).then(unwrap);

export const resetSession = (id) =>
  sb.from("sessions").delete().eq("id", id).then(unwrap);

// ------------------------------------------------------------------- events
export const logEvent = (sessionId, type, detail, question) =>
  sb.from("session_events")
    .insert({ session_id: sessionId, type, detail: detail || {}, question: question || null })
    .then(({ error }) => { if (error) console.warn("event not logged", type, error.message); });

export const sessionEvents = (sessionId) =>
  sb.from("session_events").select("*").eq("session_id", sessionId)
    .order("at").then(unwrap);

// ------------------------------------------------------------------- grades
export const gradeExam = (code, regrade = false) =>
  sb.rpc("grade_exam", { p_code: code, p_regrade: regrade }).then(unwrap);

export const gradeSession = (id) =>
  sb.rpc("grade_session", { p_session: id }).then(unwrap);

export const setOverride = (sessionId, questionId, earned, comment) =>
  sb.rpc("set_override", {
    p_session: sessionId, p_question: questionId,
    p_earned: earned, p_comment: comment || "",
  }).then(unwrap);

export const setFeedback = (sessionId, feedback) =>
  sb.rpc("set_feedback", { p_session: sessionId, p_feedback: feedback }).then(unwrap);

export const examGrades = (code) =>
  sb.from("grades").select("*").eq("exam_code", code).then(unwrap);

export const myGrade = (sessionId) =>
  sb.from("grades").select("*").eq("session_id", sessionId).maybeSingle().then(unwrap);

export const myGrades = () =>
  sb.auth.getUser().then(({ data: { user } }) =>
    sb.from("grades").select("*").eq("student_id", user.id).then(unwrap));

export const releaseScores = (code, released) =>
  sb.from("exams").update({ scores_released: released }).eq("code", code).then(unwrap);

// ----------------------------------------------------------------- realtime
/**
 * Live monitor. Postgres changes stream over a websocket; RLS applies to the
 * stream too, so a professor only ever receives their own exam's rows.
 */
export function watchExamSessions(code, onChange) {
  const ch = sb.channel(`sessions:${code}`)
    .on("postgres_changes",
        { event: "*", schema: "public", table: "sessions", filter: `exam_code=eq.${code}` },
        (p) => onChange(p))
    .subscribe();
  return () => sb.removeChannel(ch);
}

export function watchSession(id, onChange) {
  const ch = sb.channel(`session:${id}`)
    .on("postgres_changes",
        { event: "*", schema: "public", table: "sessions", filter: `id=eq.${id}` },
        (p) => onChange(p))
    .subscribe();
  return () => sb.removeChannel(ch);
}

export function watchExamGrades(code, onChange) {
  const ch = sb.channel(`grades:${code}`)
    .on("postgres_changes",
        { event: "*", schema: "public", table: "grades", filter: `exam_code=eq.${code}` },
        (p) => onChange(p))
    .subscribe();
  return () => sb.removeChannel(ch);
}

/**
 * Difference between the server clock and this device, in ms. The countdown is
 * drawn from server time so changing the system clock does nothing. (The real
 * deadline is enforced on every write regardless — this is just the display.)
 */
export async function serverClockOffset() {
  try {
    const t0 = Date.now();
    const iso = await sb.rpc("server_now").then(unwrap);
    const t1 = Date.now();
    return new Date(iso).getTime() - (t0 + t1) / 2;
  } catch {
    return 0;
  }
}
