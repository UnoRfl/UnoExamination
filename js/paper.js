// Deterministic per-student "paper" construction.
//
// Both the student's browser and the professor's browser call buildPaper()
// with the same inputs (question list, exam settings, session id) and get the
// SAME question subset / order / option order. Nothing about the order is
// stored, so a student cannot pick their own subset or order.

export function hashString(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createPRNG(seed) {
  // mulberry32
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(array, prng) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const QUESTION_TYPES = {
  mc: "Multiple choice (one answer)",
  multi: "Multiple select (several answers)",
  tf: "True / False",
  text: "Short answer / identification",
  essay: "Essay (manually graded)",
};

/**
 * @param {Array}  questions  [{id,type,prompt,options?,points}]  (no answers)
 * @param {Object} settings   exam.settings
 * @param {string} sid        session id "<CODE>_<uid>"
 * @returns {Array} ordered questions; option entries are {oi, text} where oi is
 *                  the ORIGINAL option index (what gets stored as the answer).
 */
export function buildPaper(questions, settings, sid) {
  const sorted = questions.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const prng = createPRNG(hashString(sid + "|" + sorted.length));

  let list = sorted;
  if (settings.shuffleQuestions) list = shuffle(list, prng);
  const n = Number(settings.questionsPerStudent) || 0;
  if (n > 0 && n < list.length) list = list.slice(0, n);

  return list.map((q) => {
    const copy = { ...q, points: Number(q.points) || 1 };
    if (Array.isArray(q.options)) {
      let opts = q.options.map((text, oi) => ({ oi, text }));
      if (settings.shuffleOptions) opts = shuffle(opts, prng);
      copy.options = opts;
    }
    return copy;
  });
}

export function paperMaxPoints(paper) {
  return paper.reduce((s, q) => s + (Number(q.points) || 1), 0);
}

/** Validate a question object coming from the editor / an import. Returns [] if ok. */
export function validateQuestion(q, i) {
  const errs = [];
  const label = `Q${i + 1}`;
  if (!q.id) errs.push(`${label}: missing id`);
  if (!QUESTION_TYPES[q.type]) errs.push(`${label}: unknown type "${q.type}"`);
  if (!q.prompt || !String(q.prompt).trim()) errs.push(`${label}: empty prompt`);
  if ((q.type === "mc" || q.type === "multi")) {
    if (!Array.isArray(q.options) || q.options.length < 2) errs.push(`${label}: needs at least 2 options`);
    else if (q.options.some((o) => !String(o).trim())) errs.push(`${label}: has an empty option`);
  }
  if (q.points != null && (isNaN(Number(q.points)) || Number(q.points) <= 0)) errs.push(`${label}: points must be > 0`);
  return errs;
}

/** Validate the answer key entry for a question. */
export function validateKey(q, k, i) {
  const label = `Q${i + 1}`;
  if (q.type === "essay") return [];
  if (!k) return [`${label}: no answer key`];
  switch (q.type) {
    case "mc":
      if (!Number.isInteger(k.correct) || k.correct < 0 || k.correct >= q.options.length) return [`${label}: pick the correct option`];
      return [];
    case "multi":
      if (!Array.isArray(k.correct) || k.correct.length === 0) return [`${label}: pick at least one correct option`];
      return [];
    case "tf":
      if (typeof k.correct !== "boolean") return [`${label}: choose True or False`];
      return [];
    case "text":
      if (!Array.isArray(k.accepted) || k.accepted.filter((a) => String(a).trim()).length === 0) return [`${label}: add at least one accepted answer`];
      return [];
  }
  return [];
}
