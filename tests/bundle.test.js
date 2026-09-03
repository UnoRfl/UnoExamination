// Importing a whole exam from one file is the feature most likely to be used
// on a file we have never seen, so these tests are mostly about tolerance:
// odd column orders, missing types, letters vs numbers, stray blank rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toBundle, toQuestionSheet, templateSheets,
  questionsFromTable, settingsFromTable, fromBundleJson, bundleProblems,
} from "../js/bundle.js";
import { buildXlsx, readXlsx, readDelimited } from "../js/xlsx.js";
import fs from "node:fs";
import path from "node:path";

const PAPER = [
  { id: "new_abc", type: "mc", prompt: "Pick one", points: 1, options: ["a", "b", "c"], key: { correct: 1 } },
  { id: "q2", type: "multi", prompt: "Pick some", points: 2, options: ["w", "x", "y", "z"], key: { correct: [0, 2], partialCredit: true } },
  { id: "q3", type: "tf", prompt: "Sky is blue", points: 1, key: { correct: true } },
  { id: "q4", type: "text", prompt: "Name it", points: 1, key: { accepted: ["firewall", "packet filter"], caseSensitive: false } },
  { id: "q5", type: "essay", prompt: "Discuss", points: 10, key: {} },
];
const EXAM = { title: "Prelim", course: "IAS 101", duration_minutes: 45, require_fullscreen: false, roster: ["a@x.edu"] };

// ---------------------------------------------------------------- JSON bundle
test("a bundle round-trips an exam exactly", () => {
  const back = fromBundleJson(JSON.stringify(toBundle(EXAM, PAPER)));
  assert.equal(back.exam.title, "Prelim");
  assert.equal(back.exam.duration_minutes, 45);
  assert.equal(back.exam.require_fullscreen, false);
  assert.deepEqual(back.exam.roster, ["a@x.edu"]);
  assert.equal(back.questions.length, 5);
  assert.deepEqual(back.questions.map((q) => q.type), ["mc", "multi", "tf", "text", "essay"]);
  assert.equal(back.questions[0].key.correct, 1);
  assert.deepEqual(back.questions[1].key.correct, [0, 2]);
  assert.equal(back.questions[1].key.partialCredit, true);
  assert.equal(back.questions[2].key.correct, true);
  assert.deepEqual(back.questions[3].key.accepted, ["firewall", "packet filter"]);
  assert.equal(bundleProblems(back.questions).length, 0);
});

test("a bundle never leaks a temporary editor id", () => {
  const b = toBundle(EXAM, PAPER);
  assert.equal(b.questions[0].id, "q1", "new_abc was an unsaved editor id");
  assert.ok(!JSON.stringify(b).includes("new_"));
});

test("a hand-written bundle with the key inline is accepted", () => {
  const { exam, questions } = fromBundleJson(JSON.stringify({
    exam: { title: "Quiz 1", duration_minutes: "30", shuffle_questions: "yes" },
    questions: [
      { type: "mc", prompt: "2+2?", options: ["3", "4"], correct: 1 },
      { type: "tf", prompt: "Water is wet", correct: "true" },
      { type: "text", prompt: "Capital of Japan", accepted: ["Tokyo"] },
    ],
  }));
  assert.equal(exam.title, "Quiz 1");
  assert.equal(exam.duration_minutes, 30, "a string number is coerced");
  assert.equal(exam.shuffle_questions, true, '"yes" counts as true');
  assert.equal(questions[0].key.correct, 1);
  assert.equal(questions[1].key.correct, true);
  assert.deepEqual(questions[2].key.accepted, ["Tokyo"]);
  assert.equal(bundleProblems(questions).length, 0);
});

test("the older {questions, answers} export still imports", () => {
  const { questions } = fromBundleJson(JSON.stringify({
    title: "Old export",
    questions: [{ id: "q1", type: "mc", prompt: "P", options: ["a", "b"] }],
    answers: { q1: { correct: 0 } },
  }));
  assert.equal(questions[0].key.correct, 0);
});

test("a bare title at the top level is picked up", () => {
  const { exam } = fromBundleJson(JSON.stringify({
    title: "From the old editor",
    questions: [{ type: "tf", prompt: "x", correct: true }],
  }));
  assert.equal(exam.title, "From the old editor");
});

test("the legacy single-file quiz array still imports", () => {
  const { questions } = fromBundleJson(
    'const baseQuizData = [{ type: "text", q: "What is AAA?", a: ["authentication", "AAA"] }];');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, "text");
  assert.deepEqual(questions[0].key.accepted, ["authentication", "AAA"]);
});

test("an empty or question-less file says so plainly", () => {
  assert.throws(() => fromBundleJson(""), /empty/i);
  assert.throws(() => fromBundleJson('{"questions":[]}'), /no questions/i);
});

