// Firestore security-rules tests. Run against the emulator:
//   npx firebase emulators:exec --only firestore --project demo-uno "node --test tests/rules/"
// (java is required for the emulator)
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  serverTimestamp, increment, Timestamp, writeBatch,
} from "firebase/firestore";

const PROJECT = "demo-uno";
const ADMIN_EMAIL = "professor@example.edu";  // matches BOOTSTRAP_ADMIN_EMAIL default in firestore.rules
const CODE = "ABC123";
let env;

const prof = () => env.authenticatedContext("prof1", { email: "prof1@uni.edu", email_verified: true }).firestore();
const otherProf = () => env.authenticatedContext("prof2", { email: "prof2@uni.edu", email_verified: true }).firestore();
const bootstrap = () => env.authenticatedContext("boot", { email: ADMIN_EMAIL, email_verified: true }).firestore();
const stu = (id = "stu1", extra = {}) => env.authenticatedContext(id, { email: `${id}@school.edu`, email_verified: true, ...extra }).firestore();
const unverified = () => env.authenticatedContext("stu9", { email: "stu9@school.edu", email_verified: false }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const now = () => Timestamp.now();
const plus = (mins) => Timestamp.fromMillis(Date.now() + mins * 60_000);
const minus = (mins) => Timestamp.fromMillis(Date.now() - mins * 60_000);

const examDoc = (over = {}) => ({
  ownerUid: "prof1", ownerName: "Prof", title: "Test exam", course: "", instructions: "", status: "open",
  opensAt: minus(10), closesAt: plus(120), scoresReleased: false, questionCount: 2, totalPoints: 2,
  settings: { durationMinutes: 30, maxViolations: 5, violationAction: "lock", allowedDomain: "", roster: [] },
  createdAt: now(), updatedAt: now(), ...over,
});
const sessionDoc = (uid, over = {}) => ({
  examCode: CODE, examTitle: "Test exam", uid, email: `${uid}@school.edu`, displayName: "S", studentId: "1", section: "A",
  status: "in_progress", startedAt: serverTimestamp(), heartbeatAt: serverTimestamp(), lastSavedAt: serverTimestamp(),
  violations: 0, answers: {}, clientId: "c1", client: {}, progress: { answered: 0, total: 2 }, ...over,
});

/** Seed data bypassing rules. */
async function seed(fn) { await env.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore())); }
async function seedExam(over = {}) {
  await seed(async (db) => {
    await setDoc(doc(db, "users", "prof1"), { email: "prof1@uni.edu", role: "professor", displayName: "Prof", createdAt: now() });
    await setDoc(doc(db, "users", "prof2"), { email: "prof2@uni.edu", role: "professor", displayName: "Prof2", createdAt: now() });
    await setDoc(doc(db, "users", "stu1"), { email: "stu1@school.edu", role: "student", displayName: "S", createdAt: now() });
    await setDoc(doc(db, "exams", CODE), examDoc(over));
    await setDoc(doc(db, "exams", CODE, "content", "questions"), { questions: [{ id: "q1", type: "mc", prompt: "?", options: ["a", "b"], points: 1 }] });
    await setDoc(doc(db, "exams", CODE, "private", "answerKey"), { answers: { q1: { correct: 1 } } });
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: process.env.FIRESTORE_EMULATOR_HOST?.split(":")[0] || "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":")[1] || 8080) },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

// ------------------------------------------------------------------ answer key
test("students can never read the answer key; owner can; other professors cannot", async () => {
  await seedExam();
  await assertFails(getDoc(doc(stu(), "exams", CODE, "private", "answerKey")));
  await assertFails(getDoc(doc(anon(), "exams", CODE, "private", "answerKey")));
  await assertFails(getDoc(doc(otherProf(), "exams", CODE, "private", "answerKey")));
  await assertSucceeds(getDoc(doc(prof(), "exams", CODE, "private", "answerKey")));
});

test("questions are only readable after the student has a session", async () => {
  await seedExam();
  await assertFails(getDoc(doc(stu(), "exams", CODE, "content", "questions")));
  await assertSucceeds(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
  await assertSucceeds(getDoc(doc(stu(), "exams", CODE, "content", "questions")));
  // a different student still cannot
  await assertFails(getDoc(doc(stu("stu2"), "exams", CODE, "content", "questions")));
});

// ------------------------------------------------------------------ exam visibility
test("students can get an open exam by code but cannot list exams", async () => {
  await seedExam();
  await assertSucceeds(getDoc(doc(stu(), "exams", CODE)));
  await assertFails(getDocs(collection(stu(), "exams")));
  await assertFails(getDocs(query(collection(stu(), "exams"), where("status", "==", "open"))));
  await assertFails(getDoc(doc(anon(), "exams", CODE)));
});

test("draft / closed / out-of-window exams are invisible to students", async () => {
  await seedExam({ status: "draft" });
  await assertFails(getDoc(doc(stu(), "exams", CODE)));
  await seedExam({ status: "open", opensAt: plus(10) });
  await assertFails(getDoc(doc(stu(), "exams", CODE)));
  await seedExam({ status: "open", closesAt: minus(1) });
  await assertFails(getDoc(doc(stu(), "exams", CODE)));
  await seedExam({ status: "closed" });
  await assertFails(getDoc(doc(stu(), "exams", CODE)));
  await assertSucceeds(getDoc(doc(prof(), "exams", CODE)));
});

test("only professors create exams; only the owner edits/deletes; key fields cannot be smuggled in", async () => {
  await seedExam();
  await assertFails(setDoc(doc(stu(), "exams", "NEW111"), examDoc({ ownerUid: "stu1" })));
  await assertSucceeds(setDoc(doc(prof(), "exams", "NEW111"), examDoc()));
  await assertFails(setDoc(doc(prof(), "exams", "NEW222"), examDoc({ answers: { q1: 1 } })));
  await assertFails(setDoc(doc(prof(), "exams", "NEW333"), examDoc({ ownerUid: "prof2" })));
  await assertFails(updateDoc(doc(otherProf(), "exams", CODE), { title: "hijack" }));
  await assertFails(updateDoc(doc(stu(), "exams", CODE), { title: "hijack" }));
  await assertSucceeds(updateDoc(doc(prof(), "exams", CODE), { title: "renamed" }));
  await assertFails(updateDoc(doc(prof(), "exams", CODE), { ownerUid: "prof2" }));
  await assertFails(deleteDoc(doc(otherProf(), "exams", CODE)));
  await assertSucceeds(deleteDoc(doc(prof(), "exams", CODE)));
});

test("exam + questions + answer key can be created and deleted in one batch by the owner only", async () => {
  await seedExam();
  const mk = (db, owner) => {
    const b = writeBatch(db);
    b.set(doc(db, "exams", "BATCH1"), examDoc({ ownerUid: owner }));
    b.set(doc(db, "exams", "BATCH1", "content", "questions"), { questions: [] });
    b.set(doc(db, "exams", "BATCH1", "private", "answerKey"), { answers: {} });
    return b.commit();
  };
  await assertFails(mk(stu(), "stu1"));
  await assertFails(mk(otherProf(), "prof1"));            // cannot create on someone else's behalf
  await assertSucceeds(mk(prof(), "prof1"));
  // key never readable by students even via the content doc smuggling check
  await assertFails(setDoc(doc(prof(), "exams", "BATCH1", "content", "questions"), { questions: [], answers: { q1: 1 } }));
  await assertFails(setDoc(doc(otherProf(), "exams", "BATCH1", "private", "answerKey"), { answers: {} }));
  // batch delete of everything by owner
  const del = (db) => { const b = writeBatch(db); b.delete(doc(db, "exams", "BATCH1", "content", "questions")); b.delete(doc(db, "exams", "BATCH1", "private", "answerKey")); b.delete(doc(db, "exams", "BATCH1")); return b.commit(); };
  await assertFails(del(otherProf()));
  await assertSucceeds(del(prof()));
});

test("professor lists only their own exams", async () => {
  await seedExam();
  await assertSucceeds(getDocs(query(collection(prof(), "exams"), where("ownerUid", "==", "prof1"))));
  await assertFails(getDocs(query(collection(otherProf(), "exams"), where("ownerUid", "==", "prof1"))));
  await assertFails(getDocs(collection(prof(), "exams")));
});

// ------------------------------------------------------------------ sessions: create
test("session creation: correct id, verified e-mail, open exam, server timestamps", async () => {
  await seedExam();
  const good = sessionDoc("stu1");
  await assertSucceeds(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), good));
  // second attempt (doc exists -> create denied, update rules apply and forbid resetting startedAt)
  await assertFails(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), good));
  // wrong id
  await assertFails(setDoc(doc(stu("stu2"), "sessions", `${CODE}_stu1`), sessionDoc("stu2")));
  await assertFails(setDoc(doc(stu("stu2"), "sessions", `${CODE}_stu2_extra`), sessionDoc("stu2")));
  // forged start time / status / violations / answers
  await assertFails(setDoc(doc(stu("stu3"), "sessions", `${CODE}_stu3`), sessionDoc("stu3", { startedAt: plus(20) })));
  await assertFails(setDoc(doc(stu("stu3"), "sessions", `${CODE}_stu3`), sessionDoc("stu3", { status: "submitted" })));
  await assertFails(setDoc(doc(stu("stu3"), "sessions", `${CODE}_stu3`), sessionDoc("stu3", { violations: -5 })));
  await assertFails(setDoc(doc(stu("stu3"), "sessions", `${CODE}_stu3`), sessionDoc("stu3", { answers: { q1: 1 } })));
  await assertFails(setDoc(doc(stu("stu3"), "sessions", `${CODE}_stu3`), sessionDoc("stu3", { extraMinutes: 500 })));
  await assertFails(setDoc(doc(stu("stu3"), "sessions", `${CODE}_stu3`), sessionDoc("stu3", { grade: { score: 100 } })));
  // unverified e-mail
  await assertFails(setDoc(doc(unverified(), "sessions", `${CODE}_stu9`), sessionDoc("stu9")));
  await assertFails(setDoc(doc(anon(), "sessions", `${CODE}_x`), sessionDoc("x")));
});

