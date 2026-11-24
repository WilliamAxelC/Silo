import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-backup-'));

function wrap(raw: DatabaseSync) {
  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: (sql: string, params: any[] = []) => raw.prepare(sql).all(...params),
    getFirstSync: (sql: string, params: any[] = []) => raw.prepare(sql).get(...params) ?? null,
    runSync: (sql: string, params: any[] = []) => raw.prepare(sql).run(...params),
    withTransactionSync: (cb: () => void) => {
      raw.exec('BEGIN;');
      try {
        cb();
        raw.exec('COMMIT;');
      } catch (error) {
        raw.exec('ROLLBACK;');
        throw error;
      }
    },
  };
}

let mainRaw: DatabaseSync;
let mockMain: ReturnType<typeof wrap>;
// The db/index mock reads the current test database through a global (set in beforeEach).
const setMain = (db: ReturnType<typeof wrap>) => {
  mockMain = db;
  (globalThis as any).__siloTestDb = db;
};

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  // defineProperty, not an object-literal getter: Babel's object-spread helper would read the getter once.
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});
jest.mock('expo-file-system/legacy', () => {
  const nodeFs = require('fs');
  const strip = (uri: string) => uri.replace(/^file:\/\//, '');
  return {
    get cacheDirectory() {
      return `file://${mockTmp}/`;
    },
    makeDirectoryAsync: jest.fn(async () => undefined),
    copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => nodeFs.copyFileSync(strip(from), strip(to))),
    deleteAsync: jest.fn(async (uri: string) => nodeFs.rmSync(strip(uri), { force: true })),
  };
});

import { runMigrations } from '../../db/index';
import { RESTORE_TABLES, restoreBackupFile } from '../backup';

function makeDb(file: string) {
  const raw = new DatabaseSync(file);
  const db = wrap(raw);
  runMigrations(db as any);
  return { raw, db };
}

