// Browser smoke test: every page must actually RENDER.
//
// This exists because three separate bugs shipped that a Node test cannot see:
// an SDK import that failed, a syntax error in one page, and an auth call that
// hung forever. All three looked identical to a user — a page stuck on
// "Loading…" with no error — and all three would have been caught here.
//
// It needs no credentials. The site is served locally and every request to the
// Supabase API is intercepted and answered with a stub, so the test is
// hermetic: no network, no project, no secrets.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/smoke/out");
const PORT = Number(process.env.SMOKE_PORT || 5099);
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let pass = 0, fail = 0;
const log = (...a) => console.log("[smoke]", ...a);
function check(label, ok, extra = "") {
  if (ok) { pass++; log("PASS", label); } else { fail++; log("FAIL", label, extra); }
}

// In CI Playwright manages its own browser. In a sandbox that ships one
// already, PLAYWRIGHT_CHROMIUM_PATH points at it.
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {});

/**
 * Answer Supabase REST/auth calls locally so the page can render without a
 * project. `session` decides whether the visitor looks signed in.
 */
const FAKE_USER = { id: "00000000-0000-4000-8000-000000000001", email: "prof@example.edu",
  aud: "authenticated", role: "authenticated", email_confirmed_at: "2024-01-01T00:00:00Z" };

