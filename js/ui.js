// Tiny DOM / formatting helpers shared by every page.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** h('div.card#id', {onclick}, children...) */
export function h(tag, attrs = {}, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || "div");
  for (const r of rest) {
    if (r.startsWith(".")) el.classList.add(r.slice(1));
    else if (r.startsWith("#")) el.id = r.slice(1);
  }
  if (attrs && typeof attrs === "object" && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/**
 * append() with h()'s rule about empty children.
 *
 * Element.append(null) renders the literal text "null" on the page, which is
 * exactly what `cond ? node : null` produces on the false branch. h() already
 * skips those; this is the same for an element you already have.
 */
export function mount(host, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    host.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return host;
}

let toastHost;
export function toast(msg, kind = "info", ms = 3500) {
  if (!toastHost) { toastHost = h("div.toast-host"); document.body.append(toastHost); }
  const t = h(`div.toast.toast-${kind}`, msg);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
}

/** Promise-based modal. buttons: [{label, value, kind}] */
export function dialog({ title, body, buttons = [{ label: "OK", value: true, kind: "primary" }], dismissible = true, wide = false }) {
  return new Promise((resolve) => {
    const overlay = h("div.modal-overlay");
    const card = h("div.modal-card" + (wide ? ".wide" : ""));
    const restore = document.activeElement;

    // Every exit runs through here, so the key listener can never outlive the
    // dialog and swallow the next Escape the page sees.
    const finish = (value) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (restore?.focus) try { restore.focus(); } catch {}
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && dismissible) { e.stopPropagation(); finish(null); }
    };

    if (title) card.append(h("h3.modal-title", title));
    card.append(typeof body === "string" ? h("div.modal-body", { html: body }) : h("div.modal-body", body));
    const actions = h("div.modal-actions");
    for (const b of buttons) {
      actions.append(h(`button.btn.btn-${b.kind || "secondary"}`, { onclick: () => finish(b.value) }, b.label));
    }
    card.append(actions);
    overlay.append(card);
    if (dismissible) overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    // The primary action, not the Cancel that usually comes first.
    (actions.querySelector(".btn-primary, .btn-danger, .btn-success") || actions.querySelector("button"))?.focus();
  });
}

export const confirmDialog = (title, body, okLabel = "Confirm", kind = "danger") =>
  dialog({ title, body, buttons: [{ label: "Cancel", value: false }, { label: okLabel, value: true, kind }] });

export function promptDialog(title, label, value = "", type = "text") {
  const input = h("input.input", { type, value });
  return dialog({
    title, body: h("label.field", h("span", label), input),
    buttons: [{ label: "Cancel", value: null }, { label: "OK", value: "ok", kind: "primary" }],
  }).then((v) => (v === "ok" ? input.value : null));
}

export const pad2 = (n) => String(n).padStart(2, "0");
export function mmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return hrs > 0 ? `${hrs}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}
export function fmtDate(ts) {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
export function fmtTime(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}
export function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts === "number") return new Date(ts);
  return null;
}
export function ago(ts) {
  const d = toDate(ts); if (!d) return "—";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
/** yyyy-mm-ddThh:mm for <input type=datetime-local> in local time */
export function toLocalInput(date) {
  const d = toDate(date) || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function downloadText(filename, text, mime = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export const qs = (k) => new URLSearchParams(location.search).get(k);
export const randomId = (n = 12) => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
};
/** Unambiguous exam code (no 0/O/1/I/L). Never contains '_' (used as separator). */
export function examCode(len = 6) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return Array.from(a, (b) => alphabet[b % alphabet.length]).join("");
}
