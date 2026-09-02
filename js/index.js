import { db, doc, getDoc, getDocs, collection, query, where } from "./firebase-init.js";
import { siteConfig } from "./firebase-config.js";
import { watchAuth, ensureProfile, renderAuthPanel, logout, resendVerification, updateMyProfile } from "./auth.js";
import { $, h, esc, toast, fmtDate, clear } from "./ui.js";

const app = $("#app");
$("#brandName").textContent = siteConfig.institutionName;
document.title = siteConfig.institutionName;

let profile = null;

watchAuth(async (user) => {
  clear($("#topRight"));
  if (!user) { renderSignedOut(); return; }
  try { profile = await ensureProfile(user); }
  catch (e) { app.innerHTML = `<div class="card"><div class="form-error">${esc(e.message)}</div></div>`; return; }
  $("#topRight").append(
    h("span.small.muted", user.email),
    profile.role === "professor" ? h("a.btn.btn-sm.btn-primary", { href: "professor.html" }, "Dashboard") : null,
    h("button.btn.btn-sm", { onclick: () => logout() }, "Sign out"),
  );
  renderHome(user);
});

function renderSignedOut() {
  clear(app);
  app.append(
    h("div.card",
      h("h1", siteConfig.institutionName),
      h("p.muted", siteConfig.tagline),
      h("div#authHost"),
    ),
    h("div.card.small.muted",
      h("strong", "Before you start an exam: "),
      "use a laptop or desktop, close every other tab and application, and keep this window in fullscreen. " +
      "Leaving the exam window is recorded and reported to your professor.",
    ),
  );
  renderAuthPanel($("#authHost"));
}

function renderHome(user) {
  clear(app);
  const codeInput = h("input.input.mono", { placeholder: "e.g. K7M2XQ", maxlength: 12, style: { textTransform: "uppercase", letterSpacing: ".2em", fontSize: "1.2rem" }, autocomplete: "off" });
  const join = (e) => {
    e?.preventDefault();
    const code = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) return toast("Enter the exam code from your professor.", "warn");
    location.href = `exam.html?code=${encodeURIComponent(code)}`;
  };

  if (!user.emailVerified) {
    app.append(h("div.card", { style: { borderColor: "var(--warn)" } },
      h("strong", "Verify your e-mail. "),
      "You cannot start an exam until your e-mail address is verified. Check your inbox (and spam folder). ",
      h("button.btn.btn-sm", { onclick: async () => { await resendVerification(); toast("Verification e-mail sent.", "success"); } }, "Resend e-mail"),
      " ", h("button.btn.btn-sm.btn-ghost", { onclick: () => location.reload() }, "I've verified – refresh"),
    ));
  }

  app.append(
    h("div.card",
      h("h2", `Hello, ${esc(user.displayName || profile.displayName || user.email)}`),
      h("form.row", { onsubmit: join },
        h("div", { style: { flex: 1, minWidth: "200px" } }, codeInput),
        h("button.btn.btn-primary.btn-lg", { type: "submit" }, "Enter exam"),
      ),
      h("p.help", "Your professor announces the code at the start of the exam."),
    ),
    profileCard(user),
    h("div.card", h("div.card-head", h("h3", "My results")), h("div#results", h("p.muted", "Loading…"))),
  );
  loadResults(user);
}

function profileCard(user) {
  const name = h("input.input", { value: profile.displayName || user.displayName || "", placeholder: "Last Name, First Name" });
  const sid = h("input.input", { value: profile.studentId || "", placeholder: "e.g. 21-1234-567" });
  const sec = h("input.input", { value: profile.section || "", placeholder: "e.g. 50015" });
  return h("div.card",
    h("div.card-head", h("h3", "My details"), h("span.small.muted", "Shown to your professor on every exam")),
    h("div.grid.grid-3",
      h("label.field", h("span", "Full name"), name),
      h("label.field", h("span", "Student ID"), sid),
      h("label.field", h("span", "Section"), sec),
    ),
    h("div.row", { style: { marginTop: ".8rem" } },
      h("button.btn", { onclick: async () => {
        try {
          await updateMyProfile(user.uid, { displayName: name.value.trim(), studentId: sid.value.trim(), section: sec.value.trim() });
          Object.assign(profile, { displayName: name.value.trim(), studentId: sid.value.trim(), section: sec.value.trim() });
          toast("Saved.", "success");
        } catch (e) { toast(e.message, "error"); }
      } }, "Save details"),
    ),
  );
}

async function loadResults(user) {
  const host = $("#results");
  try {
    const snap = await getDocs(query(collection(db, "sessions"), where("uid", "==", user.uid)));
    if (snap.empty) { host.innerHTML = `<p class="muted">No exams taken yet.</p>`; return; }
    const rows = [];
    for (const d of snap.docs) {
      const s = d.data();
      let grade = null, released = false;
      try { const g = await getDoc(doc(db, "grades", d.id)); if (g.exists()) { grade = g.data(); released = true; } }
      catch { /* permission-denied => not released */ }
      rows.push({ id: d.id, s, grade, released });
    }
    rows.sort((a, b) => (b.s.startedAt?.toMillis?.() || 0) - (a.s.startedAt?.toMillis?.() || 0));
    clear(host);
    host.append(h("div.table-wrap", h("table.table",
      h("thead", h("tr", h("th", "Exam"), h("th", "Taken"), h("th", "Status"), h("th", "Score"), h("th", ""))),
      h("tbody", rows.map((r) => h("tr",
        h("td", h("strong", r.s.examTitle || r.s.examCode), h("div.small.muted.mono", r.s.examCode)),
        h("td", fmtDate(r.s.startedAt)),
        h("td", statusBadge(r.s.status)),
        h("td", r.grade ? h("strong", `${r.grade.score} / ${r.grade.max}`, h("span.muted.small", ` (${r.grade.percent}%)`))
                 : h("span.muted.small", r.s.status === "in_progress" ? "—" : "Not released yet")),
        h("td", r.s.status === "in_progress" ? h("a.btn.btn-sm.btn-primary", { href: `exam.html?code=${r.s.examCode}` }, "Resume")
              : r.grade ? h("a.btn.btn-sm", { href: `exam.html?code=${r.s.examCode}&review=1` }, "Review") : null),
      ))),
    )));
  } catch (e) { host.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
}

export function statusBadge(st) {
  const map = { in_progress: ["In progress", "badge-accent"], submitted: ["Submitted", "badge-success"], locked: ["Locked", "badge-danger"], terminated: ["Terminated", "badge-danger"] };
  const [label, cls] = map[st] || [st, ""];
  return h(`span.badge.${cls}`, label);
}
