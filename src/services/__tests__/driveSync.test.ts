import { DatabaseSync } from 'node:sqlite';

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

// ---- fake local files and a fake Drive -----------------------------------------------------------
const mockLocal = new Map<string, number>(); // uri -> size
type DriveItem = { id: string; name: string; parent: string; folder: boolean; createdTime: string };
const mockDrive: DriveItem[] = [];
let mockSeq = 0;
const mockUploads: string[] = [];

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  cacheDirectory: 'file:///cache/',
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  makeDirectoryAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(async (uri: string) => (mockLocal.has(uri) ? { exists: true, size: mockLocal.get(uri) } : { exists: false })),
  deleteAsync: jest.fn(async (uri: string) => void mockLocal.delete(uri)),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockLocal.set(to, mockLocal.get(from) ?? 1);
    mockLocal.delete(from);
  }),
  uploadAsync: jest.fn(async (session: string, uri: string) => {
    const meta = JSON.parse(decodeURIComponent(session.split('meta=')[1]));
    const id = `f${(mockSeq += 1)}`;
    mockDrive.push({ id, name: meta.name, parent: meta.parents[0], folder: false, createdTime: new Date(2026, 0, mockSeq).toISOString() });
    mockUploads.push(`${meta.name}<-${uri}`);
    return { status: 200, body: JSON.stringify({ id }) };
  }),
  downloadAsync: jest.fn(async (_url: string, uri: string) => {
    mockLocal.set(uri, 10);
    return { status: 200, uri };
  }),
}));
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: jest.fn(async () => {
    mockLocal.set('file:///cache/thumb-tmp.jpg', 2);
    return { uri: 'file:///cache/thumb-tmp.jpg' };
  }),
}));
jest.mock('../backup', () => ({
  createBackupFile: jest.fn(async () => {
    mockLocal.set('file:///cache/backups/tmp.db', 100);
    return 'file:///cache/backups/tmp.db';
  }),
  restoreBackupFile: jest.fn(async () => ({ transactions: 3 })),
}));

function fakeFetch(url: string, init: any = {}) {
  const method = init.method ?? 'GET';
  const json = (body: unknown, status = 200) =>
    Promise.resolve({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
  if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
    const meta = JSON.parse(init.body);
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => `https://upload.session/?meta=${encodeURIComponent(JSON.stringify(meta))}` } });
  }
  const u = new URL(url);
  if (u.pathname === '/drive/v3/files' && method === 'GET') {
    const q = u.searchParams.get('q') ?? '';
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const name = /name = '([^']+)'/.exec(q)?.[1];
    const folders = q.includes("mimeType = 'application/vnd.google-apps.folder'");
    const files = mockDrive
      .filter((f) => f.parent === parent && (name ? f.name === name : true) && (folders ? f.folder : !f.folder))
      .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
      .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: '100' }));
    return json({ files });
  }
  if (u.pathname === '/drive/v3/files' && method === 'POST') {
    const body = JSON.parse(init.body);
    const id = `d${(mockSeq += 1)}`;
    mockDrive.push({ id, name: body.name, parent: body.parents[0], folder: true, createdTime: new Date().toISOString() });
    return json({ id });
  }
  const del = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (del && method === 'DELETE') {
    const i = mockDrive.findIndex((f) => f.id === del[1]);
    if (i >= 0) mockDrive.splice(i, 1);
    return Promise.resolve({ ok: true, status: 204, json: async () => ({}), headers: { get: () => null } });
  }
  return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
}

const mockSignin = {
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(async () => ({ type: 'success', data: { user: { email: 'me@example.com' }, scopes: ['https://www.googleapis.com/auth/drive.file'] } })),
    addScopes: jest.fn(async () => ({})),
    hasPreviousSignIn: jest.fn(() => true),
    signInSilently: jest.fn(async () => ({})),
    getTokens: jest.fn(async () => ({ accessToken: 'token-123' })),
    revokeAccess: jest.fn(async () => null),
    signOut: jest.fn(async () => null),
  },
};

import { runMigrations } from '../../db/index';
import { __setDriveFetchForTests } from '../drive/driveApi';
import { __setGoogleSigninForTests, connectDrive, disconnectDrive, getConnectedAccount, DRIVE_FILE_SCOPE } from '../drive/googleAuth';
import {
  DRIVE_BACKUP_KEEP,
  backupToDrive,
  fetchFullReceipt,
  listDriveBackups,
  offloadOldReceipts,
  runDriveSyncIfDue,
  setOffloadMonths,
} from '../drive/driveSync';

