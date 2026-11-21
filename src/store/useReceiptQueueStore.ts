import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';

import { expoDb } from '../db/index';
import { analyzeReceiptImage, type ParsedReceiptResult } from '../services/ai/agent';

export type ReceiptQueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface ReceiptQueueItem {
  id: number;
  imageUri: string;
  imageHash: string | null;
  status: ReceiptQueueStatus;
  result: ParsedReceiptResult | null;
  error: string | null;
  createdAt: number;
}

export interface EnqueueReceiptsResult {
  added: number;
  skippedDuplicates: number;
}

interface ReceiptQueueRow {
  id: number;
  image_uri: string;
  image_hash?: string | null;
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
  /** Copies picked images into app storage (picker URIs are temporary), skips duplicates already in queue, and queues them. */
  enqueue: (uris: string[]) => Promise<EnqueueReceiptsResult>;
  retry: (id: number) => void;
  /** Removes a receipt from the queue. Pass deleteImage=false when a saved transaction now owns the image. */
  remove: (id: number, deleteImage?: boolean) => Promise<void>;
  /** Removes multiple receipts at once. */
  removeMany: (ids: number[], deleteImages?: boolean) => Promise<void>;
  /** Removes every receipt matching any of the given statuses (e.g. ['done']). Returns how many were removed. */
  clearByStatus: (statuses: ReceiptQueueStatus[]) => Promise<number>;
}

const RECEIPTS_DIR = `${FileSystem.documentDirectory ?? ''}receipts/`;

// In-memory fallback map when running against test DBs created without the image_hash column.
const inMemoryHashByUri = new Map<string, string>();

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
  return {
    id: row.id,
    imageUri: row.image_uri,
    imageHash: row.image_hash ?? inMemoryHashByUri.get(row.image_uri) ?? null,
    status,
    result,
    error: row.error,
    createdAt: row.created_at,
  };
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

async function computeImageFingerprint(uri: string): Promise<string> {
  if (typeof FileSystem.getInfoAsync === 'function') {
    try {
      const info = await FileSystem.getInfoAsync(uri, { md5: true });
      if (info && info.exists && 'md5' in info && typeof info.md5 === 'string' && info.md5.trim().length > 0) {
        return `md5:${info.md5.trim().toLowerCase()}`;
      }
    } catch {
      // Fall back to URI-based deduplication when file info/md5 is unavailable.
    }
  }
  return `uri:${uri}`;
}

function insertQueueRow(imageUri: string, imageHash: string, createdAt: number) {
  inMemoryHashByUri.set(imageUri, imageHash);
  try {
    expoDb.runSync(
      `INSERT INTO receipt_queue (image_uri, image_hash, status, created_at) VALUES (?, ?, 'pending', ?);`,
      [imageUri, imageHash, createdAt],
    );
  } catch {
    // Graceful fallback if an isolated test table predates the image_hash column.
    expoDb.runSync(`INSERT INTO receipt_queue (image_uri, status, created_at) VALUES (?, 'pending', ?);`, [
      imageUri,
      createdAt,
    ]);
  }
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
      if (uris.length === 0) return { added: 0, skippedDuplicates: 0 };
      await FileSystem.makeDirectoryAsync(RECEIPTS_DIR, { intermediates: true }).catch(() => undefined);

      // Build existing fingerprint set from persisted queue rows
      const existingItems = readAll();
      const seenFingerprints = new Set<string>();
      for (const item of existingItems) {
        if (item.imageHash) {
          seenFingerprints.add(item.imageHash);
        } else {
          const existingFp = await computeImageFingerprint(item.imageUri);
          seenFingerprints.add(existingFp);
        }
        seenFingerprints.add(`uri:${item.imageUri}`);
      }

      const now = Date.now();
      let added = 0;
      let skippedDuplicates = 0;

      for (let i = 0; i < uris.length; i++) {
        const sourceUri = uris[i];
        if (!sourceUri) continue;

        const fingerprint = await computeImageFingerprint(sourceUri);
        if (seenFingerprints.has(fingerprint) || seenFingerprints.has(`uri:${sourceUri}`)) {
          skippedDuplicates += 1;
          continue;
        }

        const extension = /\.(jpe?g|png|heic|webp)$/i.exec(sourceUri)?.[0] ?? '.jpg';
        const dest = `${RECEIPTS_DIR}receipt-${now}-${added}${extension}`;
        let stored = sourceUri;
        try {
          await FileSystem.copyAsync({ from: sourceUri, to: dest });
          stored = dest;
        } catch (error) {
          console.warn('Could not copy receipt image into app storage; using picker URI:', error);
        }

        insertQueueRow(stored, fingerprint, now + added);
        seenFingerprints.add(fingerprint);
        seenFingerprints.add(`uri:${sourceUri}`);
        seenFingerprints.add(`uri:${stored}`);
        added += 1;
      }

      refresh();
      if (added > 0) {
        void processQueue();
      }
      return { added, skippedDuplicates };
    },

    retry: (id) => {
      expoDb.runSync(`UPDATE receipt_queue SET status = 'pending', error = NULL WHERE id = ?;`, [id]);
      refresh();
      void processQueue();
    },

    remove: async (id, deleteImage = true) => {
      const item = get().items.find((entry) => entry.id === id);
      expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
      if (item) {
        inMemoryHashByUri.delete(item.imageUri);
      }
      refresh();
      if (deleteImage && item?.imageUri.startsWith(RECEIPTS_DIR)) {
        await FileSystem.deleteAsync(item.imageUri, { idempotent: true }).catch(() => undefined);
      }
    },

    removeMany: async (ids, deleteImages = true) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const targets = get().items.filter((entry) => idSet.has(entry.id));
      for (const id of ids) {
        expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
      }
      for (const item of targets) {
        inMemoryHashByUri.delete(item.imageUri);
      }
      refresh();
      if (deleteImages) {
        for (const item of targets) {
          if (item.imageUri.startsWith(RECEIPTS_DIR)) {
            await FileSystem.deleteAsync(item.imageUri, { idempotent: true }).catch(() => undefined);
          }
        }
      }
    },

    clearByStatus: async (statuses) => {
      if (statuses.length === 0) return 0;
      const statusSet = new Set(statuses);
      const targets = get().items.filter((entry) => statusSet.has(entry.status));
      if (targets.length === 0) return 0;
      await get().removeMany(
        targets.map((item) => item.id),
        true,
      );
      return targets.length;
    },
  };
});
