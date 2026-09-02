import { sb, asError } from "./supabase.js";
import { siteConfig } from "./config.js";
import { myProfile } from "./db.js";
import { $, h, toast } from "./ui.js";

/**
 * Fires immediately with the current session, then on every change.
 *
 * Deliberately paranoid: whichever of getSession() or the INITIAL_SESSION event
 * arrives first wins, and if neither has arrived in 6 seconds we assume signed
 * out and render the sign-in form. A page that renders nothing is worse than a
 * page that shows a sign-in box you can retry from.
 */
export function watchAuth(cb) {
  let delivered = false;
  const deliver = (user) => {
    delivered = true;
    try { cb(user); } catch (e) { console.error("auth handler failed", e); }
  };

  const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION" && delivered) return;   // already handled
    deliver(session?.user ?? null);
  });

  sb.auth.getSession()
    .then(({ data, error }) => {
      if (error) console.warn("getSession:", error.message);
      if (!delivered) deliver(data?.session?.user ?? null);
    })
    .catch((e) => {
      console.warn("getSession failed:", e?.message || e);
      if (!delivered) deliver(null);
    });

  setTimeout(() => {
    if (!delivered) {
      console.warn("auth did not initialise in time; showing the sign-in form");
      deliver(null);
    }
  }, 6000);

  return () => sub.subscription.unsubscribe();
}

export const currentUser = async () => (await sb.auth.getUser()).data.user;
export const logout = () => sb.auth.signOut();
export const getProfile = myProfile;

export async function signInGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.href.split("#")[0] },
  });
  if (error) throw asError(error);
}

export async function loginEmail(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw asError(error);
}

export async function registerEmail(email, password, displayName) {
  const { data, error } = await sb.auth.signUp({
    email: email.trim(), password,
    options: {
      data: { full_name: displayName || "" },
      emailRedirectTo: location.origin + location.pathname,
    },
  });
  if (error) throw asError(error);
  return data;
}

export async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: location.origin + location.pathname,
  });
  if (error) throw asError(error);
}

export async function resendVerification(email) {
  const { error } = await sb.auth.resend({ type: "signup", email });
  if (error) throw asError(error);
}

/** Supabase marks a verified address with email_confirmed_at. */
export const isVerified = (user) =>
  !!(user?.email_confirmed_at || user?.confirmed_at);

/**
 * Render the sign-in panel. Callers react through watchAuth.
 * @param {HTMLElement} host
 * @param {{professorMode?: boolean}} opts
 */
export function renderAuthPanel(host, opts = {}) {
  const googleOnly = siteConfig.googleOnlyForStudents && !opts.professorMode;
  host.innerHTML = "";
  const err = h("div.form-error", { hidden: true });
  const showErr = (e) => {
    err.hidden = false;
    err.textContent = friendlyAuthError(e);
  };

  const gBtn = h("button.btn.btn-google", {
    type: "button",
    onclick: async () => { try { await signInGoogle(); } catch (e) { showErr(e); } },
  }, h("span.g-logo", { html: GOOGLE_SVG }), "Continue with Google");

  const form = h("form.auth-form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      const email = $("[name=email]", form).value.trim();
      const pass = $("[name=password]", form).value;
      const name = $("[name=name]", form)?.value.trim();
      const btn = $("button[type=submit]", form);
      btn.disabled = true;
      try {
        if (form.dataset.mode === "register") {
          if (!name) throw new Error("Please enter your full name.");
          const res = await registerEmail(email, pass, name);
          if (res.session) toast("Account created.", "success");
          else toast("Account created. Open the confirmation link we e-mailed you.", "success", 8000);
        } else {
          await loginEmail(email, pass);
        }
      } catch (e2) { showErr(e2); } finally { btn.disabled = false; }
    },
  });
  form.dataset.mode = "login";

  const nameField = h("label.field",
    h("span", "Full name (Last, First)"),
    h("input.input", { name: "name", autocomplete: "name", placeholder: "Dela Cruz, Juan" }));
  nameField.hidden = true;

  form.append(
    nameField,
    h("label.field", h("span", "E-mail"),
      h("input.input", { name: "email", type: "email", required: true, autocomplete: "username" })),
    h("label.field", h("span", "Password"),
      h("input.input", { name: "password", type: "password", required: true, minlength: 6, autocomplete: "current-password" })),
    err,
    h("button.btn.btn-primary.btn-block", { type: "submit" }, "Sign in"),
    h("div.auth-links",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); toggle(); } }, "Create an account"),
      h("a", { href: "#", onclick: async (e) => {
        e.preventDefault();
        const email = $("[name=email]", form).value.trim();
        if (!email) return showErr(new Error("Type your e-mail first, then click 'Forgot password'."));
        try { await resetPassword(email); toast("Password reset e-mail sent.", "success"); }
        catch (e3) { showErr(e3); }
      } }, "Forgot password"),
    ),
  );

  function toggle() {
    const reg = form.dataset.mode !== "register";
    form.dataset.mode = reg ? "register" : "login";
    nameField.hidden = !reg;
    $("button[type=submit]", form).textContent = reg ? "Create account" : "Sign in";
    $(".auth-links a", form).textContent = reg ? "I already have an account" : "Create an account";
    err.hidden = true;
  }

  host.append(h("div.auth-panel",
    gBtn,
    googleOnly
      ? h("p.muted.small", "Sign in with your school Google account.")
      : [h("div.divider", h("span", "or")), form],
  ));
}

export function friendlyAuthError(e) {
  const raw = (e?.raw || e?.message || String(e)).toLowerCase();
  const map = [
    [/invalid login credentials/, "Wrong e-mail or password."],
    [/email not confirmed/, "Confirm your e-mail address first — check your inbox."],
    [/user already registered|already been registered/, "That e-mail already has an account. Sign in instead."],
    [/password should be at least/, "Password must be at least 6 characters."],
    [/unable to validate email|invalid format/, "That e-mail address looks invalid."],
    [/rate limit|too many/, "Too many attempts. Wait a minute and try again."],
    [/provider is not enabled/, "Google sign-in is not enabled on this project yet."],
    [/redirect|not allowed/, "This site's URL is not in the Supabase redirect list (see README)."],
    [/failed to fetch|network/, "Network error. Check your connection."],
  ];
  const hit = map.find(([re]) => re.test(raw));
  return hit ? hit[1] : (e?.friendly || e?.message || String(e));
}

const GOOGLE_SVG = `<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.5 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.5-5.8c-2.1 1.4-4.8 2.3-8.1 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;
