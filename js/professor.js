// Professor dashboard: exam builder, live monitor, grading, access.
//
// Grading is a database function now, so this page never downloads an answer
// key to compute a score — it asks the server and shows the result.
import { siteConfig } from "./config.js";
import { watchAuth, renderAuthPanel, logout } from "./auth.js";
import {
  myProfile, claimProfessor, setRoleByEmail, listProfessors,
  myExams, getExam, saveExam, deleteExam,
  examQuestions, examQuestionsWithKeys, replaceQuestions,
  examSessions, sessionEvents, profUpdateSession, resetSession, getPaper,
  gradeExam, gradeSession, setOverride, setFeedback, examGrades, releaseScores,
  watchExamSessions, watchExamGrades,
} from "./db.js";
import { QUESTION_TYPES, validateQuestion, validateKey, paperMaxPoints } from "./paper.js";
import { riskScore, importQuestions, EVENT_WEIGHTS } from "./grading.js";
import {
  $, $$, h, esc, toast, dialog, confirmDialog, promptDialog, fmtDate, fmtTime, ago, mmss,
  toDate, toLocalInput, clear, downloadText, csvEscape, examCode, randomId,
} from "./ui.js";

// tells the boot watchdog in the HTML that the module graph loaded
window.__unoBooted = true;

const app = $("#app");
$("#brandName").textContent = siteConfig.institutionName;

const P = { user: null, profile: null, unsubs: [] };

// ---------------------------------------------------------------- auth
watchAuth(async (user) => {
  window.__unoRendered = true;
  clear($("#topRight"));
  if (!user) {
    clear(app);
    const host = h("div");
    app.append(h("div.container.narrow", h("div.card", h("h2", "Professor sign-in"), host)));
    renderAuthPanel(host, { professorMode: true });
    return;
  }
  P.user = user;
  try { P.profile = await myProfile(); }
  catch (e) { app.innerHTML = `<div class="container"><div class="card"><div class="form-error">${esc(e.friendly || e.message)}</div></div></div>`; return; }

  $("#topRight").append(
    h("span.small.muted", user.email),
    h("a.btn.btn-sm", { href: "./" }, "Student view"),
    h("button.btn.btn-sm", { onclick: () => logout() }, "Sign out"),
  );
  if (P.profile?.role !== "professor") return renderNotProfessor(user);
  window.addEventListener("hashchange", route);
  route();
});

function renderNotProfessor(user) {
  clear(app);
  const codeI = h("input.input", { placeholder: "XXXXX-XXXXX-XXXXX", autocomplete: "off",
    style: { textTransform: "uppercase", letterSpacing: ".08em" } });
  const err = h("div.form-error", { hidden: true });
  app.append(h("div.container.narrow", h("div.card",
    h("h2", "This account is not a professor yet"),
    h("p", "If you are setting this site up for the first time, enter the one-time " +
           "bootstrap code from your deployment notes:"),
    h("div.row", h("div", { style: { flex: 1 } }, codeI),
      h("button.btn.btn-primary", { onclick: async () => {
        err.hidden = true;
        try {
          await claimProfessor(codeI.value.trim().toUpperCase());
          toast("You are now a professor.", "success");
          P.profile = await myProfile();
          location.reload();
        } catch (e) { err.hidden = false; err.textContent = e.friendly || e.message; }
      } }, "Become professor")),
    err,
    h("p.help", { style: { marginTop: "1rem" } },
      "Otherwise ask an existing professor to add you from their ", h("strong", "Access"),
      " tab. Give them this e-mail: ", h("code", user.email)),
  )));
}

const stopLive = () => { P.unsubs.forEach((u) => { try { u(); } catch {} }); P.unsubs = []; };

