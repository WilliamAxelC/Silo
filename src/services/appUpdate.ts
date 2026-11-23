import * as FileSystem from 'expo-file-system/legacy';
import { Linking } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { create } from 'zustand';

import { recordError } from './errorLog';
import { getInstalledVersion, type UpdateManifest } from './updates';

/**
 * In-app updates for the sideloaded APK: download from the download site, check the SHA-256 from
 * version.json and that the file really is a newer Silo, then hand it to Android's package installer
 * (the user confirms there). Android never lets an app replace itself silently.
 */
export const SILO_PACKAGE = 'com.LCSdev.silo';

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

  start: async (manifest) => {
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
      set({ status: 'needs-permission', error: null });
      return;
    }
    try {
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
