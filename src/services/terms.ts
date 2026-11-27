import { create } from 'zustand';

import { expoDb } from '../db/index';

/**
 * Terms of Service acceptance. Under Indonesian consumer law changed terms bind only once accepted, so the
 * app records which version the user agreed to and asks again when TERMS_VERSION changes.
 */
export const TERMS_VERSION = '2026-11-28';
export const TERMS_URL = 'https://cuang.dev/projects/silo/terms/';
export const PRIVACY_URL = 'https://cuang.dev/projects/silo/privacy/';
const KEY = 'termsAccepted';

interface Accepted {
  version: string;
  at: number;
}

function read(): Accepted | null {
  try {
    const raw = expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [KEY])?.value;
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.version === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

interface TermsState {
  accepted: Accepted | null;
  loaded: boolean;
  /** Hidden for this session after "Later" on changed terms (first acceptance cannot be postponed). */
  postponed: boolean;
  load: () => void;
  accept: (now?: number) => void;
  postpone: () => void;
}

export const useTermsStore = create<TermsState>((set) => ({
  accepted: null,
  loaded: false,
  postponed: false,
  load: () => set({ accepted: read(), loaded: true }),
  accept: (now = Date.now()) => {
    const value: Accepted = { version: TERMS_VERSION, at: now };
    expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [KEY, JSON.stringify(value)]);
    set({ accepted: value, postponed: false });
  },
  postpone: () => set({ postponed: true }),
}));

/** 'first' = never accepted (must agree to use Silo); 'changed' = agreed to an older version. */
export function termsPrompt(state: Pick<TermsState, 'accepted' | 'loaded' | 'postponed'>): 'none' | 'first' | 'changed' {
  if (!state.loaded) return 'none';
  if (!state.accepted) return 'first';
  if (state.accepted.version !== TERMS_VERSION && !state.postponed) return 'changed';
  return 'none';
}
