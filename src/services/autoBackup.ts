import * as FileSystem from 'expo-file-system/legacy';

import { expoDb } from '../db/index';
import { createBackupFile } from './backup';
import { recordError } from './errorLog';

/**
 * Daily automatic backups kept in Silo's private storage (last 7). They protect against mistakes and bad
 * updates on this phone; for a lost phone the user still exports a backup elsewhere.
 */
export const AUTO_BACKUP_KEEP = 7;
const ENABLED_KEY = 'autoBackupEnabled';
const FILE_RE = /^silo-auto-(\d{4}-\d{2}-\d{2})\.db$/;

export interface AutoBackup {
  uri: string;
  date: string;
  sizeBytes: number;
}

export function autoBackupDir(): string {
  return `${FileSystem.documentDirectory ?? ''}auto-backups/`;
}

function localDateKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function isAutoBackupEnabled(): boolean {
  try {
    return expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [ENABLED_KEY])?.value !== 'false';
  } catch {
    return true;
  }
}

export function setAutoBackupEnabled(enabled: boolean): void {
  expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [ENABLED_KEY, enabled ? 'true' : 'false']);
}

export async function listAutoBackups(): Promise<AutoBackup[]> {
  const dir = autoBackupDir();
  let names: string[] = [];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return [];
  }
  const out: AutoBackup[] = [];
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match) continue;
    let sizeBytes = 0;
    try {
      const info = await FileSystem.getInfoAsync(`${dir}${name}`);
      sizeBytes = info.exists ? ((info as { size?: number }).size ?? 0) : 0;
    } catch {
      // size is informational only
    }
    out.push({ uri: `${dir}${name}`, date: match[1], sizeBytes });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

let running: Promise<AutoBackup | null> | null = null;

/**
 * Makes today's backup unless one exists (or backups are off), then keeps only the newest AUTO_BACKUP_KEEP.
 * Never throws.
 */
export function runAutoBackupIfDue(now = new Date(), options: { force?: boolean } = {}): Promise<AutoBackup | null> {
  if (running) return running;
  const job = (async () => {
    try {
      if (!options.force && !isAutoBackupEnabled()) return null;
      const date = localDateKey(now);
      const existing = await listAutoBackups();
      const today = existing.find((b) => b.date === date);
      if (today && !options.force) return today;

      const dir = autoBackupDir();
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const temp = await createBackupFile(now);
      const target = `${dir}silo-auto-${date}.db`;
      await FileSystem.deleteAsync(target, { idempotent: true });
      await FileSystem.moveAsync({ from: temp, to: target });

      const all = await listAutoBackups();
      for (const old of all.slice(AUTO_BACKUP_KEEP)) {
        await FileSystem.deleteAsync(old.uri, { idempotent: true });
      }
      return all.find((b) => b.date === date) ?? null;
    } catch (error) {
      recordError(error, 'error');
      return null;
    }
  })();
  // Cleared after the job settles. (Clearing inside the job ran before this assignment when it returned
  // without awaiting, leaving a stale finished job that every later call, even a forced one, returned.)
  running = job;
  void job.finally(() => {
    if (running === job) running = null;
  });
  return job;
}

export async function deleteAllAutoBackups(): Promise<void> {
  await FileSystem.deleteAsync(autoBackupDir(), { idempotent: true }).catch(() => undefined);
}