function route() {
  stopLive();
  const [view, code, sub] = (location.hash || "#exams").slice(1).split("/");
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

// ---------------------------------------------------------------- helpers
const statusBadge = (st) => {
  const m = {
    draft: ["Draft", ""], open: ["Open", "badge-success"], closed: ["Closed", "badge-danger"],
    in_progress: ["In progress", "badge-accent"], submitted: ["Submitted", "badge-success"],
    locked: ["Locked", "badge-danger"], terminated: ["Terminated", "badge-danger"],
    expired: ["Expired", "badge-warn"],
  };
  const [l, c] = m[st] || [st, ""];
  return h(`span.badge${c ? "." + c : ""}`, l);
};

const deadlineOf = (s, ex) => {
  const start = toDate(s.started_at)?.getTime();
  if (!start) return null;
  const mins = (ex.duration_minutes || 0) + (s.extra_minutes || 0);
  return Math.min(start + mins * 60_000, toDate(ex.closes_at)?.getTime() || Infinity);
};
const effectiveStatus = (s, ex) => {
  if (s.status !== "in_progress") return s.status;
  const dl = deadlineOf(s, ex);
  return dl && Date.now() > dl + 90_000 ? "expired" : "in_progress";
};

// ------------------------------------------------------------- exams list
async function viewExams(main) {
  main.append(h("div.card-head", h("h1", "My exams"), h("a.btn.btn-primary", { href: "#new" }, "➕ New exam")));
  const host = h("div.grid.grid-2"); main.append(host);
  try {
    const exams = await myExams();
    if (!exams.length) {
      return host.append(h("div.empty", "No exams yet. Create one, or import your existing question list."));
    }
    for (const ex of exams) {
      host.append(h("div.card.exam-tile", {
        onclick: () => (location.hash = `#exam/${ex.code}/${ex.status === "open" ? "monitor" : "edit"}`),
      },
        h("div.card-head",
          h("div", h("h3", ex.title),
            h("div.small.muted", [ex.course, `${ex.question_count} questions`, `${ex.duration_minutes} min`].filter(Boolean).join(" · "))),
          statusBadge(ex.status)),
        h("div.row.between",
          h("span.pill-code", { style: { fontSize: "1.1rem" } }, ex.code),
          h("div.row",
            h("a.btn.btn-sm", { href: `#exam/${ex.code}/edit`, onclick: (e) => e.stopPropagation() }, "Edit"),
            h("a.btn.btn-sm", { href: `#exam/${ex.code}/monitor`, onclick: (e) => e.stopPropagation() }, "Monitor"),
            h("a.btn.btn-sm", { href: `#exam/${ex.code}/grades`, onclick: (e) => e.stopPropagation() }, "Grades"))),
        h("div.small.muted", { style: { marginTop: ".5rem" } },
          ex.scores_released ? "Scores released · " : "", `Updated ${ago(ex.updated_at)}`),
      ));
    }
  } catch (e) { host.append(h("div.form-error", e.friendly || e.message)); }
}

// ----------------------------------------------------------------- editor
async function viewEditor(main, code) {
  let ex, questions = [];
  if (code) {
    try {
      ex = await getExam(code);
      if (!ex) throw new Error("Exam not found");
      questions = (await examQuestionsWithKeys(code)).map((q) => ({
        id: q.id, type: q.type, prompt: q.prompt,
        options: (q.options || []).slice(), points: Number(q.points), key: q.key || {},
      }));
    } catch (e) { return main.append(h("div.form-error", e.friendly || e.message)); }
  } else {
    ex = {
      code: null, owner_id: P.user.id, owner_name: P.profile?.display_name || P.user.email,
      title: "", course: "", instructions: "", status: "draft",
      opens_at: new Date().toISOString(),
      closes_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      scores_released: false, duration_minutes: 60, max_violations: 5,
      violation_action: "lock", require_fullscreen: true, block_clipboard: true,
      shuffle_questions: true, shuffle_options: true, questions_per_student: 0,
      one_at_a_time: false, require_student_id: true, show_correct_answers: false,
      allowed_domain: "", roster: [],
    };
  }

  let sessionCount = 0;
  if (code) { try { sessionCount = (await examSessions(code)).length; } catch {} }

  const f = {
    title: h("input.input", { value: ex.title, placeholder: "e.g. Information Assurance – Prelim Examination", required: true }),
    course: h("input.input", { value: ex.course || "", placeholder: "Course / subject (optional)" }),
    owner_name: h("input.input", { value: ex.owner_name || "" }),
    instructions: h("textarea", { placeholder: "Instructions shown to students before they start…" }, ex.instructions || ""),
    opens_at: h("input.input", { type: "datetime-local", value: toLocalInput(ex.opens_at) }),
    closes_at: h("input.input", { type: "datetime-local", value: toLocalInput(ex.closes_at) }),
    duration_minutes: h("input.input", { type: "number", min: 1, max: 600, value: ex.duration_minutes }),
    max_violations: h("input.input", { type: "number", min: 1, max: 50, value: ex.max_violations }),
    violation_action: h("select", [["lock", "Lock exam – professor must unlock"], ["submit", "Auto-submit the exam"], ["warn", "Only warn & report"]]
      .map(([v, l]) => h("option", { value: v, selected: ex.violation_action === v }, l))),
    questions_per_student: h("input.input", { type: "number", min: 0, value: ex.questions_per_student || 0 }),
    allowed_domain: h("input.input", { value: ex.allowed_domain || "", placeholder: "e.g. perpetualdalta.edu.ph (blank = any)" }),
    roster: h("textarea", { rows: 3, placeholder: "student1@school.edu\nstudent2@school.edu" },
      (ex.roster || []).join("\n")),
    require_fullscreen: sw("Require fullscreen", "The paper opens fullscreen. Leaving it is recorded.", ex.require_fullscreen),
    block_clipboard: sw("Block copy & paste", "Stops questions being pasted into a chat or search box.", ex.block_clipboard),
    shuffle_questions: sw("Shuffle question order", "Each student gets the questions in a different order.", ex.shuffle_questions),
    shuffle_options: sw("Shuffle answer options", "“B” is not the same choice on the screen next to them.", ex.shuffle_options),
    one_at_a_time: sw("One question at a time", "Nobody can photograph the whole paper at once.", ex.one_at_a_time),
    require_student_id: sw("Ask for student ID & section", "Collected once, before the timer starts.", ex.require_student_id),
    show_correct_answers: sw("Reveal correct answers afterwards", "Only takes effect once you release the scores.", ex.show_correct_answers),
  };
  /** A labelled toggle. `.input` is kept so save() can read it like the old checkbox. */
  function sw(label, desc, val) {
    const i = h("input", { type: "checkbox", checked: !!val, onchange: () => refreshSummary() });
    const l = h("label.switch", i, h("div", h("div.s-label", label), h("div.s-desc", desc)));
    l.input = i;
    return l;
  }
  for (const k of ["duration_minutes", "max_violations", "questions_per_student", "allowed_domain"])
    f[k].addEventListener("input", () => refreshSummary());
  f.violation_action.addEventListener("change", () => refreshSummary());
  f.roster.addEventListener("input", () => refreshSummary());

  // --- Presets. Most professors want one of three postures, not seven decisions.
  const PRESETS = [
    { name: "Practice", desc: "Open book. Nothing locked down, answers shown after.",
      set: { require_fullscreen: false, block_clipboard: false, shuffle_questions: false,
             shuffle_options: false, one_at_a_time: false, show_correct_answers: true },
      max_violations: 20, violation_action: "warn" },
    { name: "Standard quiz", desc: "Shuffled, fullscreen, copy blocked. A few slips forgiven.",
      set: { require_fullscreen: true, block_clipboard: true, shuffle_questions: true,
             shuffle_options: true, one_at_a_time: false, show_correct_answers: false },
      max_violations: 5, violation_action: "lock" },
    { name: "Strict proctored", desc: "One question at a time, short leash — two slips locks it.",
      set: { require_fullscreen: true, block_clipboard: true, shuffle_questions: true,
             shuffle_options: true, one_at_a_time: true, show_correct_answers: false },
      max_violations: 2, violation_action: "lock" },
  ];
  const presetBtns = PRESETS.map((p) => h("button.preset", { type: "button",
    onclick: () => {
      for (const [k, v] of Object.entries(p.set)) f[k].input.checked = v;
      f.max_violations.value = p.max_violations;
      f.violation_action.value = p.violation_action;
      refreshSummary();
      toast(`Applied the “${p.name}” preset. You can still change anything below.`, "success");
    } }, h("span.p-name", p.name), h("span.p-desc", p.desc)));
  const matchesPreset = (p) =>
    Object.entries(p.set).every(([k, v]) => f[k].input.checked === v) &&
    Number(f.max_violations.value) === p.max_violations &&
    f.violation_action.value === p.violation_action;

  // --- The one line that says what the exam actually does, plus a note on each
  //     collapsed group so nothing important hides behind a closed arrow.
  const summary = h("div.summary-line");
  const note = { timing: h("span.g-note"), proctor: h("span.g-note"),
                 delivery: h("span.g-note"), access: h("span.g-note"), after: h("span.g-note") };
  const ACTION_WORD = { lock: "lock the exam", submit: "auto-submit", warn: "warn only" };

  function refreshSummary() {
    presetBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(matchesPreset(PRESETS[i]))));
    const on = (k) => f[k].input.checked;
    const mins = Math.max(1, parseInt(f.duration_minutes.value) || 0);
    const per = Math.max(0, parseInt(f.questions_per_student.value) || 0);
    const lim = Math.max(1, parseInt(f.max_violations.value) || 1);
    const act = ACTION_WORD[f.violation_action.value] || f.violation_action.value;
    const rosterCount = f.roster.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).length;
    const domain = f.allowed_domain.value.trim().replace(/^@/, "");

    clear(summary);
    const bits = [
      [String(mins), " min"],
      [String(per || questions.length), per ? ` of ${questions.length} questions each` : " questions"],
      [null, on("require_fullscreen") ? "fullscreen" : "windowed"],
      [null, on("shuffle_questions") || on("shuffle_options") ? "shuffled" : "fixed order"],
      [String(lim), ` violations → ${act}`],
    ];
    bits.forEach(([b, rest], i) => {
      if (i) summary.append(h("span.sep", "•"));
      summary.append(b ? h("span", h("b", b), rest) : h("span", rest));
    });

    note.timing.textContent = `${mins} min · ${lim} violations → ${act}`;
    const pc = ["require_fullscreen", "block_clipboard"].filter(on).length;
    note.proctor.textContent = pc === 2 ? "fullscreen + clipboard locked"
      : pc === 1 ? (on("require_fullscreen") ? "fullscreen only" : "clipboard only") : "off";
    const dbits = [on("shuffle_questions") && "questions shuffled", on("shuffle_options") && "options shuffled",
                   on("one_at_a_time") && "one at a time", per && `${per} per student`].filter(Boolean);
    note.delivery.textContent = dbits.length ? dbits.join(", ") : "everyone gets the same paper";
    note.access.textContent = rosterCount ? `${rosterCount} on the roster`
      : domain ? `anyone @${domain}` : "anyone with the code";
    note.after.textContent = on("show_correct_answers") ? "answers revealed on release" : "scores only";
  }

  const qHost = h("div#qHost");
  const stats = h("span.small");
  const qFilter = h("input.input", { placeholder: "Search questions…", oninput: () => render() });
  const newQid = () => `new_${randomId(8)}`;
  let openQid = null;                       // only one question is expanded at a time

  const TYPE_CHIP = { mc: "Choice", multi: "Multi", tf: "T / F", text: "Short", essay: "Essay" };
  const isIncomplete = (q, i) => validateQuestion(q, i).length > 0 || validateKey(q, q.key, i).length > 0;

  function updateStats() {
    const bad = questions.filter(isIncomplete).length;
    clear(stats);
    stats.append(h("span.muted", `${questions.length} questions · ${paperMaxPoints(questions)} points`));
    if (bad) stats.append(h("span", { style: { color: "var(--warn)", fontWeight: "600" } }, ` · ${bad} unfinished`));
  }

  // A 60-question exam used to render 60 open editors at once. Now each question
  // is one line, and exactly one opens at a time.
  const render = () => {
    clear(qHost);
    const term = qFilter.value.trim().toLowerCase();
    const list = h("div.q-list");
    let shown = 0;
    questions.forEach((q, i) => {
      if (term && !(q.prompt || "").toLowerCase().includes(term)) return;
      shown++;
      list.append(qRow(q, i));
      if (q.id === openQid) list.append(h("div.q-body", qEditor(q, i)));
    });
    if (!shown) list.append(h("div.q-empty", questions.length
      ? `No question mentions “${qFilter.value.trim()}”.`
      : "No questions yet. Add one below, or import a file you already have."));
    qHost.append(list);
    updateStats();
    refreshSummary();
  };

  function qRow(q, i) {
    const open = q.id === openQid;
    const act = (title, glyph, fn, style) => h("button.btn.btn-sm.btn-ghost",
      { type: "button", title, style, onclick: (e) => { e.stopPropagation(); fn(); } }, glyph);
    const text = (q.prompt || "").trim();
    return h("div.q-row" + (open ? ".open" : ""), {
        dataset: { qid: q.id }, title: open ? "Click to collapse" : "Click to edit",
        onclick: () => { openQid = open ? null : q.id; render(); } },
      h("span.q-idx", `${i + 1}.`),
      h("span.type-chip", TYPE_CHIP[q.type] || q.type),
      h("span.q-text" + (text ? "" : ".blank"), text || "Untitled question"),
      h("span.q-meta",
        h("span.q-flag" + (isIncomplete(q, i) ? ".warn" : ""),
          { title: isIncomplete(q, i) ? "Missing a prompt, an option or an answer key" : "Ready" }),
        h("span.q-pts", `${q.points ?? 1} pt`)),
      h("span.q-actions",
        act("Move up", "↑", () => {
          if (i > 0) { [questions[i - 1], questions[i]] = [questions[i], questions[i - 1]]; render(); } }),
        act("Move down", "↓", () => {
          if (i < questions.length - 1) { [questions[i + 1], questions[i]] = [questions[i], questions[i + 1]]; render(); } }),
        act("Duplicate", "⧉", () => {
          questions.splice(i + 1, 0, { ...q, id: newQid(), options: q.options?.slice(),
            key: JSON.parse(JSON.stringify(q.key || {})) });
          render(); }),
        act("Delete", "✕", () => {
          questions.splice(i, 1); if (openQid === q.id) openQid = null; render(); },
          { color: "var(--danger)" })));
  }

  function qEditor(q, i) {
    const k = q.key || (q.key = {});
    const box = h("div", { dataset: { qid: q.id } });

    // Keep the collapsed row in step while typing, without re-rendering the
    // list (which would steal focus mid-word).
    const syncRow = () => {
      const r = qHost.querySelector(`.q-row[data-qid="${q.id}"]`);
      if (!r) return;
      const t = r.querySelector(".q-text"), txt = (q.prompt || "").trim();
      t.textContent = txt || "Untitled question";
      t.classList.toggle("blank", !txt);
      r.querySelector(".q-pts").textContent = `${q.points ?? 1} pt`;
      r.querySelector(".q-flag").classList.toggle("warn", isIncomplete(q, i));
      updateStats();
    };

    const typeSel = h("select", Object.entries(QUESTION_TYPES)
      .map(([v, l]) => h("option", { value: v, selected: q.type === v }, l)));
    typeSel.style.maxWidth = "260px";
    typeSel.onchange = () => {
      q.type = typeSel.value;
      if ((q.type === "mc" || q.type === "multi") && (!q.options || q.options.length < 2)) q.options = ["", ""];
      q.key = q.type === "tf" ? { correct: true } : {};
      render();
    };
    const prompt = h("textarea", { rows: 3, placeholder: "Question text",
      oninput: (e) => { q.prompt = e.target.value; syncRow(); } }, q.prompt || "");
    const pts = h("input.input", { type: "number", min: .5, step: .5, value: q.points ?? 1,
      style: { width: "80px" }, oninput: (e) => { q.points = Number(e.target.value); syncRow(); } });

    box.append(
      h("div.row", { style: { marginBottom: ".6rem" } },
        h("label.field", { style: { flex: "1", minWidth: "180px", maxWidth: "280px" } },
          h("span", "Question type"), typeSel),
        h("label.field", { style: { width: "90px" } }, h("span", "Points"), pts),
        h("div.spacer"),
        h("button.btn.btn-sm", { type: "button", title: "Collapse this question",
          onclick: () => { openQid = null; render(); } }, "Done")),
      h("label.field", h("span", "Question text"), prompt));

    const body = h("div", { style: { marginTop: ".8rem" } });
    if (q.type === "mc" || q.type === "multi") {
      q.options = q.options || ["", ""];
      const rows = h("div");
      const draw = () => {
        clear(rows);
        q.options.forEach((opt, oi) => {
          const isCorrect = q.type === "mc"
            ? Number(k.correct) === oi
            : Array.isArray(k.correct) && k.correct.map(Number).includes(oi);
          const mark = h("input", { type: q.type === "mc" ? "radio" : "checkbox",
            name: `c_${q.id}`, checked: isCorrect, title: "Correct answer",
            onchange: (e) => {
              if (q.type === "mc") k.correct = oi;
              else {
                const s = new Set((k.correct || []).map(Number));
                e.target.checked ? s.add(oi) : s.delete(oi);
                k.correct = [...s].sort((a, b) => a - b);
              }
            } });
          rows.append(h("div.opt-row", mark,
            h("input.input", { value: opt, placeholder: `Option ${oi + 1}`,
              oninput: (e) => (q.options[oi] = e.target.value) }),
            h("button.btn.btn-sm.btn-ghost", { onclick: () => {
              q.options.splice(oi, 1);
              if (q.type === "mc") {
                if (Number(k.correct) === oi) delete k.correct;
                else if (Number(k.correct) > oi) k.correct = Number(k.correct) - 1;
              } else {
                k.correct = (k.correct || []).map(Number).filter((c) => c !== oi).map((c) => (c > oi ? c - 1 : c));
              }
              draw();
            } }, "✕")));
        });
      };
      draw();
      body.append(h("p.help", `Tick the correct ${q.type === "mc" ? "option" : "options"}.`), rows,
        h("div.row", h("button.btn.btn-sm", { onclick: () => { q.options.push(""); draw(); } }, "+ option"),
          q.type === "multi" ? h("label.check.small",
            h("input", { type: "checkbox", checked: !!k.partialCredit,
              onchange: (e) => (k.partialCredit = e.target.checked) }),
            h("span", "Partial credit")) : null));
    } else if (q.type === "tf") {
      body.append(h("div.row", h("span.small.muted", "Correct answer:"),
        ...[[true, "True"], [false, "False"]].map(([v, l]) => h("label.check",
          h("input", { type: "radio", name: `c_${q.id}`, checked: k.correct === v,
            onchange: () => (k.correct = v) }), h("span", l)))));
    } else if (q.type === "text") {
      body.append(
        h("label.field", h("span", "Accepted answers (one per line – any of them earns the points)"),
          h("textarea", { rows: 3, oninput: (e) =>
            (k.accepted = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)) },
            (k.accepted || []).join("\n"))),
        h("label.check.small", h("input", { type: "checkbox", checked: !!k.caseSensitive,
          onchange: (e) => (k.caseSensitive = e.target.checked) }), h("span", "Case sensitive")),
        h("p.help", "Matching ignores capitalisation (unless case sensitive), extra spaces and surrounding punctuation."));
    } else {
      body.append(h("p.help", "Essay answers are graded manually from the Grades tab."));
    }
    box.append(body);
    return box;
  }

  const addQ = (type) => {
    const q = { id: newQid(), type, prompt: "", points: 1, key: type === "tf" ? { correct: true } : {} };
    if (type === "mc" || type === "multi") q.options = ["", "", "", ""];
    questions.push(q); render();
    qHost.lastElementChild?.scrollIntoView({ behavior: "smooth" });
  };

  const errBox = h("div.form-error", { hidden: true });

  const collect = () => {
    const opens = new Date(f.opens_at.value), closes = new Date(f.closes_at.value);
    const errs = [];
    if (!f.title.value.trim()) errs.push("Title is required");
    if (isNaN(opens) || isNaN(closes)) errs.push("Set valid open/close dates");
    else if (closes <= opens) errs.push("Close date must be after open date");
    questions.forEach((q, i) => errs.push(...validateQuestion(q, i), ...validateKey(q, q.key, i)));
    const perStudent = Math.max(0, parseInt(f.questions_per_student.value) || 0);
    if (perStudent > questions.length) errs.push("Questions per student exceeds the number of questions");
    return { opens, closes, perStudent, errs };
  };

  async function save(newStatus) {
    const { opens, closes, perStudent, errs } = collect();
    const publishing = newStatus === "open" || (!newStatus && ex.status === "open");
    const blocking = publishing ? errs : errs.filter((e) => /^(Title|Set|Close|Questions per)/.test(e));
    if (publishing && !questions.length) blocking.push("Add at least one question before publishing.");
    if (blocking.length) {
      errBox.hidden = false;
      errBox.innerHTML = blocking.map(esc).join("<br>");
      errBox.scrollIntoView({ behavior: "smooth" });
      return false;
    }
    errBox.hidden = true;
    if (errs.length) toast(`Saved as draft with ${errs.length} incomplete question(s).`, "warn", 5000);

    const codeToUse = ex.code || examCode(6);
    const perQ = questions.length ? paperMaxPoints(questions) / questions.length : 0;
    const row = {
      code: codeToUse, owner_id: P.user.id, owner_name: f.owner_name.value.trim(),
      title: f.title.value.trim(), course: f.course.value.trim(), instructions: f.instructions.value,
      status: newStatus || ex.status || "draft",
      opens_at: opens.toISOString(), closes_at: closes.toISOString(),
      scores_released: !!ex.scores_released,
      duration_minutes: Math.max(1, Math.min(600, parseInt(f.duration_minutes.value) || 60)),
      max_violations: Math.max(1, parseInt(f.max_violations.value) || 5),
      violation_action: f.violation_action.value,
      require_fullscreen: f.require_fullscreen.input.checked,
      block_clipboard: f.block_clipboard.input.checked,
      shuffle_questions: f.shuffle_questions.input.checked,
      shuffle_options: f.shuffle_options.input.checked,
      questions_per_student: perStudent,
      one_at_a_time: f.one_at_a_time.input.checked,
      require_student_id: f.require_student_id.input.checked,
      show_correct_answers: f.show_correct_answers.input.checked,
      allowed_domain: f.allowed_domain.value.trim().toLowerCase().replace(/^@/, ""),
      roster: f.roster.value.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      question_count: questions.length,
      total_points: perStudent ? Math.round(perQ * perStudent * 100) / 100 : paperMaxPoints(questions),
      updated_at: new Date().toISOString(),
    };
    try {
      await saveExam(row);
      await replaceQuestions(codeToUse, questions);
      toast(newStatus === "open" ? `Published! Exam code: ${codeToUse}` : "Saved.", "success");
      if (!ex.code) location.hash = `#exam/${codeToUse}/edit`; else route();
      return true;
    } catch (e) {
      errBox.hidden = false; errBox.textContent = e.friendly || e.message; return false;
    }
  }

  async function importDialog() {
    const ta = h("textarea", { rows: 12, style: { fontFamily: "var(--mono)", fontSize: ".8rem" },
      placeholder: 'Paste JSON exported from this app, or the legacy JS array:\n[ { type: "text", q: "Question…", a: ["answer 1", "answer 2"] }, … ]' });
    const file = h("input", { type: "file", accept: ".json,.js,.txt",
      onchange: async (e) => { const fl = e.target.files[0]; if (fl) ta.value = await fl.text(); } });
    const mode = h("select", h("option", { value: "append" }, "Append to existing questions"),
      h("option", { value: "replace" }, "Replace all questions"));
    const ok = await dialog({
      title: "Import questions",
      body: h("div.stack",
        h("p.help", "Accepted: our JSON export ({questions, answers}), a plain array of " +
          "{type,q|prompt,a|accepted|correct,options}, or the exact baseQuizData array from the old single-file quiz."),
        file, ta, h("label.field", h("span", "Mode"), mode)),
      buttons: [{ label: "Cancel", value: false }, { label: "Import", value: true, kind: "primary" }],
    });
    if (!ok) return;
    try {
      const { questions: qs, answers } = importQuestions(ta.value);
      const incoming = qs.map((q) => ({
        id: newQid(), type: q.type, prompt: q.prompt,
        options: q.options || [], points: Number(q.points) || 1,
        key: answers[q.id] || {},
      }));
      if (mode.value === "replace") questions = incoming; else questions.push(...incoming);
      render();
      toast(`Imported ${incoming.length} questions.`, "success");
    } catch (e) { toast("Import failed: " + e.message, "error", 6000); }
  }

  const exportJson = () => downloadText(
    `${(f.title.value || "exam").replace(/[^a-z0-9]+/gi, "-")}.json`,
    JSON.stringify({
      title: f.title.value,
      questions: questions.map((q, i) => ({ id: `q${i + 1}`, type: q.type, prompt: q.prompt, options: q.options, points: q.points })),
      answers: Object.fromEntries(questions.map((q, i) => [`q${i + 1}`, q.key || {}])),
    }, null, 2), "application/json");

  main.append(...[
    h("div.card-head", h("h1", ex.code ? "Edit exam" : "New exam"),
      h("div.row", ex.code ? h("span.pill-code", ex.code) : null, statusBadge(ex.status))),
    sessionCount && ex.status !== "draft"
      ? h("div.form-error", { style: { background: "var(--warn-soft)", color: "var(--warn)", marginBottom: "1rem" } },
          `⚠ ${sessionCount} student session(s) exist. Changing, adding or removing QUESTIONS now ` +
          `replaces them and will break grading for students who already started. Settings and dates are safe to change.`)
      : null,
    errBox,
    h("div.card", h("h3", "Details"),
      h("div.grid.grid-2",
        h("label.field", h("span", "Title *"), f.title),
        h("label.field", h("span", "Course"), f.course)),
      h("label.field", { style: { marginTop: ".7rem" } }, h("span", "Instructions for students"), f.instructions),
      h("div.grid.grid-3", { style: { marginTop: ".7rem" } },
        h("label.field", h("span", "Opens at"), f.opens_at),
        h("label.field", h("span", "Closes at (hard cut-off)"), f.closes_at),
        h("label.field", h("span", "Professor name shown"), f.owner_name)),
    ),
    h("div.card",
      h("h3", "How the exam runs"),
      h("p.help", { style: { marginTop: 0 } },
        "Start from a preset, then open only the group you want to change. " +
        "Everything here can be edited later, even after students have started."),
      h("div.preset-row", presetBtns),
      h("div", { style: { marginTop: ".9rem", marginBottom: ".2rem" } }, summary),

      h("details.group", { open: true },
        h("summary", "Time limit & violations", note.timing),
        h("div.group-body",
          h("div.grid.grid-3", { style: { marginTop: ".8rem" } },
            h("label.field", h("span", "Duration (minutes)"), f.duration_minutes,
              h("span.help", "Counted from the moment a student starts, not from the open time.")),
            h("label.field", h("span", "Violation limit"), f.max_violations,
              h("span.help", "Tab switches, exiting fullscreen, paste attempts.")),
            h("label.field", h("span", "When the limit is reached"), f.violation_action)))),

      h("details.group",
        h("summary", "Lockdown while writing", note.proctor),
        h("div.group-body", f.require_fullscreen, f.block_clipboard,
          h("p.help", "These are deterrents that get logged, not a guarantee. " +
            "The monitor tab shows you every slip as it happens."))),

      h("details.group",
        h("summary", "How the paper is dealt out", note.delivery),
        h("div.group-body", f.shuffle_questions, f.shuffle_options, f.one_at_a_time,
          h("label.field", { style: { marginTop: ".8rem", maxWidth: "320px" } },
            h("span", "Questions per student"), f.questions_per_student,
            h("span.help", "0 gives everyone the whole set. Any other number draws that many at random from the pool below.")))),

      h("details.group",
        h("summary", "Who is allowed in", note.access),
        h("div.group-body",
          f.require_student_id,
          h("div.grid.grid-2", { style: { marginTop: ".8rem" } },
            h("label.field", h("span", "Restrict to e-mail domain"), f.allowed_domain,
              h("span.help", "Blank lets any signed-in account in.")),
            h("label.field", h("span", "Roster"), f.roster,
              h("span.help", "One e-mail per line. Blank lets anyone with the code in."))))),

      h("details.group",
        h("summary", "After the exam", note.after),
        h("div.group-body", f.show_correct_answers,
          h("p.help", "Scores stay hidden until you release them from the Grades tab, " +
            "whatever this is set to."))),
    ),
    h("div.card",
      h("div.card-head", h("div", h("h3", "Questions"), stats),
        h("div.row", h("button.btn.btn-sm", { onclick: importDialog }, "⬆ Import"),
          h("button.btn.btn-sm", { onclick: exportJson }, "⬇ Export JSON"))),
      h("div.q-toolbar", qFilter,
        h("span.small.muted", "Click a row to edit it."),
        h("div.spacer"),
        h("button.btn.btn-sm", { type: "button", title: "Collapse the open question",
          onclick: () => { openQid = null; render(); } }, "Collapse all")),
      qHost,
      h("div.add-menu", { style: { marginTop: ".8rem" } }, h("span.small.muted", "Add:"),
        ...Object.entries(QUESTION_TYPES).map(([v, l]) =>
          h("button.btn.btn-sm", { onclick: () => addQ(v) }, "+ " + l.split(" (")[0]))),
    ),
    h("div.card", h("div.row",
      h("button.btn.btn-primary", { onclick: () => save() }, "💾 Save"),
      ex.status !== "open" ? h("button.btn.btn-success", { onclick: async () => {
        if (await confirmDialog("Publish exam?", "Students with the code will be able to start it within the open/close window.", "Publish", "success")) save("open");
      } }, "🚀 Publish (open)") : null,
      ex.status === "open" ? h("button.btn", { onclick: async () => {
        if (await confirmDialog("Close exam?", "Students can no longer start or continue.", "Close exam")) save("closed");
      } }, "⏹ Close exam") : null,
      ex.status === "closed" ? h("button.btn", { onclick: () => save("open") }, "Re-open") : null,
      h("div.spacer"),
      ex.code ? h("button.btn.btn-sm.btn-danger", { onclick: () => removeExam(ex.code) }, "🗑 Delete exam") : null,
    )),
  ].filter(Boolean));
  render();
}

