// Student exam runner: gate -> proctored exam -> submission / review.
//
// The clock, the single-attempt rule, the frozen-after-submit rule and the
// hidden answer key are all enforced in Postgres. Everything in this file is
// the experience around those guarantees, plus the evidence log.
import { siteConfig } from "./config.js";
import { watchAuth, renderAuthPanel, logout, isVerified, resendVerification } from "./auth.js";
import {
  myProfile, updateMyProfile, examIntro, startExam, getPaper, mySession, getSession,
  saveAnswers, heartbeat, bumpViolations, submitSession, lockSession, logEvent,
  myGrade, watchSession, serverClockOffset,
} from "./db.js";
import { STRIKE_EVENTS } from "./grading.js";
import { Proctor, detectReload, clientFingerprint } from "./proctor.js";
import { $, $$, h, esc, toast, dialog, confirmDialog, mmss, fmtDate, clear, qs, randomId } from "./ui.js";

// tells the boot watchdog in the HTML that the module graph loaded
window.__unoBooted = true;

const app = $("#app");
const CODE = (qs("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const REVIEW = qs("review") === "1";
const CLIENT_ID = randomId(10);

const S = {
  user: null, profile: null, exam: null, session: null, paper: [],
  answers: {}, dirty: false, saveTimer: null,
  proctor: null, unwatch: null, hbTimer: null, tickTimer: null, lastHb: 0,
  clockOffset: 0, deadlineMs: 0, violations: 0, current: 0, ended: false,
};

if (!CODE) {
  window.__unoRendered = true;
  app.innerHTML = `<div class="container narrow"><div class="card"><h2>No exam code</h2>
    <p>Go back to the <a href="./">home page</a> and enter your exam code.</p></div></div>`;
} else {
  watchAuth(async (user) => {
    if (!user) return renderSignIn();
    S.user = user;
    try {
      S.profile = await myProfile();
      await load();
    } catch (e) { fatal(e); }
  });
}

function fatal(e) {
  window.__unoRendered = true;
  console.error(e);
  app.innerHTML = `<div class="container narrow"><div class="card"><h2>Cannot load exam</h2>
    <div class="form-error">${esc(e.friendly || e.message)}</div>
    <p style="margin-top:1rem"><a class="btn" href="./">Back to home</a></p></div></div>`;
}

function renderSignIn() {
  window.__unoRendered = true;
  clear(app);
  const host = h("div");
  app.append(h("div.container.narrow", h("div.card",
    h("h2", "Sign in to take the exam"), h("p.muted", `Exam code: ${CODE}`), host)));
  renderAuthPanel(host);
}

async function load() {
  S.exam = await examIntro(CODE);
  if (!S.exam) {
    throw Object.assign(new Error(
      "This exam is not open, or the code is wrong. Check the code with your professor."),
      { friendly: "This exam is not open, or the code is wrong." });
  }
  S.session = await mySession(CODE);
  if (S.session) {
    S.violations = S.session.violations || 0;
    S.answers = { ...(S.session.answers || {}) };
    switch (S.session.status) {
      case "in_progress": return renderGate("resume");
      case "locked":      return renderLocked();
      case "terminated":  return renderTerminated();
      case "submitted":   return REVIEW ? renderReview() : renderDone();
    }
  }
  renderGate("start");
}

// ---------------------------------------------------------------------- gate
function renderGate(mode) {
  window.__unoRendered = true;
  clear(app);
  const ex = S.exam, u = S.user;

  if (!isVerified(u)) {
    app.append(h("div.container.narrow", h("div.card",
      h("h2", "Confirm your e-mail first"),
      h("p", "For identity reasons you can only sit an exam from a confirmed e-mail address. " +
             "Open the link we sent you, then come back."),
      h("div.row",
        h("button.btn", { onclick: async () => {
          try { await resendVerification(u.email); toast("Confirmation e-mail sent.", "success"); }
          catch (e) { toast(e.message, "error"); }
        } }, "Resend confirmation"),
        h("button.btn.btn-primary", { onclick: () => location.reload() }, "I've confirmed – continue"),
      ))));
    return;
  }

  const nameI = h("input.input", { value: S.profile?.display_name || "", placeholder: "Last Name, First Name" });
  const idI   = h("input.input", { value: S.profile?.student_id || "", placeholder: "Student number" });
  const secI  = h("input.input", { value: S.profile?.section || "", placeholder: "Section code" });
  const agree = h("input", { type: "checkbox" });

  const btn = h("button.btn.btn-primary.btn-lg", { disabled: true, onclick: async () => {
    btn.disabled = true;
    makeProctor();
    // Fullscreen must be requested from the click itself (browser rule).
    if (ex.require_fullscreen) await S.proctor.requestFullscreen();
    try {
      await begin(nameI.value.trim(), idI.value.trim(), secI.value.trim(), mode);
    } catch (e) {
      S.proctor?.stop(); S.proctor?.exitFullscreen(); S.proctor = null;
      btn.disabled = false;
      toast(e.friendly || e.message, "error", 8000);
    }
  } }, mode === "resume" ? "Resume examination" : "Start examination");
  agree.addEventListener("change", () => (btn.disabled = !agree.checked));

  const monitored = [
    "switching tabs or windows, minimising, or leaving fullscreen",
    "copy / cut / paste and the right-click menu",
    "opening developer tools or blocked keyboard shortcuts",
    "reloading the page, opening the exam twice, or going offline",
  ];
  const policy = ex.violation_action === "lock"
    ? `After ${ex.max_violations} violations the exam locks and only your professor can unlock it.`
    : ex.violation_action === "submit"
    ? `After ${ex.max_violations} violations the exam is submitted automatically.`
    : "Every violation is reported to your professor.";

  app.append(h("div.container.narrow",
    siteConfig.bannerUrl ? h("img.banner-img", { src: siteConfig.bannerUrl, alt: "" }) : null,
    h("div.card",
      h("div.card-head",
        h("div", h("h1", ex.title),
          h("p.muted", [ex.course, ex.owner_name && `by ${ex.owner_name}`].filter(Boolean).join(" · "))),
        h("span.pill-code", CODE)),
      ex.instructions ? h("p", { style: { whiteSpace: "pre-wrap" } }, ex.instructions) : null,
      h("div.grid.grid-3",
        h("div.stat", h("div.n", `${ex.duration_minutes} min`), h("div.l", "Time limit")),
        h("div.stat", h("div.n", String(ex.question_count ?? "?")), h("div.l", "Questions")),
        h("div.stat", h("div.n", String(Number(ex.total_points) || "?")), h("div.l", "Points")),
      ),
      mode === "resume"
        ? h("div.form-error", { style: { marginTop: "1rem", background: "var(--warn-soft)", color: "var(--warn)" } },
            "You already started this exam. The clock has been running since ",
            fmtDate(S.session.started_at), ". Your saved answers will be restored.")
        : null,
    ),
    h("div.card",
      h("h3", "Your details"),
      h("div.grid.grid-3",
        h("label.field", h("span", "Full name"), nameI),
        h("label.field", h("span", "Student ID" + (ex.require_student_id ? " *" : "")), idI),
        h("label.field", h("span", "Section" + (ex.require_student_id ? " *" : "")), secI),
      ),
      h("p.help", `Signed in as ${u.email}. Wrong account? `,
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); logout(); } }, "Sign out")),
    ),
    h("div.card",
      h("h3", "Examination rules"),
      h("ul", { style: { paddingLeft: "1.2rem" } },
        h("li", `The timer starts when you click ${mode === "resume" ? "Resume" : "Start"} and runs on the server — closing the page does not pause it.`),
        h("li", "One attempt only. Your answers are saved automatically as you type."),
        ex.require_fullscreen ? h("li", "The exam runs in fullscreen. Leaving fullscreen is a violation.") : null,
        h("li", "The following are recorded with timestamps and shown to your professor: ",
          h("ul", monitored.map((m) => h("li", m)))),
        h("li", policy),
      ),
      h("label.check", { style: { margin: "1rem 0" } }, agree,
        h("span", "I understand and agree to the rules above. I will not use unauthorised materials or devices.")),
      h("div.row", btn, h("a.btn", { href: "./" }, "Cancel")),
    ),
  ));
}

