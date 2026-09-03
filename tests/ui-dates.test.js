// Dates arrive from Postgres as ISO strings.
//
// toDate() used to return null for one, because it was written for Firestore
// Timestamp objects. Nothing crashed — every date simply rendered as "—", the
// monitor never showed time left, and opening an exam for editing silently
// reset its open/close window to the current moment. Quiet, wide, and easy to
// reintroduce, so it is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toDate, fmtDate, fmtTime, ago, toLocalInput, mmss } from "../js/ui.js";

const ISO = "2026-01-15T09:30:00.000Z";

test("an ISO string from Postgres is a date", () => {
  const d = toDate(ISO);
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), ISO);
});

test("the other shapes still work", () => {
  const d = new Date(ISO);
  assert.equal(toDate(d), d, "a Date passes through");
  assert.equal(toDate(d.getTime()).toISOString(), ISO, "epoch milliseconds");
  assert.equal(toDate({ toDate: () => d }), d, "a legacy Firestore value");
});

test("nothing, and nonsense, are null rather than Invalid Date", () => {
  assert.equal(toDate(null), null);
  assert.equal(toDate(undefined), null);
  assert.equal(toDate(""), null);
  assert.equal(toDate("not a date"), null);
  assert.equal(toDate(new Date("nope")), null);
});

test("a formatted date is a date, not a dash", () => {
  assert.notEqual(fmtDate(ISO), "—");
  assert.match(fmtDate(ISO), /2026/);
  assert.notEqual(fmtTime(ISO), "—");
  assert.equal(fmtDate(null), "—", "but nothing still reads as nothing");
});

test("ago() measures from an ISO string", () => {
  assert.equal(ago(new Date(Date.now() - 3600e3).toISOString()), "1h ago");
  assert.equal(ago(new Date(Date.now() - 2000).toISOString()), "just now");
  assert.equal(ago(new Date(Date.now() - 30_000).toISOString()), "30s ago");
  assert.equal(ago(null), "—");
});

test("editing an exam keeps its dates instead of resetting them to now", () => {
  // toLocalInput feeds <input type=datetime-local>. Returning "now" for a
  // stored date is how an exam's window used to get quietly rewritten on save.
  const local = toLocalInput(ISO);
  assert.match(local, /^2026-01-15T\d\d:\d\d$/, local);
  const now = toLocalInput(null);
  assert.match(now, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/, "no date still means now");
});

test("mmss counts down in a readable shape", () => {
  assert.equal(mmss(0), "00:00");
  assert.equal(mmss(59.9), "00:59");
  assert.equal(mmss(90), "01:30");
  assert.equal(mmss(3661), "1:01:01");
  assert.equal(mmss(-5), "00:00", "an expired clock does not go negative");
});