async function removeExam(code) {
  if (!(await confirmDialog("Delete exam?",
    `This permanently deletes exam <b>${code}</b>, every student session, event log and grade. Export the grades first if you need them.`,
    "Delete everything"))) return;
  try {
    await deleteExam(code);   // cascades to questions, keys, sessions, events, grades
    toast("Exam deleted.", "success");
    location.hash = "#exams";
  } catch (e) { toast(e.friendly || e.message, "error"); }
}

// ----------------------------------------------------------- live monitor
async function viewMonitor(main, code) {
  let ex;
  try { ex = await getExam(code); if (!ex) throw new Error("Exam not found"); }
  catch (e) { return main.append(h("div.form-error", e.friendly || e.message)); }

  const sessions = new Map(), grades = new Map(), risks = new Map();
  const grading = new Set();

  const stats = h("div.grid.grid-3", { style: { gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", marginBottom: "1rem" } });
  const tbody = h("tbody");
  const search = h("input.input", { placeholder: "Filter by name / e-mail / section…", style: { maxWidth: "300px" }, oninput: () => render() });
  const onlyFlag = h("input", { type: "checkbox", onchange: () => render() });

  main.append(
    h("div.card-head",
      h("div", h("h1", ex.title),
        h("div.small.muted", `${ex.course || ""} · ${ex.duration_minutes} min · limit ${ex.max_violations} violations (${ex.violation_action})`)),
      h("div.row", h("span.pill-code", code), statusBadge(ex.status),
        h("button.btn.btn-sm", { onclick: () => {
          const url = `${location.origin}${location.pathname.replace(/professor\.html$/, "")}exam.html?code=${code}`;
          navigator.clipboard?.writeText(url);
          toast("Student link copied.", "success");
        } }, "Copy student link"))),
    ex.status !== "open"
      ? h("div.form-error", { style: { marginBottom: "1rem" } }, "This exam is not open, so students cannot start it. ",
          h("a", { href: `#exam/${code}/edit` }, "Publish it from the editor."))
      : null,
    stats,
    h("div.card",
      h("div.row.between", { style: { marginBottom: ".7rem" } },
        h("div.row", search, h("label.check.small", onlyFlag, h("span", "Only flagged / at-risk"))),
        h("div.row",
          h("button.btn.btn-sm", { onclick: analyseAll }, "🔍 Analyse risk (loads event logs)"),
          h("button.btn.btn-sm", { onclick: () => exportCsv(ex, sessions, grades, risks) }, "⬇ CSV"))),
      h("div.table-wrap", h("table.table",
        h("thead", h("tr", h("th", "Student"), h("th", "Status"), h("th", "Progress"), h("th", "Time left"),
          h("th", "Violations"), h("th", "Risk"), h("th", "Score"), h("th", "Actions"))),
        tbody)),
    ),
  );

  try {
    (await examSessions(code)).forEach((s) => sessions.set(s.id, s));
    (await examGrades(code)).forEach((g) => grades.set(g.session_id, g));
  } catch (e) { toast(e.friendly || e.message, "error"); }
  render();

  P.unsubs.push(watchExamSessions(code, ({ eventType, new: row, old }) => {
    if (eventType === "DELETE") sessions.delete(old?.id);
    else if (row) { sessions.set(row.id, row); maybeGrade(row); }
    render();
  }));
  P.unsubs.push(watchExamGrades(code, ({ eventType, new: row, old }) => {
    if (eventType === "DELETE") grades.delete(old?.session_id);
    else if (row) grades.set(row.session_id, row);
    render();
  }));
  const ticker = setInterval(render, 5000);
  P.unsubs.push(() => clearInterval(ticker));

  async function maybeGrade(s) {
    if (s.status !== "submitted" || grades.has(s.id) || grading.has(s.id)) return;
    grading.add(s.id);
    try { grades.set(s.id, await gradeSession(s.id)); render(); }
    catch (e) { console.warn("auto-grade failed", e); }
    finally { grading.delete(s.id); }
  }

  async function analyseAll() {
    toast("Loading event logs…");
    for (const s of sessions.values()) {
      try { risks.set(s.id, riskScore(s, await sessionEvents(s.id), ex)); } catch {}
    }
    render();
    toast("Risk analysis done.", "success");
  }

  function render() {
    const list = [...sessions.values()];
    const q = search.value.trim().toLowerCase();
    const counts = { total: list.length, in_progress: 0, submitted: 0, locked: 0, expired: 0, online: 0, flagged: 0 };
    for (const s of list) {
      const es = effectiveStatus(s, ex);
      counts[es] = (counts[es] || 0) + 1;
      if (es === "in_progress" && Date.now() - (toDate(s.heartbeat_at)?.getTime() || 0) < 60_000) counts.online++;
      if (s.flagged || risks.get(s.id)?.level === "high" || s.violations >= ex.max_violations) counts.flagged++;
    }
    clear(stats);
    [["Students", counts.total], ["Online now", counts.online], ["In progress", counts.in_progress],
     ["Submitted", counts.submitted], ["Locked", counts.locked], ["Expired", counts.expired], ["Flagged", counts.flagged]]
      .forEach(([l, n]) => stats.append(h("div.stat",
        h("div.n", { style: (l === "Flagged" || l === "Locked") && n ? { color: "var(--danger)" } : {} }, String(n)),
        h("div.l", l))));

    clear(tbody);
    list.sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email));
    let shown = 0;
    for (const s of list) {
      const es = effectiveStatus(s, ex), risk = risks.get(s.id), g = grades.get(s.id);
      const flagged = s.flagged || risk?.level === "high" || s.violations >= ex.max_violations;
      if (q && !`${s.display_name} ${s.email} ${s.student_no} ${s.section}`.toLowerCase().includes(q)) continue;
      if (onlyFlag.checked && !flagged && risk?.level !== "medium") continue;
      shown++;
      const hbAge = Date.now() - (toDate(s.heartbeat_at)?.getTime() || 0);
      const dot = es !== "in_progress" ? "" : hbAge < 60_000 ? "dot-online" : hbAge < 180_000 ? "dot-idle" : "dot-offline";
      const dl = deadlineOf(s, ex);
      tbody.append(h("tr", { class: `risk-${risk?.level || (flagged ? "high" : "")}` },
        h("td",
          h("div", dot ? h("span.dot", { class: `dot ${dot}`, title: `heartbeat ${ago(s.heartbeat_at)}` }) : null,
            h("strong", s.display_name || "—"), s.flagged ? " 🚩" : ""),
          h("div.small.muted", `${s.email}${s.student_no ? " · " + s.student_no : ""}${s.section ? " · " + s.section : ""}`)),
        h("td", statusBadge(es),
          h("div.small.muted", es === "submitted" ? fmtTime(s.submitted_at) : `started ${fmtTime(s.started_at)}`)),
        h("td", `${s.answered} / ${s.total || ex.question_count || "?"}`),
        h("td.mono", es === "in_progress" && dl ? mmss((dl - Date.now()) / 1000) : "—",
          s.extra_minutes ? h("div.small.muted", `+${s.extra_minutes} min`) : null),
        h("td", h("strong", { style: s.violations >= ex.max_violations ? { color: "var(--danger)" } : {} }, String(s.violations || 0)),
          h("span.muted.small", ` / ${ex.max_violations}`)),
        h("td", risk
          ? h(`span.badge.badge-${risk.level === "high" ? "danger" : risk.level === "medium" ? "warn" : "success"}`,
              { title: risk.reasons.join(", ") }, `${risk.level} ${risk.score}`)
          : h("span.muted.small", "—")),
        h("td", g
          ? h("span", h("strong", `${Number(g.score)}/${Number(g.max_score)}`),
              g.needs_manual ? h("span.badge.badge-warn", { style: { marginLeft: ".3rem" }, title: "essay questions need manual grading" }, "manual") : null)
          : h("span.muted.small", ["submitted", "expired"].includes(es) ? "ungraded" : "—")),
        h("td", h("div.row", { style: { gap: ".3rem" } },
          h("button.btn.btn-sm", { onclick: () => openDrawer(ex, s, grades.get(s.id), risks, render) }, "View"),
          es === "locked" ? h("button.btn.btn-sm.btn-success", {
            onclick: () => act(s, { status: "in_progress" }, "Unlocked") } , "Unlock") : null,
          ["in_progress", "locked"].includes(es) ? h("button.btn.btn-sm", { title: "Add time", onclick: async () => {
            const m = await promptDialog("Extra time", "Total extra minutes for this student", String(s.extra_minutes || 0), "number");
            if (m != null) act(s, { extra_minutes: Math.max(0, parseInt(m) || 0) }, "Time updated");
          } }, "+⏱") : null,
          ["in_progress", "locked", "expired"].includes(es) ? h("button.btn.btn-sm", {
            title: "Force submit with saved answers", onclick: async () => {
              if (await confirmDialog("Force submit?", `Submit ${esc(s.display_name || s.email)} now with their saved answers?`, "Submit", "primary"))
                act(s, { status: "submitted", submitted_at: new Date().toISOString() }, "Submitted");
            } }, "Submit") : null,
          !["terminated", "submitted"].includes(es) ? h("button.btn.btn-sm.btn-danger", {
            title: "Terminate attempt", onclick: async () => {
              if (await confirmDialog("Terminate attempt?", "The student is thrown out and receives no score unless you grade manually.", "Terminate"))
                act(s, { status: "terminated", terminated_at: new Date().toISOString() }, "Terminated");
            } }, "✕") : null,
          h("button.btn.btn-sm.btn-ghost", { title: "Reset attempt so the student can start again", onclick: async () => {
            if (await confirmDialog("Reset attempt?", `Delete ${esc(s.display_name || s.email)}'s session, events and grade so they can start again?`, "Reset")) {
              try { await resetSession(s.id); sessions.delete(s.id); grades.delete(s.id); render(); toast("Attempt reset.", "success"); }
              catch (e) { toast(e.friendly || e.message, "error"); }
            }
          } }, "↺"),
        )),
      ));
    }
    if (!shown) {
      tbody.append(h("tr", h("td", { colspan: 8 }, h("div.empty",
        list.length ? "No student matches that filter." : ["No students have started yet. Share the code ", h("strong", code), "."]))));
    }
  }

  async function act(s, patch, msg) {
    try { await profUpdateSession(s.id, patch); toast(msg, "success"); }
    catch (e) { toast(e.friendly || e.message, "error"); }
  }
}

// ------------------------------------------------- student drawer + grading
async function openDrawer(ex, s, grade, risks, onSaved) {
  const events = await sessionEvents(s.id).catch(() => []);
  const risk = riskScore(s, events, ex);
  risks?.set(s.id, risk);
  let paper = [];
  try { paper = await getPaper(s.id); } catch {}
  let g = grade;
  if (!g) { try { g = await gradeSession(s.id); } catch {} }
  const pq = g?.per_question || {};

  const drawer = h("div.drawer");
  const close = () => drawer.remove();

  const totalEl = h("div.stat",
    h("div.n", g ? `${Number(g.score)} / ${Number(g.max_score)}` : "—"),
    h("div.l", g ? `${g.percent}%${g.needs_manual ? ` · ${g.needs_manual} to grade` : ""}` : "not graded"));

  const tabs = h("div.tabs"); const panes = {};
  const mk = (name, label) => {
    const b = h("button", { onclick: () => {
      $$("button", tabs).forEach((x) => x.classList.toggle("active", x === b));
      Object.entries(panes).forEach(([k, p]) => (p.hidden = k !== name));
    } }, label);
    tabs.append(b); panes[name] = h("div"); return panes[name];
  };
  const answersPane = mk("answers", "Answers & grading");
  const eventsPane = mk("events", `Event log (${events.length})`);
  const infoPane = mk("info", "Device / info");
  tabs.firstChild.classList.add("active");
  eventsPane.hidden = infoPane.hidden = true;

  answersPane.append(h("div.answer-review", paper.map((q, i) => {
    const r = pq[q.id] || {};
    const cls = r.verdict === "correct" ? "ok" : r.verdict === "partial" ? "partial"
      : r.verdict === "wrong" ? "bad" : "manual";
    const earned = h("input.input", { type: "number", step: .5, min: 0, max: Number(q.points),
      value: Number(r.earned ?? 0), style: { width: "80px" } });
    const comment = h("input.input", { placeholder: "comment to student (optional)", value: r.comment || "" });
    const saveBtn = h("button.btn.btn-sm", { onclick: async () => {
      saveBtn.disabled = true;
      try {
        const res = await setOverride(s.id, q.id, Number(earned.value), comment.value);
        totalEl.firstChild.textContent = `${Number(res.score)} / ${Number(res.max_score)}`;
        totalEl.lastChild.textContent = `${res.percent}%${res.needs_manual ? ` · ${res.needs_manual} to grade` : ""}`;
        toast("Points saved.", "success");
        onSaved?.();
      } catch (e) { toast(e.friendly || e.message, "error"); }
      finally { saveBtn.disabled = false; }
    } }, "Save points");
    return h("div.ar", { class: `ar ${cls}` },
      h("div.q-num", h("span", `Q${i + 1} · ${QUESTION_TYPES[q.type]?.split(" (")[0]}`),
        h("span.row", earned, h("span.muted", `/ ${Number(q.points)}`), saveBtn)),
      h("div", { style: { fontWeight: 600, margin: ".3rem 0" } }, q.prompt),
      h("div.small", h("strong", "Student: "), fmtAnswer(q, r.answer)),
      r.expected !== undefined ? h("div.small.muted", h("strong", "Key: "), fmtKey(q, r.expected)) : null,
      h("div", { style: { marginTop: ".4rem" } }, comment),
    );
  })));
  if (!paper.length) answersPane.append(h("div.empty", "No paper to show."));

  const counts = risk.counts || {};
  eventsPane.append(
    h("div.row", { style: { marginBottom: ".6rem" } },
      ...Object.entries(counts).sort((a, b) => (EVENT_WEIGHTS[b[0]] || 0) - (EVENT_WEIGHTS[a[0]] || 0))
        .map(([t, n]) => h(`span.badge${(EVENT_WEIGHTS[t] || 0) >= 3 ? ".badge-danger" : (EVENT_WEIGHTS[t] || 0) >= 1 ? ".badge-warn" : ""}`,
          `${t.replace(/_/g, " ")} ×${n}`))),
    h("ul.timeline", events.map((e) => h("li", h("span.t", fmtTime(e.at)),
      h("span", h("strong", e.type.replace(/_/g, " ")),
        e.detail && Object.keys(e.detail).length ? h("span.muted.small", " " + summarize(e)) : null)))),
    !events.length ? h("div.empty", "No events recorded.") : null,
  );

  const c = s.client || {};
  infoPane.append(h("div.stack",
    kv("Session id", s.id), kv("E-mail", s.email), kv("Student ID", s.student_no || "—"),
    kv("Section", s.section || "—"), kv("Started", fmtDate(s.started_at)),
    kv("Submitted", fmtDate(s.submitted_at)), kv("Last heartbeat", fmtDate(s.heartbeat_at)),
    kv("Last saved", fmtDate(s.last_saved_at)), kv("Extra time", `${s.extra_minutes || 0} min`),
    kv("Browser", c.ua || "—"), kv("Platform", `${c.platform || "—"} · ${c.lang || ""} · ${c.tz || ""}`),
    kv("Screen / viewport", `${c.screen || "—"} / ${c.viewport || "—"}`),
    kv("Touch device", c.touch ? "yes" : "no"),
    kv("Second tab seen", counts.multiple_tabs ? "YES" : "no"),
  ));

  const feedback = h("textarea", { rows: 2, placeholder: "Feedback shown to the student with the score (optional)" }, g?.feedback || "");
  const note = h("textarea", { rows: 2, placeholder: "Private note (professors only)" }, s.note || "");

  drawer.append(
    h("div.row.between",
      h("div", h("h2", s.display_name || s.email), h("div.small.muted", s.email), statusBadge(effectiveStatus(s, ex))),
      h("button.btn.btn-ghost", { onclick: close }, "✕ Close")),
    h("div.grid.grid-3", { style: { margin: ".8rem 0" } }, totalEl,
      h("div.stat", h("div.n", { style: { color: risk.level === "high" ? "var(--danger)" : risk.level === "medium" ? "var(--warn)" : "var(--success)" } },
        `${risk.level.toUpperCase()} ${risk.score}`), h("div.l", "Risk score")),
      h("div.stat", h("div.n", String(s.violations || 0)), h("div.l", "Violations"))),
    risk.reasons.length ? h("p.small", h("strong", "Why: "), risk.reasons.join(" · ")) : null,
    tabs, answersPane, eventsPane, infoPane,
    h("div.card", { style: { marginTop: "1rem" } },
      h("label.field", h("span", "Feedback to student"), feedback),
      h("label.field", { style: { marginTop: ".5rem" } }, h("span", "Private note"), note),
      h("div.row", { style: { marginTop: ".7rem" } },
        h("button.btn.btn-primary", { onclick: async () => {
          try {
            await setFeedback(s.id, feedback.value);
            await profUpdateSession(s.id, { note: note.value, reviewed: true });
            toast("Saved.", "success"); onSaved?.(); close();
          } catch (e) { toast(e.friendly || e.message, "error"); }
        } }, "💾 Save feedback & note"),
        h("button.btn", { onclick: async () => {
          try { await profUpdateSession(s.id, { flagged: !s.flagged }); toast(s.flagged ? "Flag removed" : "Flagged", "success"); onSaved?.(); close(); }
          catch (e) { toast(e.friendly || e.message, "error"); }
        } }, s.flagged ? "🏳 Unflag" : "🚩 Flag for review"),
        h("div.spacer"),
        h("a.small", { href: "#", onclick: (e) => {
          e.preventDefault();
          downloadText(`${s.id}-events.json`, JSON.stringify(events, null, 2), "application/json");
        } }, "download event log"),
      )),
  );
  document.body.append(drawer);
}

const kv = (k, v) => h("div.row.between",
  { style: { borderBottom: "1px dashed var(--border)", padding: ".25rem 0" } },
  h("span.muted.small", k),
  h("span.small.mono", { style: { textAlign: "right", wordBreak: "break-all" } }, v));

function fmtAnswer(q, a) {
  if (a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length)) return h("em.muted", "—");
  if (q.type === "mc") return q.options?.find((o) => o.oi === Number(a))?.text ?? String(a);
  if (q.type === "multi") return (Array.isArray(a) ? a : [a]).map((v) => q.options?.find((o) => o.oi === Number(v))?.text ?? v).join("; ");
  if (q.type === "tf") return String(a) === "true" ? "True" : "False";
  return String(a);
}
function fmtKey(q, key) {
  if (!key) return h("em.muted", "—");
  if (q.type === "text") return (key.accepted || []).join(" / ");
  if (q.type === "tf") return key.correct ? "True" : "False";
  if (q.type === "mc") return q.options?.find((o) => o.oi === Number(key.correct))?.text ?? String(key.correct);
  if (q.type === "multi") return (key.correct || []).map((v) => q.options?.find((o) => o.oi === Number(v))?.text ?? v).join("; ");
  return "—";
}
function summarize(e) {
  const d = e.detail || {}, parts = [];
  if (d.ms) parts.push(`${Math.round(d.ms / 1000)}s away`);
  if (d.key) parts.push(d.key);
  if (d.len) parts.push(`${d.len} chars`);
  if (d.reason) parts.push(d.reason);
  if (d.reload) parts.push("after reload");
  if (d.w) parts.push(`${d.w}×${d.h}`);
  if (e.question) parts.push(`on ${e.question}`);
  return parts.join(", ");
}

