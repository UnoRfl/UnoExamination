// Self-diagnostic for a fresh Firebase project.
//
// Every check answers one question a first-time deployer actually gets wrong:
// config pasted? Firestore created? rules DEPLOYED (not left in test mode)?
// sign-in provider enabled? domain authorized? e-mail verified? professor role?
import { firebaseConfig, siteConfig, isConfigured } from "./firebase-config.js";
import { $, h, esc, clear } from "./ui.js";

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
      fix ? h("div.check-fix", { class: `check-fix${fixBad ? " bad" : ""}`, html: fix }) : null,
    ));
  host.append(r);
  return r;
}

let failed = 0, warned = 0, pending = false;
const ok = (t, d) => row(PASS, t, d);
const bad = (t, d, fix) => { failed++; return row(FAIL, t, d, fix, true); };
const warn = (t, d, fix) => { warned++; return row(WARN, t, d, fix); };

async function run() {
  clear(host); clear(actions); summary.hidden = true;
  failed = 0; warned = 0; pending = false;

  // ------------------------------------------------------------ 1. config
  if (!isConfigured()) {
    bad("Firebase config not filled in",
      "<code>js/firebase-config.js</code> still contains <code>REPLACE_ME</code>.",
      "Firebase console → gear icon → <b>Project settings</b> → scroll to <b>Your apps</b> → " +
      "click the web app (or <b>&lt;/&gt;</b> to create one) → copy the <code>firebaseConfig</code> " +
      "object and paste its values into <code>js/firebase-config.js</code>.");
    return finish();
  }
  ok("Firebase config present", `Project <code>${esc(firebaseConfig.projectId)}</code>`);

  // ------------------------------------------------------------ 2. SDK + init
  let fb;
  const initRow = row(BUSY, "Loading the Firebase SDK…");
  try {
    fb = await import("./firebase-init.js");
    initRow.remove();
    ok("Firebase SDK loaded and initialised",
      siteConfig.useEmulators && ["localhost", "127.0.0.1"].includes(location.hostname)
        ? "Connected to the <b>local emulators</b> (useEmulators is on)." : "Connected to the live project.");
  } catch (e) {
    initRow.remove();
    bad("Firebase SDK failed to load", esc(e.message),
      "Check your internet connection, and that the page is served over http(s) — " +
      "opening the files directly with <code>file://</code> does not work. Use " +
      "<code>npm run serve</code> or GitHub Pages.");
    return finish();
  }

  // ------------------------------------------------------------ 3. Firestore reachable + rules deployed
  const dbRow = row(BUSY, "Testing Firestore and your security rules…");
  let rulesState = "unknown";
  try {
    // Nothing may read this path under our rules. permission-denied is the
    // CORRECT answer and proves the rules are deployed rather than wide open.
    await fb.getDoc(fb.doc(fb.db, "_setup_probe", "probe"));
    rulesState = "open";
  } catch (e) {
    rulesState = e.code || e.message;
  }
  dbRow.remove();
  if (rulesState === "permission-denied") {
    ok("Firestore reachable and security rules are deployed",
      "A locked path correctly returned <code>permission-denied</code>.");
  } else if (rulesState === "open") {
    bad("DANGER: your database is wide open",
      "A path that should be denied to everyone was readable, so your project is still " +
      "in <b>test mode</b> — any student could read your answer keys and write any grade.",
      "Deploy the rules NOW: Firebase console → <b>Firestore Database</b> → <b>Rules</b> tab → " +
      "paste the entire contents of <code>firestore.rules</code> → <b>Publish</b>. " +
      "Then reload this page.");
  } else if (/unavailable|offline|network/i.test(rulesState)) {
    bad("Cannot reach Firestore", `Error: <code>${esc(rulesState)}</code>`,
      "Have you created the database? Firebase console → <b>Firestore Database</b> → " +
      "<b>Create database</b> → pick a region → <b>production mode</b>.");
  } else if (/not-found|NOT_FOUND/i.test(rulesState)) {
    bad("Firestore database does not exist yet", `Error: <code>${esc(rulesState)}</code>`,
      "Firebase console → <b>Firestore Database</b> → <b>Create database</b> → " +
      "choose a region → <b>production mode</b>.");
  } else {
    warn("Unexpected Firestore response", `Got <code>${esc(rulesState)}</code> from the probe read.`,
      "This is usually still fine, but confirm the rules from <code>firestore.rules</code> are published.");
  }

  // ------------------------------------------------------------ 4. Auth state
  const user = await new Promise((resolve) => {
    const un = fb.onAuthStateChanged(fb.auth, (u) => { un(); resolve(u); });
  });

  if (!user) {
    pending = true;
    row(INFO, "Not signed in",
      "Sign in below as the professor account to finish the remaining checks " +
      "(e-mail verification, professor role, and whether you can create an exam).");
    actions.append(
      h("button.btn", { onclick: async () => {
        try {
          const p = new fb.GoogleAuthProvider();
          p.setCustomParameters({ prompt: "select_account" });
          await fb.signInWithPopup(fb.auth, p);
          run();
        } catch (e) { showAuthError(e); }
      } }, "Sign in with Google to continue"),
      h("a.btn.btn-ghost", { href: "professor.html" }, "or use the dashboard's sign-in"),
    );
    return finish();
  }

  ok("Signed in", `<code>${esc(user.email)}</code> · uid <code>${esc(user.uid)}</code>`);
  actions.append(h("button.btn", { onclick: async () => { await fb.signOut(fb.auth); run(); } }, "Sign out"));

  if (user.emailVerified) {
    ok("E-mail address is verified", "Required by the rules before anyone can sit an exam.");
  } else {
    bad("E-mail address is NOT verified",
      "The security rules require a verified e-mail to start an exam session.",
      "Check your inbox for the verification link. " +
      "<button class='btn btn-sm' id='resend'>Resend verification e-mail</button>");
    const btn = $("#resend");
    btn && btn.addEventListener("click", async () => {
      const { sendEmailVerification } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js");
      try { await sendEmailVerification(user); btn.textContent = "Sent — check your inbox"; }
      catch (e) { btn.textContent = e.message; }
    });
  }

  // ------------------------------------------------------------ 5. profile + role
  const profRow = row(BUSY, "Checking your account role…");
  let profile = null, profileErr = null;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) { profileErr = e.code || e.message; }
  profRow.remove();

  if (profileErr) {
    bad("Cannot read your own user profile", `Error: <code>${esc(profileErr)}</code>`,
      "Make sure the rules published in the console are the full contents of " +
      "<code>firestore.rules</code> from this repository.");
  } else if (!profile) {
    row(INFO, "No profile document yet",
      "It is created automatically the first time you open the dashboard or the home page.");
  } else if (profile.role === "professor") {
    ok("You are a professor", "You can create exams and grade them.");
  } else {
    // Is this account the bootstrap admin? Try to claim the role: the rules
    // allow it only for the e-mail hard-coded in firestore.rules.
    let claimed = false, claimErr = null;
    try {
      await fb.updateDoc(fb.doc(fb.db, "users", user.uid), { role: "professor", updatedAt: fb.serverTimestamp() });
      claimed = true;
    } catch (e) { claimErr = e.code || e.message; }
    if (claimed) {
      ok("Promoted this account to professor", "Your e-mail matches BOOTSTRAP_ADMIN_EMAIL in the rules.");
      profile.role = "professor";
    } else {
      bad("This account is a student, not a professor",
        `The rules would not let it self-promote (<code>${esc(claimErr || "denied")}</code>), which means ` +
        `<code>${esc(user.email)}</code> is not the bootstrap admin e-mail in your deployed rules.`,
        `Open <code>firestore.rules</code>, set<br>` +
        `<code>function BOOTSTRAP_ADMIN_EMAIL() { return '${esc(user.email)}'; }</code><br>` +
        `then re-publish the rules in the console and reload this page. ` +
        `(Or ask an existing professor to promote you from their <b>Access</b> tab.)`);
    }
  }

  // ------------------------------------------------------------ 6. can we actually create an exam?
  if (profile?.role === "professor") {
    const wRow = row(BUSY, "Testing that you can create and delete an exam…");
    const code = "SETUP" + Math.floor(Math.random() * 10);
    let writeErr = null;
    try {
      const now = new Date();
      await fb.setDoc(fb.doc(fb.db, "exams", code), {
        ownerUid: user.uid, ownerName: "setup check", title: "Setup check (safe to ignore)", course: "",
        instructions: "", status: "draft", opensAt: fb.Timestamp.fromDate(now),
        closesAt: fb.Timestamp.fromDate(new Date(Date.now() + 3600_000)), scoresReleased: false,
        questionCount: 0, totalPoints: 0,
        settings: { durationMinutes: 1, maxViolations: 5, violationAction: "lock", allowedDomain: "", roster: [] },
        createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp(),
      });
      await fb.setDoc(fb.doc(fb.db, "exams", code, "private", "answerKey"), { answers: {} });
      const back = await fb.getDoc(fb.doc(fb.db, "exams", code, "private", "answerKey"));
      if (!back.exists()) throw new Error("answer key did not come back");
      await fb.deleteDoc(fb.doc(fb.db, "exams", code, "private", "answerKey"));
      await fb.deleteDoc(fb.doc(fb.db, "exams", code));
    } catch (e) { writeErr = e.code || e.message; }
    wRow.remove();
    if (!writeErr) ok("Exam create / read-key / delete all work", "Everything is wired up correctly.");
    else bad("Could not create a test exam", `Error: <code>${esc(writeErr)}</code>`,
      "The published rules are probably an older or partial copy. Re-paste the whole " +
      "<code>firestore.rules</code> file in the console and publish again.");
  }

  // ------------------------------------------------------------ 7. authorized domain reminder
  row(INFO, "Authorized domains",
    `This page is served from <code>${esc(location.hostname)}</code>. Firebase Auth only allows ` +
    `sign-in from domains you have listed.`,
    "If sign-in fails with <code>auth/unauthorized-domain</code>: Firebase console → " +
    "<b>Authentication</b> → <b>Settings</b> → <b>Authorized domains</b> → <b>Add domain</b> → " +
    `<code>${esc(location.hostname)}</code>.`);

  finish();
}

