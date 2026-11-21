import * as FileSystem from 'expo-file-system/legacy';
import { backupDatabaseAsync, openDatabaseAsync } from 'expo-sqlite';

import { expoDb, rebuildFtsIndex, runMigrations } from '../db/index';

/**
 * MIME types accepted when picking a Silo SQLite backup file (.db / .sqlite / .silo).
 * Excludes images/media so Android DocumentsUI filters out receipt photos.
 */
export const BACKUP_PICKER_MIME_TYPES: string[] = [
  'application/octet-stream',
  'application/x-sqlite3',
  'application/vnd.sqlite3',
];

const NON_BACKUP_MEDIA_EXT_RE = /\.(?:jpe?g|png|gif|webp|heic|heif|bmp|svg|mp4|mov|avi|mkv|mp3|wav|pdf|csv|txt)$/i;

/**
 * Rejects obvious non-backup file extensions (such as receipt photos) in case a third-party
 * Android file manager ignores the DocumentPicker MIME filter.
 */
export function isLikelyBackupFile(fileName?: string | null): boolean {
  if (!fileName || !fileName.trim()) return true;
  return !NON_BACKUP_MEDIA_EXT_RE.test(fileName.trim());
}

// Restored in this order so foreign keys always point at rows that already exist.
const RESTORE_TABLES = [
  'wallets',
  'categories',
  'app_settings',
  'budgets',
  'transactions',
  'transaction_items',
  'shared_splits',
  'recurring_rules',
  'transaction_templates',
] as const;
// receipt_queue is left alone: queued photos live on the old device.

function plainPath(uri: string): string {
  return decodeURI(uri.replace(/^file:\/\//, ''));
}

/**
 * Writes a consistent copy of the whole Silo database (all tables, current WAL included) to the cache
 * directory and returns its file URI, ready to share or save.
 */
export async function createBackupFile(now = new Date()): Promise<string> {
  const dir = `${FileSystem.cacheDirectory ?? ''}backups/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const fileName = `silo-backup-${now.toISOString().slice(0, 10)}.db`;
  const targetUri = `${dir}${fileName}`;
  await FileSystem.deleteAsync(targetUri, { idempotent: true });

  const dest = await openDatabaseAsync(fileName, undefined, plainPath(dir));
  let failed = false;
  try {
    await backupDatabaseAsync({ sourceDatabase: expoDb, destDatabase: dest });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await dest.closeAsync().catch(() => undefined);
    if (failed) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
      await FileSystem.deleteAsync(`${targetUri}-wal`, { idempotent: true }).catch(() => undefined);
      await FileSystem.deleteAsync(`${targetUri}-shm`, { idempotent: true }).catch(() => undefined);
    }
  }
  return targetUri;
}

/**
 * Replaces all data with the contents of a Silo backup file. Runs in one transaction: a bad file leaves
 * the current data untouched. Columns are matched by name, so backups from older app versions restore too.
 */
export async function restoreBackupFile(sourceUri: string): Promise<{ transactions: number }> {
  const workCopy = `${FileSystem.cacheDirectory ?? ''}restore-${Date.now()}.db`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: workCopy });
  } catch (error) {
    await FileSystem.deleteAsync(workCopy, { idempotent: true }).catch(() => undefined);
    throw error;
  }

  try {
    expoDb.runSync('ATTACH DATABASE ? AS backup;', [plainPath(workCopy)]);
  } catch {
    await FileSystem.deleteAsync(workCopy, { idempotent: true });
    throw new Error('This file is not a Silo backup.');
  }

  try {
    const backupTables = new Set(
      expoDb
        .getAllSync<{ name: string }>(`SELECT name FROM backup.sqlite_master WHERE type = 'table';`)
        .map((row) => row.name),
    );
    if (!backupTables.has('transactions') || !backupTables.has('categories')) {
      throw new Error('This file is not a Silo backup.');
    }

    expoDb.execSync('PRAGMA foreign_keys = OFF;');
    expoDb.withTransactionSync(() => {
      for (const table of [...RESTORE_TABLES].reverse()) {
        expoDb.execSync(`DELETE FROM main.${table};`);
      }
      for (const table of RESTORE_TABLES) {
        if (!backupTables.has(table)) continue;
        const current = new Set(expoDb.getAllSync<{ name: string }>(`PRAGMA main.table_info(${table});`).map((c) => c.name));
        const columns = expoDb
          .getAllSync<{ name: string }>(`PRAGMA backup.table_info(${table});`)
          .map((c) => c.name)
          .filter((name) => current.has(name));
        if (columns.length === 0) continue;
        const list = columns.map((c) => `"${c}"`).join(', ');
        expoDb.execSync(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM backup.${table};`);
      }
      const brokenLinks = expoDb.getAllSync('PRAGMA main.foreign_key_check;');
      if (brokenLinks.length > 0) {
        throw new Error('The backup is damaged (records point at missing data).');
      }
    });
  } finally {
    expoDb.execSync('PRAGMA foreign_keys = ON;');
    try {
      expoDb.execSync('DETACH DATABASE backup;');
    } catch {
      // already detached
    }
    await FileSystem.deleteAsync(workCopy, { idempotent: true });
  }

  // Older backups may predate newer columns/tables' defaults or seeded categories.
  expoDb.execSync('PRAGMA user_version = 0;');
  runMigrations(expoDb);
  rebuildFtsIndex(expoDb);

  const count = expoDb.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions;');
  return { transactions: count?.n ?? 0 };
}