// ----------------------------------------------------------------- grades
async function viewGrades(main, code) {
  let ex;
  try { ex = await getExam(code); if (!ex) throw new Error("Exam not found"); }
  catch (e) { return main.append(h("div.form-error", e.friendly || e.message)); }

  const sessions = new Map((await examSessions(code)).map((s) => [s.id, s]));
  const grades = new Map((await examGrades(code)).map((g) => [g.session_id, g]));
  const risks = new Map();

  const body = h("tbody#gradesBody");
  const fill = () => {
    clear(body);
    const list = [...sessions.values()].sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email));
    if (!list.length) body.append(h("tr", h("td", { colspan: 8 }, h("div.empty", "No submissions yet."))));
    for (const s of list) {
      const g = grades.get(s.id), es = effectiveStatus(s, ex);
      body.append(h("tr", { class: s.flagged || s.violations >= ex.max_violations ? "risk-high" : "" },
        h("td", h("strong", s.display_name || "—"), s.flagged ? " 🚩" : "",
          h("div.small.muted", `${s.email}${s.student_no ? " · " + s.student_no : ""}`)),
        h("td", s.section || "—"), h("td", statusBadge(es)), h("td", fmtDate(s.submitted_at)),
        h("td", String(s.violations || 0)),
        h("td", g ? h("strong", `${Number(g.score)} / ${Number(g.max_score)}`) : h("span.muted", "—"),
          g?.needs_manual ? h("span.badge.badge-warn", { style: { marginLeft: ".3rem" } }, `${g.needs_manual} manual`) : null),
        h("td", g ? `${g.percent}%` : "—"),
        h("td", h("button.btn.btn-sm", { onclick: () => openDrawer(ex, s, g, risks, refresh) }, "Review")),
      ));
    }
  };
  async function refresh() {
    (await examGrades(code)).forEach((g) => grades.set(g.session_id, g));
    (await examSessions(code)).forEach((s) => sessions.set(s.id, s));
    fill();
  }

  const releaseBtn = h("button.btn", { class: `btn ${ex.scores_released ? "" : "btn-success"}`, onclick: async () => {
    const releasing = !ex.scores_released;
    if (!(await confirmDialog(releasing ? "Release scores?" : "Hide scores?",
      releasing ? `Students will see their score${ex.show_correct_answers ? " and the correct answers" : ""}. Ungraded submissions are graded first.`
                : "Students will no longer see their scores.",
      releasing ? "Release" : "Hide", "primary"))) return;
    try {
      if (releasing) { const n = await gradeExam(code, false); if (n) toast(`Graded ${n} submission(s).`, "success"); }
      await releaseScores(code, releasing);
      toast(releasing ? "Scores released." : "Scores hidden.", "success");
      route();
    } catch (e) { toast(e.friendly || e.message, "error"); }
  } }, ex.scores_released ? "🙈 Hide scores" : "📢 Release scores");

  main.append(
    h("div.card-head", h("div", h("h1", "Grades"), h("div.small.muted", ex.title)),
      h("div.row", h("span.pill-code", code),
        ex.scores_released ? h("span.badge.badge-success", "Released") : h("span.badge", "Not released"))),
    h("div.card", h("div.row",
      h("button.btn.btn-primary", { onclick: async () => {
        try { const n = await gradeExam(code, false); toast(`Graded ${n} submission(s).`, "success"); refresh(); }
        catch (e) { toast(e.friendly || e.message, "error"); }
      } }, "⚡ Grade ungraded"),
      h("button.btn", { title: "Recompute every grade with the current answer key; manual points are kept",
        onclick: async () => {
          try { const n = await gradeExam(code, true); toast(`Regraded ${n} submission(s).`, "success"); refresh(); }
          catch (e) { toast(e.friendly || e.message, "error"); }
        } }, "♻ Regrade all"),
      releaseBtn,
      h("div.spacer"),
      h("button.btn", { onclick: () => exportCsv(ex, sessions, grades, risks) }, "⬇ Export CSV"),
    ), h("p.help", { style: { marginTop: ".6rem" } },
      "Grading runs inside the database, so the answer key is never sent to this browser. " +
      "Attempts whose time has expired are graded from their last saved answers. " +
      "Essay questions need manual points — click Review.")),
    h("div.card", h("div.table-wrap", h("table.table",
      h("thead", h("tr", h("th", "Student"), h("th", "Section"), h("th", "Status"), h("th", "Submitted"),
        h("th", "Violations"), h("th", "Score"), h("th", "%"), h("th", ""))),
      body))),
  );
  fill();
}