let raw: DatabaseSync;
let db: ReturnType<typeof wrap>;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  db = wrap(raw);
  (globalThis as any).__siloTestDb = db;
  runMigrations(db as any);
  mockLocal.clear();
  mockDrive.length = 0;
  mockUploads.length = 0;
  mockSeq = 0;
  __setDriveFetchForTests(fakeFetch as any);
  __setGoogleSigninForTests(mockSignin as any);
});
afterEach(() => raw.close());

describe('Google Drive sync', () => {
  it('connects with only the drive.file scope and remembers the account', async () => {
    expect(await connectDrive()).toBe('me@example.com');
    expect(mockSignin.GoogleSignin.configure).toHaveBeenCalledWith({ scopes: [DRIVE_FILE_SCOPE] });
    expect(getConnectedAccount()).toBe('me@example.com');
    await disconnectDrive();
    expect(mockSignin.GoogleSignin.revokeAccess).toHaveBeenCalled();
    expect(getConnectedAccount()).toBeNull();
  });

  it('backs up into Silo/Backups, replaces the same day and keeps only the newest 30', async () => {
    await connectDrive();
    await backupToDrive(new Date(2026, 10, 23));
    await backupToDrive(new Date(2026, 10, 23, 18)); // same day: replaced, not duplicated
    const silo = mockDrive.find((f) => f.folder && f.name === 'Silo')!;
    const backupsFolder = mockDrive.find((f) => f.folder && f.name === 'Backups' && f.parent === silo.id)!;
    expect(silo.parent).toBe('root');
    expect(mockDrive.filter((f) => f.parent === backupsFolder.id).map((f) => f.name)).toEqual(['silo-backup-2026-11-23.db']);

    for (let day = 1; day <= 35; day += 1) await backupToDrive(new Date(2026, 0, day));
    const names = (await listDriveBackups()).map((f) => f.name);
    expect(names).toHaveLength(DRIVE_BACKUP_KEEP);
    expect(mockLocal.has('file:///cache/backups/tmp.db')).toBe(false); // temp file cleaned up
  });

  it('moves old receipt photos to Drive, keeps a thumbnail and loads the full photo on demand', async () => {
    await connectDrive();
    const old = new Date(2026, 0, 5).getTime();
    const recent = new Date(2026, 10, 20).getTime();
    db.runSync(`INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, image_uri) VALUES (1, 1, 'Old', -1, 'expense', ?, 'file:///docs/receipts/a.jpg');`, [old]);
    db.runSync(`INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, image_uri) VALUES (2, 1, 'New', -1, 'expense', ?, 'file:///docs/receipts/b.jpg');`, [recent]);
    mockLocal.set('file:///docs/receipts/a.jpg', 800_000);
    mockLocal.set('file:///docs/receipts/b.jpg', 800_000);

    const result = await offloadOldReceipts(3, new Date(2026, 10, 23));
    expect(result).toEqual({ moved: 1, freedBytes: 800_000 });
    expect(mockLocal.has('file:///docs/receipts/a.jpg')).toBe(false);
    expect(mockLocal.has('file:///docs/receipts/b.jpg')).toBe(true);
    const tx = db.getFirstSync('SELECT image_uri FROM transactions WHERE id = 1;') as any;
    expect(tx.image_uri).toBe('file:///docs/receipts/thumbs/a.jpg');
    expect(mockUploads[0]).toBe('receipt-1-a.jpg<-file:///docs/receipts/a.jpg');

    // Running again moves nothing new.
    expect((await offloadOldReceipts(3, new Date(2026, 10, 23))).moved).toBe(0);

    const full = await fetchFullReceipt(1, 'file:///docs/receipts/thumbs/a.jpg');
    expect(full).toMatch(/^file:\/\/\/cache\/drive-receipts\/f\d+\.jpg$/);
    // If the photo was replaced since it moved, the viewer shows the new local one.
    expect(await fetchFullReceipt(1, 'file:///docs/receipts/new-photo.jpg')).toBeNull();
  });

  it('daily sync does nothing until Drive is connected, then backs up once a day', async () => {
    await runDriveSyncIfDue(new Date(2026, 10, 23));
    expect(mockUploads).toHaveLength(0);
    await connectDrive();
    setOffloadMonths(0);
    await runDriveSyncIfDue(new Date(2026, 10, 23, 9));
    await runDriveSyncIfDue(new Date(2026, 10, 23, 20));
    expect(mockUploads.filter((u) => u.startsWith('silo-backup'))).toHaveLength(1);
  });
});
