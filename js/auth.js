import {
  auth, db, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signOut, updateProfile, doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "./firebase-init.js";
import { siteConfig } from "./firebase-config.js";
import { $, h, esc, toast } from "./ui.js";

export function watchAuth(cb) { return onAuthStateChanged(auth, cb); }
export const currentUser = () => auth.currentUser;
export const logout = () => signOut(auth);

export async function signInGoogle() {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, p);
}
export async function registerEmail(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName) await updateProfile(cred.user, { displayName });
  await sendEmailVerification(cred.user);
  return cred;
}
export const loginEmail = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const resendVerification = () => auth.currentUser && sendEmailVerification(auth.currentUser);

/** Ensure users/{uid} exists; returns profile data. */
export async function ensureProfile(user, extra = {}) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const data = {
    email: (user.email || "").toLowerCase(),
    displayName: user.displayName || extra.displayName || "",
    photoURL: user.photoURL || "",
    role: "student",
    studentId: extra.studentId || "",
    section: extra.section || "",
    createdAt: serverTimestamp(),
  };
  await setDoc(ref, data);
  return data;
}
export async function updateMyProfile(uid, fields) {
  await updateDoc(doc(db, "users", uid), { ...fields, updatedAt: serverTimestamp() });
}

/**
 * Render a sign-in panel into `host`. Resolves nothing; callers react to watchAuth.
 * @param {HTMLElement} host
 * @param {{professorMode?:boolean}} opts
 */
export function renderAuthPanel(host, opts = {}) {
  const googleOnly = siteConfig.googleOnlyForStudents && !opts.professorMode;
  host.innerHTML = "";
  const err = h("div.form-error", { hidden: true });
  const showErr = (e) => { err.hidden = false; err.textContent = friendlyAuthError(e); };

  const gBtn = h("button.btn.btn-google", { type: "button", onclick: async () => { try { await signInGoogle(); } catch (e) { showErr(e); } } },
    h("span.g-logo", { html: GOOGLE_SVG }), "Continue with Google");

  const emailForm = h("form.auth-form", { onsubmit: async (e) => {
    e.preventDefault();
    const mode = emailForm.dataset.mode;
    const email = $("[name=email]", emailForm).value.trim();
    const pass = $("[name=password]", emailForm).value;
    const name = $("[name=name]", emailForm)?.value.trim();
    try {
      if (mode === "register") {
        if (!name) throw new Error("Please enter your full name.");
        await registerEmail(email, pass, name);
        toast("Account created. Check your inbox for the verification e-mail.", "success", 6000);
      } else {
        await loginEmail(email, pass);
      }
    } catch (e2) { showErr(e2); }
  } });
  emailForm.dataset.mode = "login";

  const nameField = h("label.field", h("span", "Full name (Last, First)"), h("input.input", { name: "name", autocomplete: "name", placeholder: "Dela Cruz, Juan" }));
  nameField.hidden = true;
  emailForm.append(
    nameField,
    h("label.field", h("span", "E-mail"), h("input.input", { name: "email", type: "email", required: true, autocomplete: "username" })),
    h("label.field", h("span", "Password"), h("input.input", { name: "password", type: "password", required: true, minlength: 6, autocomplete: "current-password" })),
    err,
    h("button.btn.btn-primary.btn-block", { type: "submit" }, "Sign in"),
    h("div.auth-links",
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); toggleMode(); } }, "Create an account"),
      h("a", { href: "#", onclick: async (e) => {
        e.preventDefault();
        const email = $("[name=email]", emailForm).value.trim();
        if (!email) return showErr(new Error("Type your e-mail first, then click 'Forgot password'."));
        try { await resetPassword(email); toast("Password reset e-mail sent.", "success"); } catch (e3) { showErr(e3); }
      } }, "Forgot password"),
    ),
  );
  function toggleMode() {
    const reg = emailForm.dataset.mode !== "register";
    emailForm.dataset.mode = reg ? "register" : "login";
    nameField.hidden = !reg;
    $("button[type=submit]", emailForm).textContent = reg ? "Create account" : "Sign in";
    $(".auth-links a", emailForm).textContent = reg ? "I already have an account" : "Create an account";
    err.hidden = true;
  }

  host.append(h("div.auth-panel",
    gBtn,
    googleOnly ? h("p.muted.small", "Sign in with your school Google account.")
      : [h("div.divider", h("span", "or")), emailForm],
  ));
}

export function friendlyAuthError(e) {
  const code = e?.code || "";
  const map = {
    "auth/invalid-credential": "Wrong e-mail or password.",
    "auth/user-not-found": "No account with that e-mail.",
    "auth/wrong-password": "Wrong password.",
    "auth/email-already-in-use": "That e-mail already has an account. Sign in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-email": "That e-mail address looks invalid.",
    "auth/popup-closed-by-user": "Sign-in window was closed.",
    "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups and retry.",
    "auth/unauthorized-domain": "This site's domain is not authorised in Firebase Auth (see README).",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "permission-denied": "Permission denied by the server rules.",
  };
  return map[code] || e?.message || String(e);
}

const GOOGLE_SVG = `<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.5 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.5-5.8c-2.1 1.4-4.8 2.3-8.1 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;
