// Reading an exam out of a document a professor already wrote.
//
// Real papers are not consistent, so these tests are shaped after the actual
// variants: "1." vs "1)" vs "Q1.", answers on their own line vs in brackets
// on the prompt, options as "A." or "a)", prompts that wrap, and stray
// headings between sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument, docxToText, pdfToText } from "../js/docimport.js";
import { bundleProblems } from "../js/bundle.js";

const PAPER = `
INFORMATION ASSURANCE — PRELIM EXAMINATION
Prof. Uno · 60 minutes

PART I. MULTIPLE CHOICE

1. Which principle of the CIA triad is violated when data is altered
   without authorisation?
A. Confidentiality
B. Integrity
C. Availability
D. Non-repudiation
Answer: B

2) Which control most directly limits the damage of a stolen password? (2 points)
   a) Password rotation
   b) Multi-factor authentication
   c) Longer passwords
   d) Account lockout
   ANS: b

Q3. Select every administrative control. (2 pts)
A. Security policy
B. Firewall rule
C. Staff training
D. Door lock
Answer: A and C

PART II. TRUE OR FALSE

4. Encryption at rest protects data if a disk is physically stolen. [Answer: True]

5. A firewall inspects the contents of encrypted traffic by default.
Answer: False

PART III. IDENTIFICATION

6. Name the security principle of giving a user only the access they need.
Answer: least privilege | principle of least privilege

7. Explain defence in depth and give two examples from your own device.
`;

test("a realistic paper comes back as a complete exam", () => {
  const { questions, warnings, stats } = parseDocument(PAPER);
  assert.equal(questions.length, 7, warnings.join(" | "));
  assert.deepEqual(questions.map((q) => q.type),
    ["mc", "mc", "multi", "tf", "tf", "text", "essay"]);
  assert.deepEqual(bundleProblems(questions), []);
  assert.equal(stats.withKey, 6, "only the essay has no key");
});

test("the answer key is read whichever way it was written", () => {
  const { questions } = parseDocument(PAPER);
  assert.equal(questions[0].key.correct, 1, '"Answer: B"');
  assert.equal(questions[1].key.correct, 1, '"ANS: b" with lowercase options');
  assert.deepEqual(questions[2].key.correct, [0, 2], '"A and C"');
  assert.equal(questions[3].key.correct, true, "an inline [Answer: True]");
  assert.equal(questions[4].key.correct, false);
  assert.deepEqual(questions[5].key.accepted, ["least privilege", "principle of least privilege"]);
});

test("a prompt that wraps onto the next line stays one question", () => {
  const { questions } = parseDocument(PAPER);
  assert.match(questions[0].prompt, /altered without authorisation\?$/);
  assert.ok(!questions[0].prompt.includes("\n"));
});

test("points in the prompt are read and removed from the text", () => {
  const { questions } = parseDocument(PAPER);
  assert.equal(questions[1].points, 2);
  assert.equal(questions[2].points, 2);
  assert.equal(questions[0].points, 1, "no marking means one point");
  assert.ok(!/points?\)/i.test(questions[1].prompt), questions[1].prompt);
});

test("options keep their order and their text", () => {
  const { questions } = parseDocument(PAPER);
  assert.deepEqual(questions[0].options,
    ["Confidentiality", "Integrity", "Availability", "Non-repudiation"]);
  assert.deepEqual(questions[1].options,
    ["Password rotation", "Multi-factor authentication", "Longer passwords", "Account lockout"]);
});

test("a PART heading between sections is not imported as a question", () => {
  const { questions } = parseDocument(PAPER);
  assert.ok(!questions.some((q) => /^PART/i.test(q.prompt)), questions.map((q) => q.prompt).join(" | "));
});

test("an answer written out in words is matched to its option", () => {
  const { questions } = parseDocument(
    "1. Which is a hash?\nA. AES\nB. SHA-256\nC. RSA\nAnswer: SHA-256\n");
  assert.equal(questions[0].key.correct, 1);
});

