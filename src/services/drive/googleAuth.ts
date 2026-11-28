import { expoDb } from '../../db/index';

/**
 * Google sign-in for Drive sync. Scope `drive.file`: Silo can only see and change files it created itself
 * (its "Silo" folder), never anything else in the user's Drive. Tokens are held by Google Play services;
 * Silo asks for a fresh access token for each sync and never stores it.
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ACCOUNT_KEY = 'driveAccount';

type GoogleSigninModule = typeof import('@react-native-google-signin/google-signin');

let cached: GoogleSigninModule | null | undefined;
let configured = false;

/** Lazy so screens and tests load without the native module. */
function lib(): GoogleSigninModule | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('@react-native-google-signin/google-signin') as GoogleSigninModule;
  } catch {
    cached = null;
  }
  return cached;
}

function signin() {
  const m = lib();
  if (!m) throw new Error('Google sign-in is not available on this device.');
  if (!configured) {
    m.GoogleSignin.configure({ scopes: [DRIVE_FILE_SCOPE] });
    configured = true;
  }
  return m;
}

export function getConnectedAccount(): string | null {
  try {
    return expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [ACCOUNT_KEY])?.value || null;
  } catch {
    return null;
  }
}

function setConnectedAccount(email: string | null) {
  if (email) expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [ACCOUNT_KEY, email]);
  else expoDb.runSync('DELETE FROM app_settings WHERE key = ?;', [ACCOUNT_KEY]);
}

/**
 * Google answers DEVELOPER_ERROR (code 10) when its Cloud project has no Android OAuth client for this package
 * name plus signing certificate. The library text only makes sense to developers, so say what it means.
 */
export function explainSignInError(error: unknown): unknown {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? '');
  const message = String(e?.message ?? '');
  if (code === '10' || code === 'DEVELOPER_ERROR' || message.startsWith('DEVELOPER_ERROR')) {
    return new Error(
      "Google Drive isn't set up for this copy of Silo yet, so Google refused the sign-in. Your records are safe. Use Back Up All Data for now."
    );
  }
  return error;
}

/** Opens Google's account picker. Resolves the email, or null when the user backs out. */
export async function connectDrive(): Promise<string | null> {
  const m = signin();
  await m.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  let result: any;
  try {
    result = await m.GoogleSignin.signIn();
  } catch (error) {
    throw explainSignInError(error);
  }
  if (result?.type === 'cancelled') return null;
  const user = result?.data?.user ?? result?.user;
  const granted: string[] = result?.data?.scopes ?? result?.scopes ?? [];
  if (granted.length && !granted.includes(DRIVE_FILE_SCOPE)) {
    const added: any = await m.GoogleSignin.addScopes({ scopes: [DRIVE_FILE_SCOPE] });
    if (!added) throw new Error('Drive access was not granted.');
  }
  const email = String(user?.email ?? '');
  setConnectedAccount(email || 'Google account');
  return email || 'Google account';
}

/** A short-lived access token for the Drive API (refreshes silently). */
export async function getDriveAccessToken(): Promise<string> {
  const m = signin();
  if (!m.GoogleSignin.hasPreviousSignIn()) throw new Error('Not connected to Google Drive.');
  await m.GoogleSignin.signInSilently();
  const tokens = await m.GoogleSignin.getTokens();
  if (!tokens?.accessToken) throw new Error('Google did not return an access token.');
  return tokens.accessToken;
}

/** Revokes Silo's Drive access and forgets the account. Files already on Drive stay there. */
export async function disconnectDrive(): Promise<void> {
  const m = lib();
  try {
    if (m) {
      signin();
      await m.GoogleSignin.revokeAccess().catch(() => undefined);
      await m.GoogleSignin.signOut().catch(() => undefined);
    }
  } finally {
    setConnectedAccount(null);
  }
}

/** For tests. */
export function __setGoogleSigninForTests(value: GoogleSigninModule | null) {
  cached = value;
  configured = false;
}
