// Single place that loads the Firebase SDK (from Google's CDN, no build step)
// and re-exports everything the rest of the app needs.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut, updateProfile,
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, onSnapshot, writeBatch,
  serverTimestamp, increment, deleteField, Timestamp, runTransaction,
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { firebaseConfig, siteConfig, isConfigured } from "./firebase-config.js";

if (!isConfigured()) {
  document.addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.className = "setup-banner";
    b.innerHTML = "<strong>Setup required:</strong> edit <code>js/firebase-config.js</code> " +
      "with your Firebase project settings. See README.md.";
    document.body.prepend(b);
  });
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (siteConfig.useEmulators && isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut, updateProfile,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, onSnapshot, writeBatch,
  serverTimestamp, increment, deleteField, Timestamp, runTransaction,
};
