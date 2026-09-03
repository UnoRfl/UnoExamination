// One file in, a whole exam out.
//
// Building a 60-question exam by clicking "+ Multiple choice" sixty times is
// nobody's idea of a good evening. This module reads a complete exam — title,
// settings and every question with its answer key — from one of three shapes:
//
//   1. our JSON bundle (round-trips exactly, and is the documented format)
//   2. an Excel / CSV question sheet (one row per question, which is how most
//      professors already have their question bank)
//   3. the older shapes we have always accepted: {questions, answers}, a bare
//      array, or the baseQuizData array from the original single-file quiz
//
// and writes shapes 1 and 2 back out, so an exam can be edited in Excel and
// re-imported.
import { QUESTION_TYPES, validateQuestion, validateKey } from "./paper.js";
import { importQuestions } from "./grading.js";
import { S } from "./xlsx.js";

/** The kinds of assessment an exam can be. Matches the database constraint. */
export const EXAM_TYPES = {
  quiz: "Quiz",
  long_test: "Long test",
  prelim: "Prelim examination",
  midterm: "Midterm examination",
  semi_final: "Semi-final examination",
  final: "Final examination",
  practice: "Practice / review",
  other: "Other",
};

/** Settings a bundle may carry. Anything else in the file is ignored. */
export const BUNDLE_SETTINGS = {
  title: "", course: "", instructions: "", exam_type: "quiz", passing_percent: 60,
  duration_minutes: 60, max_violations: 5, violation_action: "lock",
  require_fullscreen: true, block_clipboard: true,
  shuffle_questions: true, shuffle_options: true, one_at_a_time: false,
  require_student_id: true, show_correct_answers: false,
  questions_per_student: 0, allowed_domain: "", roster: [],
};

const BOOLS = new Set(Object.keys(BUNDLE_SETTINGS).filter((k) => typeof BUNDLE_SETTINGS[k] === "boolean"));
const NUMS = new Set(["duration_minutes", "max_violations", "questions_per_student", "passing_percent"]);

const truthy = (v) => {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return ["true", "yes", "y", "1", "on", "t"].includes(s);
};

// --------------------------------------------------------------- writing out
/** The answer key, flattened onto the question — far easier to hand-write. */
function keyFields(q) {
  const k = q.key || {};
  if (q.type === "mc") return { correct: Number(k.correct ?? 0) };
  if (q.type === "multi") return { correct: (k.correct || []).map(Number), partialCredit: !!k.partialCredit };
  if (q.type === "tf") return { correct: k.correct === true };
  if (q.type === "text") return { accepted: k.accepted || [], caseSensitive: !!k.caseSensitive };
  return {};
}

