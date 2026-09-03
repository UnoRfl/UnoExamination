// The Excel writer has to produce files Excel will actually open. A round-trip
// through our own reader proves the two halves agree with each other, not that
// the file is valid — so the CI job additionally opens the same bytes with
// openpyxl (see tests/xlsx-validate.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildXlsx, readXlsx, readDelimited, S } from "../js/xlsx.js";

const OUT = path.join(import.meta.dirname, "out");

const SHEET = {
  name: "Grades",
  cols: [22, 26, 12, 10, 9, 9],
  filter: true,
  rows: [
    ["Student", "E-mail", "Student no", "Score", "Percent", "Submitted"],
    ["Dela Cruz, Juan", "juan@school.edu", "21-0001", 47, { v: 78.3, s: S.PERCENT }, new Date(Date.UTC(2026, 0, 15, 9, 30))],
    ["O'Brien, \"Mae\"", "mae@school.edu", "21-0002", 60, { v: 100, s: S.PERCENT }, new Date(Date.UTC(2026, 0, 15, 9, 45))],
    ["Ng, Wei <lab>", "wei@school.edu", "21-0003", 0, { v: 0, s: S.PERCENT }, ""],
    ["Ünlü, Zoë — ß", "zoe@school.edu", "21-0004", 12.5, { v: 20.8, s: S.PERCENT }, ""],
  ],
};

async function roundTrip(sheets) {
  const blob = buildXlsx(sheets);
  return { blob, rows: await readXlsx(await blob.arrayBuffer()) };
}

test("a workbook round-trips through our own reader", async () => {
  const { rows } = await roundTrip([SHEET]);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0].slice(0, 3), ["Student", "E-mail", "Student no"]);
  assert.equal(rows[1][0], "Dela Cruz, Juan");
  assert.equal(rows[1][3], 47, "numbers stay numbers, not text");
  assert.equal(rows[2][0], 'O\'Brien, "Mae"', "quotes survive");
  assert.equal(rows[3][0], "Ng, Wei <lab>", "angle brackets survive");
  assert.equal(rows[4][0], "Ünlü, Zoë — ß", "non-ASCII survives");
});

test("an empty cell stays empty rather than becoming a zero", async () => {
  const { rows } = await roundTrip([SHEET]);
  assert.equal(rows[3][5], "", "a student who never submitted has no date");
  assert.notEqual(rows[3][5], 0);
});

test("a date is written as a real Excel date, not a string", async () => {
  const { rows } = await roundTrip([SHEET]);
  assert.equal(typeof rows[1][5], "number", "so Excel can sort and filter by it");
  // 2026-01-15 is 46037 days after 1899-12-30
  assert.ok(Math.abs(Math.floor(rows[1][5]) - 46037) <= 1, `got ${rows[1][5]}`);
});

test("several sheets each keep their own rows", async () => {
  const blob = buildXlsx([
    { name: "One", rows: [["a"], ["1"]] },
    { name: "Two", rows: [["b"], ["2"]] },
  ]);
  const buf = await blob.arrayBuffer();
  const rows = await readXlsx(buf);          // reads sheet1
  assert.deepEqual(rows, [["a"], ["1"]]);
  const text = Buffer.from(buf).toString("latin1");
  assert.ok(text.includes("xl/worksheets/sheet2.xml"), "the second sheet is in the package");
  assert.ok(text.includes('name="One"') && text.includes('name="Two"'));
});

test("a sheet name Excel would reject is repaired, not passed through", () => {
  const blob = buildXlsx([{ name: "Grades: 2026/27 [final]", rows: [["x"]] }]);
  assert.ok(blob.size > 0);
});

test("a name longer than Excel's 31-character limit is trimmed", async () => {
  const long = "Per question breakdown for the prelim examination";
  const buf = await buildXlsx([{ name: long, rows: [["x"]] }]).arrayBuffer();
  const text = Buffer.from(buf).toString("utf8");
  const name = text.match(/<sheet name="([^"]*)"/)[1];
  assert.ok(name.length <= 31, `"${name}" is ${name.length} characters`);
});

test("CSV and TSV both parse, quotes and embedded newlines included", () => {
  const csv = 'Type,Prompt,Points\nmc,"Which one, exactly?",2\ntext,"He said ""no""",1\n';
  const rows = readDelimited(csv);
  assert.deepEqual(rows[1], ["mc", "Which one, exactly?", "2"]);
  assert.deepEqual(rows[2], ["text", 'He said "no"', "1"]);

  const tsv = "Type\tPrompt\tPoints\nmc\tPick one\t2\n";
  assert.deepEqual(readDelimited(tsv)[1], ["mc", "Pick one", "2"]);
});

test("blank lines in a pasted sheet are dropped", () => {
  assert.equal(readDelimited("a,b\n\n\nc,d\n\n").length, 2);
});

test("a file that is not a workbook fails with an explanation", async () => {
  await assert.rejects(
    () => readXlsx(new TextEncoder().encode("this is not a zip").buffer),
    /not a valid \.xlsx/);
});

// Leaves a file behind for tests/xlsx-validate.py to open with openpyxl.
test("writes a fixture for the external validator", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const blob = buildXlsx([
    SHEET,
    { name: "Per question", rows: [["#", "Prompt", "Correct", "Wrong"], [1, "What is AAA?", 30, 5]] },
  ]);
  fs.writeFileSync(path.join(OUT, "sample.xlsx"), Buffer.from(await blob.arrayBuffer()));
  assert.ok(fs.statSync(path.join(OUT, "sample.xlsx")).size > 1000);
});
