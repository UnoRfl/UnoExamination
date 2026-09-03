// Self-diagnostic for a fresh Supabase project.
//
// Each check answers a question a first-time deployer actually gets wrong:
// config pasted? database reachable? RLS actually on? e-mail confirmed?
// professor role? can I really create an exam and read its key back?
import { supabaseConfig, siteConfig, isConfigured } from "./config.js";
import { $, h, esc, clear } from "./ui.js";

// tells the boot watchdog in the HTML that the module graph loaded
window.__unoBooted = true;

const host = $("#checks");
const summary = $("#summary");
const actions = $("#authActions");

const PASS = "✅", FAIL = "❌", WARN = "⚠️", INFO = "ℹ️", BUSY = "⏳";

function row(icon, title, detail, fix, fixBad) {
  const r = h("div.check-row",
    h("div.check-icon", icon),
    h("div",
      h("div.check-title", title),
      detail ? h("div.check-detail", { html: detail }) : null,
      fix ? h("div.check-fix", { class: `check-fix${fixBad ? " bad" : ""}`, html: fix }) : null));
  host.append(r);
  return r;
}

let failed = 0, warned = 0, pending = false;
const ok = (t, d) => row(PASS, t, d);
const bad = (t, d, fix) => { failed++; return row(FAIL, t, d, fix, true); };
const warn = (t, d, fix) => { warned++; return row(WARN, t, d, fix); };