/** The exam as a JSON bundle: everything needed to recreate it elsewhere. */
export function toBundle(exam, questions) {
  const settings = {};
  for (const k of Object.keys(BUNDLE_SETTINGS)) if (exam[k] !== undefined) settings[k] = exam[k];
  return {
    format: "unoexamination.exam",
    version: 1,
    exported_at: new Date().toISOString(),
    exam: settings,
    questions: questions.map((q, i) => ({
      id: q.id?.startsWith("new_") ? `q${i + 1}` : (q.id || `q${i + 1}`),
      type: q.type,
      prompt: q.prompt || "",
      points: Number(q.points) || 1,
      ...(q.type === "mc" || q.type === "multi" ? { options: (q.options || []).map(String) } : {}),
      ...keyFields(q),
    })),
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Longest option list in the paper, so the sheet has just enough columns. */
const widestOptions = (questions) =>
  Math.max(2, ...questions.map((q) => (q.options || []).length), 4);

/**
 * The same exam as a question sheet: one row each, options in their own
 * columns, the key in a single "Correct" column. This is the format the
 * importer reads back, so an exam can round-trip through Excel.
 */
export function toQuestionSheet(exam, questions) {
  const n = widestOptions(questions);
  const head = ["Type", "Points", "Question",
    ...Array.from({ length: n }, (_, i) => `Option ${LETTERS[i]}`),
    "Correct", "Case sensitive", "Partial credit"];

  const rows = [head];
  for (const q of questions) {
    const k = q.key || {};
    let correct = "";
    if (q.type === "mc") correct = LETTERS[Number(k.correct)] ?? "";
    else if (q.type === "multi") correct = (k.correct || []).map((i) => LETTERS[Number(i)]).join(", ");
    else if (q.type === "tf") correct = k.correct === true ? "TRUE" : "FALSE";
    else if (q.type === "text") correct = (k.accepted || []).join(" | ");

    rows.push([
      q.type, Number(q.points) || 1, { v: q.prompt || "", s: S.WRAP },
      ...Array.from({ length: n }, (_, i) => ({ v: (q.options || [])[i] ?? "", s: S.WRAP })),
      correct,
      q.type === "text" ? (k.caseSensitive ? "TRUE" : "FALSE") : "",
      q.type === "multi" ? (k.partialCredit ? "TRUE" : "FALSE") : "",
    ]);
  }

  const settingRows = [["Setting", "Value", "Notes"]];
  for (const [k, dflt] of Object.entries(BUNDLE_SETTINGS)) {
    const v = exam?.[k] ?? dflt;
    settingRows.push([k, Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v,
      { v: SETTING_NOTES[k] || "", s: S.MUTED }]);
  }

  return [
    { name: "Questions", rows, filter: true,
      cols: [10, 8, 60, ...Array.from({ length: n }, () => 26), 16, 14, 14] },
    { name: "Settings", rows: settingRows, cols: [24, 30, 52] },
    HOW_TO_SHEET,
  ];
}

const SETTING_NOTES = {
  title: "Shown to students. Required.",
  exam_type: "quiz, long_test, prelim, midterm, semi_final, final, practice or other.",
  passing_percent: "The pass mark, used by the score-per-section report.",
  course: "Optional subject line.",
  instructions: "Shown before the exam starts.",
  duration_minutes: "Counted from each student's own start.",
  max_violations: "Tab switches, fullscreen exits, paste attempts.",
  violation_action: "lock, submit or warn.",
  require_fullscreen: "TRUE or FALSE.",
  block_clipboard: "TRUE or FALSE.",
  shuffle_questions: "TRUE or FALSE.",
  shuffle_options: "TRUE or FALSE.",
  one_at_a_time: "TRUE or FALSE.",
  require_student_id: "TRUE or FALSE.",
  show_correct_answers: "Only after you release the scores.",
  questions_per_student: "0 = everyone gets every question.",
  allowed_domain: "e.g. school.edu. Blank = any signed-in account.",
  roster: "Comma-separated e-mails. Blank = anyone with the code.",
};

/** A short instruction sheet, so the template explains itself. */
const HOW_TO_SHEET = {
  name: "How to fill this in",
  headerRows: 0,
  cols: [18, 96],
  rows: [
    [{ v: "Filling in the Questions sheet", s: S.TITLE }],
    [],
    [{ v: "Type", s: S.BOLD }, "One of: mc, multi, tf, text, essay"],
    [{ v: "", s: S.MUTED }, { v: "mc = one correct option · multi = several · tf = true/false · text = short answer · essay = graded by hand", s: S.MUTED }],
    [{ v: "Points", s: S.BOLD }, "A number. Leave blank for 1."],
    [{ v: "Question", s: S.BOLD }, "The question text students see."],
    [{ v: "Option A…", s: S.BOLD }, "Fill only as many as the question needs. Used by mc and multi."],
    [{ v: "Correct", s: S.BOLD }, "mc: a single letter, e.g. B (a number like 2 also works)"],
    ["", "multi: letters separated by commas, e.g. A, C"],
    ["", "tf: TRUE or FALSE"],
    ["", "text: every accepted answer, separated by | — e.g.  firewall | packet filter"],
    ["", "essay: leave blank"],
    [{ v: "Case sensitive", s: S.BOLD }, "text only. TRUE to require exact capitalisation. Default FALSE."],
    [{ v: "Partial credit", s: S.BOLD }, "multi only. TRUE to award part marks for a partly-right answer."],
    [],
    [{ v: "Notes", s: S.TITLE }],
    [],
    ["", "Add as many option columns as you need — name them Option A, Option B, and so on."],
    ["", "You can delete the Settings sheet; the exam keeps whatever it is already set to."],
    ["", "Rows that are completely blank are skipped, so spacing rows are fine."],
    ["", "Matching for short answers ignores capitalisation, extra spaces and trailing punctuation."],
    ["", "Import this file from the professor dashboard: My exams → Import exam, or Import inside an exam."],
  ],
};

/** A blank workbook a professor can fill in and import. */
export function templateSheets() {
  const rows = [
    ["Type", "Points", "Question", "Option A", "Option B", "Option C", "Option D",
      "Correct", "Case sensitive", "Partial credit"],
    ["mc", 1, "Which control most directly limits the damage of a stolen password?",
      "Password rotation", "Multi-factor authentication", "Longer passwords", "Account lockout", "B", "", ""],
    ["multi", 2, "Which of these are administrative controls? (choose all that apply)",
      "Security policy", "Firewall rule", "Staff training", "Door lock", "A, C", "", "TRUE"],
    ["tf", 1, "Encryption at rest protects data if a disk is physically stolen.",
      "", "", "", "", "TRUE", "", ""],
    ["text", 1, "Name the security principle of giving a user only the access they need.",
      "", "", "", "", "least privilege | principle of least privilege | POLP", "FALSE", ""],
    ["essay", 10, "Explain defence in depth and give two examples from your own device.",
      "", "", "", "", "", "", ""],
  ];
  const settingRows = [["Setting", "Value", "Notes"]];
  for (const [k, v] of Object.entries(BUNDLE_SETTINGS)) {
    settingRows.push([k, Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v,
      { v: SETTING_NOTES[k] || "", s: S.MUTED }]);
  }
  settingRows[1][1] = "My exam title";
  return [
    { name: "Questions", rows, filter: true, cols: [10, 8, 60, 26, 26, 26, 26, 22, 14, 14] },
    { name: "Settings", rows: settingRows, cols: [24, 30, 52] },
    HOW_TO_SHEET,
  ];
}

// ---------------------------------------------------------------- reading in
/** "B" → 1, "2" → 1, "b" → 1. Returns -1 when it cannot tell. */
function optionIndex(token) {
  const t = String(token ?? "").trim();
  if (!t) return -1;
  if (/^[A-Za-z]$/.test(t)) return t.toUpperCase().charCodeAt(0) - 65;
  const n = Number(t);
  return Number.isFinite(n) && n >= 1 ? n - 1 : -1;
}

const normType = (t) => {
  const s = String(t ?? "").trim().toLowerCase();
  const map = {
    mc: "mc", "multiple choice": "mc", choice: "mc", radio: "mc", single: "mc",
    multi: "multi", "multiple select": "multi", checkbox: "multi", "multiple answer": "multi",
    tf: "tf", "true/false": "tf", "true / false": "tf", truefalse: "tf", boolean: "tf",
    text: "text", short: "text", "short answer": "text", identification: "text", fill: "text",
    essay: "essay", long: "essay", manual: "essay", paragraph: "essay",
  };
  return map[s] || (QUESTION_TYPES[s] ? s : null);
};

/**
 * Reads a question sheet: `rows[0]` are headers, one question per row after.
 * Header order does not matter and unknown columns are ignored, because a real
 * question bank always has a stray column or two.
 */
export function questionsFromTable(rows) {
  const table = (rows || []).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (table.length < 2) throw new Error("That sheet has a header row but no questions under it.");

  const head = table[0].map((c) => String(c ?? "").trim().toLowerCase());
  const find = (...names) => head.findIndex((h) => names.includes(h));
  const col = {
    type: find("type", "question type", "kind"),
    points: find("points", "point", "score", "marks", "mark"),
    prompt: find("question", "prompt", "question text", "item", "text"),
    correct: find("correct", "answer", "correct answer", "key", "answers", "accepted"),
    caseSensitive: find("case sensitive", "case-sensitive", "casesensitive"),
    partial: find("partial credit", "partial", "partialcredit"),
  };
  const optCols = head
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => /^(option|choice)\b/.test(h) || /^[a-e]$/.test(h))
    .map(({ i }) => i);

  if (col.prompt < 0) {
    throw new Error('No "Question" column found. The first row must be headers — ' +
      "Type, Points, Question, Option A…, Correct. Download the template to see the shape.");
  }

  const questions = [], warnings = [];
  table.slice(1).forEach((row, n) => {
    const at = `Row ${n + 2}`;
    const cell = (i) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    const prompt = cell(col.prompt);
    if (!prompt) return;                       // a spacer row, not a question

    const options = optCols.map((i) => String(row[i] ?? "").trim()).filter(Boolean);
    let type = normType(cell(col.type));
    if (!type) {
      // Guess from the shape rather than refusing the whole file.
      const c = cell(col.correct);
      type = options.length >= 2 ? (c.includes(",") ? "multi" : "mc")
        : /^(true|false)$/i.test(c) ? "tf" : c ? "text" : "essay";
      if (cell(col.type)) warnings.push(`${at}: "${cell(col.type)}" is not a known type — read as ${type}.`);
    }

    const id = `q${String(questions.length + 1).padStart(3, "0")}`;
    const points = Number(cell(col.points)) || 1;
    const q = { id, type, prompt, points: points > 0 ? points : 1, key: {} };
    const raw = cell(col.correct);

    if (type === "mc" || type === "multi") {
      q.options = options.length >= 2 ? options : ["", ""];
      if (options.length < 2) warnings.push(`${at}: needs at least two options.`);
      const picks = raw.split(/[,;/]+/).map(optionIndex).filter((i) => i >= 0 && i < q.options.length);
      if (!picks.length) warnings.push(`${at}: could not read the correct answer "${raw}".`);
      if (type === "mc") q.key = { correct: picks[0] ?? 0 };
      else q.key = { correct: [...new Set(picks)].sort((a, b) => a - b), partialCredit: truthy(cell(col.partial)) };
    } else if (type === "tf") {
      if (!/^(true|false|t|f|yes|no|1|0)$/i.test(raw)) warnings.push(`${at}: expected TRUE or FALSE, got "${raw}".`);
      q.key = { correct: truthy(raw) };
    } else if (type === "text") {
      const accepted = raw.split(/\s*(?:\||;|\/\/)\s*/).map((s) => s.trim()).filter(Boolean);
      if (!accepted.length) warnings.push(`${at}: no accepted answers — separate several with |.`);
      q.key = { accepted, caseSensitive: truthy(cell(col.caseSensitive)) };
    }
    questions.push(q);
  });

  if (!questions.length) throw new Error("No questions found — every row was missing its question text.");
  return { questions, warnings };
}

/** Reads the Settings sheet of a workbook, ignoring anything unrecognised. */
export function settingsFromTable(rows) {
  const out = {};
  for (const row of rows || []) {
    const k = String(row[0] ?? "").trim();
    if (!(k in BUNDLE_SETTINGS) || row[1] === undefined || row[1] === "") continue;
    const v = row[1];
    if (BOOLS.has(k)) out[k] = truthy(v);
    else if (k === "exam_type") {
      const t = String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (t in EXAM_TYPES) out[k] = t;
    } else if (NUMS.has(k)) { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (k === "roster") out[k] = String(v).split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    else out[k] = String(v);
  }
  return out;
}

/**
 * Reads a JSON bundle, or anything the old importer accepted.
 * @returns {{exam:object, questions:object[], warnings:string[]}}
 */
export function fromBundleJson(text) {
  const { questions: qs, answers, exam } = parseJsonish(text);
  const warnings = [];
  const questions = qs.map((q, i) => {
    const id = `q${String(i + 1).padStart(3, "0")}`;
    const type = normType(q.type) || "text";
    const out = { id, type, prompt: String(q.prompt ?? q.q ?? q.question ?? ""), points: Number(q.points) || 1, key: {} };
    if (type === "mc" || type === "multi") out.options = (q.options || q.choices || []).map(String);

    // The key may be inline on the question (the documented bundle) or in a
    // separate answers map (our older export).
    const k = answers[q.id] ?? answers[id] ?? {};
    if (type === "mc") out.key = { correct: Number(k.correct ?? q.correct ?? q.answer ?? 0) };
    else if (type === "multi") out.key = {
      correct: (k.correct ?? q.correct ?? []).map(Number).filter((n) => Number.isFinite(n)),
      partialCredit: !!(k.partialCredit ?? q.partialCredit),
    };
    else if (type === "tf") {
      const raw = k.correct ?? q.correct ?? q.answer;
      out.key = { correct: typeof raw === "boolean" ? raw : truthy(raw) };
    } else if (type === "text") out.key = {
      accepted: (k.accepted ?? q.accepted ?? q.a ?? q.answers ?? []).map(String).filter(Boolean),
      caseSensitive: !!(k.caseSensitive ?? q.caseSensitive),
    };
    if (!out.prompt) warnings.push(`Question ${i + 1} has no text.`);
    return out;
  });
  if (!questions.length) throw new Error("That file contains no questions.");
  return { exam: exam || {}, questions, warnings };
}

/** Pulls {exam, questions, answers} out of whichever JSON shape this is. */
function parseJsonish(text) {
  let data = text;
  if (typeof text === "string") {
    const t = text.trim();
    if (!t) throw new Error("Nothing to import — the file or box was empty.");
    try { data = JSON.parse(t); }
    catch { data = importQuestions(t); }        // legacy JS literal, arrays, etc.
  }
  // Our bundle
  if (data && Array.isArray(data.questions)) {
    const exam = {};
    const src = data.exam || data.settings || {};
    for (const k of Object.keys(BUNDLE_SETTINGS)) {
      if (src[k] === undefined) continue;
      if (BOOLS.has(k)) exam[k] = truthy(src[k]);
      else if (NUMS.has(k)) exam[k] = Number(src[k]) || BUNDLE_SETTINGS[k];
      else if (k === "roster") exam[k] = (Array.isArray(src[k]) ? src[k] : String(src[k]).split(/[\n,;]+/))
        .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      else if (k === "exam_type") {
        const t = String(src[k]).trim().toLowerCase().replace(/[\s-]+/g, "_");
        if (t in EXAM_TYPES) exam[k] = t;
      } else exam[k] = String(src[k]);
    }
    // A bare title at the top level is the common hand-written case.
    if (!exam.title && typeof data.title === "string") exam.title = data.title;
    return { questions: data.questions, answers: data.answers || {}, exam };
  }
  const legacy = importQuestions(data);
  return { questions: legacy.questions, answers: legacy.answers || {}, exam: {} };
}

/** Everything wrong with an imported paper, in the order a professor would fix it. */
export function bundleProblems(questions) {
  const errs = [];
  questions.forEach((q, i) => errs.push(...validateQuestion(q, i), ...validateKey(q, q.key, i)));
  return errs;
}

// ------------------------------------------------------------------ roster
/**
 * Reads a class list out of a sheet. Headers are honoured when present, and
 * guessed from the content when they are not — a registrar export rarely calls
 * its columns what we would.
 */
export function rosterFromTable(rows) {
  const table = (rows || []).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (!table.length) throw new Error("That sheet is empty.");

  const head = table[0].map((c) => String(c ?? "").trim().toLowerCase());
  const looksLikeHeader = head.some((h) => /mail|name|number|no\.?$|section|id/.test(h))
    && !head.some((h) => h.includes("@"));
  const find = (...names) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  let col = { email: -1, display_name: -1, student_no: -1, section: -1 };
  if (looksLikeHeader) {
    col = {
      email: find("email", "e-mail", "mail"),
      display_name: find("name", "student name", "full name"),
      student_no: find("student no", "student number", "student id", "id no", "number"),
      section: find("section", "class", "block"),
    };
    // "Student name" would otherwise win the e-mail search on "mail"; make sure
    // the two never point at the same column.
    if (col.display_name === col.email) col.display_name = -1;
  }
  const body = looksLikeHeader ? table.slice(1) : table;

  // No usable header: find the column that actually holds addresses.
  if (col.email < 0) {
    const width = Math.max(...body.map((r) => r.length));
    for (let i = 0; i < width; i++) {
      if (body.some((r) => String(r[i] ?? "").includes("@"))) { col.email = i; break; }
    }
  }
  if (col.email < 0) throw new Error("No column of e-mail addresses was found.");

  const out = [];
  for (const r of body) {
    const cell = (i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
    const email = cell(col.email).toLowerCase();
    if (!email.includes("@")) continue;
    // Without headers, take the remaining columns in the order people write them.
    const rest = looksLikeHeader ? [] : r
      .map((c, i) => (i === col.email ? null : String(c ?? "").trim()))
      .filter((c) => c !== null && c !== "");
    out.push({
      email,
      display_name: cell(col.display_name) || rest[0] || "",
      student_no: cell(col.student_no) || rest[1] || "",
      section: cell(col.section) || rest[2] || "",
    });
  }
  return out;
}

/** The same, from text pasted into a box: one student per line. */
export function rosterFromText(text) {
  const rows = String(text || "").split(/\r?\n/)
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/\s*[,;\t|]\s*/));
  return rosterFromTable(rows);
}
