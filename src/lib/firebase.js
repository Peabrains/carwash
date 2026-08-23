import { initializeApp, getApps } from 'firebase/app';
import { browserLocalPersistence, getAuth, GoogleAuthProvider, getRedirectResult, onAuthStateChanged, setPersistence, signInWithRedirect, signOut } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseConfigured = Object.values(firebaseConfig).every(Boolean);
export const firebaseApp = firebaseConfigured
  ? (getApps()[0] ?? initializeApp(firebaseConfig))
  : null;
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
export const googleProvider = new GoogleAuthProvider();
export const firestore = firebaseApp ? getFirestore(firebaseApp) : null;
export const firebaseStorage = firebaseApp ? getStorage(firebaseApp) : null;

export async function signInStaffWithGoogle() {
  if (!firebaseAuth) throw new Error('Firebase Authentication is not configured.');
  await setPersistence(firebaseAuth, browserLocalPersistence);
  // Use same-tab redirect as the primary flow. Popup authentication is
  // routinely blocked or silently discarded by in-app browsers and Safari.
  await signInWithRedirect(firebaseAuth, googleProvider);
  return null;
}

export async function getFirebaseUser() {
  if (!firebaseAuth) return null;
  return firebaseAuth.currentUser ?? await waitForFirebaseUser();
}

function waitForFirebaseUser(timeoutMs = 8000) {
  if (!firebaseAuth) return Promise.resolve(null);
  if (firebaseAuth.currentUser) return Promise.resolve(firebaseAuth.currentUser);
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe = () => {};
    let timer;
    const finish = user => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(user ?? null);
    };
    // Firebase emits an initial null state while it restores persistence.
    // Do not treat that transient state as a completed login attempt.
    unsubscribe = onAuthStateChanged(firebaseAuth, user => {
      if (user) finish(user);
    });
    timer = setTimeout(() => finish(firebaseAuth.currentUser), timeoutMs);
  });
}

export async function finishGoogleRedirect() {
  if (!firebaseAuth) return null;
  const result = await getRedirectResult(firebaseAuth);
  return result?.user ?? await waitForFirebaseUser();
}

export function signOutStaff() {
  return firebaseAuth ? signOut(firebaseAuth) : Promise.resolve();
}

export function watchFirebaseUser(callback) {
  return firebaseAuth ? onAuthStateChanged(firebaseAuth, callback) : () => {};
}
