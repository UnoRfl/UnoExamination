// Professor dashboard: exam builder, live proctoring monitor, grading, access.
//
// Grading happens HERE, in the professor's (authenticated) browser: only the
// exam owner can read the answer key, so students never receive it.
import {
  db, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy,
  onSnapshot, writeBatch, serverTimestamp, Timestamp,
} from "./firebase-init.js";
import { siteConfig } from "./firebase-config.js";
import { watchAuth, ensureProfile, renderAuthPanel, logout } from "./auth.js";
import { buildPaper, paperMaxPoints, QUESTION_TYPES, validateQuestion, validateKey } from "./paper.js";
import { gradeSession, riskScore, importQuestions, EVENT_WEIGHTS } from "./grading.js";
import {
  $, $$, h, esc, toast, dialog, confirmDialog, promptDialog, fmtDate, fmtTime, ago, mmss, toDate,
  toLocalInput, clear, downloadText, csvEscape, examCode, randomId,
} from "./ui.js";

const app = $("#app");
$("#brandName").textContent = siteConfig.institutionName;

const P = { user: null, profile: null, exams: [], unsubs: [], cache: {} };

const DEFAULT_SETTINGS = {
  durationMinutes: 60, maxViolations: 5, violationAction: "lock", requireFullscreen: true, blockClipboard: true,
  shuffleQuestions: true, shuffleOptions: true, questionsPerStudent: 0, oneAtATime: false, requireStudentId: true,
  allowedDomain: "", roster: [], showCorrectAnswers: false, autoGrade: true,
};

// ---------------------------------------------------------------- auth / routing
watchAuth(async (user) => {
  clear($("#topRight"));
  if (!user) { clear(app); const host = h("div"); app.append(h("div.container.narrow", h("div.card", h("h2", "Professor sign-in"), host))); renderAuthPanel(host, { professorMode: true }); return; }
  P.user = user;
  P.profile = await ensureProfile(user);
  if (P.profile.role !== "professor") {
    // Bootstrap admin (e-mail hard-coded in firestore.rules) may claim the role.
    try { await updateDoc(doc(db, "users", user.uid), { role: "professor", updatedAt: serverTimestamp() }); P.profile.role = "professor"; }
    catch { /* not the bootstrap admin */ }
  }
  $("#topRight").append(h("span.small.muted", user.email), h("a.btn.btn-sm", { href: "./" }, "Student view"), h("button.btn.btn-sm", { onclick: () => logout() }, "Sign out"));
  if (P.profile.role !== "professor") return renderNotProfessor(user);
  window.addEventListener("hashchange", route);
  route();
});

function renderNotProfessor(user) {
  clear(app);
  app.append(h("div.container.narrow", h("div.card",
    h("h2", "This account is not a professor"),
    h("p", "Ask an existing professor to promote you from their ", h("strong", "Access"), " tab. Give them this e-mail:"),
    h("p", h("code", user.email)),
    h("p.help", "First deployment? Put your e-mail in BOOTSTRAP_ADMIN_EMAIL inside firestore.rules, deploy the rules, sign in with that (verified) e-mail and reload this page."),
  )));
}

function stopLive() { P.unsubs.forEach((u) => u()); P.unsubs = []; }

function route() {
  stopLive();
  const parts = (location.hash || "#exams").slice(1).split("/");
  const [view, code, sub] = parts;
  clear(app);
  const nav = h("nav.sidebar",
    link("#exams", "📚 My exams", view === "exams"),
    link("#new", "➕ New exam", view === "new"),
    code ? h("div.small.muted", { style: { padding: ".6rem .8rem 0" } }, "Exam ", h("code", code)) : null,
    code ? link(`#exam/${code}/edit`, "✏️ Edit", sub === "edit") : null,
    code ? link(`#exam/${code}/monitor`, "📡 Live monitor", sub === "monitor") : null,
    code ? link(`#exam/${code}/grades`, "🎯 Grades", sub === "grades") : null,
    h("div.spacer"),
    link("#access", "👥 Access", view === "access"),
    link("#help", "❔ Help", view === "help"),
  );
  const main = h("main.main");
  app.append(h("div.dash", nav, main));
  if (view === "exams") return viewExams(main);
  if (view === "new") return viewEditor(main, null);
  if (view === "exam" && code) {
    if (sub === "monitor") return viewMonitor(main, code);
    if (sub === "grades") return viewGrades(main, code);
    return viewEditor(main, code);
  }
  if (view === "access") return viewAccess(main);
  if (view === "help") return viewHelp(main);
  viewExams(main);
}
const link = (href, label, active) => h("a", { href, class: active ? "active" : "" }, label);

// ---------------------------------------------------------------- data helpers
async function loadExam(code, force = false) {
  if (!force && P.cache[code]) return P.cache[code];
  const [e, q, k] = await Promise.all([
    getDoc(doc(db, "exams", code)),
    getDoc(doc(db, "exams", code, "content", "questions")),
    getDoc(doc(db, "exams", code, "private", "answerKey")),
  ]);
  if (!e.exists()) throw new Error("Exam not found");
  const data = { exam: { id: code, ...e.data() }, questions: q.exists() ? q.data().questions || [] : [], key: k.exists() ? k.data().answers || {} : {} };
  data.exam.settings = { ...DEFAULT_SETTINGS, ...(data.exam.settings || {}) };
  P.cache[code] = data;
  return data;
}
const statusBadge = (st) => {
  const m = { draft: ["Draft", ""], open: ["Open", "badge-success"], closed: ["Closed", "badge-danger"], in_progress: ["In progress", "badge-accent"], submitted: ["Submitted", "badge-success"], locked: ["Locked", "badge-danger"], terminated: ["Terminated", "badge-danger"], expired: ["Expired", "badge-warn"] };
  const [l, c] = m[st] || [st, ""]; return h(`span.badge${c ? "." + c : ""}`, l);
};
/** Effective status: in_progress past its deadline (+grace) is "expired". */
function effectiveStatus(s, exam) {
  if (s.status !== "in_progress") return s.status;
  const dl = deadlineOf(s, exam);
  return dl && Date.now() > dl + 90_000 ? "expired" : "in_progress";
}
function deadlineOf(s, exam) {
  const start = toDate(s.startedAt)?.getTime(); if (!start) return null;
  const mins = (exam.settings.durationMinutes || 0) + (s.extraMinutes || 0);
  return Math.min(start + mins * 60_000, toDate(exam.closesAt)?.getTime() || Infinity);
}

// ---------------------------------------------------------------- exams list
async function viewExams(main) {
  main.append(h("div.card-head", h("h1", "My exams"), h("a.btn.btn-primary", { href: "#new" }, "➕ New exam")));
  const host = h("div.grid.grid-2"); main.append(host);
  try {
    const snap = await getDocs(query(collection(db, "exams"), where("ownerUid", "==", P.user.uid)));
    P.exams = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (toDate(b.updatedAt)?.getTime() || 0) - (toDate(a.updatedAt)?.getTime() || 0));
    if (!P.exams.length) return host.append(h("div.empty", "No exams yet. Create one, or import your existing question list."));
    for (const ex of P.exams) {
      host.append(h("div.card.exam-tile", { onclick: () => (location.hash = `#exam/${ex.id}/${ex.status === "open" ? "monitor" : "edit"}`) },
        h("div.card-head", h("div", h("h3", ex.title), h("div.small.muted", [ex.course, `${ex.questionCount || 0} questions`, `${ex.settings?.durationMinutes} min`].filter(Boolean).join(" · "))), statusBadge(ex.status)),
        h("div.row.between", h("span.pill-code", { style: { fontSize: "1.1rem" } }, ex.id),
          h("div.row", h("a.btn.btn-sm", { href: `#exam/${ex.id}/edit`, onclick: (e) => e.stopPropagation() }, "Edit"),
            h("a.btn.btn-sm", { href: `#exam/${ex.id}/monitor`, onclick: (e) => e.stopPropagation() }, "Monitor"),
            h("a.btn.btn-sm", { href: `#exam/${ex.id}/grades`, onclick: (e) => e.stopPropagation() }, "Grades"))),
        h("div.small.muted", { style: { marginTop: ".5rem" } }, ex.scoresReleased ? "Scores released · " : "", `Updated ${ago(ex.updatedAt)}`),
      ));
    }
  } catch (e) { host.append(h("div.form-error", e.message)); }
}

