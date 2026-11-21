import { DatabaseSync } from 'node:sqlite';

const rawDb = new DatabaseSync(':memory:');
const mockDb = {
  execSync: (sql: string) => rawDb.exec(sql),
  getAllSync: (sql: string, params: any[] = []) => rawDb.prepare(sql).all(...params),
  runSync: (sql: string, params: any[] = []) => rawDb.prepare(sql).run(...params),
};

// Getter: jest.mock is hoisted above mockDb's initialisation.
jest.mock('../../db/index', () => ({
  get expoDb() {
    return mockDb;
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  copyAsync: jest.fn(() => Promise.resolve()),
  moveAsync: jest.fn(() => Promise.resolve()),
  deleteAsync: jest.fn(() => Promise.resolve()),
  getInfoAsync: jest.fn((uri: string) => Promise.resolve({ exists: true, size: 1024, md5: `hash-${uri}` })),
}));
const mockAnalyze = jest.fn();
jest.mock('../../services/ai/agent', () => ({ analyzeReceiptImage: (...args: unknown[]) => mockAnalyze(...args) }));

import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { getModelLifecycleManager } from '../../services/ai/modelLifecycle';
import { useReceiptQueueStore } from '../useReceiptQueueStore';
import { useSettingsStore } from '../useSettingsStore';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const waitIdle = async () => {
  for (let i = 0; i < 50 && useReceiptQueueStore.getState().isProcessing; i++) await flush();
};

describe('useReceiptQueueStore', () => {
  beforeAll(() => {
    // Same table as db/index.ts createReceiptQueueTable (db/index is mocked here).
    rawDb.exec(`CREATE TABLE receipt_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, image_uri TEXT NOT NULL,
      image_hash TEXT, thumbnail_uri TEXT, status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, error TEXT, created_at INTEGER NOT NULL);`);
  });

  beforeEach(() => {
    rawDb.exec('DELETE FROM receipt_queue;');
    mockAnalyze.mockReset();
    jest.clearAllMocks();
    useReceiptQueueStore.setState({ items: [], isProcessing: false });
  });

  it('copies picked photos into app storage and reads them one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    mockAnalyze.mockImplementation(async (uri: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await flush();
      active--;
      return { merchantName: uri.includes('-0') ? 'First' : 'Second', totalAmount: 1000, confidence: 'high' };
    });

    await useReceiptQueueStore.getState().enqueue(['file:///cache/a.jpg', 'file:///cache/b.jpg']);
    await waitIdle();

    const { items } = useReceiptQueueStore.getState();
    expect(FileSystem.copyAsync).toHaveBeenCalledTimes(2);
    expect(items.map((i) => i.status)).toEqual(['done', 'done']);
    expect(items[0].imageUri).toMatch(/^file:\/\/\/docs\/receipts\/receipt-\d+-0\.jpg$/);
    expect(items.map((i) => i.result?.merchantName)).toEqual(['First', 'Second']);
    expect(maxActive).toBe(1);
  });

  it('marks unreadable photos as failed with a helpful message and retries on request', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('NO_TEXT_DETECTED')).mockResolvedValueOnce({ totalAmount: 5000 });

    await useReceiptQueueStore.getState().enqueue(['file:///cache/blurry.jpg']);
    await waitIdle();
    const failed = useReceiptQueueStore.getState().items[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/No readable text/);

    useReceiptQueueStore.getState().retry(failed.id);
    await waitIdle();
    expect(useReceiptQueueStore.getState().items[0]).toMatchObject({ status: 'done', error: null });
  });

  it('re-queues receipts that were mid-read when the app closed', async () => {
    mockDb.runSync(`INSERT INTO receipt_queue (image_uri, status, created_at) VALUES ('file:///docs/receipts/x.jpg', 'processing', 1);`);
    mockAnalyze.mockResolvedValue({ totalAmount: 7000 });

    useReceiptQueueStore.getState().load();
    await waitIdle();

    expect(mockAnalyze).toHaveBeenCalledWith('file:///docs/receipts/x.jpg');
    expect(useReceiptQueueStore.getState().items[0].status).toBe('done');
  });

  it('keeps the photo when a saved transaction owns it, deletes it otherwise, and always cleans up thumbnails', async () => {
    mockAnalyze.mockResolvedValue({ totalAmount: 1 });
    await useReceiptQueueStore.getState().enqueue(['file:///cache/a.jpg', 'file:///cache/b.jpg']);
    await waitIdle();
    const [saved, discarded] = useReceiptQueueStore.getState().items;
    expect(saved.thumbnailUri).toMatch(/^file:\/\/\/cache\/thumbs\/thumb-\d+-0\.jpg$/);
    expect(discarded.thumbnailUri).toMatch(/^file:\/\/\/cache\/thumbs\/thumb-\d+-1\.jpg$/);

    await useReceiptQueueStore.getState().remove(saved.id, false);
    await useReceiptQueueStore.getState().remove(discarded.id);

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(saved.imageUri, expect.anything());
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(discarded.imageUri, { idempotent: true });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(saved.thumbnailUri, { idempotent: true });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(discarded.thumbnailUri, { idempotent: true });
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
    expect(useReceiptQueueStore.getState().items).toEqual([]);
  });

  it('detects and skips duplicate receipt imports by image content hash across picker URIs (F-07)', async () => {
    mockAnalyze.mockResolvedValue({ merchantName: 'Coffee Shop', totalAmount: 30000, confidence: 'high' });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri.includes('same-photo')) {
        return { exists: true, size: 4096, md5: 'deadbeef1234' };
      }
      return { exists: true, size: 2048, md5: `unique-${uri}` };
    });

    const first = await useReceiptQueueStore
      .getState()
      .enqueue(['file:///picker/same-photo-1.jpg', 'file:///picker/other.jpg']);
    await waitIdle();
    expect(first).toEqual({ added: 2, skippedDuplicates: 0 });
    expect(useReceiptQueueStore.getState().items).toHaveLength(2);

    // Re-importing the same photo via a new temporary gallery URI is skipped
    const second = await useReceiptQueueStore
      .getState()
      .enqueue(['file:///picker/same-photo-2.jpg', 'file:///picker/same-photo-3.jpg']);
    await waitIdle();
    expect(second).toEqual({ added: 0, skippedDuplicates: 2 });
    expect(useReceiptQueueStore.getState().items).toHaveLength(2);
    // Only the 2 unique files were copied into storage
    expect(FileSystem.copyAsync).toHaveBeenCalledTimes(2);
  });

  it('supports clearByStatus and removeMany for bulk inbox cleanup (F-08)', async () => {
    mockAnalyze
      .mockResolvedValueOnce({ merchantName: 'Done 1', totalAmount: 10000 })
      .mockRejectedValueOnce(new Error('NO_TEXT_DETECTED'))
      .mockResolvedValueOnce({ merchantName: 'Done 2', totalAmount: 20000 });

    await useReceiptQueueStore
      .getState()
      .enqueue(['file:///cache/1.jpg', 'file:///cache/2.jpg', 'file:///cache/3.jpg']);
    await waitIdle();

    expect(useReceiptQueueStore.getState().items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);

    const clearedCount = await useReceiptQueueStore.getState().clearByStatus(['done']);
    expect(clearedCount).toBe(2);
    const remaining = useReceiptQueueStore.getState().items;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('failed');

    await useReceiptQueueStore.getState().removeMany([remaining[0].id]);
    expect(useReceiptQueueStore.getState().items).toEqual([]);
    // 3 original receipt images + 3 thumbnails deleted
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(6);
  });

  it('generates JPEG thumbnails on enqueue without generating for skipped duplicates', async () => {
    mockAnalyze.mockResolvedValue({ merchantName: 'Cafe', totalAmount: 25000, confidence: 'high' });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      size: 2048,
      md5: uri.includes('dup') ? 'dup-hash' : `hash-${uri}`,
    }));

    await useReceiptQueueStore
      .getState()
      .enqueue(['file:///picker/dup-1.jpg', 'file:///picker/dup-2.jpg', 'file:///picker/unique.jpg']);
    await waitIdle();

    expect(manipulateAsync).toHaveBeenCalledTimes(2);
    expect(manipulateAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/docs\/receipts\/receipt-\d+-0\.jpg$/),
      [{ resize: { width: 168 } }],
      { compress: 0.7, format: SaveFormat.JPEG },
    );
    const items = useReceiptQueueStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items[0].thumbnailUri).toMatch(/^file:\/\/\/cache\/thumbs\/thumb-\d+-0\.jpg$/);
    expect(items[1].thumbnailUri).toMatch(/^file:\/\/\/cache\/thumbs\/thumb-\d+-1\.jpg$/);
  });

  it('lazily generates and persists missing thumbnails for legacy queue items, and cleans up orphans if removed mid-generation', async () => {
    mockDb.runSync(
      `INSERT INTO receipt_queue (image_uri, image_hash, thumbnail_uri, status, created_at) VALUES (?, ?, NULL, 'done', 100);`,
      ['file:///docs/receipts/legacy-1.jpg', 'md5:legacy-1'],
    );
    mockDb.runSync(
      `INSERT INTO receipt_queue (image_uri, image_hash, thumbnail_uri, status, created_at) VALUES (?, ?, NULL, 'done', 200);`,
      ['file:///docs/receipts/legacy-2.jpg', 'md5:legacy-2'],
    );
    useReceiptQueueStore.getState().load();
    await waitIdle();

    const [legacy1, legacy2] = useReceiptQueueStore.getState().items;
    expect(legacy1.thumbnailUri).toBeNull();
    expect(legacy2.thumbnailUri).toBeNull();

    // Lazy creation persists to SQLite and updates item in store
    const createdThumb = await useReceiptQueueStore.getState().ensureThumbnail(legacy1.id);
    expect(createdThumb).toMatch(/^file:\/\/\/cache\/thumbs\/thumb-\d+-\d+\.jpg$/);
    expect(useReceiptQueueStore.getState().items[0].thumbnailUri).toBe(createdThumb);
    const persisted = rawDb
      .prepare('SELECT thumbnail_uri FROM receipt_queue WHERE id = ?;')
      .get(legacy1.id) as { thumbnail_uri: string | null };
    expect(persisted.thumbnail_uri).toBe(createdThumb);

    // Calling ensureThumbnail again when thumbnail already exists is a no-op
    (manipulateAsync as jest.Mock).mockClear();
    expect(await useReceiptQueueStore.getState().ensureThumbnail(legacy1.id)).toBe(createdThumb);
    expect(manipulateAsync).not.toHaveBeenCalled();

    // Removing an item while its lazy thumbnail is being generated deletes the orphan thumbnail file
    let resolveManipulate!: (val: { uri: string; width: number; height: number }) => void;
    (manipulateAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveManipulate = resolve;
        }),
    );
    const inFlight = useReceiptQueueStore.getState().ensureThumbnail(legacy2.id);
    await flush();
    await useReceiptQueueStore.getState().remove(legacy2.id);
    resolveManipulate({ uri: 'file:///tmp/orphan.jpg', width: 168, height: 220 });
    const orphanResult = await inFlight;
    expect(orphanResult).toBeNull();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/cache\/thumbs\/thumb-\d+-\d+\.jpg$/),
      { idempotent: true },
    );
  });

  it('awaits Secret hydration in external mode and modelLifecycle.ensureInitialized in local mode before analyzing queued receipts on launch (R4-01 & R4-02)', async () => {
    // 1. External mode: must await waitForSecretsHydrated before analyzeReceiptImage runs
    mockDb.runSync(`INSERT INTO receipt_queue (image_uri, status, created_at) VALUES ('file:///docs/receipts/ext.jpg', 'pending', 1);`);
    mockAnalyze.mockResolvedValueOnce({ merchantName: 'Cloud Cafe', totalAmount: 32000 });

    let resolveSecrets!: () => void;
    const waitSecretsSpy = jest
      .spyOn(useSettingsStore.getState(), 'waitForSecretsHydrated')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecrets = resolve;
          }),
      );
    useSettingsStore.setState({ aiInferenceMode: 'external' });

    try {
      useReceiptQueueStore.getState().load();
      await flush();
      expect(mockAnalyze).not.toHaveBeenCalled();

      resolveSecrets();
      await waitIdle();
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      expect(useReceiptQueueStore.getState().items[0].status).toBe('done');
    } finally {
      waitSecretsSpy.mockRestore();
      useSettingsStore.setState({ aiInferenceMode: 'local' });
    }

    // 2. Local mode: must await getModelLifecycleManager().ensureInitialized() before analyzeReceiptImage runs
    rawDb.exec('DELETE FROM receipt_queue;');
    useReceiptQueueStore.setState({ items: [], isProcessing: false });
    mockAnalyze.mockReset();
    mockAnalyze.mockResolvedValueOnce({ merchantName: 'Local Mart', totalAmount: 18000 });
    mockDb.runSync(`INSERT INTO receipt_queue (image_uri, status, created_at) VALUES ('file:///docs/receipts/loc.jpg', 'pending', 2);`);

    let resolveLifecycle!: () => void;
    const ensureSpy = jest
      .spyOn(getModelLifecycleManager(), 'ensureInitialized')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveLifecycle = resolve;
          }),
      );

    try {
      useReceiptQueueStore.getState().load();
      await flush();
      expect(ensureSpy).toHaveBeenCalledTimes(1);
      expect(mockAnalyze).not.toHaveBeenCalled();

      resolveLifecycle();
      await waitIdle();
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      expect(useReceiptQueueStore.getState().items[0].status).toBe('done');
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('persists computed image_hash back to SQLite for legacy rows with NULL hash so subsequent enqueues do not re-hash them (MIN-03)', async () => {
    mockDb.runSync(
      `INSERT INTO receipt_queue (image_uri, image_hash, status, created_at) VALUES ('file:///docs/receipts/legacy-nohash.jpg', NULL, 'done', 100);`
    );
    mockAnalyze.mockResolvedValue({ merchantName: 'New Cafe', totalAmount: 15000, confidence: 'high' });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
      exists: true,
      size: 2048,
      md5: uri.includes('legacy-nohash') ? 'legacy-md5-abc' : `md5-${uri}`,
    }));

    // First enqueue hashes the legacy row once and persists its image_hash to SQLite
    await useReceiptQueueStore.getState().enqueue(['file:///picker/new-1.jpg']);
    await waitIdle();

    const persisted = rawDb
      .prepare(`SELECT image_hash FROM receipt_queue WHERE image_uri = 'file:///docs/receipts/legacy-nohash.jpg';`)
      .get() as { image_hash: string | null };
    expect(persisted.image_hash).toBe('md5:legacy-md5-abc');

    // Second enqueue must NOT re-hash legacy-nohash.jpg on disk
    (FileSystem.getInfoAsync as jest.Mock).mockClear();
    await useReceiptQueueStore.getState().enqueue(['file:///picker/new-2.jpg']);
    await waitIdle();

    const hashedUris = (FileSystem.getInfoAsync as jest.Mock).mock.calls.map((c) => c[0]);
    expect(hashedUris).not.toContain('file:///docs/receipts/legacy-nohash.jpg');
  });
});
