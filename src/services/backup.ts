import * as FileSystem from 'expo-file-system/legacy';
import { backupDatabaseAsync, openDatabaseAsync } from 'expo-sqlite';

import { expoDb, rebuildFtsIndex, runMigrations } from '../db/index';

// Restored in this order so foreign keys always point at rows that already exist.
const RESTORE_TABLES = [
  'wallets',
  'categories',
  'app_settings',
  'budgets',
  'transactions',
  'transaction_items',
  'shared_splits',
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
  await FileSystem.deleteAsync(`${dir}${fileName}`, { idempotent: true });

  const dest = await openDatabaseAsync(fileName, undefined, plainPath(dir));
  try {
    await backupDatabaseAsync({ sourceDatabase: expoDb, destDatabase: dest });
  } finally {
    await dest.closeAsync();
  }
  return `${dir}${fileName}`;
}

/**
 * Replaces all data with the contents of a Silo backup file. Runs in one transaction: a bad file leaves
 * the current data untouched. Columns are matched by name, so backups from older app versions restore too.
 */
export async function restoreBackupFile(sourceUri: string): Promise<{ transactions: number }> {
  const workCopy = `${FileSystem.cacheDirectory ?? ''}restore-${Date.now()}.db`;
  await FileSystem.copyAsync({ from: sourceUri, to: workCopy });

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