// ---------------------------------------------------------------- editor
async function viewEditor(main, code) {
  let data;
  if (code) {
    try { data = await loadExam(code, true); } catch (e) { return main.append(h("div.form-error", e.message)); }
  } else {
    data = {
      exam: { id: null, title: "", course: "", instructions: "", ownerUid: P.user.uid, ownerName: P.profile.displayName || P.user.displayName || P.user.email, status: "draft",
        opensAt: new Date(), closesAt: new Date(Date.now() + 30 * 86400_000), settings: { ...DEFAULT_SETTINGS }, scoresReleased: false },
      questions: [], key: {},
    };
  }
  const ex = data.exam, st = ex.settings;
  let questions = data.questions.map((q) => ({ ...q })), key = JSON.parse(JSON.stringify(data.key));
  let sessionsCount = 0;
  if (code) { try { const s = await getDocs(query(collection(db, "sessions"), where("examCode", "==", code))); sessionsCount = s.size; } catch {} }

  // ---- meta form
  const f = {
    title: h("input.input", { value: ex.title, placeholder: "e.g. Information Assurance – Prelim Examination", required: true }),
    course: h("input.input", { value: ex.course || "", placeholder: "Course / subject (optional)" }),
    ownerName: h("input.input", { value: ex.ownerName || "" }),
    instructions: h("textarea", { placeholder: "Instructions shown to students before they start…" }, ex.instructions || ""),
    opensAt: h("input.input", { type: "datetime-local", value: toLocalInput(ex.opensAt) }),
    closesAt: h("input.input", { type: "datetime-local", value: toLocalInput(ex.closesAt) }),
    durationMinutes: h("input.input", { type: "number", min: 1, max: 600, value: st.durationMinutes }),
    maxViolations: h("input.input", { type: "number", min: 1, max: 50, value: st.maxViolations }),
    violationAction: h("select", [["lock", "Lock exam – professor must unlock"], ["submit", "Auto-submit the exam"], ["warn", "Only warn & report"]].map(([v, l]) => h("option", { value: v, selected: st.violationAction === v }, l))),
    questionsPerStudent: h("input.input", { type: "number", min: 0, value: st.questionsPerStudent || 0 }),
    allowedDomain: h("input.input", { value: st.allowedDomain || "", placeholder: "e.g. perpetualdalta.edu.ph (blank = any)" }),
    roster: h("textarea", { placeholder: "Optional: one student e-mail per line. Blank = anyone with the code (and domain) can take it." }, (st.roster || []).join("\n")),
    requireFullscreen: chk("Require fullscreen", st.requireFullscreen),
    blockClipboard: chk("Block copy / paste", st.blockClipboard),
    shuffleQuestions: chk("Shuffle question order per student", st.shuffleQuestions),
    shuffleOptions: chk("Shuffle answer options per student", st.shuffleOptions),
    oneAtATime: chk("Show one question at a time", st.oneAtATime),
    requireStudentId: chk("Require student ID & section", st.requireStudentId),
    showCorrectAnswers: chk("Show correct answers to students when scores are released", st.showCorrectAnswers),
    autoGrade: chk("Auto-grade submissions while the monitor is open", st.autoGrade),
  };
  function chk(label, val) { const i = h("input", { type: "checkbox", checked: !!val }); const l = h("label.check", i, h("span", label)); l.input = i; return l; }

  const qHost = h("div#qHost");
  const statsEl = h("span.muted.small");
  const renderQuestions = () => {
    clear(qHost);
    questions.forEach((q, i) => qHost.append(questionEditor(q, i)));
    statsEl.textContent = `${questions.length} questions · ${paperMaxPoints(questions)} points`;
  };
  function questionEditor(q, i) {
    const k = key[q.id] || (key[q.id] = {});
    const box = h("div.q-editor", { dataset: { qid: q.id } });
    const typeSel = h("select", Object.entries(QUESTION_TYPES).map(([v, l]) => h("option", { value: v, selected: q.type === v }, l)));
    typeSel.style.maxWidth = "260px";
    typeSel.onchange = () => { q.type = typeSel.value; if ((q.type === "mc" || q.type === "multi") && !q.options) q.options = ["", ""]; key[q.id] = {}; renderQuestions(); };
    const prompt = h("textarea", { rows: 2, placeholder: "Question text", oninput: (e) => (q.prompt = e.target.value) }, q.prompt || "");
    const pts = h("input.input", { type: "number", min: .5, step: .5, value: q.points ?? 1, style: { width: "80px" }, oninput: (e) => (q.points = Number(e.target.value)) });
    box.append(h("div.row.between", { style: { marginBottom: ".5rem" } },
      h("div.row", h("strong", `Q${i + 1}`), typeSel, h("label.small.muted", "pts ", pts)),
      h("div.row",
        h("button.btn.btn-sm.btn-ghost", { title: "Move up", onclick: () => { if (i > 0) { [questions[i - 1], questions[i]] = [questions[i], questions[i - 1]]; renderQuestions(); } } }, "↑"),
        h("button.btn.btn-sm.btn-ghost", { title: "Move down", onclick: () => { if (i < questions.length - 1) { [questions[i + 1], questions[i]] = [questions[i], questions[i + 1]]; renderQuestions(); } } }, "↓"),
        h("button.btn.btn-sm.btn-ghost", { title: "Duplicate", onclick: () => { const nq = { ...q, id: newQid(), options: q.options?.slice() }; questions.splice(i + 1, 0, nq); key[nq.id] = JSON.parse(JSON.stringify(k)); renderQuestions(); } }, "⧉"),
        h("button.btn.btn-sm.btn-ghost", { title: "Delete", style: { color: "var(--danger)" }, onclick: () => { questions.splice(i, 1); delete key[q.id]; renderQuestions(); } }, "✕"),
      )),
      prompt);
    const body = h("div", { style: { marginTop: ".5rem" } });
    if (q.type === "mc" || q.type === "multi") {
      q.options = q.options || ["", ""];
      const rows = h("div");
      const draw = () => {
        clear(rows);
        q.options.forEach((opt, oi) => {
          const isCorrect = q.type === "mc" ? k.correct === oi : Array.isArray(k.correct) && k.correct.includes(oi);
          const mark = h("input", { type: q.type === "mc" ? "radio" : "checkbox", name: `c_${q.id}`, checked: isCorrect, title: "Correct answer", onchange: (e) => {
            if (q.type === "mc") k.correct = oi;
            else { const s = new Set(k.correct || []); e.target.checked ? s.add(oi) : s.delete(oi); k.correct = [...s].sort(); }
          } });
          rows.append(h("div.opt-row", mark,
            h("input.input", { value: opt, placeholder: `Option ${oi + 1}`, oninput: (e) => (q.options[oi] = e.target.value) }),
            h("button.btn.btn-sm.btn-ghost", { onclick: () => { q.options.splice(oi, 1); if (q.type === "mc") { if (k.correct === oi) delete k.correct; else if (k.correct > oi) k.correct--; } else k.correct = (k.correct || []).filter((c) => c !== oi).map((c) => (c > oi ? c - 1 : c)); draw(); } }, "✕")));
        });
      };
      draw();
      body.append(h("p.help", `Tick the correct ${q.type === "mc" ? "option" : "options"}.`), rows,
        h("div.row", h("button.btn.btn-sm", { onclick: () => { q.options.push(""); draw(); } }, "+ option"),
          q.type === "multi" ? h("label.check.small", h("input", { type: "checkbox", checked: !!k.partialCredit, onchange: (e) => (k.partialCredit = e.target.checked) }), h("span", "Partial credit")) : null));
    } else if (q.type === "tf") {
      body.append(h("div.row", h("span.small.muted", "Correct answer:"),
        ...[[true, "True"], [false, "False"]].map(([v, l]) => h("label.check", h("input", { type: "radio", name: `c_${q.id}`, checked: k.correct === v, onchange: () => (k.correct = v) }), h("span", l)))));
    } else if (q.type === "text") {
      body.append(h("label.field", h("span", "Accepted answers (one per line – any of them earns the points)"),
        h("textarea", { rows: 3, oninput: (e) => (k.accepted = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)) }, (k.accepted || []).join("\n"))),
        h("label.check.small", h("input", { type: "checkbox", checked: !!k.caseSensitive, onchange: (e) => (k.caseSensitive = e.target.checked) }), h("span", "Case sensitive")),
        h("p.help", "Matching ignores capitalisation (unless case sensitive), extra spaces and surrounding punctuation."));
    } else {
      body.append(h("p.help", "Essay answers are graded manually from the Grades tab."));
    }
    box.append(body);
    return box;
  }
  const newQid = () => `q_${randomId(6)}`;

  const addQ = (type) => { const q = { id: newQid(), type, prompt: "", points: 1 }; if (type === "mc" || type === "multi") q.options = ["", "", "", ""]; questions.push(q); key[q.id] = type === "tf" ? { correct: true } : {}; renderQuestions(); qHost.lastElementChild?.scrollIntoView({ behavior: "smooth" }); };

  const errBox = h("div.form-error", { hidden: true });
  const collect = () => {
    const opens = new Date(f.opensAt.value), closes = new Date(f.closesAt.value);
    const settings = {
      durationMinutes: Math.max(1, Math.min(600, parseInt(f.durationMinutes.value) || 60)),
      maxViolations: Math.max(1, parseInt(f.maxViolations.value) || 5),
      violationAction: f.violationAction.value,
      questionsPerStudent: Math.max(0, parseInt(f.questionsPerStudent.value) || 0),
      allowedDomain: f.allowedDomain.value.trim().toLowerCase().replace(/^@/, ""),
      roster: f.roster.value.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      requireFullscreen: f.requireFullscreen.input.checked, blockClipboard: f.blockClipboard.input.checked,
      shuffleQuestions: f.shuffleQuestions.input.checked, shuffleOptions: f.shuffleOptions.input.checked,
      oneAtATime: f.oneAtATime.input.checked, requireStudentId: f.requireStudentId.input.checked,
      showCorrectAnswers: f.showCorrectAnswers.input.checked, autoGrade: f.autoGrade.input.checked,
    };
    const errs = [];
    if (!f.title.value.trim()) errs.push("Title is required");
    if (isNaN(opens) || isNaN(closes)) errs.push("Set valid open/close dates");
    else if (closes <= opens) errs.push("Close date must be after open date");
    questions.forEach((q, i) => { errs.push(...validateQuestion(q, i), ...validateKey(q, key[q.id], i)); });
    if (settings.questionsPerStudent > questions.length) errs.push("Questions per student exceeds number of questions");
    return { settings, opens, closes, errs };
  };

  async function save(newStatus) {
    const { settings, opens, closes, errs } = collect();
    const publishing = newStatus === "open" || (!newStatus && ex.status === "open");
    const metaErrs = errs.filter((e) => /^(Title|Set|Close|Questions per)/.test(e));
    // Drafts may be saved with incomplete questions; an OPEN exam may not.
    const blocking = publishing ? errs : metaErrs;
    if (publishing && !questions.length) blocking.push("Add at least one question before publishing.");
    if (blocking.length) { errBox.hidden = false; errBox.innerHTML = blocking.map(esc).join("<br>"); errBox.scrollIntoView({ behavior: "smooth" }); return false; }
    errBox.hidden = true;
    if (errs.length) toast(`Saved as draft with ${errs.length} incomplete question(s).`, "warn", 5000);
    const id = ex.id || examCode(6);
    const status = newStatus || ex.status || "draft";
    const cleanQuestions = questions.map((q) => { const c = { id: q.id, type: q.type, prompt: q.prompt.trim(), points: Number(q.points) || 1 }; if (q.options) c.options = q.options.map((o) => String(o).trim()); return c; });
    const cleanKey = {}; for (const q of cleanQuestions) cleanKey[q.id] = key[q.id] || {};
    const examDoc = {
      ownerUid: P.user.uid, ownerName: f.ownerName.value.trim(), title: f.title.value.trim(), course: f.course.value.trim(), instructions: f.instructions.value,
      status, opensAt: Timestamp.fromDate(opens), closesAt: Timestamp.fromDate(closes), settings, scoresReleased: !!ex.scoresReleased,
      questionCount: cleanQuestions.length, totalPoints: paperMaxPoints(settings.questionsPerStudent ? cleanQuestions.slice(0, settings.questionsPerStudent) : cleanQuestions),
      updatedAt: serverTimestamp(), createdAt: ex.createdAt || serverTimestamp(),
    };
    if (settings.questionsPerStudent) examDoc.totalPoints = Math.round(paperMaxPoints(cleanQuestions) / cleanQuestions.length * settings.questionsPerStudent);
    try {
      const b = writeBatch(db);
      b.set(doc(db, "exams", id), examDoc);
      b.set(doc(db, "exams", id, "content", "questions"), { questions: cleanQuestions, updatedAt: serverTimestamp() });
      b.set(doc(db, "exams", id, "private", "answerKey"), { answers: cleanKey, updatedAt: serverTimestamp() });
      await b.commit();
      delete P.cache[id];
      toast(newStatus === "open" ? `Published! Exam code: ${id}` : "Saved.", "success");
      if (!ex.id) location.hash = `#exam/${id}/edit`; else route();
      return true;
    } catch (e) { errBox.hidden = false; errBox.textContent = e.message; return false; }
  }

  async function importDialog() {
    const ta = h("textarea", { rows: 12, placeholder: 'Paste JSON exported from this app, or the legacy JS array:\n[ { type: "text", q: "Question…", a: ["answer 1", "answer 2"] }, … ]', style: { fontFamily: "var(--mono)", fontSize: ".8rem" } });
    const file = h("input", { type: "file", accept: ".json,.js,.txt", onchange: async (e) => { const fl = e.target.files[0]; if (fl) ta.value = await fl.text(); } });
    const mode = h("select", h("option", { value: "append" }, "Append to existing questions"), h("option", { value: "replace" }, "Replace all questions"));
    const ok = await dialog({ title: "Import questions", body: h("div.stack", h("p.help", "Accepted: our JSON export ({questions, answers}), a plain array of {type,q|prompt,a|accepted|correct,options}, or the exact baseQuizData array from the old single-file quiz."), file, ta, h("label.field", h("span", "Mode"), mode)),
      buttons: [{ label: "Cancel", value: false }, { label: "Import", value: true, kind: "primary" }] });
    if (!ok) return;
    try {
      const { questions: qs, answers } = importQuestions(ta.value);
      const used = new Set(questions.map((q) => q.id));
      const incoming = qs.map((q) => { let id = q.id; if (!id || used.has(id) || mode.value === "append") id = newQid(); used.add(id); key[id] = answers[q.id] || {}; return { ...q, id }; });
      if (mode.value === "replace") { for (const q of questions) delete key[q.id]; questions = incoming; } else questions.push(...incoming);
      renderQuestions();
      toast(`Imported ${incoming.length} questions.`, "success");
    } catch (e) { toast("Import failed: " + e.message, "error", 6000); }
  }
  const exportJson = () => downloadText(`${(f.title.value || "exam").replace(/[^a-z0-9]+/gi, "-")}.json`, JSON.stringify({ title: f.title.value, questions, answers: key }, null, 2), "application/json");

  main.append(
    h("div.card-head", h("h1", ex.id ? "Edit exam" : "New exam"), h("div.row", ex.id ? h("span.pill-code", ex.id) : null, statusBadge(ex.status))),
    sessionsCount && ex.status !== "draft" ? h("div.form-error", { style: { background: "var(--warn-soft)", color: "var(--warn)", marginBottom: "1rem" } }, `⚠ ${sessionsCount} student session(s) exist. Changing, adding or removing QUESTIONS now will scramble the per-student order and break grading for students who already started. Settings and dates are safe to change.`) : null,
    errBox,
    h("div.card", h("h3", "Details"),
      h("div.grid.grid-2", h("label.field", h("span", "Title *"), f.title), h("label.field", h("span", "Course"), f.course)),
      h("label.field", { style: { marginTop: ".7rem" } }, h("span", "Instructions for students"), f.instructions),
      h("div.grid.grid-3", { style: { marginTop: ".7rem" } },
        h("label.field", h("span", "Opens at"), f.opensAt), h("label.field", h("span", "Closes at (hard cut-off)"), f.closesAt), h("label.field", h("span", "Professor name shown"), f.ownerName)),
    ),
    h("div.card", h("h3", "Timing & anti-cheat"),
      h("div.grid.grid-3",
        h("label.field", h("span", "Duration (minutes)"), f.durationMinutes),
        h("label.field", h("span", "Violation limit"), f.maxViolations),
        h("label.field", h("span", "When the limit is reached"), f.violationAction),
      ),
      h("div.grid.grid-2", { style: { marginTop: ".8rem" } }, f.requireFullscreen, f.blockClipboard, f.shuffleQuestions, f.shuffleOptions, f.oneAtATime, f.requireStudentId, f.showCorrectAnswers, f.autoGrade),
      h("div.grid.grid-3", { style: { marginTop: ".8rem" } },
        h("label.field", h("span", "Questions per student (0 = all)"), f.questionsPerStudent, h("span.help", "Random subset per student from the pool below.")),
        h("label.field", h("span", "Restrict to e-mail domain"), f.allowedDomain),
        h("label.field", h("span", "Roster (allowed e-mails)"), f.roster),
      ),
    ),
    h("div.card",
      h("div.card-head", h("div", h("h3", "Questions"), statsEl),
        h("div.row", h("button.btn.btn-sm", { onclick: importDialog }, "⬆ Import"), h("button.btn.btn-sm", { onclick: exportJson }, "⬇ Export JSON"))),
      qHost,
      h("div.row", { style: { marginTop: ".8rem" } }, h("span.small.muted", "Add:"),
        ...Object.entries(QUESTION_TYPES).map(([v, l]) => h("button.btn.btn-sm", { onclick: () => addQ(v) }, "+ " + l.split(" (")[0]))),
    ),
    h("div.card", h("div.row",
      h("button.btn.btn-primary", { onclick: () => save() }, "💾 Save"),
      ex.status !== "open" ? h("button.btn.btn-success", { onclick: async () => { if (await confirmDialog("Publish exam?", "Students with the code will be able to start it within the open/close window.", "Publish", "success")) save("open"); } }, "🚀 Publish (open)") : null,
      ex.status === "open" ? h("button.btn", { onclick: async () => { if (await confirmDialog("Close exam?", "Students can no longer start or continue. Sessions in progress will be cut off at their deadline or now, whichever is sooner.", "Close exam")) save("closed"); } }, "⏹ Close exam") : null,
      ex.status === "closed" ? h("button.btn", { onclick: () => save("open") }, "Re-open") : null,
      h("div.spacer"),
      ex.id ? h("button.btn.btn-sm", { onclick: async () => { const t = await promptDialog("Duplicate exam", "Title for the copy", ex.title + " (copy)"); if (!t) return; await duplicateExam(data, t); } }, "⧉ Duplicate") : null,
      ex.id ? h("button.btn.btn-sm.btn-danger", { onclick: () => deleteExam(ex.id) }, "🗑 Delete exam") : null,
    )),
  );
  renderQuestions();
}

