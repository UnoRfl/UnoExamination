// Student exam runner: pre-check gate -> proctored exam -> submission / review.
import {
  db, doc, getDoc, setDoc, updateDoc, addDoc, collection, onSnapshot,
  serverTimestamp, increment,
} from "./firebase-init.js";
import { siteConfig } from "./firebase-config.js";
import { watchAuth, ensureProfile, renderAuthPanel, logout, resendVerification, updateMyProfile } from "./auth.js";
import { buildPaper, paperMaxPoints } from "./paper.js";
import { STRIKE_EVENTS } from "./grading.js";
import { Proctor, detectReload, clientFingerprint } from "./proctor.js";
import { $, $$, h, esc, toast, dialog, confirmDialog, mmss, fmtDate, clear, qs, randomId } from "./ui.js";

const app = $("#app");
const CODE = (qs("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const REVIEW = qs("review") === "1";
const CLIENT_ID = randomId(10);

const S = {
  user: null, profile: null, exam: null, sid: null, session: null, paper: [],
  answers: {}, dirty: new Set(), saveTimer: null, saving: false,
  proctor: null, unsub: null, hbTimer: null, tickTimer: null, lastHb: 0,
  clockOffset: 0, deadlineMs: 0, violations: 0, current: 0, ended: false, takenOver: false,
};

// ---------------------------------------------------------------- bootstrap
if (!CODE) {
  app.innerHTML = `<div class="container narrow"><div class="card"><h2>No exam code</h2><p>Go back to the <a href="./">home page</a> and enter your exam code.</p></div></div>`;
} else {
  watchAuth(async (user) => {
    if (!user) return renderSignIn();
    S.user = user;
    try {
      S.profile = await ensureProfile(user);
      await loadExam();
    } catch (e) { fatal(e); }
  });
}

function fatal(e) {
  console.error(e);
  const msg = e?.code === "permission-denied"
    ? "This exam is not open (or the code is wrong). Ask your professor to confirm the code and that the exam is published."
    : e?.message || String(e);
  app.innerHTML = `<div class="container narrow"><div class="card"><h2>Cannot load exam</h2><div class="form-error">${esc(msg)}</div>
    <p style="margin-top:1rem"><a class="btn" href="./">Back to home</a></p></div></div>`;
}

function renderSignIn() {
  clear(app);
  const host = h("div");
  app.append(h("div.container.narrow", h("div.card", h("h2", "Sign in to take the exam"), h("p.muted", `Exam code: ${CODE}`), host)));
  renderAuthPanel(host);
}

async function loadExam() {
  const snap = await getDoc(doc(db, "exams", CODE));
  if (!snap.exists()) throw new Error("Exam not found. Check the code with your professor.");
  S.exam = { id: snap.id, ...snap.data() };
  S.sid = `${CODE}_${S.user.uid}`;
  const sess = await getDoc(doc(db, "sessions", S.sid));
  S.session = sess.exists() ? sess.data() : null;

  if (S.session) {
    S.violations = S.session.violations || 0;
    S.answers = { ...(S.session.answers || {}) };
    switch (S.session.status) {
      case "in_progress": return renderGate("resume");
      case "locked": return renderLocked();
      case "terminated": return renderTerminated();
      case "submitted": return REVIEW ? renderReview() : renderDone();
    }
  }
  renderGate("start");
}

// ---------------------------------------------------------------- gate
function renderGate(mode) {
  clear(app);
  const ex = S.exam, st = ex.settings;
  const u = S.user;
  if (!u.emailVerified) {
    app.append(h("div.container.narrow", h("div.card",
      h("h2", "Verify your e-mail first"),
      h("p", "For identity reasons you can only take exams from a verified e-mail address. Open the verification link we sent you, then come back."),
      h("div.row",
        h("button.btn", { onclick: async () => { await resendVerification(); toast("Verification e-mail sent.", "success"); } }, "Resend verification e-mail"),
        h("button.btn.btn-primary", { onclick: async () => { await u.reload(); location.reload(); } }, "I've verified – continue"),
      ),
    )));
    return;
  }

  const needDetails = st.requireStudentId && (!S.profile.studentId || !S.profile.displayName || !S.profile.section);
  const nameI = h("input.input", { value: S.profile.displayName || u.displayName || "", placeholder: "Last Name, First Name" });
  const idI = h("input.input", { value: S.profile.studentId || "", placeholder: "Student number" });
  const secI = h("input.input", { value: S.profile.section || "", placeholder: "Section code" });
  const agree = h("input", { type: "checkbox" });
  const btn = h("button.btn.btn-primary.btn-lg", { disabled: true, onclick: async () => {
    btn.disabled = true;
    makeProctor();
    // Fullscreen must be requested synchronously-ish from the click (user activation).
    if (st.requireFullscreen) await S.proctor.requestFullscreen();
    try {
      if (mode === "resume") await resumeExam();
      else await startExam({ name: nameI.value.trim(), studentId: idI.value.trim(), section: secI.value.trim() });
    } catch (e) { fatal(e); }
    btn.disabled = false;
  } }, mode === "resume" ? "Resume examination" : "Start examination");
  agree.addEventListener("change", () => (btn.disabled = !agree.checked));

  const monitored = [
    "switching tabs or windows, minimising, or leaving fullscreen",
    "copy / cut / paste and the right-click menu",
    "opening developer tools or blocked keyboard shortcuts",
    "reloading the page, opening the exam in a second tab, or going offline",
  ];
  const policy = st.violationAction === "lock" ? `After ${st.maxViolations} violations the exam locks and only your professor can unlock it.`
    : st.violationAction === "submit" ? `After ${st.maxViolations} violations the exam is submitted automatically.`
    : `Every violation is reported to your professor.`;

  app.append(h("div.container.narrow",
    siteConfig.bannerUrl ? h("img.banner-img", { src: siteConfig.bannerUrl, alt: "" }) : null,
    h("div.card",
      h("div.card-head", h("div", h("h1", ex.title), h("p.muted", [ex.course, ex.ownerName && `by ${ex.ownerName}`].filter(Boolean).join(" · "))),
        h("span.pill-code", CODE)),
      ex.instructions ? h("p", { style: { whiteSpace: "pre-wrap" } }, ex.instructions) : null,
      h("div.grid.grid-3",
        h("div.stat", h("div.n", `${st.durationMinutes} min`), h("div.l", "Time limit")),
        h("div.stat", h("div.n", String(st.questionsPerStudent || ex.questionCount || "?")), h("div.l", "Questions")),
        h("div.stat", h("div.n", String(ex.totalPoints ?? "?")), h("div.l", "Points")),
      ),
      mode === "resume" ? h("div.form-error", { style: { marginTop: "1rem", background: "var(--warn-soft)", color: "var(--warn)" } },
        "You already started this exam. The clock has been running since ", fmtDate(S.session.startedAt), ". Your saved answers will be restored.") : null,
    ),
    needDetails || mode === "start" ? h("div.card",
      h("h3", "Your details"),
      h("div.grid.grid-3",
        h("label.field", h("span", "Full name"), nameI),
        h("label.field", h("span", "Student ID" + (st.requireStudentId ? " *" : "")), idI),
        h("label.field", h("span", "Section" + (st.requireStudentId ? " *" : "")), secI),
      ),
      h("p.help", `Signed in as ${u.email}. Wrong account? `, h("a", { href: "#", onclick: (e) => { e.preventDefault(); logout(); } }, "Sign out")),
    ) : null,
    h("div.card",
      h("h3", "Examination rules"),
      h("ul", { style: { paddingLeft: "1.2rem" } },
        h("li", `The timer starts when you click ${mode === "resume" ? "Resume" : "Start"} and is kept on the server – closing the page does not pause it.`),
        h("li", "One attempt only. Your answers are saved automatically as you type."),
        st.requireFullscreen ? h("li", "The exam runs in fullscreen. Leaving fullscreen is a violation.") : null,
        h("li", "The following are recorded with timestamps and shown to your professor: ", h("ul", monitored.map((m) => h("li", m)))),
        h("li", policy),
      ),
      h("label.check", { style: { margin: "1rem 0" } }, agree, h("span", "I understand and agree to the rules above. I will not use unauthorised materials or devices.")),
      h("div.row", btn, h("a.btn", { href: "./" }, "Cancel")),
    ),
  ));
}

async function startExam({ name, studentId, section }) {
  const st = S.exam.settings;
  if (st.requireStudentId && (!name || !studentId || !section)) return toast("Please fill in your name, student ID and section.", "warn");
  try {
    if (name !== S.profile.displayName || studentId !== S.profile.studentId || section !== S.profile.section) {
      await updateMyProfile(S.user.uid, { displayName: name, studentId, section });
      Object.assign(S.profile, { displayName: name, studentId, section });
    }
    const ref = doc(db, "sessions", S.sid);
    await setDoc(ref, {
      examCode: CODE, examTitle: S.exam.title, uid: S.user.uid, email: (S.user.email || "").toLowerCase(),
      displayName: name || S.user.displayName || "", studentId: studentId || "", section: section || "",
      status: "in_progress", startedAt: serverTimestamp(), heartbeatAt: serverTimestamp(), lastSavedAt: serverTimestamp(),
      violations: 0, answers: {}, clientId: CLIENT_ID, client: clientFingerprint(), progress: { answered: 0, total: 0 },
    });
    const snap = await getDoc(ref);
    S.session = snap.data();
    S.answers = {};
    await enterExam("started");
  } catch (e) {
    S.proctor?.exitFullscreen();
    if (e.code === "permission-denied") {
      toast("The server refused to start this exam: it may be closed, outside its schedule, or your account is not on the roster.", "error", 8000);
    } else throw e;
  }
}

async function resumeExam() {
  const snap = await getDoc(doc(db, "sessions", S.sid));
  S.session = snap.data();
  if (S.session.status !== "in_progress") return loadExam();
  S.answers = { ...(S.session.answers || {}) };
  S.violations = S.session.violations || 0;
  // Another tab still alive? (heartbeat within the last 60 s)
  const hb = S.session.heartbeatAt?.toMillis?.() || 0;
  const recent = Date.now() - hb < 60_000;
  await enterExam(recent ? "multiple_tabs" : "resumed");
}

// ---------------------------------------------------------------- exam
function makeProctor() {
  const st = S.exam.settings;
  S.proctor?.stop();
  S.proctor = new Proctor({
    requireFullscreen: !!st.requireFullscreen,
    blockClipboard: st.blockClipboard !== false,
    blockContextMenu: true,
    strikeTypes: STRIKE_EVENTS,
    onEvent: (type, detail) => logEvent(type, detail),
    onStrike: (_, type) => onViolation(type),
  });
}

async function enterExam(startEvent) {
  const st = S.exam.settings;
  if (!S.proctor) makeProctor();
  S.ended = false;

  const qsnap = await getDoc(doc(db, "exams", CODE, "content", "questions"));
  if (!qsnap.exists()) throw new Error("This exam has no questions yet.");
  S.paper = buildPaper(qsnap.data().questions || [], st, S.sid);

  await syncClock();
  computeDeadline();

  const reloaded = detectReload(S.sid);
  S.proctor.start();
  logEvent(startEvent, { reload: reloaded, client: clientFingerprint() });
  if (startEvent === "multiple_tabs") onViolation("multiple_tabs");
  if (reloaded && startEvent === "resumed") logEvent("page_reload");

  renderExam();
  startHeartbeat();
  listenSession();
  S.tickTimer = setInterval(tick, 500);
  tick();
}

async function syncClock() {
  try {
    const ref = doc(db, "sessions", S.sid);
    const t0 = Date.now();
    await updateDoc(ref, { heartbeatAt: serverTimestamp(), clientId: CLIENT_ID });
    const t1 = Date.now();
    const snap = await getDoc(ref);
    const server = snap.data().heartbeatAt?.toMillis?.();
    if (server) {
      S.clockOffset = server - (t0 + t1) / 2;
      if (Math.abs(S.clockOffset) > 120_000) logEvent("clock_skew", { offsetMs: Math.round(S.clockOffset) });
    }
    S.lastHb = Date.now();
  } catch (e) { console.warn("clock sync failed", e); }
}
const serverNow = () => Date.now() + S.clockOffset;
function computeDeadline() {
  const start = S.session.startedAt?.toMillis?.() || serverNow();
  const mins = (S.exam.settings.durationMinutes || 0) + (S.session.extraMinutes || 0);
  S.deadlineMs = Math.min(start + mins * 60_000, S.exam.closesAt?.toMillis?.() || Infinity);
}

function renderExam() {
  clear(app);
  const st = S.exam.settings;
  const total = S.paper.length;
  const head = h("div.exam-head",
    h("div", h("div.title", S.exam.title), h("div.small.muted", `${S.profile.displayName || S.user.email}${S.profile.section ? " · " + S.profile.section : ""}`)),
    h("div.spacer"),
    h("div.strike-bar#strikes", { title: "Violations" }),
    h("div.save-state#saveState", "All changes saved"),
    h("div.timer#timer", "--:--"),
    h("button.btn.btn-primary", { onclick: () => submit("manual") }, "Submit"),
  );
  const list = h("div#qlist");
  const nav = h("div.exam-nav", h("div.card",
    h("div.small.muted", { style: { marginBottom: ".5rem" } }, h("span#answeredCount", "0"), ` of ${total} answered`),
    h("div.nav-grid#navGrid", S.paper.map((q, i) => h("button", { type: "button", onclick: () => goTo(i) }, String(i + 1)))),
    st.oneAtATime ? h("div.row", { style: { marginTop: ".8rem" } },
      h("button.btn.btn-sm#prevBtn", { onclick: () => goTo(S.current - 1) }, "← Prev"),
      h("button.btn.btn-sm#nextBtn", { onclick: () => goTo(S.current + 1) }, "Next →")) : null,
  ));
  app.append(head, h("div.exam-body", h("div", list), nav));
  renderStrikes();

  if (st.oneAtATime) goTo(0);
  else { S.paper.forEach((q, i) => list.append(questionCard(q, i))); }
  updateNav();
}

function goTo(i) {
  if (!S.exam.settings.oneAtATime) {
    const el = $(`[data-qid="${S.paper[i].id}"]`); el?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
  }
  S.current = Math.max(0, Math.min(S.paper.length - 1, i));
  const list = $("#qlist"); clear(list); list.append(questionCard(S.paper[S.current], S.current));
  $("#prevBtn").disabled = S.current === 0; $("#nextBtn").disabled = S.current === S.paper.length - 1;
  updateNav();
}

function questionCard(q, i) {
  const ans = S.answers[q.id];
  const card = h("div.q-card", { dataset: { qid: q.id } },
    h("div.q-num", h("span", `Question ${i + 1} of ${S.paper.length}`), h("span", `${q.points} pt${q.points === 1 ? "" : "s"}`)),
    h("div.q-prompt", q.prompt),
  );
  const set = (v) => setAnswer(q.id, v);
  switch (q.type) {
    case "mc":
      card.append(h("div.options", q.options.map((o) => optionRow("radio", `q_${q.id}`, o.text, ans === o.oi, () => set(o.oi)))));
      break;
    case "multi": {
      const cur = new Set(Array.isArray(ans) ? ans : []);
      card.append(h("p.help", "Select all that apply."), h("div.options", q.options.map((o) => optionRow("checkbox", `q_${q.id}`, o.text, cur.has(o.oi), (checked) => {
        checked ? cur.add(o.oi) : cur.delete(o.oi); set([...cur].sort((a, b) => a - b));
      }))));
      break;
    }
    case "tf":
      card.append(h("div.options", [["true", "True"], ["false", "False"]].map(([v, l]) => optionRow("radio", `q_${q.id}`, l, String(ans) === v, () => set(v === "true")))));
      break;
    case "text":
      card.append(h("input.input", { value: ans ?? "", placeholder: "Type your answer…", autocomplete: "off", spellcheck: false, oninput: (e) => set(e.target.value) }));
      break;
    case "essay":
      card.append(h("textarea", { placeholder: "Write your answer…", rows: 8, oninput: (e) => set(e.target.value) }, ans ?? ""));
      break;
  }
  return card;
}
function optionRow(type, name, label, checked, onchange) {
  const input = h("input", { type, name, checked });
  const row = h("label.option", { class: `option${checked ? " selected" : ""}` }, input, h("span", label));
  input.addEventListener("change", () => {
    if (type === "radio") $$(`input[name="${name}"]`).forEach((r) => r.closest(".option").classList.toggle("selected", r.checked));
    else row.classList.toggle("selected", input.checked);
    onchange(input.checked);
  });
  return row;
}

function setAnswer(qid, v) {
  if (S.ended) return;
  if (v === "" || v == null) delete S.answers[qid]; else S.answers[qid] = v;
  S.dirty.add(qid);
  updateNav();
  setSaveState("saving");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushAnswers, 800);
}
function answeredCount() { return S.paper.filter((q) => S.answers[q.id] !== undefined && S.answers[q.id] !== "" && !(Array.isArray(S.answers[q.id]) && !S.answers[q.id].length)).length; }
function updateNav() {
  const btns = $$("#navGrid button");
  S.paper.forEach((q, i) => {
    const a = S.answers[q.id];
    btns[i]?.classList.toggle("answered", a !== undefined && a !== "" && !(Array.isArray(a) && !a.length));
    btns[i]?.classList.toggle("current", S.exam.settings.oneAtATime && i === S.current);
  });
  const c = $("#answeredCount"); if (c) c.textContent = String(answeredCount());
}
function setSaveState(state) {
  const el = $("#saveState"); if (!el) return;
  el.className = `save-state ${state}`;
  el.textContent = state === "saving" ? "Saving…" : state === "offline" ? "OFFLINE – reconnect to save!" : state === "error" ? "Save failed – retrying" : "All changes saved";
}

async function flushAnswers() {
  if (!S.dirty.size || S.ended) return;
  const patch = { lastSavedAt: serverTimestamp(), progress: { answered: answeredCount(), total: S.paper.length } };
  const keys = [...S.dirty]; S.dirty.clear();
  // Write the whole answers map (small) – simplest and matches rules' affectedKeys check.
  patch.answers = S.answers;
  try {
    S.saving = true;
    await withTimeout(updateDoc(doc(db, "sessions", S.sid), patch), 8000);
    setSaveState(S.dirty.size ? "saving" : "saved");
  } catch (e) {
    keys.forEach((k) => S.dirty.add(k));
    if (e.code === "permission-denied") return handleDeadlinePassed();
    setSaveState(navigator.onLine ? "error" : "offline");
    setTimeout(flushAnswers, 3000);
  } finally { S.saving = false; }
}
function withTimeout(p, ms) {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
}

// ---------------------------------------------------------------- timer / heartbeat / listener
function tick() {
  const el = $("#timer"); if (!el || S.ended) return;
  const remaining = (S.deadlineMs - serverNow()) / 1000;
  el.textContent = mmss(remaining);
  el.className = "timer" + (remaining < 60 ? " danger" : remaining < 300 ? " warn" : "");
  if (remaining <= 0) submit("time");
}
function startHeartbeat() {
  S.lastHb = Date.now();
  S.hbTimer = setInterval(async () => {
    if (S.ended) return;
    const gap = Date.now() - S.lastHb;
    if (gap > 70_000) logEvent("heartbeat_gap", { ms: gap });
    try {
      await withTimeout(updateDoc(doc(db, "sessions", S.sid), { heartbeatAt: serverTimestamp(), clientId: CLIENT_ID }), 8000);
      S.lastHb = Date.now();
      if (!S.dirty.size) setSaveState("saved");
    } catch (e) {
      if (e.code === "permission-denied") handleDeadlinePassed(); else setSaveState("offline");
    }
  }, 25_000);
}
function listenSession() {
  S.unsub = onSnapshot(doc(db, "sessions", S.sid), (snap) => {
    if (!snap.exists()) { endLocal(); return renderMessage("Session reset", "Your professor reset this attempt. Reload the page to start again.", true); }
    const d = snap.data();
    const prevExtra = S.session?.extraMinutes || 0;
    S.session = d;
    if (d.violations > S.violations) { S.violations = d.violations; renderStrikes(); }
    if ((d.extraMinutes || 0) !== prevExtra) { computeDeadline(); toast(`Your professor adjusted your time: +${d.extraMinutes || 0} min total.`, "success", 6000); }
    if (!snap.metadata.hasPendingWrites && d.clientId && d.clientId !== CLIENT_ID && !S.ended) {
      // Someone (or the same student) opened the exam elsewhere - this tab yields.
      S.takenOver = true; endLocal();
      return renderMessage("Exam continued in another window", "This exam was opened in another tab or device, so this window has been closed. Continue in the other window. This has been reported to your professor.", true);
    }
    if (S.ended) return;
    if (d.status === "locked") { endLocal(); renderLocked(); }
    else if (d.status === "terminated") { endLocal(); renderTerminated(); }
    else if (d.status === "submitted") { endLocal(); renderDone(); }
  });
}
function endLocal() {
  S.ended = true;
  clearInterval(S.hbTimer); clearInterval(S.tickTimer); clearTimeout(S.saveTimer);
  S.proctor?.stop(); S.proctor?.exitFullscreen();
}

// ---------------------------------------------------------------- violations / events
function sanitize(o) {
  if (o == null) return {};
  return JSON.parse(JSON.stringify(o, (_, v) => (v === undefined ? null : v)));
}
function logEvent(type, detail) {
  if (!S.sid) return;
  const ev = { type, at: serverTimestamp(), clientId: CLIENT_ID, detail: sanitize(detail) };
  if (detail?.q) ev.q = String(detail.q);
  addDoc(collection(db, "sessions", S.sid, "events"), ev).catch((e) => console.warn("event not logged", type, e.code));
}
function renderStrikes() {
  const bar = $("#strikes"); if (!bar) return;
  clear(bar);
  const max = S.exam.settings.maxViolations || 5;
  for (let i = 0; i < max; i++) bar.append(h("i", { class: i < S.violations ? "on" : "" }));
  bar.title = `${S.violations} of ${max} violations`;
}
async function onViolation(type) {
  if (S.ended) return;
  S.violations++;
  renderStrikes();
  $$(".q-card").forEach((c) => { c.classList.add("shake"); setTimeout(() => c.classList.remove("shake"), 500); });
  updateDoc(doc(db, "sessions", S.sid), { violations: increment(1) }).catch(() => {});

  const st = S.exam.settings, max = st.maxViolations || 5;
  if (S.violations >= max && st.violationAction === "submit") {
    await dialog({ title: "Violation limit reached", body: "The exam will now be submitted automatically with your saved answers.", dismissible: false });
    return submit("violations");
  }
  if (S.violations >= max && st.violationAction === "lock") {
    await flushAnswers();
    try { await updateDoc(doc(db, "sessions", S.sid), { status: "locked", lockedAt: serverTimestamp() }); }
    catch (e) { console.warn(e); }
    logEvent("locked", { reason: type });
    endLocal(); return renderLocked();
  }
  S.proctor.paused = true;
  const labels = { tab_hidden: "You switched tabs or minimised the window.", window_blur: "Another window or application took focus.", fullscreen_exit: "You left fullscreen mode.", devtools_suspected: "Developer tools appear to be open.", paste: "Pasting is not allowed during the exam.", multiple_tabs: "The exam was opened in more than one tab.", print_screen: "Screen capture is not allowed." };
  await dialog({
    title: "⚠ Security warning",
    body: h("div", h("p", labels[type] || "A prohibited action was detected."),
      h("p", h("strong", { style: { color: "var(--danger)" } }, `Violation ${S.violations} of ${max}. `),
        st.violationAction === "lock" ? "Reaching the limit locks your exam until your professor unlocks it." : st.violationAction === "submit" ? "Reaching the limit submits your exam automatically." : "All violations are reported to your professor.")),
    buttons: [{ label: st.requireFullscreen ? "Acknowledge & return to fullscreen" : "Acknowledge", value: true, kind: "primary" }], dismissible: false,
  });
  if (st.requireFullscreen) await S.proctor.requestFullscreen();
  setTimeout(() => { S.proctor.paused = false; }, 800);
}

// ---------------------------------------------------------------- submit / end states
async function submit(reason) {
  if (S.ended) return;
  if (reason === "manual") {
    const unanswered = S.paper.length - answeredCount();
    S.proctor.paused = true;
    const ok = await confirmDialog("Submit examination?",
      `${unanswered ? `<p><strong>${unanswered}</strong> question(s) are unanswered.</p>` : ""}<p>You cannot change your answers after submitting.</p>`, "Submit now", "primary");
    S.proctor.paused = false;
    if (!ok) return;
  }
  S.ended = true;
  clearTimeout(S.saveTimer);
  try {
    await updateDoc(doc(db, "sessions", S.sid), {
      answers: S.answers, status: "submitted", submittedAt: serverTimestamp(), lastSavedAt: serverTimestamp(),
      progress: { answered: answeredCount(), total: S.paper.length },
    });
    logEvent("submitted", { reason });
  } catch (e) {
    if (e.code !== "permission-denied") { S.ended = false; toast("Submission failed: " + e.message + " – retrying…", "error"); return setTimeout(() => submit(reason), 3000); }
  }
  endLocal();
  renderDone(reason);
}
function handleDeadlinePassed() {
  if (S.ended) return;
  endLocal();
  renderMessage("Time is up", "The server closed this exam because the time limit passed. The answers saved before the deadline count as your submission.");
}

function renderDone(reason) {
  clear(app);
  app.append(h("div.container.narrow", h("div.card.center",
    h("h1", { style: { color: "var(--success)" } }, "Examination submitted"),
    h("p", `${S.exam.title}`),
    h("p.muted", reason === "time" ? "Time ran out – your saved answers were submitted." : reason === "violations" ? "Submitted automatically after reaching the violation limit." : `Submitted ${fmtDate(S.session?.submittedAt) === "—" ? "" : "at " + fmtDate(S.session?.submittedAt)}`),
    h("p", S.exam.scoresReleased ? h("a.btn.btn-primary", { href: `exam.html?code=${CODE}&review=1` }, "View my score") : "Your professor will release scores later. You can check them on the home page."),
    h("p", h("a.btn", { href: "./" }, "Back to home")),
  )));
}
function renderLocked() {
  clear(app);
  app.append(h("div.locked-screen", h("div",
    h("h1", "EXAMINATION LOCKED"),
    h("p", `The violation limit was reached. Raise your hand / contact your professor – only they can unlock this exam.`),
    h("p.muted.small", "This page updates automatically when the exam is unlocked."),
  )));
  // wait for unlock
  S.unsub?.(); S.ended = false;
  S.unsub = onSnapshot(doc(db, "sessions", S.sid), (snap) => {
    const d = snap.data(); if (!d) return;
    S.session = d;
    if (d.status === "in_progress") { S.unsub?.(); S.ended = false; logEvent("unlocked"); renderGate("resume"); }
    else if (d.status === "submitted" || d.status === "terminated") { S.unsub?.(); loadExam(); }
  });
}
function renderTerminated() {
  clear(app);
  app.append(h("div.locked-screen", h("div", h("h1", "EXAMINATION TERMINATED"), h("p", "Your professor terminated this attempt."), h("p", h("a.btn", { href: "./" }, "Back to home")))));
}
function renderMessage(title, body, reloadable) {
  clear(app);
  app.append(h("div.container.narrow", h("div.card.center", h("h1", title), h("p", body), h("p", reloadable ? h("button.btn.btn-primary", { onclick: () => location.reload() }, "Reload") : null, " ", h("a.btn", { href: "./" }, "Back to home")))));
}

// ---------------------------------------------------------------- review (after release)
async function renderReview() {
  clear(app);
  let grade = null;
  try { const g = await getDoc(doc(db, "grades", S.sid)); if (g.exists()) grade = g.data(); } catch {}
  if (!grade) return renderMessage("Scores not released", "Your professor has not released the scores for this exam yet.");
  let paper = [];
  try {
    const qsnap = await getDoc(doc(db, "exams", CODE, "content", "questions"));
    paper = buildPaper(qsnap.data().questions || [], S.exam.settings, S.sid);
  } catch {}
  const pq = grade.perQuestion || {};
  app.append(h("div.container.narrow",
    h("div.card",
      h("div.card-head", h("div", h("h1", S.exam.title), h("p.muted", `Submitted ${fmtDate(S.session.submittedAt)}`)),
        h("div.stat", h("div.n", `${grade.score} / ${grade.max}`), h("div.l", `${grade.percent}%`))),
      grade.needsManual ? h("p.help", "Some questions are still being graded manually; this score may change.") : null,
      grade.feedback ? h("p", { style: { whiteSpace: "pre-wrap" } }, h("strong", "Feedback: "), grade.feedback) : null,
    ),
    h("div.answer-review", paper.map((q, i) => {
      const r = pq[q.id] || {};
      const cls = r.correct === true ? "ok" : r.correct === "partial" ? "partial" : r.correct === false ? "bad" : "manual";
      return h("div.ar", { class: `ar ${cls}` },
        h("div.q-num", h("span", `Question ${i + 1}`), h("span", `${r.earned ?? 0} / ${r.max ?? q.points}`)),
        h("div.q-prompt", { style: { fontSize: "1rem" } }, q.prompt),
        h("div.small", h("strong", "Your answer: "), displayAnswer(q, S.answers[q.id])),
        r.expected !== undefined ? h("div.small.muted", h("strong", "Accepted answer: "), displayAnswer(q, r.expected, true)) : null,
        r.comment ? h("div.small", h("em", r.comment)) : null,
      );
    })),
    h("p.center", { style: { marginTop: "1rem" } }, h("a.btn", { href: "./" }, "Back to home")),
  ));
}
export function displayAnswer(q, a, isKey = false) {
  if (a === undefined || a === null || a === "") return h("em.muted", "unanswered");
  if (q.type === "mc") { const o = q.options.find((x) => x.oi === Number(a)); return o ? o.text : String(a); }
  if (q.type === "multi") return (Array.isArray(a) ? a : [a]).map((v) => q.options.find((x) => x.oi === Number(v))?.text ?? v).join("; ");
  if (q.type === "tf") return String(a) === "true" ? "True" : "False";
  if (q.type === "text" && isKey && Array.isArray(a)) return a.join(" / ");
  return String(a);
}
