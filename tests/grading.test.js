// Unit tests for the pure client-side logic that survives on this side of the
// wire: the proctoring risk model, the question importer, and editor
// validation. Scoring itself is a database function and is covered by
// tests/security.test.mjs, which exercises it over the real API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { riskScore, importQuestions, EVENT_WEIGHTS, STRIKE_EVENTS } from "../js/grading.js";
import { validateQuestion, validateKey, paperMaxPoints, QUESTION_TYPES } from "../js/paper.js";

// ------------------------------------------------------------------- import
test("importQuestions accepts the legacy single-file quiz array", () => {
  const legacy = `const baseQuizData = [
    { type: "text", q: "Due _____ is the planning phase.", a: ["care"] },
    { type: "text", q: "Second", a: ["x", "y"] }
  ];`;
  const { questions, answers } = importQuestions(legacy);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].type, "text");
  assert.equal(questions[0].prompt, "Due _____ is the planning phase.");
  assert.deepEqual(answers[questions[1].id].accepted, ["x", "y"]);
});

test("importQuestions infers types and carries keys across", () => {
  const { questions, answers } = importQuestions(JSON.stringify([
    { prompt: "Pick one", options: ["a", "b"], correct: 1 },
    { prompt: "Pick many", options: ["a", "b", "c"], correct: [0, 2] },
    { type: "tf", prompt: "True?", correct: true },
    { type: "essay", prompt: "Discuss", points: 5 },
  ]));
  assert.equal(questions[0].type, "mc");
  assert.equal(answers[questions[0].id].correct, 1);
  assert.equal(questions[1].type, "multi");
  assert.deepEqual(answers[questions[1].id].correct, [0, 2]);
  assert.equal(questions[2].type, "tf");
  assert.equal(answers[questions[2].id].correct, true);
  assert.equal(questions[3].type, "essay");
  assert.equal(questions[3].points, 5);
});

test("importQuestions round-trips our own export shape", () => {
  const own = importQuestions({
    questions: [{ id: "z", type: "text", prompt: "p", points: 2 }],
    answers: { z: { accepted: ["k"] } },
  });
  assert.equal(own.questions[0].id, "z");
  assert.deepEqual(own.answers.z.accepted, ["k"]);
});

// --------------------------------------------------------------- validation
test("validateQuestion catches incomplete questions", () => {
  assert.ok(validateQuestion({ type: "mc", prompt: "x", options: ["only one"] }, 0).length);
  assert.ok(validateQuestion({ type: "mc", prompt: "x", options: ["a", ""] }, 0).length);
  assert.ok(validateQuestion({ type: "text", prompt: "   " }, 0).length);
  assert.ok(validateQuestion({ type: "text", prompt: "ok", points: 0 }, 0).length);
  assert.equal(validateQuestion({ type: "text", prompt: "ok", points: 2 }, 0).length, 0);
});

test("validateKey enforces a usable key per question type", () => {
  assert.ok(validateKey({ type: "mc", options: ["a", "b"] }, {}, 0).length);
  assert.equal(validateKey({ type: "mc", options: ["a", "b"] }, { correct: 1 }, 0).length, 0);
  assert.ok(validateKey({ type: "mc", options: ["a", "b"] }, { correct: 5 }, 0).length);
  assert.ok(validateKey({ type: "multi", options: ["a", "b"] }, { correct: [] }, 0).length);
  assert.ok(validateKey({ type: "tf" }, { correct: "yes" }, 0).length);
  assert.equal(validateKey({ type: "tf" }, { correct: false }, 0).length, 0);
  assert.ok(validateKey({ type: "text" }, { accepted: [] }, 0).length);
  assert.equal(validateKey({ type: "text" }, { accepted: ["a"] }, 0).length, 0);
  // essays are graded by hand, so they never need a key
  assert.equal(validateKey({ type: "essay" }, undefined, 0).length, 0);
});

test("paperMaxPoints totals the paper", () => {
  assert.equal(paperMaxPoints([{ points: 1 }, { points: 2.5 }, {}]), 4.5);
  assert.equal(paperMaxPoints([]), 0);
  assert.ok(Object.keys(QUESTION_TYPES).includes("essay"));
});

// ---------------------------------------------------------------- risk model
test("riskScore ranks a clean attempt low and a noisy one high", () => {
  const exam = { duration_minutes: 60, max_violations: 5 };
  const clean = riskScore({ violations: 0 }, [{ type: "started" }, { type: "submitted" }], exam);
  assert.equal(clean.level, "low");

  const noisy = riskScore({ violations: 5 }, [
    ...Array(4).fill({ type: "tab_hidden", detail: { ms: 20000 } }),
    { type: "paste", detail: { len: 300 } },
    { type: "devtools_suspected" },
    { type: "multiple_tabs" },
  ], exam);
  assert.equal(noisy.level, "high");
  assert.ok(noisy.reasons.some((r) => r.includes("tab hidden")));
});

test("riskScore flags implausibly fast completion", () => {
  const r = riskScore({
    startedAt: { toMillis: () => 0 },
    submittedAt: { toMillis: () => 3 * 60_000 },
    progress: { answered: 58, total: 60 },
    violations: 0,
  }, [], { duration_minutes: 60 });
  assert.ok(r.reasons.some((x) => x.includes("allotted time")));
});

test("riskScore has diminishing returns so one noisy signal cannot dominate", () => {
  const exam = { duration_minutes: 60, max_violations: 5 };
  const five = riskScore({ violations: 0 }, Array(5).fill({ type: "window_blur" }), exam);
  const twenty = riskScore({ violations: 0 }, Array(20).fill({ type: "window_blur" }), exam);
  assert.ok(twenty.score > five.score);
  assert.ok(twenty.score < five.score * 4, "20 events should not score 4x the 5-event case");
});

test("strike events are the disruptive ones, not every signal", () => {
  assert.ok(STRIKE_EVENTS.has("tab_hidden"));
  assert.ok(STRIKE_EVENTS.has("paste"));
  assert.ok(STRIKE_EVENTS.has("fullscreen_exit"));
  // merely informational signals must not cost a strike
  assert.ok(!STRIKE_EVENTS.has("copy"));
  assert.ok(!STRIKE_EVENTS.has("context_menu"));
  assert.ok(!STRIKE_EVENTS.has("resize"));
  // every strike event carries a weight so it shows up in the risk score
  for (const t of STRIKE_EVENTS) assert.ok(EVENT_WEIGHTS[t] > 0, `${t} needs a weight`);
});