function exportCsv(ex, sessions, grades, risks) {
  const rows = [["Name", "Email", "Student ID", "Section", "Status", "Started", "Submitted", "Violations",
    "Risk level", "Risk score", "Risk reasons", "Flagged", "Score", "Max", "Percent", "Needs manual", "Note"]];
  for (const s of sessions.values()) {
    const g = grades.get(s.id), r = risks.get(s.id);
    rows.push([s.display_name, s.email, s.student_no, s.section, effectiveStatus(s, ex),
      s.started_at || "", s.submitted_at || "", s.violations || 0,
      r?.level || "", r?.score ?? "", r?.reasons.join("; ") || "", s.flagged ? "yes" : "",
      g?.score ?? "", g?.max_score ?? "", g?.percent ?? "", g?.needs_manual ?? "", s.note || ""]);
  }
  downloadText(`${ex.code}-${ex.title.replace(/[^a-z0-9]+/gi, "-")}-grades.csv`,
    rows.map((r) => r.map(csvEscape).join(",")).join("\r\n"), "text/csv");
}

// ----------------------------------------------------------------- access
async function viewAccess(main) {
  main.append(h("div.card-head", h("h1", "Access"), null));
  const emailI = h("input.input", { type: "email", placeholder: "colleague@university.edu" });
  const list = h("div");
  main.append(
    h("div.card", h("h3", "Add a professor"),
      h("p.help", "They must sign in to this site once first — that creates their account. Then enter their e-mail here."),
      h("form.row", { onsubmit: async (e) => {
        e.preventDefault();
        const em = emailI.value.trim().toLowerCase();
        if (!em) return;
        try { await setRoleByEmail(em, "professor"); toast(`${em} is now a professor.`, "success"); emailI.value = ""; load(); }
        catch (e2) { toast(e2.friendly || e2.message, "error", 6000); }
      } }, h("div", { style: { flex: 1 } }, emailI), h("button.btn.btn-primary", { type: "submit" }, "Add"))),
    h("div.card", h("h3", "Current professors"), list),
  );
  async function load() {
    clear(list);
    try {
      const profs = await listProfessors();
      if (!profs.length) return list.append(h("p.muted", "None yet."));
      profs.forEach((u) => list.append(h("div.row.between",
        { style: { padding: ".4rem 0", borderBottom: "1px solid var(--border)" } },
        h("div", h("strong", u.display_name || u.email), h("div.small.muted", u.email)),
        u.id !== P.user.id
          ? h("button.btn.btn-sm", { onclick: async () => {
              if (await confirmDialog("Remove?", `${esc(u.email)} will become a student account.`, "Remove")) {
                try { await setRoleByEmail(u.email, "student"); load(); }
                catch (e) { toast(e.friendly || e.message, "error"); }
              }
            } }, "Remove") : h("span.badge", "you"))));
    } catch (e) { list.append(h("div.form-error", e.friendly || e.message)); }
  }
  load();
}

