import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { expoDb } from '../db/index';
import { analyzeReceiptImage, type ParsedReceiptResult } from '../services/ai/agent';
import { getModelLifecycleManager } from '../services/ai/modelLifecycle';
import { useSettingsStore } from './useSettingsStore';

export type ReceiptQueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface ReceiptQueueItem {
  id: number;
  imageUri: string;
  imageHash: string | null;
  thumbnailUri: string | null;
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
  thumbnail_uri?: string | null;
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
  /** Lazily generates and persists a small JPEG thumbnail for a queue item that doesn't have one yet. */
  ensureThumbnail: (id: number, options?: { force?: boolean }) => Promise<string | null>;
  retry: (id: number) => void;
  /** Removes a receipt from the queue. Pass deleteImage=false when a saved transaction now owns the image. */
  remove: (id: number, deleteImage?: boolean) => Promise<void>;
  /** Removes multiple receipts at once. */
  removeMany: (ids: number[], deleteImages?: boolean) => Promise<void>;
  /** Removes every receipt matching any of the given statuses (e.g. ['done']). Returns how many were removed. */
  clearByStatus: (statuses: ReceiptQueueStatus[]) => Promise<number>;
}

const THUMBNAIL_WIDTH_PX = 168;
const THUMBNAIL_COMPRESS = 0.7;

function getReceiptsDir(): string {
  return `${FileSystem.documentDirectory ?? ''}receipts/`;
}

function getThumbsDir(): string {
  return `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ''}thumbs/`;
}

// In-memory fallback maps when running against test DBs created without the image_hash/thumbnail_uri columns.
const inMemoryHashByUri = new Map<string, string>();
const inMemoryThumbByUri = new Map<string, string>();

const inFlightThumbIds = new Set<number>();
const failedThumbIds = new Set<number>();
let thumbGenerationChain: Promise<void> = Promise.resolve();

export async function createReceiptThumbnail(sourceUri: string, tag: string): Promise<string | null> {
  if (!sourceUri) return null;
  try {
    const thumbsDir = getThumbsDir();
    await FileSystem.makeDirectoryAsync(thumbsDir, { intermediates: true }).catch(() => undefined);
    const manipulated = await manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMBNAIL_WIDTH_PX } }],
      { compress: THUMBNAIL_COMPRESS, format: SaveFormat.JPEG },
    );
    if (!manipulated?.uri) return null;

    const dest = `${thumbsDir}thumb-${tag}.jpg`;
    if (typeof FileSystem.moveAsync === 'function' && manipulated.uri !== dest) {
      try {
        await FileSystem.moveAsync({ from: manipulated.uri, to: dest });
        return dest;
      } catch {
        return manipulated.uri;
      }
    }
    return manipulated.uri;
  } catch (error) {
    console.warn('Could not create receipt thumbnail; falling back to original image:', error);
    return null;
  }
}

async function deleteThumbnailQuietly(thumbnailUri: string | null | undefined, originalImageUri: string) {
  if (!thumbnailUri || thumbnailUri === originalImageUri) return;
  await FileSystem.deleteAsync(thumbnailUri, { idempotent: true }).catch(() => undefined);
}

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
    thumbnailUri: row.thumbnail_uri ?? inMemoryThumbByUri.get(row.image_uri) ?? null,
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

function insertQueueRow(imageUri: string, imageHash: string, thumbnailUri: string | null, createdAt: number) {
  inMemoryHashByUri.set(imageUri, imageHash);
  if (thumbnailUri) {
    inMemoryThumbByUri.set(imageUri, thumbnailUri);
  }
  try {
    expoDb.runSync(
      `INSERT INTO receipt_queue (image_uri, image_hash, thumbnail_uri, status, created_at) VALUES (?, ?, ?, 'pending', ?);`,
      [imageUri, imageHash, thumbnailUri, createdAt],
    );
  } catch {
    try {
      // Graceful fallback if an isolated test table predates the thumbnail_uri column.
      expoDb.runSync(
        `INSERT INTO receipt_queue (image_uri, image_hash, status, created_at) VALUES (?, ?, 'pending', ?);`,
        [imageUri, imageHash, createdAt],
      );
    } catch {
      // Graceful fallback if an isolated test table predates both image_hash and thumbnail_uri.
      expoDb.runSync(`INSERT INTO receipt_queue (image_uri, status, created_at) VALUES (?, 'pending', ?);`, [
        imageUri,
        createdAt,
      ]);
    }
  }
}

function persistThumbnailUri(id: number, imageUri: string, thumbnailUri: string) {
  inMemoryThumbByUri.set(imageUri, thumbnailUri);
  try {
    expoDb.runSync(`UPDATE receipt_queue SET thumbnail_uri = ? WHERE id = ?;`, [thumbnailUri, id]);
  } catch {
    // Graceful fallback if an isolated test table predates thumbnail_uri.
  }
}