test("session creation blocked when exam closed, not yet open, draft, or student not allowed", async () => {
  await seedExam({ status: "closed" });
  await assertFails(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
  await seedExam({ opensAt: plus(5) });
  await assertFails(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
  await seedExam({ settings: { durationMinutes: 30, maxViolations: 5, violationAction: "lock", allowedDomain: "other.edu", roster: [] } });
  await assertFails(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
  await seedExam({ settings: { durationMinutes: 30, maxViolations: 5, violationAction: "lock", allowedDomain: "school.edu", roster: [] } });
  await assertSucceeds(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
  await seed((db) => deleteDoc(doc(db, "sessions", `${CODE}_stu1`)));
  await seedExam({ settings: { durationMinutes: 30, maxViolations: 5, violationAction: "lock", allowedDomain: "", roster: ["someone@school.edu"] } });
  await assertFails(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
  await seedExam({ settings: { durationMinutes: 30, maxViolations: 5, violationAction: "lock", allowedDomain: "", roster: ["stu1@school.edu"] } });
  await assertSucceeds(setDoc(doc(stu(), "sessions", `${CODE}_stu1`), sessionDoc("stu1")));
});

// ------------------------------------------------------------------ sessions: update
async function seedSession(over = {}) {
  await seed(async (db) => setDoc(doc(db, "sessions", `${CODE}_stu1`), {
    ...sessionDoc("stu1"), startedAt: minus(5), heartbeatAt: minus(1), lastSavedAt: minus(1), ...over,
  }));
}

test("student may save answers, heartbeat, raise violations, submit and lock - nothing else", async () => {
  await seedExam(); await seedSession();
  const ref = doc(stu(), "sessions", `${CODE}_stu1`);
  await assertSucceeds(updateDoc(ref, { answers: { q1: 1 }, lastSavedAt: serverTimestamp(), progress: { answered: 1, total: 2 } }));
  await assertSucceeds(updateDoc(ref, { heartbeatAt: serverTimestamp(), clientId: "c2" }));
  await assertSucceeds(updateDoc(ref, { violations: increment(1) }));
  await assertFails(updateDoc(ref, { violations: 0 }));                              // cannot lower
  await assertFails(updateDoc(ref, { startedAt: serverTimestamp() }));                // cannot restart the clock
  await assertFails(updateDoc(ref, { extraMinutes: 60 }));                            // cannot give self time
  await assertFails(updateDoc(ref, { uid: "stu2" }));
  await assertFails(updateDoc(ref, { examCode: "OTHER1" }));
  await assertFails(updateDoc(ref, { status: "terminated" }));
  await assertFails(updateDoc(ref, { status: "submitted" }));                         // needs submittedAt == now
  await assertFails(updateDoc(ref, { status: "submitted", submittedAt: minus(60) }));  // cannot backdate
  await assertSucceeds(updateDoc(ref, { status: "submitted", submittedAt: serverTimestamp(), answers: { q1: 0 } }));
  // frozen after submit
  await assertFails(updateDoc(ref, { answers: { q1: 1 } }));
  await assertFails(updateDoc(ref, { status: "in_progress" }));
});

test("student lock requires lockedAt == now and freezes the session", async () => {
  await seedExam(); await seedSession();
  const ref = doc(stu(), "sessions", `${CODE}_stu1`);
  await assertFails(updateDoc(ref, { status: "locked" }));
  await assertSucceeds(updateDoc(ref, { status: "locked", lockedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { answers: { q1: 1 } }));
  await assertFails(updateDoc(ref, { status: "in_progress" }));  // only the professor unlocks
  await assertSucceeds(updateDoc(doc(prof(), "sessions", `${CODE}_stu1`), { status: "in_progress", unlockedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref, { answers: { q1: 1 } }));
});

test("writes after the server-side deadline are rejected; extra time from the professor re-opens the window", async () => {
  await seedExam();                       // 30 minute exam
  await seedSession({ startedAt: minus(40) });  // started 40 min ago -> 30 + 1.5 grace passed
  const ref = doc(stu(), "sessions", `${CODE}_stu1`);
  await assertFails(updateDoc(ref, { answers: { q1: 1 } }));
  await assertFails(updateDoc(ref, { status: "submitted", submittedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(prof(), "sessions", `${CODE}_stu1`), { extraMinutes: 20 }));
  await assertSucceeds(updateDoc(ref, { answers: { q1: 1 } }));
  // hard close of the exam also cuts off writes
  await seed((db) => updateDoc(doc(db, "exams", CODE), { closesAt: minus(5) }));
  await assertFails(updateDoc(ref, { answers: { q1: 0 } }));
});

test("students cannot read or touch other students' sessions; professor owner can, other professors cannot", async () => {
  await seedExam(); await seedSession();
  await assertFails(getDoc(doc(stu("stu2"), "sessions", `${CODE}_stu1`)));
  await assertFails(updateDoc(doc(stu("stu2"), "sessions", `${CODE}_stu1`), { answers: { q1: 0 } }));
  await assertFails(getDocs(query(collection(stu("stu2"), "sessions"), where("examCode", "==", CODE))));
  await assertSucceeds(getDocs(query(collection(stu(), "sessions"), where("uid", "==", "stu1"))));
  await assertSucceeds(getDoc(doc(prof(), "sessions", `${CODE}_stu1`)));
  await assertSucceeds(getDocs(query(collection(prof(), "sessions"), where("examCode", "==", CODE))));
  await assertFails(getDocs(query(collection(otherProf(), "sessions"), where("examCode", "==", CODE))));
  await assertFails(getDoc(doc(otherProf(), "sessions", `${CODE}_stu1`)));
  await assertFails(deleteDoc(doc(stu(), "sessions", `${CODE}_stu1`)));
  await assertFails(deleteDoc(doc(otherProf(), "sessions", `${CODE}_stu1`)));
  await assertSucceeds(deleteDoc(doc(prof(), "sessions", `${CODE}_stu1`)));
});

test("reading a session that does not exist yet is allowed for its owner (and denied to others)", async () => {
  await seedExam();
  // the student client checks "have I already started?" before any session exists
  await assertSucceeds(getDoc(doc(stu(), "sessions", `${CODE}_stu1`)));
  await assertSucceeds(getDoc(doc(prof(), "sessions", `${CODE}_stu1`)));
  await assertFails(getDoc(doc(stu("stu2"), "sessions", `${CODE}_stu1`)));
  await assertFails(getDoc(doc(otherProf(), "sessions", `${CODE}_stu1`)));
  await assertFails(getDoc(doc(anon(), "sessions", `${CODE}_stu1`)));
  // same for a grade that has not been written
  await assertFails(getDoc(doc(stu(), "grades", `${CODE}_stu1`)));
  await seed((db) => updateDoc(doc(db, "exams", CODE), { scoresReleased: true }));
  await assertSucceeds(getDoc(doc(stu(), "grades", `${CODE}_stu1`)));
});

test("professor actions are limited to control fields", async () => {
  await seedExam(); await seedSession();
  const ref = doc(prof(), "sessions", `${CODE}_stu1`);
  await assertSucceeds(updateDoc(ref, { status: "terminated", terminatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref, { flagged: true, note: "looked away a lot", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { answers: { q1: 1 } }));      // professors don't edit answers
  await assertFails(updateDoc(ref, { extraMinutes: 5000 }));
  await assertFails(updateDoc(ref, { extraMinutes: -1 }));
});

// ------------------------------------------------------------------ events
test("events: student appends to own log with server time; nobody edits; owner reads", async () => {
  await seedExam(); await seedSession();
  const col = collection(stu(), "sessions", `${CODE}_stu1`, "events");
  await assertSucceeds(addDoc(col, { type: "tab_hidden", detail: { ms: 1200 }, at: serverTimestamp(), clientId: "c1" }));
  await assertFails(addDoc(col, { type: "tab_hidden", detail: {}, at: minus(30), clientId: "c1" }));       // no backdating
  await assertFails(addDoc(col, { type: "tab_hidden", at: serverTimestamp(), score: 100 }));                 // unknown key
  await assertFails(addDoc(collection(stu("stu2"), "sessions", `${CODE}_stu1`, "events"), { type: "x", at: serverTimestamp() }));
  await assertSucceeds(getDocs(collection(prof(), "sessions", `${CODE}_stu1`, "events")));
  await assertFails(getDocs(collection(otherProf(), "sessions", `${CODE}_stu1`, "events")));
  const evs = await getDocs(collection(prof(), "sessions", `${CODE}_stu1`, "events"));
  await assertFails(updateDoc(doc(stu(), "sessions", `${CODE}_stu1`, "events", evs.docs[0].id), { type: "started" }));
  await assertFails(deleteDoc(doc(stu(), "sessions", `${CODE}_stu1`, "events", evs.docs[0].id)));
});

// ------------------------------------------------------------------ grades
test("grades: only the owning professor writes; students read their own only once released", async () => {
  await seedExam(); await seedSession();
  const grade = { sid: `${CODE}_stu1`, examCode: CODE, uid: "stu1", score: 1, max: 2, percent: 50, perQuestion: {}, gradedBy: "prof1", gradedAt: serverTimestamp() };
  await assertFails(setDoc(doc(stu(), "grades", `${CODE}_stu1`), { ...grade, gradedBy: "stu1", score: 2 }));
  await assertFails(setDoc(doc(otherProf(), "grades", `${CODE}_stu1`), { ...grade, gradedBy: "prof2" }));
  await assertFails(setDoc(doc(prof(), "grades", `${CODE}_stu1`), { ...grade, gradedBy: "prof2" }));
  await assertFails(setDoc(doc(prof(), "grades", `${CODE}_stu1`), { ...grade, examCode: "OTHER1" }));
  await assertSucceeds(setDoc(doc(prof(), "grades", `${CODE}_stu1`), grade));
  await assertFails(getDoc(doc(stu(), "grades", `${CODE}_stu1`)));          // not released
  await assertFails(getDoc(doc(stu("stu2"), "grades", `${CODE}_stu1`)));
  await seed((db) => updateDoc(doc(db, "exams", CODE), { scoresReleased: true }));
  await assertSucceeds(getDoc(doc(stu(), "grades", `${CODE}_stu1`)));
  await assertFails(getDoc(doc(stu("stu2"), "grades", `${CODE}_stu1`)));   // still not someone else's
  await assertSucceeds(getDocs(query(collection(prof(), "grades"), where("examCode", "==", CODE))));
  await assertFails(getDocs(query(collection(otherProf(), "grades"), where("examCode", "==", CODE))));
  await assertFails(getDocs(query(collection(stu(), "grades"), where("examCode", "==", CODE))));
});

// ------------------------------------------------------------------ users / roles
test("users: self-create as student only; role changes only by professors; bootstrap admin can self-promote", async () => {
  await seedExam();
  const s2 = stu("stu2");
  await assertFails(setDoc(doc(s2, "users", "stu2"), { email: "stu2@school.edu", role: "professor", displayName: "", createdAt: now() }));
  await assertFails(setDoc(doc(s2, "users", "stu2"), { email: "someone@else.edu", role: "student", displayName: "", createdAt: now() }));
  await assertSucceeds(setDoc(doc(s2, "users", "stu2"), { email: "stu2@school.edu", role: "student", displayName: "", createdAt: now() }));
  await assertFails(updateDoc(doc(s2, "users", "stu2"), { role: "professor" }));
  await assertSucceeds(updateDoc(doc(s2, "users", "stu2"), { displayName: "New Name", studentId: "22", updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(s2, "users", "stu1")));                       // students can't read others
  await assertSucceeds(updateDoc(doc(prof(), "users", "stu2"), { role: "professor", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(prof(), "users", "stu2"), { displayName: "x" }));  // professors can't edit others' profiles
  // bootstrap admin
  const b = bootstrap();
  await assertSucceeds(setDoc(doc(b, "users", "boot"), { email: ADMIN_EMAIL, role: "professor", displayName: "", createdAt: now() }));
  await assertSucceeds(setDoc(doc(b, "exams", "BOOT01"), examDoc({ ownerUid: "boot" })));
  // an unverified account with the admin e-mail gets nothing
  const fake = env.authenticatedContext("fake", { email: ADMIN_EMAIL, email_verified: false }).firestore();
  await assertFails(setDoc(doc(fake, "users", "fake"), { email: ADMIN_EMAIL, role: "professor", displayName: "", createdAt: now() }));
});

test("unknown collections are locked down", async () => {
  await assertFails(setDoc(doc(prof(), "misc", "x"), { a: 1 }));
  await assertFails(getDoc(doc(stu(), "misc", "x")));
});