// ------------------------------------------------------------------- help
function viewHelp(main) {
  main.append(h("div.card", { html: `
    <h1>How an exam runs</h1>
    <ol>
      <li><strong>Create</strong> the exam (or import your question list), tick the anti-cheat settings, set the open/close window and <strong>Publish</strong>. You get a 6-character code.</li>
      <li>Students sign in at the home page and enter the code. They confirm their details, accept the rules and click Start — the server records the start time.</li>
      <li>Open <strong>Live monitor</strong> during the exam. Rows update over a websocket: who is online, progress, time left, violations. You can <em>Unlock</em>, <em>add time</em>, <em>force-submit</em>, <em>terminate</em> or <em>reset</em> any student.</li>
      <li>Submissions are graded automatically by the database. Essay questions get points from the Review drawer.</li>
      <li>Click <strong>Release scores</strong> when ready, and export a CSV for your records.</li>
    </ol>
    <h3>Enforced by the server — students cannot bypass these</h3>
    <ul>
      <li>The answer key is readable only by you. Grading happens inside the database, so it is never sent to any browser — not even this one.</li>
      <li>One attempt per student per exam, tied to a confirmed e-mail address (optionally restricted to a domain or a roster).</li>
      <li>The clock is the database clock: start + duration + any extra time you grant. Writes after that are rejected, so reloading or changing the device clock achieves nothing.</li>
      <li>Submitted, locked and terminated attempts are frozen. Violation counters can only go up. Only you can unlock, extend, terminate or reset.</li>
      <li>Grades are visible to a student only after you release them, and never another student's.</li>
    </ul>
    <h3>Recorded as evidence — advisory, not proof</h3>
    <p>Tab switches, window blur, fullscreen exits, copy/paste, blocked shortcuts, suspected devtools, reloads, second tabs, offline gaps and suspiciously fast completion. Use <em>Analyse risk</em> and read the per-student event log; the risk score is a triage aid, not a verdict. No browser can see a second device or a person in the room — pair this with a visible proctor for high-stakes exams.</p>
  ` }));
}
