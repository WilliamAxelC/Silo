import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Android model downloads in a foreground service (modules/receipt-normalize ModelDownloadService): they keep
 * going with Silo in the background, show a progress notification with Pause / Cancel, and resume from the
 * partial file (HTTP Range) after a pause, a dropped connection or Silo being killed.
 *
 * `createNativeDownloadResumable` wraps it in the same shape as expo-file-system's DownloadResumable so the
 * model lifecycle can use either. Absent in Jest, Expo Go and iOS; callers fall back to expo-file-system.
 */

export type NativeDownloadStatus =
  'downloading' | 'waiting' | 'verifying' | 'paused' | 'done' | 'failed' | 'cancelled';

export type NativeDownloadState = {
  id: string;
  status: NativeDownloadStatus;
  path: string;
  downloadedBytes: number;
  totalBytes: number | null;
  bytesPerSecond?: number | null;
  message?: string | null;
  /** True while bytes are moving in this process. */
  active?: boolean;
  updatedAt?: number;
};

type StartOptions = {
  id: string;
  url: string;
  path: string;
  title: string;
  doneTitle?: string;
  totalBytes?: number;
  sha256?: string;
  wifiOnly?: boolean;
  pausable?: boolean;
  restart?: boolean;
};

interface ModelDownloadNative {
  startModelDownload?(options: StartOptions): boolean;
  pauseModelDownload?(id: string): boolean;
  cancelModelDownload?(id: string): boolean;
  getModelDownload?(id: string): NativeDownloadState | null;
  dismissModelDownloadNotification?(): boolean;
  addListener?(
    event: 'onModelDownload',
    listener: (state: NativeDownloadState) => void,
  ): { remove(): void };
}

/** Stored as the transfer manifest's resumeData: the partial file itself is the resume point. */
export const NATIVE_RESUME_DATA = 'native-range';

const STOP_TIMEOUT_MS = 10_000;

let nativeOverride: ModelDownloadNative | null | undefined;
let cachedNative: ModelDownloadNative | null | undefined;

function getNative(): ModelDownloadNative | null {
  if (nativeOverride !== undefined) {
    return nativeOverride;
  }
  if (cachedNative === undefined) {
    try {
      cachedNative = requireOptionalNativeModule<ModelDownloadNative>('ReceiptNormalize');
    } catch {
      cachedNative = null;
    }
  }
  return cachedNative;
}

/** Tests only: replace the native module (null = unavailable, undefined = the real lookup). */
export function setModelDownloadNativeForTests(native: ModelDownloadNative | null | undefined) {
  nativeOverride = native;
}

export function isNativeModelDownloadAvailable(): boolean {
  const native = getNative();
  return Boolean(native?.startModelDownload && native.addListener);
}

export function getNativeModelDownload(id: string): NativeDownloadState | null {
  try {
    return getNative()?.getModelDownload?.(id) ?? null;
  } catch {
    return null;
  }
}

/** Cancels a paused (or running) download that has no JS handle, deleting its partial file and notification. */
export function cancelNativeModelDownload(id: string): void {
  try {
    getNative()?.cancelModelDownload?.(id);
  } catch {
    // ignore
  }
}

export function dismissModelDownloadNotification(): void {
  try {
    getNative()?.dismissModelDownloadNotification?.();
  } catch {
    // ignore
  }
}

type DownloadProgress = { totalBytesExpectedToWrite: number; totalBytesWritten: number };

export type NativeDownloadOptions = {
  id: string;
  title: string;
  doneTitle?: string;
  totalBytes?: number;
  sha256?: string;
  wifiOnly?: boolean;
  pausable?: boolean;
  /** Paused or cancelled from the notification (or by Android), not through pauseAsync / cancelAsync. */
  onExternalStop?: (state: NativeDownloadState) => void;
};

export type NativeDownloadResumable = {
  downloadAsync: () => Promise<{ uri: string } | undefined>;
  resumeAsync: () => Promise<{ uri: string } | undefined>;
  pauseAsync: () => Promise<{ resumeData?: string } | undefined>;
  cancelAsync: () => Promise<void>;
};

export function createNativeDownloadResumable(
  url: string,
  fileUri: string,
  options: NativeDownloadOptions,
  onProgress?: (progress: DownloadProgress) => void,
): NativeDownloadResumable {
  const native = getNative();
  let subscription: { remove(): void } | null = null;
  let pending: {
    resolve: (value: { uri: string } | undefined) => void;
    reject: (error: Error) => void;
  } | null = null;
  let requested: 'pause' | 'cancel' | null = null;
  let stopWaiter: (() => void) | null = null;

  const settle = (outcome: { value?: { uri: string } | undefined; error?: Error }) => {
    const current = pending;
    pending = null;
    subscription?.remove();
    subscription = null;
    if (!current) {
      return;
    }
    if (outcome.error) {
      current.reject(outcome.error);
    } else {
      current.resolve(outcome.value);
    }
  };

  const handle = (state: NativeDownloadState) => {
    if (!state || state.id !== options.id) {
      return;
    }
    switch (state.status) {
      case 'downloading':
      case 'waiting':
      case 'verifying':
        onProgress?.({
          totalBytesWritten: state.downloadedBytes,
          totalBytesExpectedToWrite: state.totalBytes ?? options.totalBytes ?? 0,
        });
        return;
      case 'done':
        settle({ value: { uri: fileUri } });
        return;
      case 'failed':
        settle({ error: new Error(state.message || 'Model download failed.') });
        return;
      case 'paused':
      case 'cancelled': {
        const wasRequested = requested !== null;
        requested = null;
        if (!wasRequested && pending) {
          options.onExternalStop?.(state);
        }
        settle({ value: undefined });
        const waiter = stopWaiter;
        stopWaiter = null;
        waiter?.();
        return;
      }
      default:
        return;
    }
  };

  const start = (restart: boolean) =>
    new Promise<{ uri: string } | undefined>((resolve, reject) => {
      if (!native?.startModelDownload || !native.addListener) {
        reject(new Error('Background downloads are not available in this build.'));
        return;
      }
      pending = { resolve, reject };
      requested = null;
      subscription?.remove();
      subscription = native.addListener('onModelDownload', handle);
      let started = false;
      try {
        started = native.startModelDownload({
          id: options.id,
          url,
          path: fileUri,
          title: options.title,
          doneTitle: options.doneTitle,
          totalBytes: options.totalBytes,
          sha256: options.sha256,
          wifiOnly: options.wifiOnly,
          pausable: options.pausable,
          restart,
        });
      } catch (error) {
        settle({ error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }
      if (!started) {
        settle({
          error: new Error('Android did not let Silo start the download. Open Silo and try again.'),
        });
      }
    });

  const stop = (kind: 'pause' | 'cancel') =>
    new Promise<void>((resolve) => {
      const state = getNativeModelDownload(options.id);
      if (!pending && !state?.active) {
        if (kind === 'cancel') {
          cancelNativeModelDownload(options.id);
        }
        resolve();
        return;
      }
      requested = kind;
      const timer = setTimeout(() => {
        stopWaiter = null;
        resolve();
      }, STOP_TIMEOUT_MS);
      stopWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
      if (kind === 'pause') {
        native?.pauseModelDownload?.(options.id);
      } else {
        native?.cancelModelDownload?.(options.id);
      }
    });

  return {
    downloadAsync: () => start(true),
    resumeAsync: () => start(false),
    pauseAsync: async () => {
      await stop('pause');
      return { resumeData: NATIVE_RESUME_DATA };
    },
    cancelAsync: () => stop('cancel'),
  };
}