test("an answer given as a number picks that option", () => {
  const { questions } = parseDocument("1. Pick.\nA. one\nB. two\nC. three\nKey: 3\n");
  assert.equal(questions[0].key.correct, 2);
});

test("a missing answer is flagged rather than guessed silently", () => {
  const { questions, warnings } = parseDocument("1. Which one?\nA. yes\nB. no\n");
  assert.equal(questions[0].type, "mc");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not tell which option/);
});

test("an essay-shaped question with no key becomes an essay", () => {
  const { questions } = parseDocument(
    "1. Discuss the trade-offs between usability and security in password policy.\n");
  assert.equal(questions[0].type, "essay");
});

test("a gap in the numbering is reported", () => {
  const { warnings } = parseDocument("1. First?\nAnswer: a\n\n5. Fifth?\nAnswer: b\n");
  assert.ok(warnings.some((w) => /Numbering jumps from 1 to 5/.test(w)), warnings.join(" | "));
});

test("a document with no numbered questions explains the format", () => {
  assert.throws(() => parseDocument("Just some prose about firewalls.\nAnd more prose."),
    /must start on its own\s+line with a number|Each question needs to start/);
});

test("an empty document is refused", () => {
  assert.throws(() => parseDocument(""), /No numbered questions/);
});

test("true/false is detected from the options as well as the wording", () => {
  const { questions } = parseDocument("1. The sky is blue.\nA. True\nB. False\nAnswer: A\n");
  assert.equal(questions[0].type, "tf");
  assert.equal(questions[0].key.correct, true);
});

test("a letter inside the answer text is not mistaken for an option", () => {
  const { questions } = parseDocument(
    "1. Name the protocol.\nA. HTTP\nB. HTTPS\nC. FTP\nAnswer: HTTPS\n");
  assert.equal(questions[0].key.correct, 1, "HTTPS is the option, not option H");
});

// ------------------------------------------------------------------ .docx
test("Word paragraphs become lines", () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:r><w:t>1. What is AAA?</w:t></w:r></w:p>
    <w:p><w:r><w:t>A. Authentication</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r>
      <w:r><w:t>Authorisation</w:t></w:r></w:p>
    <w:p><w:r><w:t>B. Something else</w:t></w:r></w:p>
    <w:p><w:r><w:t>Answer: A</w:t></w:r></w:p>
  </w:body></w:document>`;
  const text = docxToText({ "word/document.xml": new TextEncoder().encode(xml) });
  const { questions } = parseDocument(text);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].prompt, "What is AAA?");
  assert.equal(questions[0].options[0], "Authentication, Authorisation",
    "runs split by formatting are joined back together");
  assert.equal(questions[0].key.correct, 0);
});

test("a .docx with no document part says so", () => {
  assert.throws(() => docxToText({ "word/settings.xml": new Uint8Array() }), /no document part/);
});

// -------------------------------------------------------------------- pdf
test("an uncompressed PDF's text is recovered", async () => {
  // A minimal PDF whose one content stream is stored, not Flate-compressed.
  const content = "BT /F1 12 Tf 72 720 Td (1. What is a firewall?) Tj T* "
    + "(A. A wall) Tj T* (B. A packet filter) Tj T* (Answer: B) Tj ET";
  const pdf = `%PDF-1.4\n1 0 obj<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n%%EOF`;
  const text = await pdfToText(new TextEncoder().encode(pdf));
  const { questions } = parseDocument(text);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].prompt, "What is a firewall?");
  assert.equal(questions[0].key.correct, 1);
});

test("a PDF holding only an image yields no text", async () => {
  const pdf = "%PDF-1.4\n1 0 obj<</Subtype/Image/Filter/DCTDecode/Length 4>>\nstream\n\xff\xd8\xff\xd9\nendstream\nendobj";
  const text = await pdfToText(new TextEncoder().encode(pdf));
  assert.equal(text.replace(/\s/g, ""), "", "a scan has pictures, not text");
});
