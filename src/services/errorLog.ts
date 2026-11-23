import { expoDb } from '../db/index';

/**
 * Silo's own crash and error log, kept on the phone (app_settings 'errorLog', newest last, 50 entries).
 * Nothing is sent anywhere: a bug report attaches it only when the user ticks the box.
 */
const KEY = 'errorLog';
const MAX_ENTRIES = 50;
const MAX_MESSAGE = 1200;

export interface ErrorLogEntry {
  at: number;
  kind: 'crash' | 'error' | 'render';
  message: string;
}

let memory: ErrorLogEntry[] | null = null;

function load(): ErrorLogEntry[] {
  if (memory) return memory;
  try {
    const row = expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [KEY]);
    const parsed = row?.value ? JSON.parse(row.value) : [];
    memory = Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.message === 'string') : [];
  } catch {
    memory = [];
  }
  return memory!;
}

function save(entries: ErrorLogEntry[]) {
  memory = entries;
  try {
    expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [KEY, JSON.stringify(entries)]);
  } catch {
    // Database not open (e.g. a crash during startup); the entry stays in memory for this session.
  }
}

/** Long digit runs (amounts, card or phone numbers) are masked so the log carries no figures. */
export function redactErrorText(text: string): string {
  return text.replace(/\d[\d.,]{3,}\d/g, '#').slice(0, MAX_MESSAGE);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? '').split('\n').slice(1, 6).join('\n');
    return `${error.name}: ${error.message}${stack ? `\n${stack}` : ''}`;
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function recordError(error: unknown, kind: ErrorLogEntry['kind'] = 'error', now = Date.now()): void {
  const entries = [...load(), { at: now, kind, message: redactErrorText(describe(error)) }];
  save(entries.slice(-MAX_ENTRIES));
}

export function getErrorLog(): ErrorLogEntry[] {
  return [...load()];
}

export function clearErrorLog(): void {
  save([]);
}

/** Plain text for a bug report, newest last. */
export function formatErrorLog(entries = getErrorLog(), limit = 15): string {
  return entries
    .slice(-limit)
    .map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.message}`)
    .join('\n');
}

let installed = false;

/** Records uncaught JS errors (then hands them to React Native's default handler). */
export function installGlobalErrorLogging(): void {
  if (installed) return;
  installed = true;
  const errorUtils = (globalThis as any).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    try {
      recordError(error, isFatal ? 'crash' : 'error');
    } catch {
      // never let logging break error handling
    }
    previous?.(error, isFatal);
  });
}

/** For tests. */
export function __resetErrorLogForTests() {
  memory = null;
  installed = false;
}
