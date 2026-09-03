import { siteConfig } from "./config.js";
import { watchAuth, renderAuthPanel, logout, isVerified, resendVerification } from "./auth.js";
import { myProfile, updateMyProfile, mySessions, myGrades } from "./db.js";
import { $, h, esc, toast, fmtDate, clear, mount } from "./ui.js";

// tells the boot watchdog in the HTML that the module graph loaded
window.__unoBooted = true;

const app = $("#app");
$("#brandName").textContent = siteConfig.institutionName;
document.title = siteConfig.institutionName;

let profile = null;

watchAuth(async (user) => {
  clear($("#topRight"));
  if (!user) return renderSignedOut();
  try {
    profile = await myProfile();
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="form-error">${esc(e.message)}</div></div>`;
    return;
  }
  mount($("#topRight"),
    h("span.small.muted", user.email),
    profile?.role === "professor"
      ? h("a.btn.btn-sm.btn-primary", { href: "professor.html" }, "Dashboard") : null,
    h("button.btn.btn-sm", { onclick: () => logout() }, "Sign out"),
  );
  renderHome(user);
});

function renderSignedOut() {
  window.__unoRendered = true;
  clear(app);
  app.append(
    h("div.card",
      h("h1", siteConfig.institutionName),
      h("p.muted", siteConfig.tagline),
      h("div#authHost"),
    ),
    h("div.card.small.muted",
      h("strong", "Before you start an exam: "),
      "use a laptop or desktop, close every other tab and application, and keep this " +
      "window in fullscreen. Leaving the exam window is recorded and reported to your professor.",
    ),
  );
  renderAuthPanel($("#authHost"));
}

function renderHome(user) {
  window.__unoRendered = true;
  clear(app);
  const codeInput = h("input.input.mono", {
    placeholder: "e.g. K7M2XQ", maxlength: 12, autocomplete: "off",
    style: { textTransform: "uppercase", letterSpacing: ".2em", fontSize: "1.2rem" },
  });
  const join = (e) => {
    e?.preventDefault();
    const code = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) return toast("Enter the exam code from your professor.", "warn");
    location.href = `exam.html?code=${encodeURIComponent(code)}`;
  };

  if (!isVerified(user)) {
    app.append(h("div.card", { style: { borderColor: "var(--warn)" } },
      h("strong", "Confirm your e-mail. "),
      "You cannot start an exam until your address is confirmed. Check your inbox and spam folder. ",
      h("button.btn.btn-sm", { onclick: async () => {
        try { await resendVerification(user.email); toast("Confirmation e-mail sent.", "success"); }
        catch (e) { toast(e.message, "error"); }
      } }, "Resend"),
      " ",
      h("button.btn.btn-sm.btn-ghost", { onclick: () => location.reload() }, "I've confirmed – refresh"),
    ));
  }

  app.append(
    h("div.card",
      h("h2", `Hello, ${esc(profile?.display_name || user.email)}`),
      h("form.row", { onsubmit: join },
        h("div", { style: { flex: 1, minWidth: "200px" } }, codeInput),
        h("button.btn.btn-primary.btn-lg", { type: "submit" }, "Enter exam"),
      ),
      h("p.help", "Your professor announces the code at the start of the exam."),
    ),
    profileCard(user),
    h("div.card", h("div.card-head", h("h3", "My results")), h("div#results", h("p.muted", "Loading…"))),
  );
  loadResults();
}

function profileCard(user) {
  const name = h("input.input", { value: profile?.display_name || "", placeholder: "Last Name, First Name" });
  const sid = h("input.input", { value: profile?.student_id || "", placeholder: "e.g. 21-1234-567" });
  const sec = h("input.input", { value: profile?.section || "", placeholder: "e.g. 50015" });
  return h("div.card",
    h("div.card-head", h("h3", "My details"), h("span.small.muted", "Shown to your professor on every exam")),
    h("div.grid.grid-3",
      h("label.field", h("span", "Full name"), name),
      h("label.field", h("span", "Student ID"), sid),
      h("label.field", h("span", "Section"), sec),
    ),
    h("div.row", { style: { marginTop: ".8rem" } },
      h("button.btn", { onclick: async (e) => {
        e.target.disabled = true;
        try {
          profile = await updateMyProfile({
            display_name: name.value.trim(),
            student_id: sid.value.trim(),
            section: sec.value.trim(),
          });
          toast("Saved.", "success");
        } catch (err) { toast(err.friendly || err.message, "error"); }
        finally { e.target.disabled = false; }
      } }, "Save details"),
    ),
  );
}

async function loadResults() {
  const host = $("#results");
  try {
    const [sessions, grades] = await Promise.all([mySessions(), myGrades()]);
    if (!sessions.length) { host.innerHTML = `<p class="muted">No exams taken yet.</p>`; return; }
    const gradeBySession = Object.fromEntries(grades.map((g) => [g.session_id, g]));
    clear(host);
    host.append(h("div.table-wrap", h("table.table",
      h("thead", h("tr", h("th", "Exam"), h("th", "Taken"), h("th", "Status"), h("th", "Score"), h("th", ""))),
      h("tbody", sessions.map((s) => {
        const g = gradeBySession[s.id];
        return h("tr",
          h("td", h("strong", s.exam_title || s.exam_code), h("div.small.muted.mono", s.exam_code)),
          h("td", fmtDate(s.started_at)),
          h("td", statusBadge(s.status)),
          h("td", g
            ? h("strong", `${Number(g.score)} / ${Number(g.max_score)}`,
                h("span.muted.small", ` (${g.percent}%)`))
            : h("span.muted.small", s.status === "in_progress" ? "—" : "Not released yet")),
          h("td", s.status === "in_progress"
            ? h("a.btn.btn-sm.btn-primary", { href: `exam.html?code=${s.exam_code}` }, "Resume")
            : g ? h("a.btn.btn-sm", { href: `exam.html?code=${s.exam_code}&review=1` }, "Review") : null),
        );
      })),
    )));
  } catch (e) {
    host.innerHTML = `<div class="form-error">${esc(e.friendly || e.message)}</div>`;
  }
}

export function statusBadge(st) {
  const map = {
    in_progress: ["In progress", "badge-accent"],
    submitted: ["Submitted", "badge-success"],
    locked: ["Locked", "badge-danger"],
    terminated: ["Terminated", "badge-danger"],
  };
  const [label, cls] = map[st] || [st, ""];
  return h(`span.badge.${cls}`, label);
}