async function duplicateExam(data, title) {
  const id = examCode(6);
  const b = writeBatch(db);
  const { id: _omit, ...rest } = data.exam;
  b.set(doc(db, "exams", id), { ...rest, title, status: "draft", scoresReleased: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  b.set(doc(db, "exams", id, "content", "questions"), { questions: data.questions, updatedAt: serverTimestamp() });
  b.set(doc(db, "exams", id, "private", "answerKey"), { answers: data.key, updatedAt: serverTimestamp() });
  await b.commit();
  toast("Duplicated.", "success"); location.hash = `#exam/${id}/edit`;
}

async function deleteExam(code) {
  if (!(await confirmDialog("Delete exam?", `This permanently deletes exam <b>${code}</b>, every student session, event log and grade. Export the grades first if you need them.`, "Delete everything"))) return;
  try {
    const sess = await getDocs(query(collection(db, "sessions"), where("examCode", "==", code)));
    for (const s of sess.docs) {
      const evs = await getDocs(collection(db, "sessions", s.id, "events"));
      await batchDelete([...evs.docs.map((d) => d.ref), doc(db, "grades", s.id), s.ref]);
    }
    await batchDelete([doc(db, "exams", code, "content", "questions"), doc(db, "exams", code, "private", "answerKey"), doc(db, "exams", code)]);
    delete P.cache[code]; toast("Exam deleted.", "success"); location.hash = "#exams";
  } catch (e) { toast(e.message, "error"); }
}
async function batchDelete(refs) {
  for (let i = 0; i < refs.length; i += 400) { const b = writeBatch(db); refs.slice(i, i + 400).forEach((r) => b.delete(r)); await b.commit(); }
}

// ---------------------------------------------------------------- grading core (runs in professor's browser)
async function computeGrade(data, session, sid, existing) {
  const paper = buildPaper(data.questions, data.exam.settings, sid);
  const overrides = existing?.overrides || {};
  const g = gradeSession(paper, data.key, session.answers || {}, overrides);
  if (data.exam.settings.showCorrectAnswers) {
    for (const q of paper) {
      const k = data.key[q.id]; if (!k) continue;
      const row = g.perQuestion[q.id];
      if (q.type === "text") row.expected = k.accepted || [];
      else if (q.type !== "essay") row.expected = k.correct;
    }
  }
  return {
    sid, examCode: data.exam.id, uid: session.uid, email: session.email, displayName: session.displayName || "", studentId: session.studentId || "", section: session.section || "",
    score: g.score, max: g.max, percent: g.percent, perQuestion: g.perQuestion, needsManual: g.needsManual, overrides,
    feedback: existing?.feedback || "", gradedAt: serverTimestamp(), gradedBy: P.user.uid, auto: !Object.keys(overrides).length,
  };
}
async function writeGrade(data, session, sid, existing) {
  const grade = await computeGrade(data, session, sid, existing);
  await setDoc(doc(db, "grades", sid), grade);
  return grade;
}

// ---------------------------------------------------------------- live monitor
async function viewMonitor(main, code) {
  let data; try { data = await loadExam(code, true); } catch (e) { return main.append(h("div.form-error", e.message)); }
  const ex = data.exam;
  const sessions = new Map(), grades = new Map(), risks = new Map();
  const autoGrading = new Set();

  const stats = h("div.grid.grid-3", { style: { gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", marginBottom: "1rem" } });
  const tbody = h("tbody");
  const search = h("input.input", { placeholder: "Filter by name / e-mail / section…", style: { maxWidth: "300px" }, oninput: () => render() });
  const onlyFlag = h("input", { type: "checkbox", onchange: () => render() });
  main.append(
    h("div.card-head", h("div", h("h1", ex.title), h("div.small.muted", `${ex.course || ""} · ${ex.settings.durationMinutes} min · limit ${ex.settings.maxViolations} violations (${ex.settings.violationAction})`)),
      h("div.row", h("span.pill-code", code), statusBadge(ex.status),
        h("button.btn.btn-sm", { onclick: () => { navigator.clipboard?.writeText(`${location.origin}${location.pathname.replace(/professor\.html$/, "")}exam.html?code=${code}`); toast("Student link copied.", "success"); } }, "Copy student link"))),
    ex.status !== "open" ? h("div.form-error", { style: { marginBottom: "1rem" } }, "This exam is not open. Students cannot start it. ", h("a", { href: `#exam/${code}/edit` }, "Publish it from the editor.")) : null,
    stats,
    h("div.card",
      h("div.row.between", { style: { marginBottom: ".7rem" } }, h("div.row", search, h("label.check.small", onlyFlag, h("span", "Only flagged / at-risk"))),
        h("div.row", h("button.btn.btn-sm", { onclick: analyseAll }, "🔍 Analyse risk (loads event logs)"), h("button.btn.btn-sm", { onclick: () => exportCsv(data, sessions, grades, risks) }, "⬇ CSV"))),
      h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "Student"), h("th", "Status"), h("th", "Progress"), h("th", "Time left"), h("th", "Violations"), h("th", "Risk"), h("th", "Score"), h("th", "Actions"))), tbody)),
    ),
  );

  const unsub = onSnapshot(query(collection(db, "sessions"), where("examCode", "==", code)), (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "removed") { sessions.delete(ch.doc.id); return; }
      const s = { id: ch.doc.id, ...ch.doc.data() };
      sessions.set(s.id, s);
      if (ch.type === "modified" || ch.type === "added") maybeAutoGrade(s);
    });
    render();
  }, (e) => toast("Live monitor error: " + e.message, "error"));
  const unsubG = onSnapshot(query(collection(db, "grades"), where("examCode", "==", code)), (snap) => {
    snap.docChanges().forEach((ch) => ch.type === "removed" ? grades.delete(ch.doc.id) : grades.set(ch.doc.id, ch.doc.data()));
    render();
  });
  P.unsubs.push(unsub, unsubG);
  const ticker = setInterval(render, 5000); P.unsubs.push(() => clearInterval(ticker));

  async function maybeAutoGrade(s) {
    if (!ex.settings.autoGrade || s.status !== "submitted" || grades.has(s.id) || autoGrading.has(s.id)) return;
    autoGrading.add(s.id);
    try { await writeGrade(data, s, s.id, null); } catch (e) { console.warn("auto-grade failed", e); } finally { autoGrading.delete(s.id); }
  }
  async function analyseAll() {
    toast("Loading event logs…");
    for (const s of sessions.values()) { risks.set(s.id, riskScore(s, await loadEvents(s.id), ex.settings)); }
    render(); toast("Risk analysis done.", "success");
  }

  function render() {
    const list = [...sessions.values()];
    const q = search.value.trim().toLowerCase();
    const counts = { total: list.length, in_progress: 0, submitted: 0, locked: 0, expired: 0, online: 0, flagged: 0 };
    for (const s of list) {
      const es = effectiveStatus(s, ex); counts[es] = (counts[es] || 0) + 1;
      if (es === "in_progress" && Date.now() - (toDate(s.heartbeatAt)?.getTime() || 0) < 60_000) counts.online++;
      if (s.flagged || risks.get(s.id)?.level === "high" || s.violations >= ex.settings.maxViolations) counts.flagged++;
    }
    clear(stats);
    [["Students", counts.total], ["Online now", counts.online], ["In progress", counts.in_progress], ["Submitted", counts.submitted], ["Locked", counts.locked], ["Expired", counts.expired], ["Flagged", counts.flagged]]
      .forEach(([l, n]) => stats.append(h("div.stat", h("div.n", { style: l === "Flagged" && n ? { color: "var(--danger)" } : l === "Locked" && n ? { color: "var(--danger)" } : {} }, String(n)), h("div.l", l))));

    clear(tbody);
    list.sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));
    for (const s of list) {
      const es = effectiveStatus(s, ex), risk = risks.get(s.id), g = grades.get(s.id);
      const flagged = s.flagged || risk?.level === "high" || s.violations >= ex.settings.maxViolations;
      if (q && !`${s.displayName} ${s.email} ${s.studentId} ${s.section}`.toLowerCase().includes(q)) continue;
      if (onlyFlag.checked && !flagged && !(risk?.level === "medium")) continue;
      const hbAge = Date.now() - (toDate(s.heartbeatAt)?.getTime() || 0);
      const dot = es !== "in_progress" ? "" : hbAge < 60_000 ? "dot-online" : hbAge < 180_000 ? "dot-idle" : "dot-offline";
      const dl = deadlineOf(s, ex);
      const left = es === "in_progress" && dl ? mmss((dl - Date.now()) / 1000) : "—";
      const tr = h("tr", { class: `risk-${risk?.level || (flagged ? "high" : "")}` },
        h("td", h("div", dot ? h("span.dot", { class: `dot ${dot}`, title: `heartbeat ${ago(s.heartbeatAt)}` }) : null, h("strong", s.displayName || "—"), s.flagged ? " 🚩" : ""),
          h("div.small.muted", `${s.email}${s.studentId ? " · " + s.studentId : ""}${s.section ? " · " + s.section : ""}`)),
        h("td", statusBadge(es), h("div.small.muted", es === "submitted" ? fmtTime(s.submittedAt) : `started ${fmtTime(s.startedAt)}`)),
        h("td", `${s.progress?.answered ?? Object.keys(s.answers || {}).length} / ${s.progress?.total || ex.questionCount || "?"}`),
        h("td.mono", left, s.extraMinutes ? h("div.small.muted", `+${s.extraMinutes} min`) : null),
        h("td", h("strong", { style: s.violations >= ex.settings.maxViolations ? { color: "var(--danger)" } : {} }, String(s.violations || 0)), h("span.muted.small", ` / ${ex.settings.maxViolations}`)),
        h("td", risk ? h(`span.badge.badge-${risk.level === "high" ? "danger" : risk.level === "medium" ? "warn" : "success"}`, { title: risk.reasons.join(", ") }, `${risk.level} ${risk.score}`) : h("span.muted.small", "—")),
        h("td", g ? h("span", h("strong", `${g.score}/${g.max}`), g.needsManual ? h("span.badge.badge-warn", { style: { marginLeft: ".3rem" }, title: "essay questions need manual grading" }, "manual") : null) : h("span.muted.small", es === "submitted" || es === "expired" ? "ungraded" : "—")),
        h("td", h("div.row", { style: { gap: ".3rem" } },
          h("button.btn.btn-sm", { onclick: () => openDrawer(data, s, grades.get(s.id), risks) }, "View"),
          es === "locked" ? h("button.btn.btn-sm.btn-success", { onclick: () => act(s, { status: "in_progress", unlockedAt: serverTimestamp() }, "Unlocked") }, "Unlock") : null,
          es === "in_progress" || es === "locked" ? h("button.btn.btn-sm", { title: "Add time", onclick: async () => { const m = await promptDialog("Extra time", "Total extra minutes for this student", String(s.extraMinutes || 0), "number"); if (m != null) act(s, { extraMinutes: Math.max(0, parseInt(m) || 0) }, "Time updated"); } }, "+⏱") : null,
          es === "in_progress" || es === "locked" || es === "expired" ? h("button.btn.btn-sm", { title: "Force submit with saved answers", onclick: async () => { if (await confirmDialog("Force submit?", `Submit ${esc(s.displayName || s.email)} now with their saved answers?`, "Submit", "primary")) act(s, { status: "submitted", submittedAt: serverTimestamp() }, "Submitted"); } }, "Submit") : null,
          es !== "terminated" && es !== "submitted" ? h("button.btn.btn-sm.btn-danger", { title: "Terminate attempt", onclick: async () => { if (await confirmDialog("Terminate attempt?", "The student is thrown out and receives no score unless you grade manually.", "Terminate")) act(s, { status: "terminated", terminatedAt: serverTimestamp() }, "Terminated"); } }, "✕") : null,
          h("button.btn.btn-sm.btn-ghost", { title: "Reset attempt (delete session so the student can start over)", onclick: async () => { if (await confirmDialog("Reset attempt?", `Delete ${esc(s.displayName || s.email)}'s session, events and grade so they can start again?`, "Reset")) { await resetSession(s.id); toast("Attempt reset.", "success"); } } }, "↺"),
        )),
      );
      tbody.append(tr);
    }
    if (!list.length) tbody.append(h("tr", h("td", { colspan: 8 }, h("div.empty", "No students have started yet. Share the code ", h("strong", code), "."))));
  }
  async function act(s, patch, msg) {
    try { await updateDoc(doc(db, "sessions", s.id), { ...patch, updatedAt: serverTimestamp() }); toast(msg, "success"); }
    catch (e) { toast(e.message, "error"); }
  }
}