// ---------------------------------------------------------------------- exam
function makeProctor() {
  const ex = S.exam;
  S.proctor?.stop();
  S.proctor = new Proctor({
    requireFullscreen: !!ex.require_fullscreen,
    blockClipboard: ex.block_clipboard !== false,
    blockContextMenu: true,
    strikeTypes: STRIKE_EVENTS,
    onEvent: (type, detail) => S.session && logEvent(S.session.id, type, detail, detail?.q),
    onStrike: (_, type) => onViolation(type),
  });
}

async function begin(name, studentNo, section, mode) {
  const ex = S.exam;
  if (ex.require_student_id && (!name || !studentNo || !section)) {
    throw Object.assign(new Error("Please fill in your name, student number and section."),
      { friendly: "Please fill in your name, student number and section." });
  }
  // start_exam is idempotent: it resumes an existing attempt rather than
  // creating a second one, and the clock keeps running from the first start.
  const sessionId = await startExam(CODE, name, studentNo, section);
  S.session = await getSession(sessionId);
  S.answers = { ...(S.session.answers || {}) };
  S.violations = S.session.violations || 0;
  if (name || studentNo || section) {
    try { S.profile = await myProfile(); } catch {}
  }

  S.paper = await getPaper(sessionId);
  if (!S.paper.length) throw new Error("This exam has no questions yet.");

  S.clockOffset = await serverClockOffset();
  computeDeadline();

  // A recent heartbeat from a different client means it is open elsewhere.
  const hb = new Date(S.session.heartbeat_at).getTime();
  const openedElsewhere = mode === "resume"
    && S.session.client_id && S.session.client_id !== CLIENT_ID
    && Date.now() - hb < 60_000;

  const reloaded = detectReload(sessionId);
  S.ended = false;
  S.proctor.start();
  logEvent(sessionId, mode === "resume" ? "resumed" : "started",
           { reload: reloaded, client: clientFingerprint() });
  if (reloaded && mode === "resume") logEvent(sessionId, "page_reload", {});

  const recovered = restoreDraft();

  renderExam();
  if (recovered) {
    toast(`Recovered ${recovered} answer${recovered === 1 ? "" : "s"} saved on this device but not yet sent.`,
      "warn", 8000);
    S.dirty = true;
    flush();
    logEvent(sessionId, "draft_recovered", { count: recovered });
  }
  startHeartbeat();
  listenSession();
  S.tickTimer = setInterval(tick, 500);
  tick();

  if (openedElsewhere) onViolation("multiple_tabs");
}

