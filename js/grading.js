// Grading + risk scoring. Pure functions (no Firebase) so they run in the
// professor's browser AND in unit tests.

/** Normalise free-text answers for comparison. */
export function normalizeText(s, { caseSensitive = false } = {}) {
  let t = String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    // strip surrounding punctuation ("liability." -> "liability")
    .replace(/^[\s.,;:!?"'()[\]{}]+|[\s.,;:!?"'()[\]{}]+$/g, "");
  if (!caseSensitive) t = t.toLowerCase();
  return t;
}

/**
 * @returns {{earned:number,max:number,correct:boolean|null}}  correct===null => needs manual grading
 */
export function gradeAnswer(q, key, ans) {
  const max = Number(q.points) || 1;
  const none = { earned: 0, max, correct: false };
  if (q.type === "essay") {
    return { earned: 0, max, correct: null };
  }
  if (ans == null || ans === "" || (Array.isArray(ans) && ans.length === 0)) return none;
  if (!key) return { earned: 0, max, correct: null };

  switch (q.type) {
    case "mc": {
      const ok = Number(ans) === Number(key.correct);
      return { earned: ok ? max : 0, max, correct: ok };
    }
    case "tf": {
      const a = typeof ans === "string" ? ans === "true" : !!ans;
      const ok = a === !!key.correct;
      return { earned: ok ? max : 0, max, correct: ok };
    }
    case "multi": {
      const chosen = new Set((Array.isArray(ans) ? ans : [ans]).map(Number));
      const correct = new Set((key.correct || []).map(Number));
      if (key.partialCredit) {
        // +1 per correct pick, -1 per wrong pick, floored at 0
        let hits = 0, misses = 0;
        for (const c of chosen) (correct.has(c) ? hits++ : misses++);
        const frac = Math.max(0, (hits - misses) / Math.max(1, correct.size));
        const earned = Math.round(frac * max * 100) / 100;
        return { earned, max, correct: earned === max ? true : earned > 0 ? "partial" : false };
      }
      const ok = chosen.size === correct.size && [...chosen].every((c) => correct.has(c));
      return { earned: ok ? max : 0, max, correct: ok };
    }
    case "text": {
      const opts = { caseSensitive: !!key.caseSensitive };
      const given = normalizeText(ans, opts);
      const ok = (key.accepted || []).some((a) => normalizeText(a, opts) === given && given !== "");
      return { earned: ok ? max : 0, max, correct: ok };
    }
  }
  return { earned: 0, max, correct: null };
}

/**
 * Grade a whole session.
 * @param paper     buildPaper() output for this session
 * @param key       answerKey.answers  {qid: {...}}
 * @param answers   session.answers    {qid: value}
 * @param overrides optional manual overrides {qid: {earned, comment}}
 */
export function gradeSession(paper, key, answers, overrides = {}) {
  const perQuestion = {};
  let score = 0, max = 0, needsManual = 0;
  for (const q of paper) {
    const auto = gradeAnswer(q, key?.[q.id], answers?.[q.id]);
    const ov = overrides[q.id];
    const row = {
      qid: q.id, type: q.type, max: auto.max,
      earned: ov && ov.earned != null ? Number(ov.earned) : auto.earned,
      correct: auto.correct,
      manual: !!(ov && ov.earned != null),
      answer: answers?.[q.id] ?? null,
    };
    if (ov?.comment) row.comment = ov.comment;
    if (row.correct === null && !row.manual) needsManual++;
    perQuestion[q.id] = row;
    score += row.earned; max += row.max;
  }
  score = Math.round(score * 100) / 100;
  return { score, max, percent: max ? Math.round((score / max) * 1000) / 10 : 0, perQuestion, needsManual };
}

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
 * @param session   session doc data
 * @param events    array of event docs [{type, at, detail}]
 * @param settings  exam.settings
 */
export function riskScore(session, events = [], settings = {}) {
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

  // Suspiciously fast completion
  const start = tsMs(session.startedAt), end = tsMs(session.submittedAt);
  const dur = Number(settings.durationMinutes) || 0;
  if (end > start && dur) {
    const usedFrac = (end - start) / (dur * 60_000);
    const total = session.progress?.total || 0, answered = session.progress?.answered || 0;
    if (usedFrac < 0.15 && total >= 10 && answered / total > 0.8) { score += 6; reasons.push(`finished in ${Math.round(usedFrac * 100)}% of allotted time`); }
  }
  if (session.violations >= (settings.maxViolations || 5)) { score += 4; reasons.push("hit violation limit"); }

  score = Math.round(score * 10) / 10;
  const level = score >= 15 ? "high" : score >= 5 ? "medium" : "low";
  return { score, level, reasons, counts };
}

function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number") return ts;
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