async function run() {
  window.__unoRendered = true;
  clear(host); clear(actions); summary.hidden = true;
  failed = 0; warned = 0; pending = false;

  // -------------------------------------------------------------- 1. config
  if (!isConfigured()) {
    bad("Supabase config not filled in",
      "<code>js/config.js</code> still has a placeholder.",
      "Supabase dashboard → <b>Project Settings</b> → <b>API</b> → copy the " +
      "<b>Project URL</b> and the <b>publishable</b> (anon) key into <code>js/config.js</code>.");
    return finish();
  }
  ok("Supabase config present", `Project <code>${esc(new URL(supabaseConfig.url).hostname.split(".")[0])}</code>`);

  // ------------------------------------------------------------ 2. SDK load
  let sbmod, db;
  const loading = row(BUSY, "Loading the Supabase SDK…");
  try {
    sbmod = await import("./supabase.js");
    db = await import("./db.js");
    loading.remove();
    ok("Supabase SDK loaded", "Connected to the project API.");
  } catch (e) {
    loading.remove();
    bad("Supabase SDK failed to load", esc(e.message),
      "Check your connection, and serve the page over http(s) — opening the files " +
      "with <code>file://</code> does not work. Use <code>npm run serve</code> or GitHub Pages.");
    return finish();
  }
  const { sb } = sbmod;

  // ------------------------------------------------- 3. reachable + RLS on
  const probing = row(BUSY, "Testing the database and its row level security…");
  let reach = "unknown";
  try {
    // Nothing may read an answer key without being the exam owner. An empty
    // result is the CORRECT answer and proves RLS is switched on.
    const { data, error } = await sb.from("answer_keys").select("question_id").limit(1);
    reach = error ? (error.message || "error") : (data?.length ? "leaked" : "locked");
  } catch (e) { reach = e.message; }
  probing.remove();

  if (reach === "locked") {
    ok("Database reachable and row level security is on",
      "A protected table correctly returned nothing.");
  } else if (reach === "leaked") {
    bad("DANGER: answer keys are readable",
      "A signed-out or non-owner request could read <code>answer_keys</code>.",
      "Re-run the migrations in <code>supabase/migrations/</code> — the RLS policies " +
      "are missing or were dropped.");
  } else if (/Failed to fetch|NetworkError/i.test(reach)) {
    bad("Cannot reach the database", `Error: <code>${esc(reach)}</code>`,
      "Check the Project URL in <code>js/config.js</code>, and that the project is not paused " +
      "(Supabase dashboard → the project should say <b>Active</b>).");
  } else if (/JWT|api key|Invalid/i.test(reach)) {
    bad("The publishable key is wrong", `Error: <code>${esc(reach)}</code>`,
      "Supabase dashboard → <b>Project Settings</b> → <b>API</b> → copy the publishable (anon) key again.");
  } else {
    ok("Database reachable", `Protected read returned: <code>${esc(reach)}</code>`);
  }

  // ---------------------------------------------------------- 4. auth state
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    pending = true;
    row(INFO, "Not signed in",
      "Sign in below as the professor account to finish the remaining checks " +
      "(e-mail confirmation, professor role, and whether you can create an exam).");
    actions.append(
      h("button.btn", { onclick: async () => {
        try {
          const { error } = await sb.auth.signInWithOAuth({
            provider: "google", options: { redirectTo: location.href.split("#")[0] } });
          if (error) throw error;
        } catch (e) { bad("Google sign-in failed", esc(e.message), googleFix(e)); finish(); }
      } }, "Sign in with Google to continue"),
      h("a.btn.btn-ghost", { href: "professor.html" }, "or use the dashboard's sign-in"),
    );
    return finish();
  }

  ok("Signed in", `<code>${esc(user.email)}</code> · id <code>${esc(user.id)}</code>`);
  actions.append(h("button.btn", { onclick: async () => { await sb.auth.signOut(); run(); } }, "Sign out"));

  if (user.email_confirmed_at || user.confirmed_at) {
    ok("E-mail address is confirmed", "Required by the server before anyone can sit an exam.");
  } else {
    bad("E-mail address is NOT confirmed",
      "<code>start_exam()</code> refuses an unconfirmed address.",
      "Open the confirmation link we e-mailed you. " +
      "<button class='btn btn-sm' id='resend'>Resend</button>");
    $("#resend")?.addEventListener("click", async (e) => {
      try { await sb.auth.resend({ type: "signup", email: user.email }); e.target.textContent = "Sent — check your inbox"; }
      catch (err) { e.target.textContent = err.message; }
    });
  }

  // ------------------------------------------------------------ 5. profile
  const profRow = row(BUSY, "Checking your account role…");
  let profile = null, profErr = null;
  try { profile = await db.myProfile(); } catch (e) { profErr = e.friendly || e.message; }
  profRow.remove();

  if (profErr) {
    bad("Cannot read your own profile", `Error: <code>${esc(profErr)}</code>`,
      "The migrations may not all have run. Re-apply <code>supabase/migrations/</code>.");
  } else if (!profile) {
    warn("No profile row yet",
      "It is created by a trigger the first time you sign up.",
      "Sign out and back in once. If it still does not appear, re-apply the migrations.");
  } else if (["professor", "admin"].includes(profile.role)) {
    ok("You are a professor", "You can create exams, monitor them and grade.");
  } else {
    pending = true;
    const codeI = h("input.input", { placeholder: "XXXXX-XXXXX-XXXXX",
      style: { maxWidth: "260px", textTransform: "uppercase" } });
    const r = row(INFO, "This account is a student",
      "Use your one-time bootstrap code to become the first professor.");
    r.querySelector("div:last-child").append(
      h("div.row", { style: { marginTop: ".5rem" } }, codeI,
        h("button.btn.btn-sm.btn-primary", { onclick: async () => {
          try { await db.claimProfessor(codeI.value.trim().toUpperCase()); run(); }
          catch (e) { alert(e.friendly || e.message); }
        } }, "Become professor")));
  }

  // ------------------------------------------- 6. can I really run an exam?
  if (["professor", "admin"].includes(profile?.role)) {
    const wRow = row(BUSY, "Testing that you can create an exam and read its key back…");
    const code = "SETUP" + Math.floor(Math.random() * 10);
    let wErr = null;
    try {
      await db.saveExam({
        code, owner_id: user.id, owner_name: "setup check", title: "Setup check (safe to ignore)",
        status: "draft", opens_at: new Date().toISOString(),
        closes_at: new Date(Date.now() + 3600_000).toISOString(),
        duration_minutes: 1, question_count: 1, total_points: 1,
      });
      await db.replaceQuestions(code, [{
        type: "mc", prompt: "probe", options: ["a", "b"], points: 1, key: { correct: 1 },
      }]);
      const back = await db.examQuestionsWithKeys(code);
      if (!back.length || back[0].key?.correct !== 1) throw new Error("the answer key did not come back");
      await db.deleteExam(code);
    } catch (e) { wErr = e.friendly || e.message; try { await db.deleteExam(code); } catch {} }
    wRow.remove();
    if (!wErr) ok("Exam create → read key → delete all work", "Everything is wired up correctly.");
    else bad("Could not run the exam round-trip", `Error: <code>${esc(wErr)}</code>`,
      "Re-apply the migrations in <code>supabase/migrations/</code>, then reload this page.");
  }

  // --------------------------------------------------- 7. redirect reminder
  row(INFO, "Sign-in redirect URLs",
    `This page is served from <code>${esc(location.origin)}</code>. Supabase only returns users ` +
    `to URLs you have listed.`,
    "If Google sign-in bounces or errors: Supabase dashboard → <b>Authentication</b> → " +
    `<b>URL Configuration</b> → add <code>${esc(location.origin)}/**</code> to <b>Redirect URLs</b> ` +
    `and set <b>Site URL</b> to <code>${esc(location.origin)}</code>.`);

  finish();
}

function googleFix(e) {
  const m = (e?.message || "").toLowerCase();
  if (m.includes("provider is not enabled")) {
    return "Enable it: Supabase dashboard → <b>Authentication</b> → <b>Sign In / Providers</b> → <b>Google</b>.";
  }
  return `Supabase dashboard → <b>Authentication</b> → <b>URL Configuration</b> → add <code>${esc(location.origin)}/**</code>.`;
}

function finish() {
  summary.hidden = false;
  clear(summary);
  if (pending && failed === 0) {
    summary.append(h("h2", "Looking good so far"),
      h("p", "Finish the step above to complete the remaining checks."));
  } else if (failed === 0 && warned === 0) {
    summary.append(h("h2", { style: { color: "var(--success)" } }, "Everything passes — you are ready"),
      h("p", "Open the ", h("a", { href: "professor.html" }, "professor dashboard"),
        ", create an exam, and share the code with your students."));
  } else {
    summary.append(
      h("h2", { style: { color: failed ? "var(--danger)" : "var(--warn)" } },
        failed ? `${failed} thing${failed === 1 ? "" : "s"} still to fix` : `${warned} warning${warned === 1 ? "" : "s"}`),
      h("p.muted", "Fix the items marked above, then click ", h("b", "Run checks again"), "."));
  }
}

$("#rerun").addEventListener("click", run);
run();
