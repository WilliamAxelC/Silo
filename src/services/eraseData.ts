import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

import { expoDb, rebuildFtsIndex, runMigrations } from '../db/index';
import { deleteAllAutoBackups } from './autoBackup';

/** Settings kept through an erase: they describe the downloaded AI model, which is not personal data. */
const KEEP_SETTING_KEYS = ['activeModelId', 'aiWifiOnlyDownload'];
const SECURE_KEYS = ['externalApiKey', 'externalApiCustomHeaders'];
const FTS_SHADOW = /_(data|idx|docsize|config|content)$/;

/**
 * Wipes everything Silo stores about the user on this phone: all records, settings, receipt photos,
 * automatic backups, the error log and saved API credentials. The app then behaves like a fresh install
 * (welcome sheet included). The downloaded AI model is kept.
 */
export async function eraseAllData(): Promise<void> {
  const kept = expoDb.getAllSync<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN (${KEEP_SETTING_KEYS.map(() => '?').join(', ')});`,
    KEEP_SETTING_KEYS,
  );
  const tables = expoDb
    .getAllSync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';`)
    .map((r) => r.name)
    .filter((name) => !(name.includes('_fts') && FTS_SHADOW.test(name)));

  expoDb.execSync('PRAGMA foreign_keys = OFF;');
  try {
    expoDb.withTransactionSync(() => {
      for (const table of tables) {
        expoDb.execSync(`DELETE FROM "${table.replace(/"/g, '')}";`);
      }
      for (const row of kept) {
        expoDb.runSync('INSERT INTO app_settings (key, value) VALUES (?, ?);', [row.key, row.value]);
      }
    });
  } finally {
    expoDb.execSync('PRAGMA foreign_keys = ON;');
  }
  // Re-seed the default account, categories and settings exactly as on first launch.
  expoDb.execSync('PRAGMA user_version = 0;');
  runMigrations(expoDb);
  rebuildFtsIndex(expoDb);
  try {
    expoDb.execSync('VACUUM;');
  } catch {
    // VACUUM can fail inside an open transaction elsewhere; the rows are gone either way.
  }

  const docs = FileSystem.documentDirectory ?? '';
  await Promise.all([
    FileSystem.deleteAsync(`${docs}receipts/`, { idempotent: true }).catch(() => undefined),
    deleteAllAutoBackups(),
    FileSystem.deleteAsync(`${FileSystem.cacheDirectory ?? ''}backups/`, { idempotent: true }).catch(() => undefined),
    ...SECURE_KEYS.map((key) => SecureStore.deleteItemAsync(key).catch(() => undefined)),
  ]);
}
