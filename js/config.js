// ============================================================================
//  Supabase configuration
//  ---------------------------------------------------------------------------
//  These two values are PUBLIC by design — they ship to every browser. All
//  security lives in the database: row level security plus SECURITY DEFINER
//  functions. See docs/SECURITY.md.
// ============================================================================
export const supabaseConfig = {
  url: "https://hczpsevbcdokhspkzplm.supabase.co",
  publishableKey: "sb_publishable_clfKNTKO6XzDVOAmI40iWA_NlxNUhGm",
};

export const siteConfig = {
  institutionName: "UnoExamination",
  tagline: "Secure online examinations",
  // Optional banner image shown above an exam (leave "" for none).
  bannerUrl: "",
  // Require Google sign-in for students (recommended with school accounts).
  googleOnlyForStudents: false,
};

export const isConfigured = () =>
  !supabaseConfig.url.includes("REPLACE_ME") && !!supabaseConfig.publishableKey;
