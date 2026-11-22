import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { expoDb } from '../db/index';
import { analyzeReceiptImage, type ParsedReceiptResult } from '../services/ai/agent';
import { getModelLifecycleManager } from '../services/ai/modelLifecycle';
import { useSettingsStore } from './useSettingsStore';
import { normalizeReceiptImage, startBackgroundWork, stopBackgroundWork } from '../services/ocr/normalizeImage';

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
  /** Gallery import still to be turned into a document-style scan before reading. */
  needsScan?: boolean;
}

/** A receipt already saved as a transaction, kept briefly so it can be reopened and fixed. */
export interface SavedReceipt {
  id: number;
  imageUri: string;
  thumbnailUri: string | null;
  transactionId: number | null;
  savedAt: number;
  result: ParsedReceiptResult | null;
}

/** Saved receipts stay in the "Recently saved" history this long. */
export const SAVED_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;

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
  needs_scan?: number | null;
  transaction_id?: number | null;
  saved_at?: number | null;
}

interface ReceiptQueueState {
  items: ReceiptQueueItem[];
  /** Recently saved receipts (newest first), for going back to fix a transaction. */
  savedItems: SavedReceipt[];
  isProcessing: boolean;
  /** Loads the queue, re-queues receipts interrupted by an app restart, and resumes processing. */
  load: () => void;
  /** Copies picked images into app storage (picker URIs are temporary), skips duplicates already in queue, and queues them. */
  enqueue: (uris: string[], options?: { scan?: boolean }) => Promise<EnqueueReceiptsResult>;
  /** Moves a reviewed receipt into the "Recently saved" history, linked to the transaction it became. */
  markSaved: (id: number, transactionId: number | null) => void;
  /** Drops a receipt from the "Recently saved" history (the transaction and its photo are kept). */
  removeSaved: (id: number) => Promise<void>;
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
    needsScan: row.needs_scan === 1,
  };
}

function readAll(): ReceiptQueueItem[] {
  return expoDb
    .getAllSync<ReceiptQueueRow>('SELECT * FROM receipt_queue ORDER BY created_at ASC, id ASC;')
    .filter((row) => row.status !== 'saved')
    .map(toItem);
}

function readSaved(): SavedReceipt[] {
  try {
    return expoDb
      .getAllSync<ReceiptQueueRow>(`SELECT * FROM receipt_queue WHERE status = 'saved' ORDER BY saved_at DESC, id DESC;`)
      .map((row) => {
        const item = toItem(row);
        return {
          id: row.id,
          imageUri: row.image_uri,
          thumbnailUri: item.thumbnailUri,
          transactionId: row.transaction_id ?? null,
          savedAt: row.saved_at ?? row.created_at,
          result: item.result,
        };
      });
  } catch {
    return [];
  }
}

