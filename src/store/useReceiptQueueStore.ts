import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';

import { expoDb } from '../db/index';
import { analyzeReceiptImage, type ParsedReceiptResult } from '../services/ai/agent';

export type ReceiptQueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface ReceiptQueueItem {
  id: number;
  imageUri: string;
  status: ReceiptQueueStatus;
  result: ParsedReceiptResult | null;
  error: string | null;
  createdAt: number;
}

interface ReceiptQueueRow {
  id: number;
  image_uri: string;
  status: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
}

interface ReceiptQueueState {
  items: ReceiptQueueItem[];
  isProcessing: boolean;
  /** Loads the queue, re-queues receipts interrupted by an app restart, and resumes processing. */
  load: () => void;
  /** Copies picked images into app storage (picker URIs are temporary) and queues them. */
  enqueue: (uris: string[]) => Promise<void>;
  retry: (id: number) => void;
  /** Removes a receipt from the queue. Pass deleteImage=false when a saved transaction now owns the image. */
  remove: (id: number, deleteImage?: boolean) => Promise<void>;
}

const RECEIPTS_DIR = `${FileSystem.documentDirectory ?? ''}receipts/`;

function toItem(row: ReceiptQueueRow): ReceiptQueueItem {
  let result: ParsedReceiptResult | null = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json) as ParsedReceiptResult;
    } catch {
      result = null;
    }
  }
  const status = (['pending', 'processing', 'done', 'failed'] as const).find((s) => s === row.status) ?? 'pending';
  return { id: row.id, imageUri: row.image_uri, status, result, error: row.error, createdAt: row.created_at };
}

function readAll(): ReceiptQueueItem[] {
  return expoDb
    .getAllSync<ReceiptQueueRow>('SELECT * FROM receipt_queue ORDER BY created_at ASC, id ASC;')
    .map(toItem);
}

function scanErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'NO_TEXT_DETECTED') {
    return 'No readable text. Retake the photo closer, flat and in good light.';
  }
  return error instanceof Error && error.message ? error.message : 'Could not read this receipt.';
}

export const useReceiptQueueStore = create<ReceiptQueueState>((set, get) => {
  const refresh = () => set({ items: readAll() });

  // Reads queued receipts one at a time; the generation service serializes model access with chat and single scans.
  const processQueue = async () => {
    if (get().isProcessing) return;
    set({ isProcessing: true });
    try {
      for (;;) {
        const next = get().items.find((item) => item.status === 'pending');
        if (!next) break;

        expoDb.runSync(`UPDATE receipt_queue SET status = 'processing', error = NULL WHERE id = ?;`, [next.id]);
        refresh();
        try {
          const result = await analyzeReceiptImage(next.imageUri);
          expoDb.runSync(`UPDATE receipt_queue SET status = 'done', result_json = ? WHERE id = ?;`, [
            JSON.stringify(result ?? {}),
            next.id,
          ]);
        } catch (error) {
          expoDb.runSync(`UPDATE receipt_queue SET status = 'failed', error = ? WHERE id = ?;`, [
            scanErrorMessage(error),
            next.id,
          ]);
        }
        refresh();
      }
    } finally {
      set({ isProcessing: false });
    }
  };

  return {
    items: [],
    isProcessing: false,

    load: () => {
      expoDb.runSync(`UPDATE receipt_queue SET status = 'pending' WHERE status = 'processing';`);
      refresh();
      void processQueue();
    },

    enqueue: async (uris) => {
      if (uris.length === 0) return;
      await FileSystem.makeDirectoryAsync(RECEIPTS_DIR, { intermediates: true }).catch(() => undefined);
      const now = Date.now();
      for (let i = 0; i < uris.length; i++) {
        const extension = /\.(jpe?g|png|heic|webp)$/i.exec(uris[i])?.[0] ?? '.jpg';
        const dest = `${RECEIPTS_DIR}receipt-${now}-${i}${extension}`;
        let stored = uris[i];
        try {
          await FileSystem.copyAsync({ from: uris[i], to: dest });
          stored = dest;
        } catch (error) {
          console.warn('Could not copy receipt image into app storage; using picker URI:', error);
        }
        expoDb.runSync(`INSERT INTO receipt_queue (image_uri, status, created_at) VALUES (?, 'pending', ?);`, [
          stored,
          now + i,
        ]);
      }
      refresh();
      void processQueue();
    },

    retry: (id) => {
      expoDb.runSync(`UPDATE receipt_queue SET status = 'pending', error = NULL WHERE id = ?;`, [id]);
      refresh();
      void processQueue();
    },

    remove: async (id, deleteImage = true) => {
      const item = get().items.find((entry) => entry.id === id);
      expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
      refresh();
      if (deleteImage && item?.imageUri.startsWith(RECEIPTS_DIR)) {
        await FileSystem.deleteAsync(item.imageUri, { idempotent: true }).catch(() => undefined);
      }
    },
  };
});
