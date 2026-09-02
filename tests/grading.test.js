import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, gradeAnswer, gradeSession, riskScore, importQuestions, STRIKE_EVENTS } from "../js/grading.js";
import { buildPaper, hashString, validateQuestion, validateKey } from "../js/paper.js";

test("normalizeText ignores case, spacing, quotes and edge punctuation", () => {
  assert.equal(normalizeText("  Due   Diligence. "), "due diligence");
  assert.equal(normalizeText("“Paper-only”"), "paper-only");
  assert.equal(normalizeText("Liability!"), "liability");
  assert.equal(normalizeText("ABC", { caseSensitive: true }), "ABC");
});

test("text answers accept any listed alternative", () => {
  const q = { id: "q1", type: "text", points: 1 };
  const key = { accepted: ["liability", "legal liability"] };
  assert.equal(gradeAnswer(q, key, "Legal Liability ").earned, 1);
  assert.equal(gradeAnswer(q, key, "negligence").earned, 0);
  assert.equal(gradeAnswer(q, key, "").earned, 0);
  assert.equal(gradeAnswer(q, key, undefined).correct, false);
});

test("mc / tf / multi grading", () => {
  assert.equal(gradeAnswer({ type: "mc", points: 2 }, { correct: 1 }, 1).earned, 2);
  assert.equal(gradeAnswer({ type: "mc", points: 2 }, { correct: 1 }, 0).earned, 0);
  assert.equal(gradeAnswer({ type: "tf", points: 1 }, { correct: false }, false).earned, 1);
  assert.equal(gradeAnswer({ type: "tf", points: 1 }, { correct: false }, "false").earned, 1);
  assert.equal(gradeAnswer({ type: "multi", points: 2 }, { correct: [0, 2] }, [2, 0]).earned, 2);
  assert.equal(gradeAnswer({ type: "multi", points: 2 }, { correct: [0, 2] }, [0]).earned, 0);
  const partial = gradeAnswer({ type: "multi", points: 2 }, { correct: [0, 2], partialCredit: true }, [0]);
  assert.equal(partial.earned, 1);
  assert.equal(partial.correct, "partial");
  const penalised = gradeAnswer({ type: "multi", points: 2 }, { correct: [0, 2], partialCredit: true }, [0, 1]);
  assert.equal(penalised.earned, 0);
});

test("essay needs manual grading; overrides apply", () => {
  const paper = [{ id: "e1", type: "essay", points: 5 }, { id: "m1", type: "mc", points: 1, options: [{ oi: 0, text: "a" }, { oi: 1, text: "b" }] }];
  const key = { m1: { correct: 1 } };
  const g = gradeSession(paper, key, { e1: "some text", m1: 1 });
  assert.equal(g.needsManual, 1);
  assert.equal(g.score, 1);
  assert.equal(g.max, 6);
  const g2 = gradeSession(paper, key, { e1: "some text", m1: 1 }, { e1: { earned: 4, comment: "good" } });
  assert.equal(g2.score, 5);
  assert.equal(g2.needsManual, 0);
  assert.equal(g2.perQuestion.e1.comment, "good");
  assert.equal(g2.percent, 83.3);
});

test("buildPaper is deterministic per session and differs between students", () => {
  const qs = Array.from({ length: 30 }, (_, i) => ({ id: `q${String(i).padStart(3, "0")}`, type: "mc", prompt: `Q${i}`, options: ["a", "b", "c", "d"], points: 1 }));
  const settings = { shuffleQuestions: true, shuffleOptions: true, questionsPerStudent: 10 };
  const a1 = buildPaper(qs, settings, "ABC123_uidA");
  const a2 = buildPaper(qs.slice().reverse(), settings, "ABC123_uidA"); // input order must not matter
  const b = buildPaper(qs, settings, "ABC123_uidB");
  assert.deepEqual(a1.map((q) => q.id), a2.map((q) => q.id));
  assert.deepEqual(a1[0].options, a2[0].options);
  assert.equal(a1.length, 10);
  assert.notDeepEqual(a1.map((q) => q.id), b.map((q) => q.id));
  // option entries carry the ORIGINAL index so the key still applies
  const oi = a1[0].options.map((o) => o.oi).sort();
  assert.deepEqual(oi, [0, 1, 2, 3]);
  // no shuffling => original order, all questions
  const plain = buildPaper(qs, { shuffleQuestions: false, shuffleOptions: false }, "X_y");
  assert.equal(plain.length, 30);
  assert.equal(plain[0].id, "q000");
  assert.deepEqual(plain[0].options.map((o) => o.text), ["a", "b", "c", "d"]);
});

test("hashString is stable", () => {
  assert.equal(hashString("ABC123_uid"), hashString("ABC123_uid"));
  assert.notEqual(hashString("a"), hashString("b"));
});

test("importQuestions accepts the legacy single-file quiz format", () => {
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

test("importQuestions accepts our own export and infers mc from options", () => {
  const { questions, answers } = importQuestions(JSON.stringify([
    { prompt: "Pick", options: ["a", "b"], correct: 1 },
    { prompt: "Pick many", options: ["a", "b", "c"], correct: [0, 2] },
    { type: "tf", prompt: "T?", correct: true },
  ]));
  assert.equal(questions[0].type, "mc"); assert.equal(answers[questions[0].id].correct, 1);
  assert.equal(questions[1].type, "multi"); assert.deepEqual(answers[questions[1].id].correct, [0, 2]);
  assert.equal(questions[2].type, "tf"); assert.equal(answers[questions[2].id].correct, true);
  const own = importQuestions({ questions: [{ id: "z", type: "text", prompt: "p" }], answers: { z: { accepted: ["k"] } } });
  assert.equal(own.questions[0].id, "z");
});

test("validation catches incomplete questions/keys", () => {
  assert.ok(validateQuestion({ id: "a", type: "mc", prompt: "x", options: ["only one"] }, 0).length);
  assert.ok(validateKey({ id: "a", type: "mc", options: ["a", "b"] }, {}, 0).length);
  assert.equal(validateKey({ id: "a", type: "text" }, { accepted: ["k"] }, 0).length, 0);
  assert.equal(validateKey({ id: "a", type: "essay" }, undefined, 0).length, 0);
});

test("riskScore ranks a clean session low and a noisy one high", () => {
  const settings = { durationMinutes: 60, maxViolations: 5 };
  const clean = riskScore({ violations: 0 }, [{ type: "started" }, { type: "submitted" }], settings);
  assert.equal(clean.level, "low");
  const noisy = riskScore({ violations: 5 }, [
    ...Array(4).fill({ type: "tab_hidden", detail: { ms: 20000 } }),
    { type: "paste", detail: { len: 300 } }, { type: "devtools_suspected" }, { type: "multiple_tabs" },
  ], settings);
  assert.equal(noisy.level, "high");
  assert.ok(noisy.reasons.some((r) => r.includes("tab hidden")));
  assert.ok(STRIKE_EVENTS.has("tab_hidden") && !STRIKE_EVENTS.has("copy"));
});

test("riskScore flags implausibly fast completion", () => {
  const start = { toMillis: () => 0 }, end = { toMillis: () => 3 * 60_000 };
  const r = riskScore({ startedAt: start, submittedAt: end, progress: { answered: 58, total: 60 }, violations: 0 }, [], { durationMinutes: 60 });
  assert.ok(r.reasons.some((x) => x.includes("allotted time")));
});
