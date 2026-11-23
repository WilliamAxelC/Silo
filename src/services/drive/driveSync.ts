import * as FileSystem from 'expo-file-system/legacy';
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { create } from 'zustand';

import { expoDb } from '../../db/index';
import { createBackupFile, restoreBackupFile } from '../backup';
import { recordError } from '../errorLog';
import { getConnectedAccount, getDriveAccessToken } from './googleAuth';
import { deleteFile, downloadFile, DriveError, ensureFolder, listFiles, uploadFile, type DriveFile } from './driveApi';

/**
 * Google Drive sync, all inside a "Silo" folder Silo creates in the user's Drive:
 *   Silo/Backups   one database backup a day (newest DRIVE_BACKUP_KEEP kept)
 *   Silo/Receipts  receipt photos older than N months, moved off the phone (a thumbnail stays)
 */
export const DRIVE_BACKUP_KEEP = 30;
const FOLDERS_KEY = 'driveFolders';
const LAST_BACKUP_KEY = 'driveLastBackupAt';
const AUTO_KEY = 'driveAutoBackup';
const OFFLOAD_KEY = 'driveOffloadMonths';
const LAST_OFFLOAD_KEY = 'driveLastOffloadAt';

function readSetting(key: string): string | null {
  try {
    return expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [key])?.value ?? null;
  } catch {
    return null;
  }
}
function writeSetting(key: string, value: string) {
  expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [key, value]);
}

const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function isDriveAutoBackupOn(): boolean {
  return readSetting(AUTO_KEY) !== 'false';
}
export function setDriveAutoBackup(on: boolean) {
  writeSetting(AUTO_KEY, on ? 'true' : 'false');
}
/** 0 = keep all receipt photos on the phone. */
export function getOffloadMonths(): number {
  const n = Number(readSetting(OFFLOAD_KEY) ?? 0);
  return [0, 3, 6, 12].includes(n) ? n : 0;
}
export function setOffloadMonths(months: number) {
  writeSetting(OFFLOAD_KEY, String(months));
}
export function getLastDriveBackupAt(): number | null {
  const n = Number(readSetting(LAST_BACKUP_KEY) ?? 0);
  return n > 0 ? n : null;
}

type Folders = { silo: string; backups: string; receipts: string };

async function folders(token: string, fresh = false): Promise<Folders> {
  if (!fresh) {
    try {
      const cached = JSON.parse(readSetting(FOLDERS_KEY) ?? 'null');
      if (cached?.silo && cached?.backups && cached?.receipts) return cached;
    } catch {
      // re-resolve below
    }
  }
  const silo = await ensureFolder(token, 'Silo');
  const result = { silo, backups: await ensureFolder(token, 'Backups', silo), receipts: await ensureFolder(token, 'Receipts', silo) };
  writeSetting(FOLDERS_KEY, JSON.stringify(result));
  return result;
}

/** Runs a Drive step; if a cached folder was deleted by the user (404), re-creates folders once. */
async function withFolders<T>(token: string, fn: (f: Folders) => Promise<T>): Promise<T> {
  try {
    return await fn(await folders(token));
  } catch (error) {
    if (error instanceof DriveError && error.status === 404) return fn(await folders(token, true));
    throw error;
  }
}

/** Uploads today's backup (replacing an earlier one from today) and keeps the newest 30. */
export async function backupToDrive(now = new Date()): Promise<string> {
  const token = await getDriveAccessToken();
  const name = `silo-backup-${dateKey(now)}.db`;
  const local = await createBackupFile(now);
  try {
    await withFolders(token, async (f) => {
      const existing = await listFiles(token, f.backups);
      await uploadFile(token, local, name, f.backups, 'application/x-sqlite3');
      for (const old of existing.filter((e) => e.name === name)) await deleteFile(token, old.id);
      const all = (await listFiles(token, f.backups)).filter((e) => /^silo-backup-\d{4}-\d{2}-\d{2}\.db$/.test(e.name));
      for (const extra of all.slice(DRIVE_BACKUP_KEEP)) await deleteFile(token, extra.id);
    });
  } finally {
    await FileSystem.deleteAsync(local, { idempotent: true }).catch(() => undefined);
  }
  writeSetting(LAST_BACKUP_KEY, String(now.getTime()));
  return name;
}

export async function listDriveBackups(): Promise<DriveFile[]> {
  const token = await getDriveAccessToken();
  return withFolders(token, (f) => listFiles(token, f.backups));
}

/** Downloads a Drive backup to the cache; the caller restores it (and deletes the file afterwards). */
export async function downloadDriveBackup(fileId: string): Promise<string> {
  const token = await getDriveAccessToken();
  return downloadFile(token, fileId, `${FileSystem.cacheDirectory ?? ''}drive-restore-${Date.now()}.db`);
}

export async function restoreFromDrive(fileId: string): Promise<{ transactions: number }> {
  const token = await getDriveAccessToken();
  const temp = `${FileSystem.cacheDirectory ?? ''}drive-restore-${Date.now()}.db`;
  await downloadFile(token, fileId, temp);
  try {
    return await restoreBackupFile(temp);
  } finally {
    await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => undefined);
  }
}