// -------------------------------------------------------------- sheet import
const SHEET = [
  ["Type", "Points", "Question", "Option A", "Option B", "Option C", "Correct", "Case sensitive", "Partial credit"],
  ["mc", 1, "Pick one", "a", "b", "c", "B", "", ""],
  ["multi", 2, "Pick some", "w", "x", "y", "A, C", "", "TRUE"],
  ["tf", 1, "Sky is blue", "", "", "", "TRUE", "", ""],
  ["text", 1, "Name it", "", "", "", "firewall | packet filter", "FALSE", ""],
  ["essay", 10, "Discuss", "", "", "", "", "", ""],
];

test("a question sheet imports with every key intact", () => {
  const { questions, warnings } = questionsFromTable(SHEET);
  assert.deepEqual(warnings, []);
  assert.equal(questions.length, 5);
  assert.equal(questions[0].key.correct, 1, "B is the second option");
  assert.deepEqual(questions[1].key.correct, [0, 2]);
  assert.equal(questions[1].key.partialCredit, true);
  assert.equal(questions[2].key.correct, true);
  assert.deepEqual(questions[3].key.accepted, ["firewall", "packet filter"]);
  assert.equal(questions[4].type, "essay");
  assert.equal(questions[4].points, 10);
  assert.equal(bundleProblems(questions).length, 0);
});

test("column order does not matter and extra columns are ignored", () => {
  const { questions } = questionsFromTable([
    ["Notes", "Question", "Option B", "Option A", "Correct", "Type", "Chapter"],
    ["ignore me", "Pick one", "second", "first", "1", "mc", "3"],
  ]);
  assert.equal(questions[0].prompt, "Pick one");
  assert.deepEqual(questions[0].options, ["second", "first"], "columns are read in sheet order");
  assert.equal(questions[0].key.correct, 0, "a numeric 1 means the first option");
});

test("a blank row is a spacer, not an error", () => {
  const { questions } = questionsFromTable([SHEET[0], SHEET[1], ["", "", "", "", "", "", "", "", ""], SHEET[3]]);
  assert.equal(questions.length, 2);
});

test("a missing type is inferred from the shape of the row", () => {
  const { questions, warnings } = questionsFromTable([
    ["Type", "Question", "Option A", "Option B", "Correct"],
    ["", "Two options, one answer", "a", "b", "A"],
    ["", "Two options, two answers", "a", "b", "A, B"],
    ["", "No options, true/false", "", "", "FALSE"],
    ["", "No options, a word", "", "", "osmosis"],
    ["", "Nothing at all", "", "", ""],
  ]);
  assert.deepEqual(questions.map((q) => q.type), ["mc", "multi", "tf", "text", "essay"]);
  assert.deepEqual(warnings, [], "an empty type is inferred silently");
});

test("an unreadable type is flagged but the row is still imported", () => {
  const { questions, warnings } = questionsFromTable([
    ["Type", "Question", "Correct"],
    ["multiple-guess", "What?", "TRUE"],
  ]);
  assert.equal(questions.length, 1);
  assert.match(warnings[0], /multiple-guess/);
});