async function stubSupabase(page, { session = null, rest = {} } = {}) {
  await page.route("**/auth/v1/**", (route) => {
    const url = route.request().url();
    if (url.includes("/user")) {
      return route.fulfill({ status: session ? 200 : 400, contentType: "application/json",
        body: JSON.stringify(session ? session.user : { error: "invalid" }) });
    }
    if (url.includes("/token")) {
      return route.fulfill({ status: session ? 200 : 400, contentType: "application/json",
        body: JSON.stringify(session || { error: "invalid" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/rest/v1/**", (route) => {
    const table = new URL(route.request().url()).pathname.replace(/^.*\/rest\/v1\//, "").split("?")[0];
    const body = Object.prototype.hasOwnProperty.call(rest, table) ? rest[table] : [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/realtime/v1/**", (route) => route.abort());
}

/** A session object shaped the way supabase-js persists it in localStorage. */
function fakeSession() {
  return { access_token: "stub.access.token", refresh_token: "stub-refresh",
    token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: FAKE_USER };
}

async function visit(label, urlPath, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // A stubbed API legitimately returns 4xx; that is not a page defect.
    if (/Failed to load resource|net::ERR|400|401|404/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith(BASE)) errors.push(`asset failed: ${u.replace(BASE, "")} ${r.failure()?.errorText || ""}`);
  });

  await stubSupabase(page, opts);
  if (opts.session) {
    // supabase-js reads its session straight out of localStorage on boot.
    await page.addInitScript(([key, sess]) => {
      try { localStorage.setItem(key, JSON.stringify(sess)); } catch {}
    }, [opts.storageKey, opts.session]);
  }
  await page.goto(BASE + urlPath, { waitUntil: "load", timeout: 30000 });

  // The whole point: something other than the placeholder must appear, and it
  // must not be the watchdog's error panel.
  let rendered = false;
  try {
    await page.waitForFunction(() => window.__unoRendered === true, null, { timeout: 20000 });
    rendered = true;
  } catch { /* fall through to the report below */ }

  const bootError = await page.locator("#bootError").count();
  const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const stillLoading = /^\s*Loading/.test(bodyText) || bodyText.includes("Loading…");

  check(`${label}: rendered`, rendered, rendered ? "" : `body was: "${bodyText.slice(0, 120)}"`);
  check(`${label}: no watchdog error panel`, bootError === 0);
  check(`${label}: placeholder replaced`, !stillLoading, stillLoading ? "still showing Loading…" : "");
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));

  if (!rendered || bootError || errors.length) {
    fs.mkdirSync(OUT, { recursive: true });
    const shot = path.join(OUT, label.replace(/\W+/g, "-") + ".png");
    await page.screenshot({ path: shot, fullPage: true });
    log(`      screenshot: ${path.relative(ROOT, shot)}`);
  }
  return { page, ctx, errors };
}

try {
  // --- the pages a visitor can reach signed out
  const home = await visit("home (signed out)", "/index.html");
  check("home: shows the sign-in form",
    (await home.page.locator("input[name=email]").count()) > 0);
  check("home: shows the exam-code box",
    (await home.page.locator("form").count()) > 0);
  await home.ctx.close();

  const prof = await visit("professor (signed out)", "/professor.html");
  check("professor: shows the sign-in form",
    (await prof.page.locator("input[name=email]").count()) > 0);
  await prof.ctx.close();

  const setup = await visit("setup check", "/setup.html");
  check("setup: ran its checks",
    (await setup.page.locator(".check-row").count()) > 0,
    `${await setup.page.locator(".check-row").count()} rows`);
  await setup.ctx.close();

  const noCode = await visit("exam without a code", "/exam.html");
  check("exam: explains the missing code",
    (await noCode.page.locator("body").innerText()).includes("No exam code"));
  await noCode.ctx.close();

  const withCode = await visit("exam with a code (signed out)", "/exam.html?code=ABC123");
  check("exam: asks the student to sign in",
    (await withCode.page.locator("input[name=email]").count()) > 0);
  await withCode.ctx.close();

  // --- the exam editor, signed in as a professor. This is the densest screen in
  //     the app and the only one a signed-out smoke test never reaches.
  const cfg = fs.readFileSync(path.join(ROOT, "js/config.js"), "utf8");
  const ref = cfg.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)[1];
  const editor = await visit("exam editor (professor)", "/professor.html#new", {
    session: fakeSession(),
    storageKey: `sb-${ref}-auth-token`,
    rest: { profiles: [{ id: FAKE_USER.id, email: FAKE_USER.email, role: "professor",
                         display_name: "Prof Test", student_id: null, section: null }] },
  });
  const ed = editor.page;
  check("editor: offers the rule presets",
    (await ed.locator(".preset").count()) === 3, `${await ed.locator(".preset").count()} presets`);
  check("editor: settings are grouped, not one flat wall",
    (await ed.locator("details.group").count()) >= 4);
  check("editor: every toggle is a labelled switch",
    (await ed.locator(".switch").count()) === 7, `${await ed.locator(".switch").count()} switches`);
  // the old flat grid of bare checkboxes must be gone from the settings card
  check("editor: no bare checkbox grid survives in the settings",
    (await ed.locator(".card:has(.preset) label.check").count()) === 0);
  check("editor: shows a plain-language summary of the settings",
    (await ed.locator(".summary-line").innerText()).includes("min"));
  check("editor: a preset marks itself as selected",
    (await ed.locator('.preset[aria-pressed="true"]').count()) >= 0);
  check("editor: empty question list explains itself",
    (await ed.locator(".q-empty").innerText()).toLowerCase().includes("no questions"));

  // add a question, then confirm it collapses to a single row
  await ed.getByRole("button", { name: "+ Multiple choice" }).click();
  await ed.getByRole("button", { name: "+ True / False" }).click();
  check("editor: added questions appear as collapsed rows",
    (await ed.locator(".q-row").count()) === 2, `${await ed.locator(".q-row").count()} rows`);
  check("editor: an unfinished question is flagged",
    (await ed.locator(".q-flag.warn").count()) === 2);
  check("editor: at most one question is expanded",
    (await ed.locator(".q-body").count()) <= 1);
  await ed.locator(".q-row").first().click();
  check("editor: clicking a row opens exactly one editor",
    (await ed.locator(".q-body").count()) === 1);
  await ed.locator(".q-body textarea").first().fill("What is defence in depth?");
  check("editor: typing updates the collapsed row live",
    (await ed.locator(".q-row").first().innerText()).includes("defence in depth"));
  await ed.locator(".q-row").nth(1).click();
  check("editor: opening another row closes the first",
    (await ed.locator(".q-body").count()) === 1);

  // presets must actually move the switches
  await ed.locator(".preset").first().click();
  check("editor: the Practice preset turns fullscreen off",
    (await ed.locator(".switch input").first().isChecked()) === false);
  await ed.locator(".preset").nth(2).click();
  check("editor: the Strict preset turns fullscreen on",
    (await ed.locator(".switch input").first().isChecked()) === true);
  check("editor: the applied preset is highlighted",
    (await ed.locator('.preset[aria-pressed="true"]').count()) === 1);

  // the search box must narrow the list
  await ed.locator(".q-toolbar input").fill("defence");
  check("editor: search narrows the question list",
    (await ed.locator(".q-row").count()) === 1);
  await ed.locator(".q-toolbar input").fill("");
  check("editor: clearing the search restores every question",
    (await ed.locator(".q-row").count()) === 2);
  await editor.ctx.close();

  // --- the failure this test exists for: a hung auth call must not blank the page
  const hung = await browser.newContext();
  const hp = await hung.newPage();
  await hp.route("**/auth/v1/**", () => { /* never answer */ });
  await hp.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, body: "[]", contentType: "application/json" }));
  await hp.goto(BASE + "/index.html", { waitUntil: "load" });
  let recovered = false;
  try {
    await hp.waitForFunction(() => window.__unoRendered === true, null, { timeout: 20000 });
    recovered = true;
  } catch {}
  check("home still renders when the auth API never answers", recovered);
  await hung.close();

  // --- and a page whose script is missing must say so rather than hang
  const broken = await browser.newContext();
  const bp = await broken.newPage();
  await bp.route("**/js/index.js", (r) => r.abort());
  await bp.goto(BASE + "/index.html", { waitUntil: "load" });
  const shown = await bp.locator("#bootError").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("a missing script produces a visible error, not a blank page", shown);
  await broken.close();
} catch (e) {
  fail++;
  log("ERROR", e.message);
} finally {
  await browser.close();
  server.close();
}

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