/** Fingerprints of every stored receipt, including saved history, so re-importing a photo is caught. */
function readAllFingerprintRows(): ReceiptQueueRow[] {
  return expoDb.getAllSync<ReceiptQueueRow>('SELECT * FROM receipt_queue;');
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

function insertQueueRow(
  imageUri: string,
  imageHash: string,
  thumbnailUri: string | null,
  createdAt: number,
  needsScan = false,
) {
  inMemoryHashByUri.set(imageUri, imageHash);
  if (thumbnailUri) {
    inMemoryThumbByUri.set(imageUri, thumbnailUri);
  }
  try {
    expoDb.runSync(
      `INSERT INTO receipt_queue (image_uri, image_hash, thumbnail_uri, status, created_at, needs_scan) VALUES (?, ?, ?, 'pending', ?, ?);`,
      [imageUri, imageHash, thumbnailUri, createdAt, needsScan ? 1 : 0],
    );
    return;
  } catch {
    // Older test tables without needs_scan fall through to the plain insert below.
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

function persistImageHash(id: number, imageUri: string, imageHash: string) {
  inMemoryHashByUri.set(imageUri, imageHash);
  try {
    expoDb.runSync(`UPDATE receipt_queue SET image_hash = ? WHERE id = ?;`, [imageHash, id]);
  } catch {
    // Graceful fallback if an isolated test table predates image_hash.
  }
}

export const useReceiptQueueStore = create<ReceiptQueueState>((set, get) => {
  const refresh = () => set({ items: readAll(), savedItems: readSaved() });

  /** Turns a gallery import into a document-style scan (cropped, black and white) and swaps the stored image. */
  const scanQueuedImage = async (item: ReceiptQueueItem): Promise<string> => {
    const scanned = await normalizeReceiptImage(item.imageUri);
    let nextUri = item.imageUri;
    if (scanned) {
      const dest = `${getReceiptsDir()}receipt-scan-${item.id}-${Date.now()}.jpg`;
      try {
        await FileSystem.copyAsync({ from: scanned, to: dest });
        nextUri = dest;
        await FileSystem.deleteAsync(scanned, { idempotent: true }).catch(() => undefined);
        if (item.imageUri.startsWith(getReceiptsDir())) {
          await FileSystem.deleteAsync(item.imageUri, { idempotent: true }).catch(() => undefined);
        }
      } catch (error) {
        console.warn('Could not store the scanned receipt; keeping the original photo:', error);
      }
    }
    try {
      expoDb.runSync(`UPDATE receipt_queue SET image_uri = ?, needs_scan = 0 WHERE id = ?;`, [nextUri, item.id]);
    } catch {
      // Older test tables without needs_scan.
    }
    if (nextUri !== item.imageUri) {
      inMemoryHashByUri.set(nextUri, item.imageHash ?? `uri:${nextUri}`);
      const thumb = await createReceiptThumbnail(nextUri, `scan-${item.id}-${Date.now()}`);
      if (thumb) {
        await deleteThumbnailQuietly(item.thumbnailUri, item.imageUri);
        persistThumbnailUri(item.id, nextUri, thumb);
      }
    }
    return nextUri;
  };

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

      let done = 0;
      for (;;) {
        const next = get().items.find((item) => item.status === 'pending');
        if (!next) break;
        const remaining = get().items.filter((item) => item.status === 'pending').length;
        // Keeps reading with the app in the background (Android foreground service + notification).
        startBackgroundWork(`Reading receipts: ${done + 1} of ${done + remaining}`);

        expoDb.runSync(`UPDATE receipt_queue SET status = 'processing', error = NULL WHERE id = ?;`, [next.id]);
        refresh();
        try {
          const imageUri = next.needsScan ? await scanQueuedImage(next) : next.imageUri;
          const result = await analyzeReceiptImage(imageUri);
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
        done += 1;
        refresh();
      }
    } finally {
      stopBackgroundWork();
      set({ isProcessing: false });
    }
  };

  return {
    items: [],
    savedItems: [],
    isProcessing: false,

    load: () => {
      failedThumbIds.clear();
      expoDb.runSync(`UPDATE receipt_queue SET status = 'pending' WHERE status = 'processing';`);
      // Forget history older than two weeks (the transactions keep their photos).
      for (const old of readSaved().filter((entry) => Date.now() - entry.savedAt > SAVED_HISTORY_MS)) {
        expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [old.id]);
        void deleteThumbnailQuietly(old.thumbnailUri, old.imageUri);
      }
      refresh();
      void processQueue();
    },

    markSaved: (id, transactionId) => {
      try {
        expoDb.runSync(`UPDATE receipt_queue SET status = 'saved', transaction_id = ?, saved_at = ? WHERE id = ?;`, [
          transactionId,
          Date.now(),
          id,
        ]);
      } catch {
        // Older test tables without the history columns: drop the row like before.
        expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
      }
      refresh();
    },

    removeSaved: async (id) => {
      const entry = get().savedItems.find((item) => item.id === id);
      expoDb.runSync('DELETE FROM receipt_queue WHERE id = ?;', [id]);
      refresh();
      if (entry) await deleteThumbnailQuietly(entry.thumbnailUri, entry.imageUri);
    },

    enqueue: async (uris, options) => {
      if (uris.length === 0) return { added: 0, skippedDuplicates: 0 };
      const receiptsDir = getReceiptsDir();
      await FileSystem.makeDirectoryAsync(receiptsDir, { intermediates: true }).catch(() => undefined);

      // Build existing fingerprint set from persisted queue rows (including the saved history)
      const existingItems = readAllFingerprintRows().map(toItem);
      const seenFingerprints = new Set<string>();
      for (const item of existingItems) {
        if (item.imageHash) {
          seenFingerprints.add(item.imageHash);
        } else {
          const existingFp = await computeImageFingerprint(item.imageUri);
          persistImageHash(item.id, item.imageUri, existingFp);
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
        insertQueueRow(stored, fingerprint, thumbnailUri, now + added, Boolean(options?.scan));
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