function showAuthError(e) {
  const code = e?.code || "";
  let fix = esc(e?.message || String(e));
  if (code === "auth/unauthorized-domain") {
    fix = `Firebase console → <b>Authentication</b> → <b>Settings</b> → <b>Authorized domains</b> → ` +
          `add <code>${esc(location.hostname)}</code>.`;
  } else if (code === "auth/operation-not-allowed" || code === "auth/configuration-not-found") {
    fix = "Google sign-in is not enabled yet: Firebase console → <b>Authentication</b> → " +
          "<b>Sign-in method</b> → <b>Google</b> → enable it and save.";
  } else if (code === "auth/popup-blocked") {
    fix = "Your browser blocked the popup. Allow popups for this site and try again.";
  }
  bad(`Sign-in failed (${esc(code || "error")})`, "", fix);
  finish();
}

function finish() {
  summary.hidden = false;
  clear(summary);
  if (pending && failed === 0) {
    summary.append(
      h("h2", "Looking good so far"),
      h("p", "Sign in above as your professor account to finish the remaining checks — " +
             "e-mail verification, the professor role, and whether you can actually create an exam."),
    );
  } else if (failed === 0 && warned === 0) {
    summary.append(
      h("h2", { style: { color: "var(--success)" } }, "Everything passes — you are ready"),
      h("p", "Open the ", h("a", { href: "professor.html" }, "professor dashboard"),
        ", create an exam, and share the code with your students."),
    );
  } else {
    summary.append(
      h("h2", { style: { color: failed ? "var(--danger)" : "var(--warn)" } },
        failed ? `${failed} thing${failed === 1 ? "" : "s"} still to fix` : `${warned} warning${warned === 1 ? "" : "s"}`),
      h("p.muted", "Fix the items marked above, then click ", h("b", "Run checks again"), "."),
    );
  }
}

$("#rerun").addEventListener("click", run);
run();
