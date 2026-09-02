// Question types and editor-side validation.
//
// NOTE: the per-student shuffle and subset selection used to live here. They
// now run inside Postgres (public.get_paper), so a student cannot reroll for an
// easier paper and the server and client can never disagree about it.

export const QUESTION_TYPES = {
  mc: "Multiple choice (one answer)",
  multi: "Multiple select (several answers)",
  tf: "True / False",
  text: "Short answer / identification",
  essay: "Essay (manually graded)",
};

export function paperMaxPoints(questions) {
  return Math.round(questions.reduce((s, q) => s + (Number(q.points) || 1), 0) * 100) / 100;
}

/** Returns [] when the question is complete enough to publish. */
export function validateQuestion(q, i) {
  const errs = [], label = `Q${i + 1}`;
  if (!QUESTION_TYPES[q.type]) errs.push(`${label}: unknown type "${q.type}"`);
  if (!q.prompt || !String(q.prompt).trim()) errs.push(`${label}: empty prompt`);
  if (q.type === "mc" || q.type === "multi") {
    if (!Array.isArray(q.options) || q.options.length < 2) errs.push(`${label}: needs at least 2 options`);
    else if (q.options.some((o) => !String(o).trim())) errs.push(`${label}: has an empty option`);
  }
  if (q.points != null && (isNaN(Number(q.points)) || Number(q.points) <= 0)) errs.push(`${label}: points must be > 0`);
  return errs;
}

/** Returns [] when the answer key for this question is usable. */
export function validateKey(q, k, i) {
  const label = `Q${i + 1}`;
  if (q.type === "essay") return [];
  if (!k) return [`${label}: no answer key`];
  switch (q.type) {
    case "mc":
      return Number.isInteger(Number(k.correct)) && Number(k.correct) >= 0 && Number(k.correct) < (q.options?.length ?? 0)
        ? [] : [`${label}: pick the correct option`];
    case "multi":
      return Array.isArray(k.correct) && k.correct.length ? [] : [`${label}: pick at least one correct option`];
    case "tf":
      return typeof k.correct === "boolean" ? [] : [`${label}: choose True or False`];
    case "text":
      return Array.isArray(k.accepted) && k.accepted.filter((a) => String(a).trim()).length
        ? [] : [`${label}: add at least one accepted answer`];
  }
  return [];
}
