// Browser-side proctoring monitor.
//
// IMPORTANT (see docs/SECURITY.md): everything in this file runs on the
// student's machine and is therefore *evidence*, not enforcement. It records
// timestamped signals for the professor and applies a strike policy; the hard
// guarantees (timer, single attempt, hidden key) live in firestore.rules.

export class Proctor {
  /**
   * @param {Object} opts
   * @param {(type:string, detail?:object)=>void} opts.onEvent   every signal
   * @param {(count:number, type:string)=>void}    opts.onStrike  strike-worthy signals
   * @param {Set<string>} opts.strikeTypes
   * @param {boolean} opts.requireFullscreen
   * @param {boolean} opts.blockClipboard
   * @param {boolean} opts.blockContextMenu
   */
  constructor(opts) {
    this.o = { requireFullscreen: true, blockClipboard: true, blockContextMenu: true, ...opts };
    this.strikes = 0;
    this.active = false;
    this.paused = false;             // paused while a modal we own is up
    this._hiddenSince = 0;
    this._blurSince = 0;
    this._lastStrikeAt = 0;
    this._handlers = [];
    this._devtoolsOpen = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); this._handlers.push([target, ev, fn, opts]); };

    // --- tab / window switching -------------------------------------------
    on(document, "visibilitychange", () => {
      if (document.hidden) { this._hiddenSince = Date.now(); }
      else if (this._hiddenSince) {
        const ms = Date.now() - this._hiddenSince; this._hiddenSince = 0;
        this._strike("tab_hidden", { ms });
      }
    });
    on(window, "blur", () => { this._blurSince = Date.now(); });
    on(window, "focus", () => {
      if (!this._blurSince) return;
      const ms = Date.now() - this._blurSince; this._blurSince = 0;
      // visibilitychange already covers real tab switches; blur alone = another
      // app/window got focus (alt-tab, second monitor, popup, IME).
      if (!document.hidden && ms > 400) this._strike("window_blur", { ms });
    });

    // --- fullscreen ---------------------------------------------------------
    on(document, "fullscreenchange", () => {
      if (!document.fullscreenElement && this.o.requireFullscreen && !this.paused) this._strike("fullscreen_exit");
    });

    // --- clipboard / context menu ------------------------------------------
    if (this.o.blockContextMenu) on(document, "contextmenu", (e) => { e.preventDefault(); this._emit("context_menu"); });
    on(document, "copy", (e) => { if (this.o.blockClipboard) e.preventDefault(); this._emit("copy"); });
    on(document, "cut", (e) => { if (this.o.blockClipboard) e.preventDefault(); this._emit("cut"); });
    on(document, "paste", (e) => {
      const len = (e.clipboardData?.getData("text") || "").length;
      if (this.o.blockClipboard) e.preventDefault();
      this._strike("paste", { len, q: this._currentQ(e.target) });
    });

    // --- keyboard -----------------------------------------------------------
    on(document, "keydown", (e) => {
      const k = e.key, mod = e.ctrlKey || e.metaKey;
      const combo =
        k === "F12" ||
        (mod && e.shiftKey && ["I", "J", "C", "K"].includes(k.toUpperCase())) ||
        (mod && ["u", "s", "p"].includes(k.toLowerCase())) ||
        (e.altKey && k.toLowerCase() === "d");
      if (combo) { e.preventDefault(); this._emit("shortcut_blocked", { key: describeKey(e) }); }
      if (k === "F5" || (mod && k.toLowerCase() === "r")) { e.preventDefault(); this._emit("shortcut_blocked", { key: "reload" }); }
    }, true);
    on(document, "keyup", (e) => { if (e.key === "PrintScreen") this._strike("print_screen"); });

    // --- mouse leaving the page -------------------------------------------
    on(document.documentElement, "mouseleave", () => this._emit("mouse_left"));

    // --- devtools heuristic (docked panel changes viewport vs outer size) ---
    this._dtTimer = setInterval(() => this._checkDevtools(), 1500);

    // --- resize / multiple displays ----------------------------------------
    let rt; on(window, "resize", () => { clearTimeout(rt); rt = setTimeout(() => this._emit("resize", { w: innerWidth, h: innerHeight }), 500); });
    if (window.screen && screen.isExtended) this._emit("multiple_displays");
    if (innerWidth < 700 || innerHeight < 450) this._emit("window_small", { w: innerWidth, h: innerHeight });

    // --- leaving the page --------------------------------------------------
    this._beforeUnload = (e) => { e.preventDefault(); e.returnValue = ""; return ""; };
    on(window, "beforeunload", this._beforeUnload);

    // Prevent text selection on questions (cosmetic friction only).
    document.body.classList.add("proctored");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    for (const [t, ev, fn, opts] of this._handlers) t.removeEventListener(ev, fn, opts);
    this._handlers = [];
    clearInterval(this._dtTimer);
    document.body.classList.remove("proctored");
  }

  /** Fullscreen must be requested from a user gesture (click). */
  async requestFullscreen() {
    const el = document.documentElement;
    try {
      if (!document.fullscreenElement) await (el.requestFullscreen?.({ navigationUI: "hide" }) || el.webkitRequestFullscreen?.());
      return true;
    } catch { return false; }
  }
  async exitFullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {} }
  get isFullscreen() { return !!document.fullscreenElement; }

  _checkDevtools() {
    // Docked DevTools shrink the viewport relative to the window chrome.
    const dw = window.outerWidth - window.innerWidth, dh = window.outerHeight - window.innerHeight;
    const open = dw > 200 || dh > 200;
    if (open && !this._devtoolsOpen) { this._devtoolsOpen = true; this._strike("devtools_suspected", { dw, dh }); }
    else if (!open) this._devtoolsOpen = false;
  }

  _currentQ(target) {
    const card = target?.closest?.("[data-qid]");
    return card ? card.dataset.qid : undefined;
  }

  _emit(type, detail) { if (this.active) this.o.onEvent?.(type, detail); }

  _strike(type, detail) {
    if (!this.active || this.paused) return;
    this._emit(type, detail);
    if (!this.o.strikeTypes || this.o.strikeTypes.has(type)) {
      // collapse bursts (blur + visibilitychange + fullscreenchange fire together)
      const now = Date.now();
      if (now - this._lastStrikeAt < 1500) return;
      this._lastStrikeAt = now;
      this.strikes++;
      this.o.onStrike?.(this.strikes, type);
    }
  }
}

function describeKey(e) {
  return [e.ctrlKey && "Ctrl", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && "Shift", e.key].filter(Boolean).join("+");
}

/** Detect that this tab was reloaded during the exam (sessionStorage survives reloads, not new tabs). */
export function detectReload(key) {
  const k = `uno_loaded_${key}`;
  const was = sessionStorage.getItem(k);
  sessionStorage.setItem(k, "1");
  return !!was;
}

export function clientFingerprint() {
  return {
    ua: navigator.userAgent.slice(0, 200),
    platform: navigator.platform || "",
    lang: navigator.language || "",
    screen: `${screen.width}x${screen.height}@${devicePixelRatio || 1}`,
    viewport: `${innerWidth}x${innerHeight}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    touch: navigator.maxTouchPoints > 0,
    cores: navigator.hardwareConcurrency || 0,
  };
}
