import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithRedirect, signOut } from 'firebase/auth';
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

export function signInStaffWithGoogle() {
  if (!firebaseAuth) throw new Error('Firebase Authentication is not configured.');
  return signInWithRedirect(firebaseAuth, googleProvider);
}

export async function getFirebaseUser() {
  if (!firebaseAuth) return null;
  return firebaseAuth.currentUser;
}

export function signOutStaff() {
  return firebaseAuth ? signOut(firebaseAuth) : Promise.resolve();
}

export function watchFirebaseUser(callback) {
  return firebaseAuth ? onAuthStateChanged(firebaseAuth, callback) : () => {};
}