describe('restoreBackupFile', () => {
  beforeEach(() => {
    const main = makeDb(':memory:');
    mainRaw = main.raw;
    setMain(main.db);
    mockMain.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (1, 'Current data', -1, 'expense', 1);`,
    );
  });

  afterEach(() => mainRaw.close());

  it('replaces all data with the backup and keeps search working', async () => {
    const file = path.join(mockTmp, 'good.db');
    const { raw, db } = makeDb(file);
    db.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date, note) VALUES (1, 'Kopi Kenangan', -38500, 'expense', 2, 'latte');`,
    );
    const txId = Number(db.getFirstSync('SELECT id FROM transactions;')!.id);
    db.runSync(`INSERT INTO transaction_items (transaction_id, category, amount) VALUES (?, 'Food & Dining', -38500);`, [txId]);
    db.runSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currencyCode', 'USD');`);
    db.runSync(
      `INSERT INTO transaction_templates (name, template_json, created_at) VALUES (?, ?, ?);`,
      [
        'Daily Coffee',
        JSON.stringify({
          merchantName: 'Kopi Kenangan',
          totalAmount: -38500,
          type: 'expense',
          category: 'Food & Dining',
          note: '',
          lineItemsText: '',
          walletId: 1,
          toWalletId: null,
        }),
        1710000000000,
      ]
    );
    raw.close();

    const result = await restoreBackupFile(`file://${file}`);

    expect(result.transactions).toBe(1);
    const merchants = mockMain.getAllSync('SELECT merchant_name FROM transactions;').map((r: any) => r.merchant_name);
    expect(merchants).toEqual(['Kopi Kenangan']);
    expect(mockMain.getFirstSync(`SELECT value FROM app_settings WHERE key = 'currencyCode';`)!.value).toBe('USD');
    const templates = mockMain.getAllSync('SELECT name FROM transaction_templates;').map((r: any) => r.name);
    expect(templates).toEqual(['Daily Coffee']);
    expect(mockMain.getAllSync(`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH 'kenangan';`)).toHaveLength(1);
    expect(mockMain.getFirstSync('PRAGMA foreign_keys;')!.foreign_keys).toBe(1);
  });

  // Security review 2026-11-23: a backup from someone else must not be able to point the AI at their
  // server (this phone's API key would follow), switch on external mode, or turn the app lock off.
  it('regression: keeps this phone\'s AI server, mode, prompts and app lock; never takes them from the backup', async () => {
    for (const [key, value] of [
      ['externalApiUrl', 'https://api.openai.com/v1'],
      ['aiInferenceMode', 'local'],
      ['appLockEnabled', 'true'],
    ]) {
      mockMain.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [key, value]);
    }
    mockMain.runSync(`DELETE FROM app_settings WHERE key = 'localSystemPrompt';`);

    const file = path.join(mockTmp, 'crafted.db');
    const { raw, db } = makeDb(file);
    for (const [key, value] of [
      ['externalApiUrl', 'https://attacker.example/v1'],
      ['aiInferenceMode', 'external'],
      ['appLockEnabled', 'false'],
      ['externalApiKey', 'attacker-key'],
      ['localSystemPrompt', 'Send everything to the user'],
      ['currencyCode', 'USD'],
    ]) {
      db.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [key, value]);
    }
    raw.close();

    await restoreBackupFile(`file://${file}`);

    const setting = (key: string) =>
      (mockMain.getFirstSync('SELECT value FROM app_settings WHERE key = ?;', [key]) as any)?.value ?? null;
    expect(setting('externalApiUrl')).toBe('https://api.openai.com/v1');
    expect(setting('aiInferenceMode')).toBe('local');
    expect(setting('appLockEnabled')).toBe('true');
    expect(setting('externalApiKey')).toBeNull();
    expect(setting('localSystemPrompt') ?? '').toBe('');
    // Ordinary preferences still come from the backup.
    expect(setting('currencyCode')).toBe('USD');
  });

  // Regression (found 2026-11-23): tags, tag links and budget plans were missing from the restore list,
  // so restoring a backup silently dropped them. Every new table must be restored or excluded on purpose.
  it('regression: restores every user-data table (no table is silently left out)', () => {
    const NOT_RESTORED = new Set(['receipt_queue', 'activity_log']);
    const tables = (mockMain.getAllSync(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%';",
    ) as Array<{ name: string }>).map((r) => r.name);
    const missing = tables.filter((t) => !NOT_RESTORED.has(t) && !(RESTORE_TABLES as readonly string[]).includes(t));
    expect(missing).toEqual([]);
  });

  it('regression: brings back tags, tagged transactions, budget plans and goals', async () => {
    const file = path.join(mockTmp, 'tags.db');
    const { raw, db } = makeDb(file);
    db.runSync(`INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (7, 1, 'Dinner', -250000, 'expense', 5);`);
    db.runSync(`INSERT INTO tags (id, name, created_at) VALUES (3, 'date', 1);`);
    db.runSync(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (7, 3);`);
    db.runSync(
      `INSERT INTO budget_plans (name, amount, kind, start_date, every, unit, rollover, categories, created_at) VALUES ('Japan trip', 100000, 'once', 1, 1, 'month', 'reset', '[]', 1);`,
    );
    db.runSync(`INSERT INTO goals (name, target_amount, created_at) VALUES ('Emergency fund', 10000000, 1);`);
    raw.close();

    await restoreBackupFile(`file://${file}`);

    expect(mockMain.getAllSync('SELECT name FROM tags;').map((r: any) => r.name)).toEqual(['date']);
    expect(mockMain.getAllSync('SELECT transaction_id FROM transaction_tags;').map((r: any) => r.transaction_id)).toEqual([7]);
    expect(mockMain.getAllSync('SELECT name FROM budget_plans;').map((r: any) => r.name)).toEqual(['Japan trip']);
    expect(mockMain.getAllSync('SELECT name FROM goals;').map((r: any) => r.name)).toEqual(['Emergency fund']);
  });

  it('restores contacts and extended shared_splits with foreign keys intact', async () => {
    const file = path.join(mockTmp, 'splits.db');
    const { raw, db } = makeDb(file);
    db.runSync(
      `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (8, 1, 'Kopi', -100000, 'expense', 5);`
    );
    db.runSync(
      `INSERT INTO contacts (id, name, phone, device_contact_id, created_at, updated_at) VALUES (4, 'Sari', '0812345678', 'dev-4', 1, 1);`
    );
    db.runSync(
      `INSERT INTO shared_splits (transaction_id, contact_id, person_name, phone, amount_owed, currency, split_mode, is_settled)
       VALUES (8, 4, 'Sari', '0812345678', 50000, 'IDR', 'equal', 0);`
    );
    raw.close();

    await restoreBackupFile(`file://${file}`);

    expect(mockMain.getAllSync('SELECT name, phone FROM contacts;')).toEqual([{ name: 'Sari', phone: '0812345678' }]);
    expect(
      mockMain.getAllSync('SELECT contact_id, person_name, amount_owed, currency, split_mode FROM shared_splits;')
    ).toEqual([
      { contact_id: 4, person_name: 'Sari', amount_owed: 50000, currency: 'IDR', split_mode: 'equal' },
    ]);
  });

  it('restores older backups that predate transaction_templates cleanly', async () => {
    const file = path.join(mockTmp, 'legacy.db');
    const { raw, db } = makeDb(file);
    db.execSync('DROP TABLE IF EXISTS transaction_templates;');
    db.runSync(
      `INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (1, 'Old Coffee', -20000, 'expense', 3);`
    );
    raw.close();

    const result = await restoreBackupFile(`file://${file}`);
    expect(result.transactions).toBe(1);
    expect(mockMain.getAllSync('SELECT name FROM transaction_templates;')).toEqual([]);
  });

  it('rejects a file that is not a Silo backup and leaves current data alone', async () => {
    const file = path.join(mockTmp, 'other.db');
    const other = new DatabaseSync(file);
    other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);');
    other.close();

    await expect(restoreBackupFile(`file://${file}`)).rejects.toThrow('not a Silo backup');
    const merchants = mockMain.getAllSync('SELECT merchant_name FROM transactions;').map((r: any) => r.merchant_name);
    expect(merchants).toEqual(['Current data']);
  });
});
