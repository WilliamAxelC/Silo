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
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  copyAsync: jest.fn(() => Promise.resolve()),
  deleteAsync: jest.fn(() => Promise.resolve()),
  getInfoAsync: jest.fn((uri: string) => Promise.resolve({ exists: true, size: 1024, md5: `hash-${uri}` })),
}));
const mockAnalyze = jest.fn();
jest.mock('../../services/ai/agent', () => ({ analyzeReceiptImage: (...args: unknown[]) => mockAnalyze(...args) }));

import * as FileSystem from 'expo-file-system/legacy';
import { useReceiptQueueStore } from '../useReceiptQueueStore';

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
      image_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, error TEXT, created_at INTEGER NOT NULL);`);
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

  it('keeps the photo when a saved transaction owns it, and deletes it otherwise', async () => {
    mockAnalyze.mockResolvedValue({ totalAmount: 1 });
    await useReceiptQueueStore.getState().enqueue(['file:///cache/a.jpg', 'file:///cache/b.jpg']);
    await waitIdle();
    const [saved, discarded] = useReceiptQueueStore.getState().items;

    await useReceiptQueueStore.getState().remove(saved.id, false);
    await useReceiptQueueStore.getState().remove(discarded.id);

    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(discarded.imageUri, { idempotent: true });
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
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
  });
});
