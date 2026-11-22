import { DatabaseSync } from 'node:sqlite';

const rawDb = new DatabaseSync(':memory:');
const mockDb = {
  execSync: (sql: string) => rawDb.exec(sql),
  getAllSync: (sql: string, params: any[] = []) => rawDb.prepare(sql).all(...params),
  runSync: (sql: string, params: any[] = []) => rawDb.prepare(sql).run(...params),
};
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
const mockNormalize = jest.fn();
const mockStartWork = jest.fn((_text: string) => true);
const mockStopWork = jest.fn();
jest.mock('../../services/ocr/normalizeImage', () => ({
  normalizeReceiptImage: (uri: string) => mockNormalize(uri),
  startBackgroundWork: (text: string) => mockStartWork(text),
  stopBackgroundWork: () => mockStopWork(),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { SAVED_HISTORY_MS, useReceiptQueueStore } from '../useReceiptQueueStore';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const waitIdle = async () => {
  for (let i = 0; i < 80 && useReceiptQueueStore.getState().isProcessing; i++) await flush();
};

describe('receipt queue: gallery scans, background work and saved history', () => {
  beforeAll(() => {
    rawDb.exec(`CREATE TABLE receipt_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, image_uri TEXT NOT NULL,
      image_hash TEXT, thumbnail_uri TEXT, status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, error TEXT,
      created_at INTEGER NOT NULL, needs_scan INTEGER NOT NULL DEFAULT 0, transaction_id INTEGER, saved_at INTEGER);`);
  });
  beforeEach(() => {
    rawDb.exec('DELETE FROM receipt_queue;');
    jest.clearAllMocks();
    useReceiptQueueStore.setState({ items: [], savedItems: [], isProcessing: false });
  });

  it('turns gallery imports into scans before reading, with a background-work notification', async () => {
    mockNormalize.mockImplementation(async (uri: string) => `file:///cache/receipt-normalized-${uri.length}.jpg`);
    mockAnalyze.mockResolvedValue({ merchantName: 'Lawson', totalAmount: 13000 });

    await useReceiptQueueStore.getState().enqueue(['file:///cache/a.jpg', 'file:///cache/b.jpg'], { scan: true });
    await waitIdle();

    const { items } = useReceiptQueueStore.getState();
    expect(items.map((i) => i.status)).toEqual(['done', 'done']);
    expect(items.every((i) => /receipts\/receipt-scan-\d+-\d+\.jpg$/.test(i.imageUri))).toBe(true);
    expect(items.every((i) => !i.needsScan)).toBe(true);
    expect(mockAnalyze.mock.calls.map((c) => c[0])).toEqual(items.map((i) => i.imageUri));
    expect(mockStartWork).toHaveBeenNthCalledWith(1, 'Reading receipts: 1 of 2');
    expect(mockStartWork).toHaveBeenNthCalledWith(2, 'Reading receipts: 2 of 2');
    expect(mockStopWork).toHaveBeenCalledTimes(1);
    // The original full-size copy is deleted once the smaller scan is stored.
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/docs\/receipts\/receipt-\d+-0\.jpg$/), expect.anything());
  });

  it('keeps camera-scanner receipts as they are', async () => {
    mockAnalyze.mockResolvedValue({ merchantName: 'Scanned', totalAmount: 1000 });
    await useReceiptQueueStore.getState().enqueue(['file:///cache/scanner-page.jpg']);
    await waitIdle();
    expect(mockNormalize).not.toHaveBeenCalled();
    expect(useReceiptQueueStore.getState().items[0].imageUri).toMatch(/receipts\/receipt-\d+-0\.jpg$/);
  });

  it('moves saved receipts to a history, blocks re-importing them, and forgets them after two weeks', async () => {
    mockAnalyze.mockResolvedValue({ merchantName: 'Indomaret', totalAmount: 30500 });
    await useReceiptQueueStore.getState().enqueue(['file:///cache/r.jpg']);
    await waitIdle();
    const [item] = useReceiptQueueStore.getState().items;

    useReceiptQueueStore.getState().markSaved(item.id, 42);
    const state = useReceiptQueueStore.getState();
    expect(state.items).toEqual([]);
    expect(state.savedItems).toEqual([expect.objectContaining({ id: item.id, transactionId: 42 })]);

    const again = await useReceiptQueueStore.getState().enqueue(['file:///cache/r.jpg']);
    expect(again).toEqual({ added: 0, skippedDuplicates: 1 });

    rawDb.prepare('UPDATE receipt_queue SET saved_at = ? WHERE id = ?;').run(Date.now() - SAVED_HISTORY_MS - 1000, item.id);
    useReceiptQueueStore.getState().load();
    expect(useReceiptQueueStore.getState().savedItems).toEqual([]);
  });
});