test("a sheet with no Question column explains what the headers should be", () => {
  assert.throws(() => questionsFromTable([["A", "B"], ["1", "2"]]), /Question" column/);
});

test("a sheet with only headers says there are no questions under them", () => {
  assert.throws(() => questionsFromTable([SHEET[0]]), /no questions under it/);
});

test("a bad answer is warned about rather than silently wrong", () => {
  const { questions, warnings } = questionsFromTable([
    ["Type", "Question", "Option A", "Option B", "Correct"],
    ["mc", "Pick one", "a", "b", "Z"],
    ["tf", "True?", "", "", "maybe"],
    ["text", "Name it", "", "", ""],
  ]);
  assert.equal(warnings.length, 3, warnings.join(" | "));
  assert.match(warnings[0], /correct answer "Z"/);
  assert.match(warnings[1], /TRUE or FALSE/);
  assert.match(warnings[2], /no accepted answers/);
  assert.equal(questions.length, 3, "the professor still gets the rows to fix");
});

test("friendly type names are accepted", () => {
  const { questions } = questionsFromTable([
    ["Type", "Question", "Option A", "Option B", "Correct"],
    ["Multiple Choice", "a", "x", "y", "A"],
    ["True/False", "b", "", "", "TRUE"],
    ["Short Answer", "c", "", "", "z"],
    ["Multiple Select", "d", "x", "y", "A,B"],
  ]);
  assert.deepEqual(questions.map((q) => q.type), ["mc", "tf", "text", "multi"]);
});

// ------------------------------------------------------------------ settings
test("the Settings sheet is read, coerced and filtered", () => {
  const s = settingsFromTable([
    ["Setting", "Value"],
    ["title", "Midterm"],
    ["duration_minutes", "90"],
    ["require_fullscreen", "FALSE"],
    ["shuffle_options", "yes"],
    ["roster", "a@x.edu, b@x.edu"],
    ["scores_released", "TRUE"],          // not importable — must be ignored
    ["nonsense", "1"],
  ]);
  assert.equal(s.title, "Midterm");
  assert.equal(s.duration_minutes, 90);
  assert.equal(s.require_fullscreen, false);
  assert.equal(s.shuffle_options, true);
  assert.deepEqual(s.roster, ["a@x.edu", "b@x.edu"]);
  assert.ok(!("scores_released" in s), "releasing scores must never come from a file");
  assert.ok(!("nonsense" in s));
});

test("a blank setting keeps the exam's current value", () => {
  const s = settingsFromTable([["Setting", "Value"], ["title", ""], ["course", "IAS"]]);
  assert.ok(!("title" in s));
  assert.equal(s.course, "IAS");
});

// -------------------------------------------------------- Excel round-trip
test("an exam exported to Excel imports back unchanged", async () => {
  const sheets = toQuestionSheet(EXAM, PAPER);
  const rows = await readXlsx(await buildXlsx(sheets).arrayBuffer());
  const { questions, warnings } = questionsFromTable(rows);
  assert.deepEqual(warnings, []);
  assert.equal(questions.length, 5);
  assert.equal(questions[0].key.correct, 1);
  assert.deepEqual(questions[1].key.correct, [0, 2]);
  assert.equal(questions[2].key.correct, true);
  assert.deepEqual(questions[3].key.accepted, ["firewall", "packet filter"]);
  assert.equal(questions[4].points, 10);
  assert.equal(bundleProblems(questions).length, 0);
});

test("the exported workbook carries the settings and a how-to sheet", () => {
  const names = toQuestionSheet(EXAM, PAPER).map((s) => s.name);
  assert.deepEqual(names, ["Questions", "Settings", "How to fill this in"]);
});

test("the blank template is itself a valid import", async () => {
  const rows = await readXlsx(await buildXlsx(templateSheets()).arrayBuffer());
  const { questions, warnings } = questionsFromTable(rows);
  assert.deepEqual(warnings, [], "the example rows must not warn");
  assert.equal(questions.length, 5, "one worked example of each type");
  assert.deepEqual(questions.map((q) => q.type), ["mc", "multi", "tf", "text", "essay"]);
  assert.equal(bundleProblems(questions).length, 0, "and must import cleanly");
});

test("options grow to fit the widest question", () => {
  const wide = [{ id: "q1", type: "mc", prompt: "p", points: 1, options: ["a", "b", "c", "d", "e", "f"], key: { correct: 5 } }];
  const [sheet] = toQuestionSheet(EXAM, wide);
  assert.ok(sheet.rows[0].includes("Option F"));
  const { questions } = questionsFromTable(sheet.rows.map((r) => r.map((c) => (c && c.v !== undefined ? c.v : c))));
  assert.equal(questions[0].key.correct, 5, "the sixth option is still the answer");
});

// ---------------------------------------------------- the shipped examples
// Both sample files are documentation. Documentation that does not import is
// worse than none, so they are tested like anything else.
const EX = path.join(import.meta.dirname, "../examples");

test("examples/sample-exam.json imports cleanly", () => {
  const { exam, questions, warnings } = fromBundleJson(fs.readFileSync(path.join(EX, "sample-exam.json"), "utf8"));
  assert.deepEqual(warnings, []);
  assert.equal(exam.title, "Sample exam – every question type");
  assert.deepEqual(questions.map((q) => q.type), ["mc", "multi", "tf", "text", "essay"]);
  assert.deepEqual(bundleProblems(questions), []);
});

test("examples/sample-questions.csv imports cleanly and matches the JSON", () => {
  const csv = questionsFromTable(readDelimited(fs.readFileSync(path.join(EX, "sample-questions.csv"), "utf8")));
  assert.deepEqual(csv.warnings, []);
  assert.deepEqual(bundleProblems(csv.questions), []);
  const json = fromBundleJson(fs.readFileSync(path.join(EX, "sample-exam.json"), "utf8"));
  assert.deepEqual(csv.questions.map((q) => q.type), json.questions.map((q) => q.type));
  assert.deepEqual(csv.questions.map((q) => q.prompt), json.questions.map((q) => q.prompt));
  assert.deepEqual(csv.questions.map((q) => q.key), json.questions.map((q) => q.key),
    "the two sample files must describe the same exam");
});

test("no example file carries anything but its own sample key", () => {
  for (const f of fs.readdirSync(EX)) {
    assert.match(f, /^sample-/, `${f} is not a sample — real answer keys must not be committed`);
  }
});
