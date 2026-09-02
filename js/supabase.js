// Single place that loads the Supabase SDK and exposes the client.
// No build step: the SDK is an ES module from jsDelivr.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm";
import { supabaseConfig, isConfigured } from "./config.js";

if (!isConfigured()) {
  document.addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.className = "setup-banner";
    b.innerHTML = "<strong>Setup required:</strong> edit <code>js/config.js</code> " +
      "with your Supabase project URL and publishable key. See README.md.";
    document.body.prepend(b);
  });
}

export const sb = createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Unwrap a PostgREST response, turning an error into a throw. */
export function unwrap({ data, error }) {
  if (error) throw asError(error);
  return data;
}

/** Turn a Supabase/Postgres error into something worth showing a human. */
export function asError(error) {
  const raw = error?.message || String(error);
  // Our RPCs raise readable messages; RLS denials are terse, so translate.
  const map = [
    [/permission denied|insufficient|42501/i, "The server refused that action."],
    [/duplicate key|already exists/i, "That already exists."],
    [/violates row-level security/i, "The server refused that write."],
    [/JWT|token is expired/i, "Your session expired — please sign in again."],
    [/Failed to fetch|NetworkError/i, "Network error. Check your connection."],
  ];
  const friendly = map.find(([re]) => re.test(raw));
  const e = new Error(cleanPgMessage(raw));
  e.raw = raw;
  e.friendly = friendly ? friendly[1] : e.message;
  return e;
}

function cleanPgMessage(m) {
  return String(m)
    .replace(/^.*?(?:ERROR|error):\s*/i, "")
    .replace(/\s*using errcode.*$/i, "")
    .replace(/^[0-9A-Z]{5}:\s*/, "")
    .trim() || "Something went wrong.";
}