export const useReceiptQueueStore = create<ReceiptQueueState>((set, get) => {
  const refresh = () => set({ items: readAll() });

  // Reads queued receipts one at a time; the generation service serializes model access with chat and single scans.
  const processQueue = async () => {
    if (get().isProcessing) return;
    if (!get().items.some((item) => item.status === 'pending')) return;
    set({ isProcessing: true });
    try {
      // Wait for SQLite settings and either SecureStore secrets (external mode) or shared
      // model lifecycle init (local mode) before starting launch-time queued AI requests.
      await useSettingsStore.getState().waitForSettingsLoaded?.();
      if (useSettingsStore.getState().aiInferenceMode === 'external') {
        await useSettingsStore.getState().waitForSecretsHydrated?.();
      } else {
        await getModelLifecycleManager?.()?.ensureInitialized?.();
      }

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
      failedThumbIds.clear();
      expoDb.runSync(`UPDATE receipt_queue SET status = 'pending' WHERE status = 'processing';`);
      refresh();
      void processQueue();
    },

    enqueue: async (uris) => {
      if (uris.length === 0) return { added: 0, skippedDuplicates: 0 };
      const receiptsDir = getReceiptsDir();
      await FileSystem.makeDirectoryAsync(receiptsDir, { intermediates: true }).catch(() => undefined);

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
        const dest = `${receiptsDir}receipt-${now}-${added}${extension}`;
        let stored = sourceUri;
        try {
          await FileSystem.copyAsync({ from: sourceUri, to: dest });
          stored = dest;
        } catch (error) {
          console.warn('Could not copy receipt image into app storage; using picker URI:', error);
        }

        const thumbnailUri = await createReceiptThumbnail(stored, `${now}-${added}`);
        insertQueueRow(stored, fingerprint, thumbnailUri, now + added);
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

    ensureThumbnail: async (id, options) => {
      const force = Boolean(options?.force);
      const initial = get().items.find((entry) => entry.id === id);
      if (!initial) return null;
      if (!force && initial.thumbnailUri) return initial.thumbnailUri;
      if (!force && failedThumbIds.has(id)) return null;
      if (inFlightThumbIds.has(id)) return null;

      inFlightThumbIds.add(id);
      let resolvedThumbUri: string | null = null;

      const task = thumbGenerationChain.then(async () => {
        try {
          const current = get().items.find((entry) => entry.id === id);
          if (!current) return;
          if (!force && current.thumbnailUri) {
            resolvedThumbUri = current.thumbnailUri;
            return;
          }

          const previousThumb = current.thumbnailUri;
          const nextThumb = await createReceiptThumbnail(current.imageUri, `${id}-${Date.now()}`);
          if (!nextThumb) {
            failedThumbIds.add(id);
            return;
          }

          const stillPresent = get().items.find((entry) => entry.id === id);
          if (!stillPresent) {
            // Item was removed while thumbnail was being generated; clean up orphan file.
            await deleteThumbnailQuietly(nextThumb, current.imageUri);
            return;
          }

          failedThumbIds.delete(id);
          persistThumbnailUri(id, stillPresent.imageUri, nextThumb);
          resolvedThumbUri = nextThumb;
          set((state) => ({
            items: state.items.map((entry) =>
              entry.id === id ? { ...entry, thumbnailUri: nextThumb } : entry,
            ),
          }));

          if (previousThumb && previousThumb !== nextThumb) {
            await deleteThumbnailQuietly(previousThumb, stillPresent.imageUri);
          }
        } finally {
          inFlightThumbIds.delete(id);
        }
      });

      thumbGenerationChain = task.catch(() => undefined);
      await task;
      return resolvedThumbUri;
    },

    retry: (id) => {
      expoDb.runSync(`UPDATE receipt_queue SET status = 'pending', error = NULL WHERE id = ?;`, [id]);
      refresh();
      void processQueue();
    },

    remove: async (id, deleteImage = true) => {
      const item = get().items.find((entry) => entry.id === id);
      expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
      failedThumbIds.delete(id);
      if (item) {
        inMemoryHashByUri.delete(item.imageUri);
        inMemoryThumbByUri.delete(item.imageUri);
      }
      refresh();
      const receiptsDir = getReceiptsDir();
      if (deleteImage && item?.imageUri.startsWith(receiptsDir)) {
        await FileSystem.deleteAsync(item.imageUri, { idempotent: true }).catch(() => undefined);
      }
      if (item) {
        await deleteThumbnailQuietly(item.thumbnailUri, item.imageUri);
      }
    },

    removeMany: async (ids, deleteImages = true) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const targets = get().items.filter((entry) => idSet.has(entry.id));
      for (const id of ids) {
        expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
        failedThumbIds.delete(id);
      }
      for (const item of targets) {
        inMemoryHashByUri.delete(item.imageUri);
        inMemoryThumbByUri.delete(item.imageUri);
      }
      refresh();
      const receiptsDir = getReceiptsDir();
      for (const item of targets) {
        if (deleteImages && item.imageUri.startsWith(receiptsDir)) {
          await FileSystem.deleteAsync(item.imageUri, { idempotent: true }).catch(() => undefined);
        }
        await deleteThumbnailQuietly(item.thumbnailUri, item.imageUri);
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
