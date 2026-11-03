// DEPRECATED (2026-10-30, see DEPRECATIONS.md): the Firebase channel is no
// longer part of the supported product. The AR tabletop keeps the game in
// the browser-local store and phones join over the AR relay; this module is
// kept only for the legacy two-browser game (/), and will be removed with
// it (the /hand controller was retired on 2026-11-03).
// The Firebase SDK is loaded on demand inside initializeFirebase(): pages
// that run on the browser-local store (the AR tabletop by default) must not
// pull it into their bundle or need an emulator to be running.
import type { Auth } from 'firebase/auth';
import type { Firestore, FirestoreSettings } from 'firebase/firestore';
import { readFirebaseConfig } from './firebase-config';

export interface FirebaseServices {
  auth: Auth;
  db: Firestore;
}

let services: FirebaseServices | undefined;

type BrowserIdentity = Pick<Navigator, 'maxTouchPoints' | 'platform' | 'userAgent'>;

export function shouldUseFetchStreams(browser: BrowserIdentity | undefined): boolean {
  if (!browser) return true;
  const isIOS = /iPad|iPhone|iPod/.test(browser.userAgent) ||
    (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
  const isMacSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(browser.userAgent);
  return !(isIOS || isMacSafari);
}

function firestoreSettings(): FirestoreSettings & { useFetchStreams: boolean } {
  // WebKit in Safari 26.4 and 26.5 can hold the final Firestore Fetch Streams
  // frame until a later keep-alive. Use XHR on WebKit until the upstream issue
  // is fixed: https://github.com/firebase/firebase-js-sdk/issues/9789
  return {
    useFetchStreams: shouldUseFetchStreams(
      typeof navigator === 'undefined' ? undefined : navigator
    )
  };
}

export async function initializeFirebase(): Promise<FirebaseServices> {
  if (services) return services;

  const [{ initializeApp }, { connectAuthEmulator, getAuth, signInAnonymously }, { connectFirestoreEmulator, initializeFirestore }] =
    await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
  const config = readFirebaseConfig(import.meta.env);
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = initializeFirestore(app, firestoreSettings());

  if (import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
    connectAuthEmulator(
      auth,
      `http://${import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1'}:${
        import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT ?? '9200'
      }`,
      { disableWarnings: true }
    );
    connectFirestoreEmulator(
      db,
      import.meta.env.VITE_FIRESTORE_EMULATOR_HOST ?? '127.0.0.1',
      Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT ?? '8186')
    );
  }

  await signInAnonymously(auth);
  services = { auth, db };
  return services;
}