// ---------------------------------------------------------------- local copy
// Answers live in memory until an autosave lands. On campus wifi that gap is
// where work gets lost: connection drops, the student closes the tab, and
// whatever had not reached the server is gone. Mirror every keystroke into
// localStorage and replay it on the next load.
const draftKey = () => `uno_draft_${S.session?.id}`;

function saveDraft() {
  try {
    localStorage.setItem(draftKey(), JSON.stringify({
      answers: S.answers, at: Date.now(), savedToServer: !S.dirty,
    }));
  } catch { /* private mode or quota: the server copy is still the real one */ }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const clearDraft = () => { try { localStorage.removeItem(draftKey()); } catch {} };

/**
 * Merge a local draft that never reached the server. The server copy wins for
 * any question it already knows about; the draft only fills in what is missing,
 * so a stale draft can never overwrite a newer saved answer.
 */
function restoreDraft() {
  const d = readDraft();
  if (!d || d.savedToServer) return 0;
  let recovered = 0;
  for (const [qid, val] of Object.entries(d.answers || {})) {
    if (S.answers[qid] === undefined && val !== "" && val != null) {
      S.answers[qid] = val;
      recovered++;
    }
  }
  return recovered;
}

const serverNow = () => Date.now() + S.clockOffset;
function computeDeadline() {
  const start = new Date(S.session.started_at).getTime();
  const mins = (S.exam.duration_minutes || 0) + (S.session.extra_minutes || 0);
  const closes = new Date(S.exam.closes_at).getTime();
  S.deadlineMs = Math.min(start + mins * 60_000, closes);
}

function renderExam() {
  window.__unoRendered = true;
  clear(app);
  const ex = S.exam, total = S.paper.length;
  const head = h("div.exam-head",
    h("div", h("div.title", ex.title),
      h("div.small.muted", `${S.profile?.display_name || S.user.email}${S.profile?.section ? " · " + S.profile.section : ""}`)),
    h("div.spacer"),
    h("div.strike-bar#strikes", { title: "Violations" }),
    h("div.save-state#saveState", "All changes saved"),
    h("div.timer#timer", "--:--"),
    h("button.btn.btn-primary", { onclick: () => submit("manual") }, "Submit"),
  );
  const list = h("div#qlist");
  const nav = h("div.exam-nav", h("div.card",
    h("div.small.muted", { style: { marginBottom: ".5rem" } },
      h("span#answeredCount", "0"), ` of ${total} answered`),
    h("div.nav-grid#navGrid", S.paper.map((q, i) =>
      h("button", { type: "button", onclick: () => goTo(i) }, String(i + 1)))),
    ex.one_at_a_time ? h("div.row", { style: { marginTop: ".8rem" } },
      h("button.btn.btn-sm#prevBtn", { onclick: () => goTo(S.current - 1) }, "← Prev"),
      h("button.btn.btn-sm#nextBtn", { onclick: () => goTo(S.current + 1) }, "Next →")) : null,
  ));
  app.append(head, h("div.exam-body", h("div", list), nav));
  renderStrikes();

  if (ex.one_at_a_time) goTo(0);
  else S.paper.forEach((q, i) => list.append(questionCard(q, i)));
  updateNav();
}

function goTo(i) {
  if (!S.exam.one_at_a_time) {
    $(`[data-qid="${S.paper[i].id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  S.current = Math.max(0, Math.min(S.paper.length - 1, i));
  const list = $("#qlist"); clear(list);
  list.append(questionCard(S.paper[S.current], S.current));
  $("#prevBtn").disabled = S.current === 0;
  $("#nextBtn").disabled = S.current === S.paper.length - 1;
  updateNav();
}

function questionCard(q, i) {
  const ans = S.answers[q.id];
  const points = Number(q.points);
  const card = h("div.q-card", { dataset: { qid: q.id } },
    h("div.q-num", h("span", `Question ${i + 1} of ${S.paper.length}`),
      h("span", `${points} pt${points === 1 ? "" : "s"}`)),
    h("div.q-prompt", q.prompt),
  );
  const set = (v) => setAnswer(q.id, v);
  switch (q.type) {
    case "mc":
      card.append(h("div.options", q.options.map((o) =>
        optionRow("radio", `q_${q.id}`, o.text, Number(ans) === o.oi, () => set(o.oi)))));
      break;
    case "multi": {
      const cur = new Set(Array.isArray(ans) ? ans.map(Number) : []);
      card.append(h("p.help", "Select all that apply."),
        h("div.options", q.options.map((o) =>
          optionRow("checkbox", `q_${q.id}`, o.text, cur.has(o.oi), (checked) => {
            checked ? cur.add(o.oi) : cur.delete(o.oi);
            set([...cur].sort((a, b) => a - b));
          }))));
      break;
    }
    case "tf":
      card.append(h("div.options", [["true", "True"], ["false", "False"]].map(([v, l]) =>
        optionRow("radio", `q_${q.id}`, l, String(ans) === v, () => set(v === "true")))));
      break;
    case "text":
      card.append(h("input.input", {
        value: ans ?? "", placeholder: "Type your answer…", autocomplete: "off", spellcheck: false,
        oninput: (e) => set(e.target.value),
      }));
      break;
    case "essay":
      card.append(h("textarea", {
        placeholder: "Write your answer…", rows: 8, oninput: (e) => set(e.target.value),
      }, ans ?? ""));
      break;
  }
  return card;
}

function optionRow(type, name, label, checked, onchange) {
  const input = h("input", { type, name, checked });
  const row = h("label.option", { class: `option${checked ? " selected" : ""}` }, input, h("span", label));
  input.addEventListener("change", () => {
    if (type === "radio") {
      $$(`input[name="${name}"]`).forEach((r) => r.closest(".option").classList.toggle("selected", r.checked));
    } else row.classList.toggle("selected", input.checked);
    onchange(input.checked);
  });
  return row;
}

function setAnswer(qid, v) {
  if (S.ended) return;
  if (v === "" || v == null) delete S.answers[qid]; else S.answers[qid] = v;
  S.dirty = true;
  saveDraft();
  updateNav();
  setSaveState("saving");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flush, 800);
}

const isAnswered = (a) =>
  a !== undefined && a !== "" && !(Array.isArray(a) && !a.length);
const answeredCount = () => S.paper.filter((q) => isAnswered(S.answers[q.id])).length;

function updateNav() {
  const btns = $$("#navGrid button");
  S.paper.forEach((q, i) => {
    btns[i]?.classList.toggle("answered", isAnswered(S.answers[q.id]));
    btns[i]?.classList.toggle("current", S.exam.one_at_a_time && i === S.current);
  });
  const c = $("#answeredCount"); if (c) c.textContent = String(answeredCount());
}

function setSaveState(state) {
  const el = $("#saveState"); if (!el) return;
  el.className = `save-state ${state}`;
  el.textContent = state === "saving" ? "Saving…"
    : state === "offline" ? "OFFLINE – reconnect to save!"
    : state === "error" ? "Save failed – retrying" : "All changes saved";
}

async function flush() {
  if (!S.dirty || S.ended) return;
  S.dirty = false;
  try {
    await saveAnswers(S.session.id, S.answers, answeredCount(), S.paper.length);
    setSaveState(S.dirty ? "saving" : "saved");
    saveDraft();
    S.lastHb = Date.now();
  } catch (e) {
    S.dirty = true;
    if (isDeadlineError(e)) return handleDeadlinePassed();
    setSaveState(navigator.onLine ? "error" : "offline");
    setTimeout(flush, 3000);
  }
}

// A refused write after the deadline comes back as "0 rows" rather than an
// error, so treat a silent no-op near the deadline as the deadline passing.
function isDeadlineError(e) {
  return /row-level security|permission|denied/i.test(e?.raw || e?.message || "");
}

// ------------------------------------------------------- timer / heartbeat
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
    if (gap > 70_000) logEvent(S.session.id, "heartbeat_gap", { ms: gap });
    try {
      await heartbeat(S.session.id, CLIENT_ID);
      S.lastHb = Date.now();
      if (!S.dirty) setSaveState("saved");
    } catch (e) {
      if (isDeadlineError(e)) handleDeadlinePassed(); else setSaveState("offline");
    }
  }, 25_000);
}

function listenSession() {
  S.unwatch = watchSession(S.session.id, ({ eventType, new: row }) => {
    if (eventType === "DELETE") {
      endLocal();
      return renderMessage("Session reset",
        "Your professor reset this attempt. Reload the page to start again.", true);
    }
    if (!row) return;
    const prevExtra = S.session?.extra_minutes || 0;
    S.session = row;
    if (row.violations > S.violations) { S.violations = row.violations; renderStrikes(); }
    if ((row.extra_minutes || 0) !== prevExtra) {
      computeDeadline();
      toast(`Your professor adjusted your time: +${row.extra_minutes} min total.`, "success", 6000);
    }
    if (S.ended) return;
    if (row.status === "locked") { endLocal(); renderLocked(); }
    else if (row.status === "terminated") { endLocal(); renderTerminated(); }
    else if (row.status === "submitted") { endLocal(); renderDone(); }
  });
}

function endLocal() {
  S.ended = true;
  clearInterval(S.hbTimer); clearInterval(S.tickTimer); clearTimeout(S.saveTimer);
  S.proctor?.stop(); S.proctor?.exitFullscreen();
  S.unwatch?.(); S.unwatch = null;
}

// ------------------------------------------------------------- violations
function renderStrikes() {
  const bar = $("#strikes"); if (!bar) return;
  clear(bar);
  const max = S.exam.max_violations || 5;
  for (let i = 0; i < max; i++) bar.append(h("i", { class: i < S.violations ? "on" : "" }));
  bar.title = `${S.violations} of ${max} violations`;
}

async function onViolation(type) {
  if (S.ended) return;
  S.violations++;
  renderStrikes();
  $$(".q-card").forEach((c) => { c.classList.add("shake"); setTimeout(() => c.classList.remove("shake"), 500); });
  bumpViolations(S.session.id, S.violations).catch(() => {});

  const ex = S.exam, max = ex.max_violations || 5;

  if (S.violations >= max && ex.violation_action === "submit") {
    await dialog({ title: "Violation limit reached",
      body: "The exam will now be submitted automatically with your saved answers.",
      dismissible: false });
    return submit("violations");
  }
  if (S.violations >= max && ex.violation_action === "lock") {
    await flush();
    try { await lockSession(S.session.id); } catch (e) { console.warn(e); }
    logEvent(S.session.id, "locked", { reason: type });
    endLocal();
    return renderLocked();
  }

  S.proctor.paused = true;
  const labels = {
    tab_hidden: "You switched tabs or minimised the window.",
    window_blur: "Another window or application took focus.",
    fullscreen_exit: "You left fullscreen mode.",
    devtools_suspected: "Developer tools appear to be open.",
    paste: "Pasting is not allowed during the exam.",
    multiple_tabs: "The exam was opened in more than one place.",
    print_screen: "Screen capture is not allowed.",
  };
  await dialog({
    title: "⚠ Security warning",
    body: h("div",
      h("p", labels[type] || "A prohibited action was detected."),
      h("p", h("strong", { style: { color: "var(--danger)" } }, `Violation ${S.violations} of ${max}. `),
        ex.violation_action === "lock" ? "Reaching the limit locks your exam until your professor unlocks it."
        : ex.violation_action === "submit" ? "Reaching the limit submits your exam automatically."
        : "All violations are reported to your professor.")),
    buttons: [{ label: ex.require_fullscreen ? "Acknowledge & return to fullscreen" : "Acknowledge",
                value: true, kind: "primary" }],
    dismissible: false,
  });
  if (ex.require_fullscreen) await S.proctor.requestFullscreen();
  setTimeout(() => { if (S.proctor) S.proctor.paused = false; }, 800);
}

// --------------------------------------------------------- submit / states
async function submit(reason) {
  if (S.ended) return;
  if (reason === "manual") {
    const unanswered = S.paper.length - answeredCount();
    S.proctor.paused = true;
    const ok = await confirmDialog("Submit examination?",
      `${unanswered ? `<p><strong>${unanswered}</strong> question(s) are unanswered.</p>` : ""}
       <p>You cannot change your answers after submitting.</p>`,
      "Submit now", "primary");
    if (S.proctor) S.proctor.paused = false;
    if (!ok) return;
  }
  S.ended = true;
  clearTimeout(S.saveTimer);
  try {
    await submitSession(S.session.id, S.answers, answeredCount(), S.paper.length);
    logEvent(S.session.id, "submitted", { reason });
  } catch (e) {
    if (!isDeadlineError(e)) {
      S.ended = false;
      toast("Submission failed: " + (e.friendly || e.message) + " – retrying…", "error");
      return setTimeout(() => submit(reason), 3000);
    }
  }
  clearDraft();
  endLocal();
  renderDone(reason);
}

function handleDeadlinePassed() {
  if (S.ended) return;
  endLocal();
  renderMessage("Time is up",
    "The server closed this exam because the time limit passed. The answers saved before the deadline count as your submission.");
}

function renderDone(reason) {
  window.__unoRendered = true;
  clear(app);
  app.append(h("div.container.narrow", h("div.card.center",
    h("h1", { style: { color: "var(--success)" } }, "Examination submitted"),
    h("p", S.exam.title),
    h("p.muted",
      reason === "time" ? "Time ran out – your saved answers were submitted."
      : reason === "violations" ? "Submitted automatically after reaching the violation limit."
      : "Your answers are recorded."),
    h("p", S.exam.scores_released
      ? h("a.btn.btn-primary", { href: `exam.html?code=${CODE}&review=1` }, "View my score")
      : "Your professor will release scores later. You can check them on the home page."),
    h("p", h("a.btn", { href: "./" }, "Back to home")),
  )));
}

function renderLocked() {
  window.__unoRendered = true;
  clear(app);
  app.append(h("div.locked-screen", h("div",
    h("h1", "EXAMINATION LOCKED"),
    h("p", "The violation limit was reached. Raise your hand — only your professor can unlock this exam."),
    h("p.muted.small", "This page updates automatically when the exam is unlocked."),
  )));
  S.unwatch?.();
  S.ended = true;
  S.unwatch = watchSession(S.session.id, ({ new: row }) => {
    if (!row) return;
    S.session = row;
    if (row.status === "in_progress") { S.unwatch?.(); S.unwatch = null; S.ended = false; renderGate("resume"); }
    else if (row.status === "submitted" || row.status === "terminated") { S.unwatch?.(); load(); }
  });
}

function renderTerminated() {
  window.__unoRendered = true;
  clear(app);
  app.append(h("div.locked-screen", h("div",
    h("h1", "EXAMINATION TERMINATED"),
    h("p", "Your professor terminated this attempt."),
    h("p", h("a.btn", { href: "./" }, "Back to home")))));
}

function renderMessage(title, body, reloadable) {
  window.__unoRendered = true;
  clear(app);
  app.append(h("div.container.narrow", h("div.card.center",
    h("h1", title), h("p", body),
    h("p", reloadable ? h("button.btn.btn-primary", { onclick: () => location.reload() }, "Reload") : null,
      " ", h("a.btn", { href: "./" }, "Back to home")))));
}

// ------------------------------------------------------------------ review
async function renderReview() {
  window.__unoRendered = true;
  clear(app);
  let grade = null;
  try { grade = await myGrade(S.session.id); } catch {}
  if (!grade) {
    return renderMessage("Scores not released",
      "Your professor has not released the scores for this exam yet.");
  }
  let paper = [];
  try { paper = await getPaper(S.session.id); } catch {}
  const pq = grade.per_question || {};

  app.append(h("div.container.narrow",
    h("div.card",
      h("div.card-head",
        h("div", h("h1", S.exam.title), h("p.muted", `Submitted ${fmtDate(S.session.submitted_at)}`)),
        h("div.stat", h("div.n", `${Number(grade.score)} / ${Number(grade.max_score)}`),
          h("div.l", `${grade.percent}%`))),
      grade.needs_manual
        ? h("p.help", "Some questions are still being graded manually; this score may change.") : null,
      grade.feedback
        ? h("p", { style: { whiteSpace: "pre-wrap" } }, h("strong", "Feedback: "), grade.feedback) : null,
    ),
    h("div.answer-review", paper.map((q, i) => {
      const r = pq[q.id] || {};
      const cls = r.verdict === "correct" ? "ok"
        : r.verdict === "partial" ? "partial"
        : r.verdict === "wrong" ? "bad" : "manual";
      return h("div.ar", { class: `ar ${cls}` },
        h("div.q-num", h("span", `Question ${i + 1}`),
          h("span", `${Number(r.earned ?? 0)} / ${Number(r.max ?? q.points)}`)),
        h("div.q-prompt", { style: { fontSize: "1rem" } }, q.prompt),
        h("div.small", h("strong", "Your answer: "), displayAnswer(q, S.answers[q.id])),
        r.expected !== undefined
          ? h("div.small.muted", h("strong", "Accepted answer: "), displayKey(q, r.expected)) : null,
        r.comment ? h("div.small", h("em", r.comment)) : null,
      );
    })),
    h("p.center", { style: { marginTop: "1rem" } }, h("a.btn", { href: "./" }, "Back to home")),
  ));
}

export function displayAnswer(q, a) {
  if (a === undefined || a === null || a === "") return h("em.muted", "unanswered");
  if (q.type === "mc") return q.options?.find((o) => o.oi === Number(a))?.text ?? String(a);
  if (q.type === "multi") {
    return (Array.isArray(a) ? a : [a])
      .map((v) => q.options?.find((o) => o.oi === Number(v))?.text ?? v).join("; ");
  }
  if (q.type === "tf") return String(a) === "true" ? "True" : "False";
  return String(a);
}

function displayKey(q, key) {
  if (!key) return h("em.muted", "—");
  if (q.type === "text") return (key.accepted || []).join(" / ");
  if (q.type === "tf") return key.correct ? "True" : "False";
  if (q.type === "mc") return q.options?.find((o) => o.oi === Number(key.correct))?.text ?? String(key.correct);
  if (q.type === "multi") {
    return (key.correct || []).map((v) => q.options?.find((o) => o.oi === Number(v))?.text ?? v).join("; ");
  }
  return "—";
}
