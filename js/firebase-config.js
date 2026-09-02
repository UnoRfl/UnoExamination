// ============================================================================
//  Firebase web configuration
//  ---------------------------------------------------------------------------
//  Copy the values from Firebase Console -> Project settings -> Your apps
//  -> "SDK setup and configuration" -> Config.  These values are NOT secrets
//  (they ship to every browser); all security lives in firestore.rules.
// ============================================================================
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

// Shown on the sign-in page and exam header. Change freely.
export const siteConfig = {
  institutionName: "UnoExamination",
  tagline: "Secure online examinations",
  // Optional banner image URL shown at the top of exams (leave "" for none).
  bannerUrl: "",
  // If true, students must use Google sign-in (recommended for school accounts).
  googleOnlyForStudents: false,
  // Development only: talk to the local Firebase emulators (npm run emulators)
  // when the page is served from localhost.
  useEmulators: false,
};

export const isConfigured = () => firebaseConfig.projectId !== "REPLACE_ME";