const receiptsDir = () => `${FileSystem.documentDirectory ?? ''}receipts/`;

/**
 * Moves receipt photos of transactions older than `months` to Drive, leaving a small thumbnail.
 * Returns how many moved and roughly how many bytes were freed.
 */
export async function offloadOldReceipts(months: number, now = new Date()): Promise<{ moved: number; freedBytes: number }> {
  if (months <= 0) return { moved: 0, freedBytes: 0 };
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate()).getTime();
  const rows = expoDb.getAllSync<{ id: number; image_uri: string }>(
    `SELECT t.id, t.image_uri FROM transactions t
       WHERE t.image_uri LIKE ? AND t.date < ? AND t.id NOT IN (SELECT transaction_id FROM drive_receipts)
       ORDER BY t.date LIMIT 200;`,
    [`${receiptsDir()}%`, cutoff],
  );
  if (rows.length === 0) return { moved: 0, freedBytes: 0 };
  const token = await getDriveAccessToken();
  const thumbs = `${receiptsDir()}thumbs/`;
  await FileSystem.makeDirectoryAsync(thumbs, { intermediates: true }).catch(() => undefined);
  let moved = 0;
  let freedBytes = 0;
  await withFolders(token, async (f) => {
    for (const row of rows) {
      const info = await FileSystem.getInfoAsync(row.image_uri);
      if (!info.exists) continue;
      const base = row.image_uri.split('/').pop() || `receipt-${row.id}.jpg`;
      const driveId = await uploadFile(token, row.image_uri, `receipt-${row.id}-${base}`, f.receipts, 'image/jpeg');
      const thumb = await manipulateAsync(row.image_uri, [{ resize: { width: 320 } }], { compress: 0.6, format: SaveFormat.JPEG });
      const thumbUri = `${thumbs}${base}`;
      await FileSystem.moveAsync({ from: thumb.uri, to: thumbUri });
      expoDb.withTransactionSync(() => {
        expoDb.runSync('UPDATE transactions SET image_uri = ? WHERE id = ?;', [thumbUri, row.id]);
        expoDb.runSync('INSERT OR REPLACE INTO drive_receipts (transaction_id, drive_file_id, thumb_uri, offloaded_at) VALUES (?, ?, ?, ?);', [
          row.id,
          driveId,
          thumbUri,
          now.getTime(),
        ]);
      });
      await FileSystem.deleteAsync(row.image_uri, { idempotent: true });
      freedBytes += (info as { size?: number }).size ?? 0;
      moved += 1;
    }
  });
  writeSetting(LAST_OFFLOAD_KEY, String(now.getTime()));
  return { moved, freedBytes };
}

/**
 * The full-size photo for a receipt that was moved to Drive, downloaded to the cache on demand.
 * Returns null when the transaction's photo is local (or was replaced since it moved).
 */
export async function fetchFullReceipt(transactionId: number, currentImageUri: string | null | undefined): Promise<string | null> {
  const row = expoDb.getFirstSync<{ drive_file_id: string; thumb_uri: string }>(
    'SELECT drive_file_id, thumb_uri FROM drive_receipts WHERE transaction_id = ?;',
    [transactionId],
  );
  if (!row || row.thumb_uri !== currentImageUri) return null;
  const dir = `${FileSystem.cacheDirectory ?? ''}drive-receipts/`;
  const local = `${dir}${row.drive_file_id}.jpg`;
  if ((await FileSystem.getInfoAsync(local)).exists) return local;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  return downloadFile(await getDriveAccessToken(), row.drive_file_id, local);
}

/** Daily: Drive backup (if on) and moving old receipt photos (if chosen). Never throws. */
export async function runDriveSyncIfDue(now = new Date()): Promise<void> {
  if (!getConnectedAccount()) return;
  const today = dateKey(now);
  try {
    const last = getLastDriveBackupAt();
    if (isDriveAutoBackupOn() && (!last || dateKey(new Date(last)) !== today)) {
      await backupToDrive(now);
    }
    const months = getOffloadMonths();
    const lastOffload = Number(readSetting(LAST_OFFLOAD_KEY) ?? 0);
    if (months > 0 && (!lastOffload || dateKey(new Date(lastOffload)) !== today)) {
      await offloadOldReceipts(months, now);
    }
    useDriveStore.getState().refresh();
  } catch (error) {
    recordError(error, 'error');
    useDriveStore.setState({ lastError: error instanceof Error ? error.message : 'Drive sync failed.' });
  }
}

interface DriveState {
  account: string | null;
  lastBackupAt: number | null;
  autoBackup: boolean;
  offloadMonths: number;
  busy: string | null;
  lastError: string | null;
  refresh: () => void;
}

export const useDriveStore = create<DriveState>((set) => ({
  account: null,
  lastBackupAt: null,
  autoBackup: true,
  offloadMonths: 0,
  busy: null,
  lastError: null,
  refresh: () =>
    set({
      account: getConnectedAccount(),
      lastBackupAt: getLastDriveBackupAt(),
      autoBackup: isDriveAutoBackupOn(),
      offloadMonths: getOffloadMonths(),
    }),
}));
