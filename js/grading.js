// Risk scoring and question import.
//
// Scoring itself lives in Postgres (private.score_one / public.grade_session)
// so the answer key never reaches a browser. What stays here is the proctoring
// risk model — advisory, and rendered on the professor's screen — plus the
// importer that turns an old quiz file into questions and keys.

/** Normalise free-text answers for comparison. */
/** Event types the student client emits, with weights for the risk score. */
export const EVENT_WEIGHTS = {
  tab_hidden: 3,
  window_blur: 2,
  fullscreen_exit: 3,
  devtools_suspected: 8,
  paste: 4,
  copy: 2,
  cut: 2,
  context_menu: 1,
  shortcut_blocked: 1,
  print_screen: 3,
  mouse_left: 0.5,
  multiple_tabs: 10,
  multiple_displays: 2,
  page_reload: 2,
  draft_recovered: 2,
  heartbeat_gap: 5,
  clock_skew: 1,
  resize: 0.5,
  window_small: 1,
  locked: 0,
  unlocked: 0,
  started: 0,
  resumed: 1,
  submitted: 0,
};

/** Events that count as a "strike" toward the violation limit. */
export const STRIKE_EVENTS = new Set([
  "tab_hidden", "window_blur", "fullscreen_exit", "devtools_suspected", "paste", "multiple_tabs", "print_screen",
]);

/**
 * @param session  a session row (Supabase snake_case, or the older camelCase)
 * @param events   [{type, at, detail}] in chronological order
 * @param exam     the exam row; only its duration and violation limit are used
 */
export function riskScore(session, events = [], exam = {}) {
  const settings = exam;
  const reasons = [];
  let score = 0;
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;

  for (const [type, n] of Object.entries(counts)) {
    const w = EVENT_WEIGHTS[type] ?? 1;
    if (!w) continue;
    // diminishing returns: first 5 full weight, rest half
    const contrib = w * Math.min(n, 5) + w * 0.5 * Math.max(0, n - 5);
    score += contrib;
    if (w >= 2) reasons.push(`${n}× ${type.replace(/_/g, " ")}`);
  }

  // Heartbeat gaps (student offline / suspended tab / blocked network)
  const hb = events.filter((e) => e.type === "heartbeat_gap").length;
  if (hb) reasons.push(`${hb} heartbeat gap(s)`);

  // Long time away (total hidden ms recorded in detail.ms)
  const awayMs = events.filter((e) => e.type === "tab_hidden" || e.type === "window_blur")
    .reduce((s, e) => s + (Number(e.detail?.ms) || 0), 0);
  if (awayMs > 60_000) { score += Math.min(15, awayMs / 60_000 * 3); reasons.push(`away ~${Math.round(awayMs / 1000)}s total`); }

  // Suspiciously fast completion. Accept either column style so the model
  // works against a Supabase row and against the shape the tests build.
  const start = tsMs(session.startedAt ?? session.started_at);
  const end   = tsMs(session.submittedAt ?? session.submitted_at);
  const dur   = Number(settings.duration_minutes ?? settings.durationMinutes) || 0;
  if (end > start && dur) {
    const usedFrac = (end - start) / (dur * 60_000);
    const total    = session.progress?.total    ?? session.total    ?? 0;
    const answered = session.progress?.answered ?? session.answered ?? 0;
    if (usedFrac < 0.15 && total >= 10 && answered / total > 0.8) { score += 6; reasons.push(`finished in ${Math.round(usedFrac * 100)}% of allotted time`); }
  }
  if (session.violations >= (settings.max_violations ?? settings.maxViolations ?? 5)) { score += 4; reasons.push("hit violation limit"); }

  score = Math.round(score * 10) / 10;
  const level = score >= 15 ? "high" : score >= 5 ? "medium" : "low";
  return { score, level, reasons, counts };
}

function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();  // legacy shape
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") { const d = Date.parse(ts); return isNaN(d) ? 0 : d; }
  return 0;
}

/** Convert the legacy single-file quiz format ([{type:"text",q,a:[...]}]) or our JSON into {questions, answers}. */
export function importQuestions(raw) {
  let data = raw;
  if (typeof raw === "string") {
    let txt = raw.trim();
    // Accept "const baseQuizData = [ ... ];" pasted straight from a JS file
    const m = txt.match(/\[[\s\S]*\]/);
    if (!txt.startsWith("[") && !txt.startsWith("{") && m) txt = m[0];
    try { data = JSON.parse(txt); }
    catch {
      // JS object literal (unquoted keys). Evaluate in a sandboxed Function - only
      // ever run on the PROFESSOR's own paste, never on student input.
      data = Function(`"use strict"; return (${txt});`)();
    }
  }
  if (data && Array.isArray(data.questions)) {
    const answers = data.answers || {};
    return { questions: data.questions, answers };
  }
  if (!Array.isArray(data)) throw new Error("Expected an array of questions");
  const questions = [], answers = {};
  data.forEach((item, i) => {
    const id = item.id || `q${String(i + 1).padStart(3, "0")}`;
    const type = legacyType(item);
    const q = { id, type, prompt: item.prompt ?? item.q ?? item.question ?? "", points: Number(item.points) || 1 };
    if (type === "mc" || type === "multi") q.options = (item.options || item.choices || []).map(String);
    questions.push(q);
    if (type === "text") answers[id] = { accepted: (item.accepted || item.a || item.answers || []).map(String), caseSensitive: !!item.caseSensitive };
    else if (type === "mc") answers[id] = { correct: Number(item.correct ?? item.answer ?? item.a) };
    else if (type === "multi") answers[id] = { correct: (item.correct || item.a || []).map(Number), partialCredit: !!item.partialCredit };
    else if (type === "tf") answers[id] = { correct: String(item.correct ?? item.a).toLowerCase() === "true" };
  });
  return { questions, answers };
}
function legacyType(item) {
  const t = String(item.type || "").toLowerCase();
  if (["mc", "multiple", "multiple-choice", "choice", "radio"].includes(t)) return "mc";
  if (["multi", "checkbox", "multiple-select"].includes(t)) return "multi";
  if (["tf", "truefalse", "true-false", "boolean"].includes(t)) return "tf";
  if (["essay", "long", "manual"].includes(t)) return "essay";
  if (["text", "short", "identification", "fill"].includes(t)) return "text";
  if (Array.isArray(item.options) || Array.isArray(item.choices)) return Array.isArray(item.correct) ? "multi" : "mc";
  return "text";
}
