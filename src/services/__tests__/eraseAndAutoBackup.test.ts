import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-erase-'));
const mockDeletedSecure: string[] = [];

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

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});
jest.mock('expo-secure-store', () => ({ deleteItemAsync: jest.fn(async (k: string) => mockDeletedSecure.push(k)) }));
jest.mock('expo-file-system/legacy', () => {
  const nodeFs = require('fs');
  const strip = (uri: string) => uri.replace(/^file:\/\//, '');
  return {
    get documentDirectory() {
      return `file://${mockTmp}/docs/`;
    },
    get cacheDirectory() {
      return `file://${mockTmp}/cache/`;
    },
    makeDirectoryAsync: jest.fn(async (uri: string) => nodeFs.mkdirSync(strip(uri), { recursive: true })),
    readDirectoryAsync: jest.fn(async (uri: string) => nodeFs.readdirSync(strip(uri))),
    getInfoAsync: jest.fn(async (uri: string) => {
      const p = strip(uri);
      return nodeFs.existsSync(p) ? { exists: true, size: nodeFs.statSync(p).size } : { exists: false };
    }),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => nodeFs.renameSync(strip(from), strip(to))),
    deleteAsync: jest.fn(async (uri: string) => nodeFs.rmSync(strip(uri), { force: true, recursive: true })),
  };
});
let mockBackupCounter = 0;
jest.mock('../backup', () => ({
  createBackupFile: jest.fn(async () => {
    const nodeFs = require('fs');
    nodeFs.mkdirSync(`${mockTmp}/cache`, { recursive: true });
    const file = `${mockTmp}/cache/tmp-${(mockBackupCounter += 1)}.db`;
    nodeFs.writeFileSync(file, 'db');
    return `file://${file}`;
  }),
}));

import { runMigrations } from '../../db/index';
import { eraseAllData } from '../eraseData';
import { AUTO_BACKUP_KEEP, listAutoBackups, runAutoBackupIfDue, setAutoBackupEnabled } from '../autoBackup';

let raw: DatabaseSync;
let db: ReturnType<typeof wrap>;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  db = wrap(raw);
  (globalThis as any).__siloTestDb = db;
  runMigrations(db as any);
  fs.rmSync(path.join(mockTmp, 'docs'), { recursive: true, force: true });
  mockDeletedSecure.length = 0;
});
afterEach(() => raw.close());

describe('erase all data', () => {
  it('removes records, tags, goals, settings, photos and backups but keeps the AI model choice', async () => {
    db.runSync(`INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date) VALUES (1, 'Lawson', -13000, 'expense', 1);`);
    db.runSync(`INSERT INTO tags (name, created_at) VALUES ('date', 1);`);
    db.runSync(`INSERT INTO goals (name, target_amount, created_at) VALUES ('Japan', 10, 1);`);
    db.runSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currencyCode', 'USD'), ('activeModelId', 'qwen3.5-2b'), ('hasCompletedOnboarding', 'true');`);
    fs.mkdirSync(path.join(mockTmp, 'docs/receipts'), { recursive: true });
    fs.writeFileSync(path.join(mockTmp, 'docs/receipts/r1.jpg'), 'x');
    fs.mkdirSync(path.join(mockTmp, 'docs/auto-backups'), { recursive: true });
    fs.writeFileSync(path.join(mockTmp, 'docs/auto-backups/silo-auto-2026-11-20.db'), 'x');

    await eraseAllData();

    const count = (t: string) => (db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t};`) as any).n;
    expect(count('transactions')).toBe(0);
    expect(count('tags')).toBe(0);
    expect(count('goals')).toBe(0);
    expect(count('wallets')).toBe(1); // default account re-seeded, like a fresh install
    const setting = (k: string) => (db.getFirstSync('SELECT value FROM app_settings WHERE key = ?;', [k]) as any)?.value;
    expect(setting('currencyCode')).toBe('IDR');
    expect(setting('hasCompletedOnboarding')).not.toBe('true');
    expect(setting('activeModelId')).toBe('qwen3.5-2b');
    expect(fs.existsSync(path.join(mockTmp, 'docs/receipts'))).toBe(false);
    expect(fs.existsSync(path.join(mockTmp, 'docs/auto-backups'))).toBe(false);
    expect(mockDeletedSecure.sort()).toEqual(['externalApiCustomHeaders', 'externalApiKey']);
  });
});

describe('automatic backups', () => {
  it('makes one backup a day and keeps only the newest seven', async () => {
    for (let day = 1; day <= 9; day += 1) {
      await runAutoBackupIfDue(new Date(2026, 10, day, 9));
      await runAutoBackupIfDue(new Date(2026, 10, day, 18)); // same day: no second backup
    }
    const backups = await listAutoBackups();
    expect(backups).toHaveLength(AUTO_BACKUP_KEEP);
    expect(backups[0].date).toBe('2026-11-09');
    expect(backups[backups.length - 1].date).toBe('2026-11-03');
    expect(mockBackupCounter).toBeGreaterThanOrEqual(9);
  });

  // Regression (found while testing 2026-11-23): with backups off the job finished synchronously and left a
  // stale "running" job behind, so Back up now (and turning backups back on) silently did nothing.
  it('regression: does nothing when turned off, but Back up now still works afterwards', async () => {
    setAutoBackupEnabled(false);
    expect(await runAutoBackupIfDue(new Date(2026, 10, 10))).toBeNull();
    expect(await listAutoBackups()).toHaveLength(0);
    const forced = await runAutoBackupIfDue(new Date(2026, 10, 10), { force: true });
    expect(forced?.date).toBe('2026-11-10');
  });
});
