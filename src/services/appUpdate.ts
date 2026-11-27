import * as FileSystem from 'expo-file-system/legacy';
import { Linking } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { create } from 'zustand';

import { expoDb } from '../db/index';
import { recordError } from './errorLog';
import { getInstalledVersion, useUpdateStore, type UpdateManifest } from './updates';
import { isPlayBuild } from './distribution';

/**
 * Android kills Silo's process when the user grants "Install unknown apps", so an update waiting for that
 * permission is remembered here and resumed on the next start (resumePendingUpdate).
 */
const PENDING_KEY = 'pendingUpdateInstall';
function setPending(versionCode: number | null) {
  try {
    if (versionCode) expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [PENDING_KEY, String(versionCode)]);
    else expoDb.runSync('DELETE FROM app_settings WHERE key = ?;', [PENDING_KEY]);
  } catch {
    // best effort
  }
}
function getPending(): number {
  try {
    return Number(expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [PENDING_KEY])?.value ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * In-app updates for the sideloaded APK: download from the download site, check the SHA-256 from
 * version.json and that the file really is a newer Silo, then hand it to Android's package installer
 * (the user confirms there). Android never lets an app replace itself silently.
 */
export const SILO_PACKAGE = 'dev.cuang.silo';

interface UpdateNative {
  sha256File(uri: string): Promise<string>;
  canInstallPackages(): boolean;
  openInstallPermissionSettings(): boolean;
  inspectApk(uri: string): { packageName: string; versionCode: number; versionName: string } | null;
  installApk(uri: string): boolean;
}

// Local Expo module (modules/receipt-normalize); absent in Expo Go, iOS and Jest.
let native: UpdateNative | null = requireOptionalNativeModule<UpdateNative>('ReceiptNormalize');

export type UpdateStatus = 'idle' | 'downloading' | 'verifying' | 'needs-permission' | 'installing' | 'error';

interface AppUpdateState {
  status: UpdateStatus;
  progress: number;
  error: string | null;
  fileUri: string | null;
  /** The update shown in the (app-wide) update sheet; null when closed. */
  sheet: UpdateManifest | null;
  openSheet: (manifest: UpdateManifest) => void;
  closeSheet: () => void;
  start: (manifest: UpdateManifest) => Promise<void>;
  /** After the user allowed "Install unknown apps" (or to retry the installer). */
  install: () => void;
  openPermissionSettings: () => void;
  cancel: () => Promise<void>;
  reset: () => void;
}

export function updatesDir(): string {
  return `${FileSystem.cacheDirectory ?? ''}updates/`;
}

let download: FileSystem.DownloadResumable | null = null;

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  status: 'idle',
  progress: 0,
  error: null,
  fileUri: null,
  sheet: null,
  openSheet: (manifest) => set({ sheet: isPlayBuild() ? null : manifest }),
  closeSheet: () => set((s) => ({ sheet: null, ...(s.status === 'error' ? { status: 'idle' as const, error: null } : {}) })),

  start: async (manifest) => {
    if (isPlayBuild()) return; // Play policy: apps from Google Play must not install their own updates.
    if (get().status === 'downloading' || get().status === 'verifying') return;
    const apk = manifest.apk;
    if (!apk || !native) {
      // Older manifest or no native support: the download page still works.
      await Linking.openURL(manifest.url);
      return;
    }
    const installed = getInstalledVersion();
    if (manifest.versionCode <= installed.versionCode) {
      set({ status: 'error', error: 'You already have this version.' });
      return;
    }
    const dir = updatesDir();
    const fileUri = `${dir}silo-${manifest.version}-${manifest.versionCode}.apk`;
    set({ status: 'downloading', progress: 0, error: null, fileUri });
    try {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const existing = await FileSystem.getInfoAsync(fileUri);
      let haveFile = existing.exists && (existing as { size?: number }).size === apk.sizeBytes;
      if (haveFile && (await native.sha256File(fileUri)) !== apk.sha256) haveFile = false;
      if (!haveFile) {
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
        download = FileSystem.createDownloadResumable(apk.url, fileUri, {}, (p) => {
          const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : apk.sizeBytes;
          set({ progress: Math.min(1, p.totalBytesWritten / total) });
        });
        const result = await download.downloadAsync();
        download = null;
        if (!result) return; // cancelled
        if (result.status !== 200) throw new UpdateError(`The download failed (HTTP ${result.status}). Please try again.`);
      }

      set({ status: 'verifying', progress: 1 });
      const sha = await native.sha256File(fileUri);
      if (sha !== apk.sha256) {
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
        throw new UpdateError('The downloaded file did not match the published checksum, so it was deleted. Nothing was installed.');
      }
      const info = native.inspectApk(fileUri);
      if (!info || info.packageName !== SILO_PACKAGE || info.versionCode !== manifest.versionCode) {
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
        throw new UpdateError('The downloaded file is not the expected Silo version, so it was deleted.');
      }
      get().install();
    } catch (error) {
      download = null;
      if (!(error instanceof UpdateError)) recordError(error, 'error');
      set({
        status: 'error',
        error: error instanceof UpdateError ? error.message : "Couldn't download the update. Check your connection and try again.",
      });
    }
  },

  install: () => {
    const { fileUri } = get();
    if (!native || !fileUri) return;
    if (!native.canInstallPackages()) {
      const code = Number(/-(\d+)\.apk$/.exec(fileUri)?.[1] ?? 0);
      setPending(code || null);
      set({ status: 'needs-permission', error: null });
      return;
    }
    try {
      setPending(null);
      native.installApk(fileUri);
      set({ status: 'installing', error: null });
    } catch (error) {
      recordError(error, 'error');
      set({ status: 'error', error: "Android's installer could not be opened." });
    }
  },

  openPermissionSettings: () => {
    try {
      native?.openInstallPermissionSettings();
    } catch (error) {
      recordError(error, 'error');
    }
  },

  cancel: async () => {
    const current = download;
    download = null;
    try {
      await current?.pauseAsync();
    } catch {
      // already finished
    }
    const { fileUri } = get();
    if (fileUri) await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => undefined);
    set({ status: 'idle', progress: 0, error: null, fileUri: null });
  },

  reset: () => set({ status: 'idle', progress: 0, error: null }),
}));

class UpdateError extends Error {}

/**
 * Called at startup: if Silo was restarted while waiting for the install permission (Android does that
 * when the permission is granted), reopen the update and continue. The file is re-verified before install.
 */
export async function resumePendingUpdate(): Promise<boolean> {
  const pending = getPending();
  if (!pending) return false;
  const latest = useUpdateStore.getState().latest;
  if (!latest || latest.versionCode !== pending || latest.versionCode <= getInstalledVersion().versionCode) {
    setPending(null);
    return false;
  }
  if (!native?.canInstallPackages()) return false; // still waiting; the banner/More stay available
  const store = useAppUpdateStore.getState();
  store.openSheet(latest);
  await store.start(latest);
  return true;
}

/** Deletes downloaded update APKs once they are installed (or older than what is running). */
export async function cleanUpInstalledUpdates(): Promise<void> {
  const installed = getInstalledVersion().versionCode;
  try {
    const dir = updatesDir();
    for (const name of await FileSystem.readDirectoryAsync(dir)) {
      const code = Number(/-(\d+)\.apk$/.exec(name)?.[1] ?? 0);
      if (!code || code <= installed) await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
    }
  } catch {
    // no updates folder yet
  }
}

/** For tests. */
export function __setUpdateNativeForTests(value: UpdateNative | null) {
  native = value;
}