async function loadEvents(sid) {
  const snap = await getDocs(query(collection(db, "sessions", sid, "events"), orderBy("at", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function resetSession(sid) {
  const evs = await getDocs(collection(db, "sessions", sid, "events"));
  await batchDelete([...evs.docs.map((d) => d.ref), doc(db, "grades", sid), doc(db, "sessions", sid)]);
}

// ---------------------------------------------------------------- student drawer (review + manual grading)
async function openDrawer(data, s, grade, risks) {
  const ex = data.exam;
  const events = await loadEvents(s.id);
  const risk = riskScore(s, events, ex.settings); risks?.set(s.id, risk);
  const paper = buildPaper(data.questions, ex.settings, s.id);
  const overrides = JSON.parse(JSON.stringify(grade?.overrides || {}));
  const feedback = h("textarea", { rows: 2, placeholder: "Feedback shown to the student with the score (optional)" }, grade?.feedback || "");
  const note = h("textarea", { rows: 2, placeholder: "Private note (only professors see this)" }, s.note || "");
  const drawer = h("div.drawer");
  const close = () => drawer.remove();
  const preview = gradeSession(paper, data.key, s.answers || {}, overrides);
  const totalEl = h("div.stat", h("div.n", `${preview.score} / ${preview.max}`), h("div.l", `${preview.percent}%${preview.needsManual ? ` · ${preview.needsManual} to grade manually` : ""}`));
  const refreshTotal = () => { const g = gradeSession(paper, data.key, s.answers || {}, overrides); totalEl.firstChild.textContent = `${g.score} / ${g.max}`; totalEl.lastChild.textContent = `${g.percent}%${g.needsManual ? ` · ${g.needsManual} to grade manually` : ""}`; };

  const tabs = h("div.tabs"); const panes = {};
  const mk = (name, label) => { const b = h("button", { onclick: () => { $$("button", tabs).forEach((x) => x.classList.toggle("active", x === b)); Object.entries(panes).forEach(([k, p]) => (p.hidden = k !== name)); } }, label); tabs.append(b); panes[name] = h("div"); return panes[name]; };
  const answersPane = mk("answers", "Answers & grading"), eventsPane = mk("events", `Event log (${events.length})`), infoPane = mk("info", "Device / info");
  tabs.firstChild.classList.add("active"); eventsPane.hidden = true; infoPane.hidden = true;

  // answers
  answersPane.append(h("div.answer-review", paper.map((q, i) => {
    const r = preview.perQuestion[q.id]; const k = data.key[q.id];
    const cls = r.correct === true ? "ok" : r.correct === "partial" ? "partial" : r.correct === false ? "bad" : "manual";
    const earned = h("input.input", { type: "number", step: .5, min: 0, max: q.points, value: overrides[q.id]?.earned ?? r.earned, style: { width: "80px" }, oninput: (e) => { overrides[q.id] = { ...(overrides[q.id] || {}), earned: Number(e.target.value) }; refreshTotal(); } });
    const comment = h("input.input", { placeholder: "comment to student (optional)", value: overrides[q.id]?.comment || "", oninput: (e) => { overrides[q.id] = { ...(overrides[q.id] || {}), earned: overrides[q.id]?.earned ?? r.earned, comment: e.target.value }; } });
    return h("div.ar", { class: `ar ${cls}` },
      h("div.q-num", h("span", `Q${i + 1} · ${QUESTION_TYPES[q.type]?.split(" (")[0]}`), h("span.row", earned, h("span.muted", `/ ${q.points}`))),
      h("div", { style: { fontWeight: 600, margin: ".3rem 0" } }, q.prompt),
      h("div.small", h("strong", "Student: "), fmtAnswer(q, s.answers?.[q.id])),
      q.type !== "essay" ? h("div.small.muted", h("strong", "Key: "), fmtAnswer(q, q.type === "text" ? k?.accepted : k?.correct)) : null,
      h("div", { style: { marginTop: ".4rem" } }, comment),
    );
  })));

  // events
  const counts = risk.counts || {};
  eventsPane.append(
    h("div.row", { style: { marginBottom: ".6rem" } }, ...Object.entries(counts).sort((a, b) => (EVENT_WEIGHTS[b[0]] || 0) - (EVENT_WEIGHTS[a[0]] || 0)).map(([t, n]) => h(`span.badge${(EVENT_WEIGHTS[t] || 0) >= 3 ? ".badge-danger" : (EVENT_WEIGHTS[t] || 0) >= 1 ? ".badge-warn" : ""}`, `${t.replace(/_/g, " ")} ×${n}`))),
    h("ul.timeline", events.map((e) => h("li", h("span.t", fmtTime(e.at)), h("span", h("strong", e.type.replace(/_/g, " ")), e.detail && Object.keys(e.detail).length ? h("span.muted.small", " " + summarizeDetail(e)) : null)))),
    !events.length ? h("div.empty", "No events recorded.") : null,
  );

  // info
  const c = s.client || {};
  infoPane.append(h("div.stack",
    kv("Session id", s.id), kv("E-mail", s.email), kv("Student ID", s.studentId || "—"), kv("Section", s.section || "—"),
    kv("Started", fmtDate(s.startedAt)), kv("Submitted", fmtDate(s.submittedAt)), kv("Last heartbeat", fmtDate(s.heartbeatAt)), kv("Last saved", fmtDate(s.lastSavedAt)),
    kv("Extra time", `${s.extraMinutes || 0} min`), kv("Browser", c.ua || "—"), kv("Platform", `${c.platform || "—"} · ${c.lang || ""} · ${c.tz || ""}`),
    kv("Screen / viewport", `${c.screen || "—"} / ${c.viewport || "—"}`), kv("Touch device", c.touch ? "yes" : "no"), kv("Other tabs seen", counts.multiple_tabs ? "YES" : "no"),
  ));

  drawer.append(
    h("div.row.between", h("div", h("h2", s.displayName || s.email), h("div.small.muted", s.email), statusBadge(effectiveStatus(s, ex))), h("button.btn.btn-ghost", { onclick: close }, "✕ Close")),
    h("div.grid.grid-3", { style: { margin: ".8rem 0" } }, totalEl,
      h("div.stat", h("div.n", { style: { color: risk.level === "high" ? "var(--danger)" : risk.level === "medium" ? "var(--warn)" : "var(--success)" } }, `${risk.level.toUpperCase()} ${risk.score}`), h("div.l", "Risk score")),
      h("div.stat", h("div.n", String(s.violations || 0)), h("div.l", "Violations"))),
    risk.reasons.length ? h("p.small", h("strong", "Why: "), risk.reasons.join(" · ")) : null,
    tabs, answersPane, eventsPane, infoPane,
    h("div.card", { style: { marginTop: "1rem" } },
      h("label.field", h("span", "Feedback to student"), feedback),
      h("label.field", { style: { marginTop: ".5rem" } }, h("span", "Private note"), note),
      h("div.row", { style: { marginTop: ".7rem" } },
        h("button.btn.btn-primary", { onclick: async () => {
          try {
            const cleanOv = {}; for (const [k, v] of Object.entries(overrides)) if (v.earned != null || v.comment) cleanOv[k] = v;
            await writeGrade(data, s, s.id, { overrides: cleanOv, feedback: feedback.value });
            await updateDoc(doc(db, "sessions", s.id), { note: note.value, reviewed: true, updatedAt: serverTimestamp() });
            toast("Grade saved.", "success"); close();
          } catch (e) { toast(e.message, "error"); }
        } }, "💾 Save grade & note"),
        h("button.btn", { onclick: async () => { await updateDoc(doc(db, "sessions", s.id), { flagged: !s.flagged, updatedAt: serverTimestamp() }); toast(s.flagged ? "Flag removed" : "Flagged", "success"); close(); } }, s.flagged ? "🏳 Unflag" : "🚩 Flag for review"),
        h("div.spacer"),
        h("a.small", { href: "#", onclick: (e) => { e.preventDefault(); downloadText(`${s.id}-events.json`, JSON.stringify(events.map((ev) => ({ ...ev, at: toDate(ev.at)?.toISOString() })), null, 2), "application/json"); } }, "download event log"),
      )),
  );
  document.body.append(drawer);
}
const kv = (k, v) => h("div.row.between", { style: { borderBottom: "1px dashed var(--border)", padding: ".25rem 0" } }, h("span.muted.small", k), h("span.small.mono", { style: { textAlign: "right", wordBreak: "break-all" } }, v));
function fmtAnswer(q, a) {
  if (a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length)) return h("em.muted", "—");
  if (q.type === "mc") return optText(q, a);
  if (q.type === "multi") return (Array.isArray(a) ? a : [a]).map((v) => optText(q, v)).join("; ");
  if (q.type === "tf") return String(a) === "true" ? "True" : "False";
  if (Array.isArray(a)) return a.join(" / ");
  return String(a);
}
// paper options are {oi, text}; raw editor options are strings
const optText = (q, v) => {
  const o = (q.options || []).find((x) => typeof x === "object" && x.oi === Number(v)) ?? q.options?.[Number(v)];
  return typeof o === "string" ? o : o?.text ?? String(v);
};
function summarizeDetail(e) {
  const d = e.detail || {};
  const parts = [];
  if (d.ms) parts.push(`${Math.round(d.ms / 1000)}s away`);
  if (d.key) parts.push(d.key);
  if (d.len) parts.push(`${d.len} chars`);
  if (d.reason) parts.push(d.reason);
  if (d.reload) parts.push("after reload");
  if (d.offsetMs) parts.push(`clock off by ${Math.round(d.offsetMs / 1000)}s`);
  if (d.w) parts.push(`${d.w}×${d.h}`);
  if (e.q) parts.push(`on ${e.q}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------- grades view
async function viewGrades(main, code) {
  let data; try { data = await loadExam(code, true); } catch (e) { return main.append(h("div.form-error", e.message)); }
  const ex = data.exam;
  const [sessSnap, gradeSnap] = await Promise.all([getDocs(query(collection(db, "sessions"), where("examCode", "==", code))), getDocs(query(collection(db, "grades"), where("examCode", "==", code)))]);
  const sessions = new Map(sessSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const grades = new Map(gradeSnap.docs.map((d) => [d.id, d.data()]));
  const risks = new Map();

  const releaseBtn = h("button.btn", { class: `btn ${ex.scoresReleased ? "" : "btn-success"}`, onclick: async () => {
    const releasing = !ex.scoresReleased;
    if (!(await confirmDialog(releasing ? "Release scores?" : "Hide scores?", releasing ? `Students will see their score${ex.settings.showCorrectAnswers ? " and the correct answers" : ""} on their home page. Ungraded submissions are graded first.` : "Students will no longer see their scores.", releasing ? "Release" : "Hide", "primary"))) return;
    try {
      if (releasing) await gradeAll(false);
      await updateDoc(doc(db, "exams", code), { scoresReleased: releasing, updatedAt: serverTimestamp() });
      ex.scoresReleased = releasing; delete P.cache[code]; toast(releasing ? "Scores released." : "Scores hidden.", "success"); route();
    } catch (e) { toast(e.message, "error"); }
  } }, ex.scoresReleased ? "🙈 Hide scores" : "📢 Release scores");

  main.append(
    h("div.card-head", h("div", h("h1", "Grades"), h("div.small.muted", ex.title)), h("div.row", h("span.pill-code", code), ex.scoresReleased ? h("span.badge.badge-success", "Released") : h("span.badge", "Not released"))),
    h("div.card", h("div.row",
      h("button.btn.btn-primary", { onclick: () => gradeAll(false) }, "⚡ Grade ungraded"),
      h("button.btn", { onclick: () => gradeAll(true), title: "Recomputes every grade with the current answer key; keeps manual overrides" }, "♻ Regrade all"),
      releaseBtn,
      h("div.spacer"),
      h("button.btn", { onclick: () => exportCsv(data, sessions, grades, risks) }, "⬇ Export CSV"),
    ), h("p.help", { style: { marginTop: ".6rem" } }, "Grading runs in your browser using the private answer key – students never download it. Sessions still 'in progress' whose time has expired are graded from their last saved answers. Essay questions need manual points (click a row).")),
    h("div.card", h("div.table-wrap", h("table.table", h("thead", h("tr", h("th", "Student"), h("th", "Section"), h("th", "Status"), h("th", "Submitted"), h("th", "Violations"), h("th", "Score"), h("th", "%"), h("th", ""))), tbodyEl()))),
  );
  function tbodyEl() {
    const tb = h("tbody#gradesBody");
    const list = [...sessions.values()].sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));
    if (!list.length) tb.append(h("tr", h("td", { colspan: 8 }, h("div.empty", "No submissions yet."))));
    for (const s of list) {
      const g = grades.get(s.id), es = effectiveStatus(s, ex);
      tb.append(h("tr", { class: s.flagged || s.violations >= ex.settings.maxViolations ? "risk-high" : "" },
        h("td", h("strong", s.displayName || "—"), s.flagged ? " 🚩" : "", h("div.small.muted", `${s.email}${s.studentId ? " · " + s.studentId : ""}`)),
        h("td", s.section || "—"), h("td", statusBadge(es)), h("td", fmtDate(s.submittedAt)), h("td", String(s.violations || 0)),
        h("td", g ? h("strong", `${g.score} / ${g.max}`) : h("span.muted", "—"), g?.needsManual ? h("span.badge.badge-warn", { style: { marginLeft: ".3rem" } }, `${g.needsManual} manual`) : null),
        h("td", g ? `${g.percent}%` : "—"),
        h("td", h("button.btn.btn-sm", { onclick: () => openDrawer(data, s, g, risks) }, "Review")),
      ));
    }
    return tb;
  }
  async function gradeAll(regrade) {
    let n = 0;
    for (const s of sessions.values()) {
      const es = effectiveStatus(s, ex);
      if (!["submitted", "expired", "terminated"].includes(es)) continue;
      if (!regrade && grades.has(s.id)) continue;
      try { const g = await writeGrade(data, s, s.id, grades.get(s.id)); grades.set(s.id, g); n++; } catch (e) { console.warn(e); }
    }
    toast(`Graded ${n} submission(s).`, "success");
    const old = $("#gradesBody"); if (old) old.replaceWith(tbodyEl());
  }
}

function exportCsv(data, sessions, grades, risks) {
  const ex = data.exam;
  const rows = [["Name", "Email", "Student ID", "Section", "Status", "Started", "Submitted", "Violations", "Risk level", "Risk score", "Risk reasons", "Flagged", "Score", "Max", "Percent", "Needs manual", "Note"]];
  for (const s of sessions.values()) {
    const g = grades.get(s.id), r = risks.get(s.id);
    rows.push([s.displayName, s.email, s.studentId, s.section, effectiveStatus(s, ex), toDate(s.startedAt)?.toISOString() || "", toDate(s.submittedAt)?.toISOString() || "",
      s.violations || 0, r?.level || "", r?.score ?? "", r?.reasons.join("; ") || "", s.flagged ? "yes" : "", g?.score ?? "", g?.max ?? "", g?.percent ?? "", g?.needsManual ?? "", s.note || ""]);
  }
  downloadText(`${ex.id}-${ex.title.replace(/[^a-z0-9]+/gi, "-")}-grades.csv`, rows.map((r) => r.map(csvEscape).join(",")).join("\r\n"), "text/csv");
}

// ---------------------------------------------------------------- access
async function viewAccess(main) {
  main.append(h("div.card-head", h("h1", "Access"), null));
  const emailI = h("input.input", { type: "email", placeholder: "colleague@university.edu" });
  const list = h("div");
  main.append(
    h("div.card", h("h3", "Promote a professor"),
      h("p.help", "The colleague must sign in to this site once first (that creates their account). Then enter their e-mail here."),
      h("form.row", { onsubmit: async (e) => {
        e.preventDefault();
        const em = emailI.value.trim().toLowerCase(); if (!em) return;
        try {
          const snap = await getDocs(query(collection(db, "users"), where("email", "==", em)));
          if (snap.empty) return toast("No account with that e-mail has signed in yet.", "warn", 6000);
          await updateDoc(snap.docs[0].ref, { role: "professor", updatedAt: serverTimestamp() });
          toast(`${em} is now a professor.`, "success"); emailI.value = ""; load();
        } catch (e2) { toast(e2.message, "error"); }
      } }, h("div", { style: { flex: 1 } }, emailI), h("button.btn.btn-primary", { type: "submit" }, "Promote"))),
    h("div.card", h("h3", "Current professors"), list),
  );
  async function load() {
    clear(list);
    try {
      const snap = await getDocs(query(collection(db, "users"), where("role", "==", "professor")));
      if (snap.empty) list.append(h("p.muted", "None yet (bootstrap admin is defined in firestore.rules)."));
      snap.docs.forEach((d) => { const u = d.data(); list.append(h("div.row.between", { style: { padding: ".4rem 0", borderBottom: "1px solid var(--border)" } },
        h("div", h("strong", u.displayName || u.email), h("div.small.muted", u.email)),
        d.id !== P.user.uid ? h("button.btn.btn-sm", { onclick: async () => { if (await confirmDialog("Demote?", `${esc(u.email)} will become a student account.`, "Demote")) { await updateDoc(d.ref, { role: "student", updatedAt: serverTimestamp() }); load(); } } }, "Demote") : h("span.badge", "you"))); });
    } catch (e) { list.append(h("div.form-error", e.message)); }
  }
  load();
}

// ---------------------------------------------------------------- help
function viewHelp(main) {
  main.append(h("div.card", { html: `
    <h1>How an exam runs</h1>
    <ol>
      <li><strong>Create</strong> the exam (or import your question list), tick the anti-cheat settings, set the open/close window and <strong>Publish</strong>. You get a 6-character code.</li>
      <li>Students sign in at the home page and enter the code. They confirm their details, accept the rules and click Start – the server records the start time.</li>
      <li>Open <strong>Live monitor</strong> during the exam. You see who is online, progress, time left, violations and can <em>Unlock</em>, <em>add time</em>, <em>force-submit</em>, <em>terminate</em> or <em>reset</em> any student.</li>
      <li>Submissions are auto-graded in your browser (keep the monitor open, or click <em>Grade ungraded</em> later). Essay questions get points from the student drawer.</li>
      <li>Click <strong>Release scores</strong> when ready. Export a CSV for your records.</li>
    </ol>
    <h3>What is enforced by the server (cannot be bypassed by students)</h3>
    <ul>
      <li>Answer key is never downloadable by students; grades are only writable by you.</li>
      <li>One attempt per student per exam; identity is the verified sign-in e-mail (optionally restricted to a domain / roster).</li>
      <li>The clock uses the server's time: start + duration (+ your extra time). Late writes are rejected.</li>
      <li>Submitted / locked / terminated sessions are frozen.</li>
    </ul>
    <h3>What is recorded as evidence (student-side, therefore advisory)</h3>
    <p>Tab switches, window blur, fullscreen exits, copy/paste, blocked shortcuts, suspected devtools, reloads, second tabs, heartbeat gaps (offline periods), suspiciously fast completion. Use <em>Analyse risk</em> and the per-student event log; the risk score is a triage aid, not a verdict. Nothing in a browser can see a second device – pair this with a visible proctor or webcam call for high-stakes exams.</p>
  ` }));
}
