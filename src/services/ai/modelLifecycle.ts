import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import { AppState, AppStateStatus, Platform } from 'react-native';

import {
  AI_BOOTSTRAP_OPTIONS,
  isSupportedLocalModelPath,
  validateRuntimeInfo,
  getActiveModelConfig,
} from './config';

import { getLlamaRnAdapter } from './llamaRnAdapter';
import {
  NATIVE_RESUME_DATA,
  cancelNativeModelDownload,
  createNativeDownloadResumable,
  getNativeModelDownload,
  isNativeModelDownloadAvailable,
  type NativeDownloadState,
} from './nativeModelDownload';
import { recordMemoryTelemetry } from './hardware';
import {
  LocalInferenceException,
  getErrorMessage,
  type LocalHealthCheckResult,
  type LocalInferenceError,
  type LocalRuntimeInfo,
} from './localInferenceTypes';
import {
  AIProvisioningSnapshot,
  AITransferSnapshot,
  createInitialProvisioningSnapshot,
  useAIStore,
} from '../../store/useAIStore';
import { useSettingsStore, waitForSettingsLoaded } from '../../store/useSettingsStore';
import { requestDownloadNotificationPermission } from '../notifications';
import { DEFAULT_APP_SETTINGS, MODEL_CATALOG, type VisionProjectorConfig } from '../../features/transactions/constants';

type DownloadProgress = {
  totalBytesExpectedToWrite: number;
  totalBytesWritten: number;
};

type DownloadPauseSnapshot = {
  resumeData?: string;
};

type DownloadResult = {
  uri: string;
};

type DownloadResumableLike = {
  downloadAsync: () => Promise<DownloadResult | undefined>;
  resumeAsync: () => Promise<DownloadResult | undefined>;
  pauseAsync: () => Promise<DownloadPauseSnapshot | undefined>;
  cancelAsync: () => Promise<void>;
};

type FileInfoResult = {
  exists: boolean;
  size?: number;
  uri: string;
  md5?: string;
};

type FileSystemLegacyModule = typeof ExpoFileSystemLegacy & {
  documentDirectory?: string | null;
  getFreeDiskStorageAsync?: () => Promise<number>;
  createDownloadResumable?: (
    uri: string,
    fileUri: string,
    options?: Record<string, unknown>,
    callback?: (progress: DownloadProgress) => void,
    resumeData?: string,
  ) => DownloadResumableLike;
  getInfoAsync?: (path: string, options?: { size?: boolean; md5?: boolean }) => Promise<FileInfoResult>;
  makeDirectoryAsync?: (path: string, options?: { intermediates?: boolean }) => Promise<void>;
  deleteAsync?: (path: string, options?: { idempotent?: boolean }) => Promise<void>;
  moveAsync?: (options: { from: string; to: string }) => Promise<void>;
  readAsStringAsync?: (path: string) => Promise<string>;
  writeAsStringAsync?: (path: string, value: string) => Promise<void>;
};

const FileSystemModule = ExpoFileSystemLegacy as FileSystemLegacyModule;

type ModelManifest = {
  version: string;
  modelPath: string | null;
  checksumVerified: boolean;
  initializedAt: string | null;
  lastVerifiedAt: string | null;
};

type TransferManifest = {
  version: string;
  status: AIProvisioningSnapshot['status'];
  downloadUrl: string;
  targetPath: string;
  tempPath: string;
  totalBytes: number | null;
  downloadedBytes: number;
  progress: number;
  resumeData: string | null;
  startedAt: string | null;
  updatedAt: string;
  lastProgressAt: string | null;
  bytesPerSecond: number | null;
  sessionId: string;
  pausedReason?: string | null;
};

export interface LocalInferenceAdapter {
  isAvailable(): boolean;
  registerModel(modelPath: string): Promise<void>;
  warmup(prompt: string): Promise<void>;
  getRuntimeInfo(): Promise<LocalRuntimeInfo>;
  runHealthCheck(): Promise<LocalHealthCheckResult>;
  indexLocalKnowledge(): Promise<void>;
  releaseContext?(): Promise<void>;
}

class NoopInferenceAdapter implements LocalInferenceAdapter {
  isAvailable(): boolean {
    return false;
  }

  async registerModel(): Promise<void> {
    throw new Error('No local inference backend is wired into this build.');
  }

  async warmup(): Promise<void> {
    throw new Error('No local inference backend is wired into this build.');
  }

  async getRuntimeInfo(): Promise<LocalRuntimeInfo> {
    throw new Error('No local inference backend is wired into this build.');
  }

  async runHealthCheck(): Promise<LocalHealthCheckResult> {
    throw new Error('No local inference backend is wired into this build.');
  }

  async indexLocalKnowledge(): Promise<void> {
    return;
  }

  async releaseContext(): Promise<void> {
    return;
  }
}

class LlamaRnInferenceAdapter implements LocalInferenceAdapter {
  private readonly adapter = getLlamaRnAdapter();

  isAvailable(): boolean {
    return Platform.OS === 'android';
  }

  async registerModel(modelPath: string): Promise<void> {
    await this.adapter.initContext({ modelPath, modelFileSizeBytes: 0 });
  }

  async warmup(): Promise<void> {
    return;
  }

  async getRuntimeInfo(): Promise<LocalRuntimeInfo> {
    return this.adapter.getRuntimeInfo();
  }

  async runHealthCheck(): Promise<LocalHealthCheckResult> {
    return {
      ok: true,
      prompt: 'ping',
      responseText: 'pong',
      matchedExpectedSubstring: true,
      durationMs: 0,
    };
  }

  async indexLocalKnowledge(): Promise<void> {
    useAIStore.getState().appendLog({
      level: 'info',
      event: 'index-init-skipped',
      message: 'Skipping redundant local AI index initialization because no native/vector indexing work is currently implemented.',
    });
    return;
  }

  async releaseContext(): Promise<void> {
    await this.adapter.releaseContext();
  }
}

function createDefaultInferenceAdapter(): LocalInferenceAdapter {
  return Platform.OS === 'android' ? new LlamaRnInferenceAdapter() : new NoopInferenceAdapter();
}

const getDocumentDirectory = () => {
  const dir = FileSystemModule.documentDirectory ?? '';
  if (!dir) {
    return '';
  }
  const withSlash = dir.endsWith('/') ? dir : `${dir}/`;
  return /^file:\/\//i.test(withSlash) ? withSlash : `file://${withSlash}`;
};
const getAiRootDirectory = () => `${getDocumentDirectory()}ai/`;
const getAiModelsDirectory = () => `${getAiRootDirectory()}models/`;
const getAiTempDirectory = () => `${getAiRootDirectory()}tmp/`;
const getManifestFile = () => `${getAiRootDirectory()}model-manifest.json`;
const getTransferManifestFile = () => `${getAiRootDirectory()}download-manifest.json`;
const getActiveModelDirectory = () => `${getAiModelsDirectory()}${getActiveModelConfig().version}/`;
const getTempDownloadPath = () => `${getAiTempDirectory()}${getActiveModelConfig().fileName}.part`;
const MODEL_DOWNLOAD_ID = 'model';
/** With the native download service the partial file is the resume point, so a download can always resume. */
const persistableResumeData = () => (isNativeModelDownloadAvailable() ? NATIVE_RESUME_DATA : null);

/** Absolute file:// URI where the active catalog model is (or will be) installed. Single source of truth. */
export function getActiveModelFileUri(): string {
  const docDir = getDocumentDirectory();
  if (!docDir) {
    return '';
  }
  return `${getActiveModelDirectory()}${getActiveModelConfig().fileName}`;
}

/** True if the active model file exists at getActiveModelFileUri() with the expected byte size. */
export async function isActiveModelInstalled(): Promise<boolean> {
  const modelUri = getActiveModelFileUri();
  if (!modelUri) {
    return false;
  }
  const info = await safeGetInfo(modelUri);
  if (!info.exists) {
    return false;
  }
  const expectedSizeBytes = getActiveModelConfig().sizeBytes;
  if (typeof expectedSizeBytes === 'number' && expectedSizeBytes > 0) {
    return info.size === expectedSizeBytes;
  }
  return true;
}

export async function checkModelExists(fileName: string, version: string = 'v1'): Promise<boolean> {
  const path = `${getAiModelsDirectory()}${version}/${fileName}`;
  const info = await safeGetInfo(path);
  return info.exists;
}

const nowIso = () => new Date().toISOString();

async function safeGetInfo(path: string, options?: { md5?: boolean }): Promise<FileInfoResult> {
  if (!FileSystemModule.getInfoAsync) {
    return { exists: false, uri: path };
  }
  return options?.md5
    ? FileSystemModule.getInfoAsync(path, { md5: true })
    : FileSystemModule.getInfoAsync(path, { size: true });
}

function normalizeCandidatePath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  if (/^file:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function deriveModelPathCandidates(preferredPath?: string | null): string[] {
  const candidates = new Set<string>();
  const normalizedPreferred = normalizeCandidatePath(preferredPath);
  const normalizedActive = normalizeCandidatePath(getActiveModelFileUri());

  if (normalizedPreferred && isSupportedLocalModelPath(normalizedPreferred)) {
    candidates.add(normalizedPreferred);
  }

  if (normalizedPreferred?.startsWith('file://') && isSupportedLocalModelPath(normalizedPreferred)) {
    candidates.add(normalizedPreferred.replace(/^file:\/\//i, ''));
  }

  if (normalizedActive && isSupportedLocalModelPath(normalizedActive)) {
    candidates.add(normalizedActive);
    candidates.add(normalizedActive.replace(/^file:\/\//i, ''));
  }

  return Array.from(candidates);
}

async function safeMove(from: string, to: string) {
  if (!FileSystemModule.moveAsync) {
    throw new Error('File move API unavailable in current runtime.');
  }

  await ensureDirectory(to.slice(0, Math.max(0, to.lastIndexOf('/') + 1)));
  await safeDelete(to);
  await FileSystemModule.moveAsync({ from, to });
}

async function findExistingModelPath(preferredPath?: string | null): Promise<string | null> {
  const candidatePaths = deriveModelPathCandidates(preferredPath);

  for (const candidatePath of candidatePaths) {
    const info = await safeGetInfo(candidatePath);
    if (info.exists) {
      return info.uri ?? candidatePath;
    }
  }

  return null;
}

async function ensureDirectory(path: string) {
  if (!FileSystemModule.makeDirectoryAsync) {
    return;
  }

  await FileSystemModule.makeDirectoryAsync(path, { intermediates: true });
}

async function safeDelete(path: string) {
  if (!FileSystemModule.deleteAsync) {
    return;
  }

  await FileSystemModule.deleteAsync(path, { idempotent: true });
}

function getActiveProjectorConfig(): VisionProjectorConfig | undefined {
  const selectedModelId = useSettingsStore.getState().activeModelId ?? DEFAULT_APP_SETTINGS.activeModelId;
  const entry = MODEL_CATALOG[selectedModelId] ?? MODEL_CATALOG[DEFAULT_APP_SETTINGS.activeModelId];
  return entry?.visionProjector;
}

const getTempProjectorPath = () => {
  const projector = getActiveProjectorConfig();
  const fileName = projector?.fileName ?? 'mmproj-F16.gguf';
  return `${getAiTempDirectory()}${fileName}.part`;
};

async function isWifiAllowed(): Promise<boolean> {
  if (!useSettingsStore.getState().aiWifiOnlyDownload) {
    return true;
  }

  let networkType: Network.NetworkStateType | undefined;
  try {
    const networkState = await Network.getNetworkStateAsync();
    networkType = networkState.type;
  } catch {
    networkType = undefined;
  }

  return networkType === Network.NetworkStateType.WIFI;
}

/** Absolute file:// URI where the vision projector is (or will be) installed. */
export function getVisionProjectorUri(): string {
  const docDir = getDocumentDirectory();
  if (!docDir) {
    return '';
  }
  const projector = getActiveProjectorConfig();
  const fileName = projector?.fileName ?? 'mmproj-F16.gguf';
  return `${getActiveModelDirectory()}${fileName}`;
}

/** True if the vision projector file exists at getVisionProjectorUri() with the expected byte size. */
export async function isVisionProjectorInstalled(): Promise<boolean> {
  const projectorUri = getVisionProjectorUri();
  if (!projectorUri) {
    return false;
  }
  const info = await safeGetInfo(projectorUri);
  if (!info.exists) {
    return false;
  }
  const projector = getActiveProjectorConfig();
  const expectedSizeBytes = projector?.sizeBytes;
  if (typeof expectedSizeBytes === 'number' && expectedSizeBytes > 0) {
    return info.size === expectedSizeBytes;
  }
  return true;
}

let inFlightProjectorResumable: DownloadResumableLike | null = null;
let inFlightProjectorPromise: Promise<void> | null = null;
const projectorProgressListeners = new Set<(fraction: number) => void>();

export async function cancelVisionProjectorDownload(): Promise<void> {
  const resumable = inFlightProjectorResumable;
  inFlightProjectorResumable = null;
  if (resumable) {
    try {
      await resumable.cancelAsync();
    } catch {
      // ignore
    }
  }
  await safeDelete(getTempProjectorPath());
}

export async function deleteVisionProjector(): Promise<void> {
  await cancelVisionProjectorDownload();
  const projectorUri = getVisionProjectorUri();
  if (projectorUri) {
    await safeDelete(projectorUri);
  }
  await safeDelete(getTempProjectorPath());
}

async function runVisionProjectorDownload(
  resumable: DownloadResumableLike,
  tempPath: string,
  projector: VisionProjectorConfig,
): Promise<void> {
  const targetPath = getVisionProjectorUri();

  try {
    if (inFlightProjectorResumable !== resumable) {
      await safeDelete(tempPath);
      return;
    }

    await ensureDirectory(getAiTempDirectory());
    await ensureDirectory(getActiveModelDirectory());
    await safeDelete(tempPath);

    if (inFlightProjectorResumable !== resumable) {
      await safeDelete(tempPath);
      return;
    }

    const result = await resumable.downloadAsync();
    if (!result?.uri) {
      await safeDelete(tempPath);
      if (inFlightProjectorResumable !== resumable) {
        return;
      }
      throw new Error('Vision projector download cancelled or failed');
    }

    const fileInfo = await safeGetInfo(tempPath, { md5: true });
    if (!fileInfo.exists) {
      await safeDelete(tempPath);
      throw new Error('Vision projector verification failed');
    }

    if (typeof projector.sizeBytes === 'number' && projector.sizeBytes > 0 && fileInfo.size !== projector.sizeBytes) {
      await safeDelete(tempPath);
      throw new Error('Vision projector verification failed');
    }

    const expectedMd5 = projector.md5?.trim().toLowerCase();
    if (expectedMd5) {
      if (!fileInfo.md5 || fileInfo.md5.trim().toLowerCase() !== expectedMd5) {
        await safeDelete(tempPath);
        throw new Error('Vision projector verification failed');
      }
    }

    await safeMove(tempPath, targetPath);
    for (const listener of projectorProgressListeners) {
      try {
        listener(1);
      } catch {
        // ignore
      }
    }
  } catch (error) {
    await safeDelete(tempPath);
    throw error;
  } finally {
    if (inFlightProjectorResumable === resumable) {
      inFlightProjectorResumable = null;
    }
  }
}

function initiateProjectorDownload(
  projector: VisionProjectorConfig,
  downloadResumableFactory: NonNullable<FileSystemLegacyModule['createDownloadResumable']>,
): Promise<void> {
  const tempPath = getTempProjectorPath();
  const backgroundSessionType = FileSystemModule.FileSystemSessionType?.BACKGROUND ?? 1;
  const onProgress = (progress: DownloadProgress) => {
    const fraction = progress.totalBytesExpectedToWrite > 0
      ? progress.totalBytesWritten / progress.totalBytesExpectedToWrite
      : 0;
    for (const listener of projectorProgressListeners) {
      try {
        listener(fraction);
      } catch {
        // ignore callback error
      }
    }
  };

  const resumable: DownloadResumableLike = isNativeModelDownloadAvailable()
    ? createNativeDownloadResumable(
        projector.url,
        tempPath,
        {
          id: 'projector',
          title: 'Downloading Silo AI vision add-on',
          doneTitle: 'Vision add-on downloaded',
          totalBytes: projector.sizeBytes,
          wifiOnly: useSettingsStore.getState().aiWifiOnlyDownload,
          pausable: false,
        },
        onProgress,
      )
    : downloadResumableFactory(projector.url, tempPath, { sessionType: backgroundSessionType }, onProgress);

  inFlightProjectorResumable = resumable;
  return runVisionProjectorDownload(resumable, tempPath, projector);
}

export function downloadVisionProjector(onProgress?: (fraction: number) => void): Promise<void> {
  void requestDownloadNotificationPermission();
  if (onProgress) {
    projectorProgressListeners.add(onProgress);
  }

  if (inFlightProjectorPromise) {
    return inFlightProjectorPromise;
  }

  const projector = getActiveProjectorConfig();
  if (!projector?.url) {
    return Promise.reject(new Error('No vision projector configured for active model'));
  }

  const downloadResumableFactory = FileSystemModule.createDownloadResumable;
  if (!downloadResumableFactory) {
    return Promise.reject(
      new Error('Download API unavailable in current runtime. Use a custom dev client or production build.'),
    );
  }

  if (useSettingsStore.getState().aiWifiOnlyDownload) {
    inFlightProjectorPromise = (async () => {
      const wifiAllowed = await isWifiAllowed();
      if (!wifiAllowed) {
        throw new Error('Wi-Fi required (change in Settings)');
      }
      return initiateProjectorDownload(projector, downloadResumableFactory);
    })().finally(() => {
      inFlightProjectorPromise = null;
      projectorProgressListeners.clear();
    });
    return inFlightProjectorPromise;
  }

  inFlightProjectorPromise = initiateProjectorDownload(projector, downloadResumableFactory).finally(() => {
    inFlightProjectorPromise = null;
    projectorProgressListeners.clear();
  });

  return inFlightProjectorPromise;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!FileSystemModule.readAsStringAsync) {
    return null;
  }

  try {
    const raw = await FileSystemModule.readAsStringAsync(path);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown) {
  if (!FileSystemModule.writeAsStringAsync) {
    return;
  }

  await ensureDirectory(getAiRootDirectory());
  await FileSystemModule.writeAsStringAsync(path, JSON.stringify(value, null, 2));
}

async function readManifest(): Promise<ModelManifest | null> {
  const parsed = await readJsonFile<Partial<ModelManifest>>(getManifestFile());
  if (!parsed || typeof parsed.modelPath !== 'string' || !parsed.modelPath.trim()) {
    return null;
  }
  return parsed as ModelManifest;
}

async function writeManifest(manifest: ModelManifest) {
  await writeJsonFile(getManifestFile(), manifest);
}

async function clearManifest() {
  await safeDelete(getManifestFile());
}

async function readTransferManifest(): Promise<TransferManifest | null> {
  const parsed = await readJsonFile<Partial<TransferManifest>>(getTransferManifestFile());
  if (!parsed || typeof parsed.status !== 'string' || typeof parsed.tempPath !== 'string' || !parsed.tempPath.trim()) {
    return null;
  }
  return parsed as TransferManifest;
}

async function writeTransferManifest(manifest: TransferManifest) {
  await writeJsonFile(getTransferManifestFile(), manifest);
}

async function clearTransferManifest() {
  await safeDelete(getTransferManifestFile());
}

export async function checkDiskStorageHealth(requiredBytes = getActiveModelConfig().minFreeSpaceBytes): Promise<{
  ok: boolean;
  status: 'ok' | 'warning' | 'critical' | 'unknown';
  freeBytes: number | null;
  totalBytes: number | null;
  message: string | null;
}> {
  if (!FileSystemModule.getFreeDiskStorageAsync) {
    const res = { ok: true, status: 'unknown' as const, freeBytes: null, totalBytes: null, message: null };
    useAIStore.getState().updateStorageHealth(res);
    return res;
  }

  const freeBytes = await FileSystemModule.getFreeDiskStorageAsync();
  let totalBytes: number | null = null;
  if (FileSystemModule.getTotalDiskCapacityAsync) {
    try {
      totalBytes = await FileSystemModule.getTotalDiskCapacityAsync();
    } catch {
      // ignore
    }
  }

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  let message: string | null = null;
  const ok = freeBytes >= requiredBytes;

  if (!ok) {
    status = 'critical';
    const requiredGb = (requiredBytes / (1024 * 1024 * 1024)).toFixed(1);
    const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
    message = `Critical Storage: Only ${freeGb} GB free. At least ${requiredGb} GB required for AI model installation.`;
  } else if (freeBytes < requiredBytes * 1.3) {
    status = 'warning';
    const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
    message = `Low Storage Warning: ${freeGb} GB free. AI model downloads may fail if device storage drops further.`;
  } else {
    status = 'ok';
  }

  const health = { ok, status, freeBytes, totalBytes, message };
  useAIStore.getState().updateStorageHealth(health);
  return health;
}

function createTransferSnapshot(manifest: TransferManifest): AITransferSnapshot {
  return {
    downloadUrl: manifest.downloadUrl,
    resumableUri: manifest.targetPath,
    resumeData: manifest.resumeData,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    bytesPerSecond: manifest.bytesPerSecond,
    lastProgressAt: manifest.lastProgressAt,
    sessionId: manifest.sessionId,
  };
}

function createSessionId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type PendingDeferredRecovery =
  | { kind: 'cleanup-orphan-temp' }
  | { kind: 'verify'; tempPath: string }
  | { kind: 'resume-download'; manifest: TransferManifest }
  | { kind: 'cleanup-partial'; manifest: TransferManifest };

export class QModelLifecycleManager {
  private downloadResumable: DownloadResumableLike | null = null;
  private inferenceAdapter: LocalInferenceAdapter;
  private active = false;
  private initialized = false;
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private initializePromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private pendingDeferredRecovery: PendingDeferredRecovery | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private inFlightDownloadPromise: Promise<void> | null = null;
  private inFlightVerificationPromise: Promise<void> | null = null;
  private lastPersistedProgressAt = 0;
  private downloadToken = 0;

  constructor(inferenceAdapter: LocalInferenceAdapter = createDefaultInferenceAdapter()) {
    this.inferenceAdapter = inferenceAdapter;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isHydrated(): boolean {
    return this.hydrated;
  }

  /**
   * Eagerly hydrates persisted provisioning metadata (installed manifest + paused/active transfer
   * manifest) via small file reads without creating directories or starting expensive verification
   * hashing / background downloads. Shared across concurrent callers.
   */
  hydratePersistedState(): Promise<void> {
    if (this.hydrated) {
      return Promise.resolve();
    }
    if (this.hydratePromise) {
      return this.hydratePromise;
    }

    const generation = this.lifecycleGeneration;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await this.restorePersistedProvisioningMetadata(generation);
        if (this.lifecycleGeneration !== generation) {
          return;
        }
        this.hydrated = true;
        useAIStore.getState().setProvisioningHydrated(true);
      } finally {
        if (this.hydratePromise === promise) {
          this.hydratePromise = null;
        }
      }
    })();

    this.hydratePromise = promise;
    return promise;
  }

  /**
   * Returns one shared lifecycle-ready promise that completes full filesystem setup,
   * persisted state restoration, deferred recovery, and AppState registration.
   */
  ensureInitialized(): Promise<void> {
    return this.initialize();
  }

  initialize(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    const generation = this.lifecycleGeneration;
    this.active = true;

    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await this.ensureFilesystemLayout();
        if (this.lifecycleGeneration !== generation) {
          return;
        }

        await this.restorePersistedState(generation);
        if (this.lifecycleGeneration !== generation) {
          return;
        }

        this.watchAppState();
        this.initialized = true;
        useAIStore.getState().setProvisioningHydrated(true);

        if (AI_BOOTSTRAP_OPTIONS.autoStartOnLaunch) {
          setTimeout(() => {
            if (this.lifecycleGeneration === generation) {
              void this.startProvisioningIfNeeded();
            }
          }, 1_200);
        }
      } catch (error) {
        if (this.lifecycleGeneration === generation) {
          this.active = false;
        }
        throw error;
      } finally {
        if (this.initializePromise === promise) {
          this.initializePromise = null;
        }
      }
    })();

    this.initializePromise = promise;
    return promise;
  }

  dispose() {
    this.lifecycleGeneration += 1;
    this.active = false;
    this.initialized = false;
    this.hydrated = false;
    this.hydratePromise = null;
    this.initializePromise = null;
    this.pendingDeferredRecovery = null;
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    useAIStore.getState().setProvisioningHydrated(false);
  }

  async startProvisioningIfNeeded() {
    await this.ensureInitialized();
    const state = useAIStore.getState();
    const snapshot = state.provisioning;
    const availability = state.refreshRuntimeAvailability();
    const runtimeInfo = state.runtime.runtimeInfo;

    if (!availability.available) {
      state.setRuntimeState('unavailable');
      state.setRuntimeError({
        code: 'backend-unavailable',
        message: availability.message,
        recoverable: false,
      });
      return;
    }

    state.setRuntimeError(null);

    if (snapshot.status === 'ready' && !snapshot.updateAvailable) {
      const resolvedInstalledPath = await findExistingModelPath(snapshot.modelPath);
      if (!resolvedInstalledPath) {
        await this.clearInvalidInstalledState('Previously installed AI model metadata pointed to a missing file. The stale path was cleared so setup can restart safely.');
      } else {
        if (resolvedInstalledPath !== snapshot.modelPath) {
          this.updateProvisioning({ modelPath: resolvedInstalledPath, lastError: null, pausedReason: null });
        }

        const alreadyLoaded = Boolean(
          state.runtimeReady
          && state.runtime.modelLoaded
          && state.runtime.generationHealthy
          && runtimeInfo?.isModelLoaded
          && runtimeInfo?.loadedModelPath
          && normalizeCandidatePath(runtimeInfo.loadedModelPath) === normalizeCandidatePath(resolvedInstalledPath),
        );

        if (!alreadyLoaded) {
          const runtimeProbeStartedAt = Date.now();
          const latestRuntimeInfo = await this.inferenceAdapter.getRuntimeInfo().catch(() => null);
          const runtimeCanBeReused = Boolean(
            latestRuntimeInfo?.isModelLoaded
            && latestRuntimeInfo.loadedModelPath
            && normalizeCandidatePath(latestRuntimeInfo.loadedModelPath) === normalizeCandidatePath(resolvedInstalledPath),
          );

          if (runtimeCanBeReused) {
            this.log('info', 'runtime-state-rehydrated', 'Recovered already-loaded native runtime state from runtime probe without repeating registration or warmup.', {
              modelPath: resolvedInstalledPath,
              durationMs: Date.now() - runtimeProbeStartedAt,
            });
            state.setRuntimeInfo(latestRuntimeInfo);
            state.setRuntimeModelLoaded(true, latestRuntimeInfo);
            state.setRuntimeHealth(true, nowIso());
            state.setWarmupPending(false);
            state.markRuntimeReady(true);
            state.setRuntimeState('healthy');
            this.updateProvisioning({ status: 'ready', modelPath: resolvedInstalledPath, lastError: null, pausedReason: null });
          } else {
            await this.registerWarmupAndIndex(resolvedInstalledPath, true);
          }
        }
        return;
      }
    }

    if (this.inFlightDownloadPromise) {
      return this.inFlightDownloadPromise;
    }

    if (['paused', 'queued', 'downloading', 'unpacking', 'registering', 'warming', 'indexing'].includes(snapshot.status)) {
      return;
    }

    if (snapshot.status === 'verifying' && snapshot.tempPath) {
      try {
        await this.resumeVerification(snapshot.tempPath);
      } catch (error) {
        this.failProvisioning(error, 'Model verification failed.');
      }
      return;
    }

    await this.provision();
  }

  async retryProvisioning() {
    void requestDownloadNotificationPermission();
    const wasInitialized = this.initialized;
    await this.ensureInitialized();
    const current = useAIStore.getState().provisioning;
    if (!wasInitialized && (current.status === 'paused' || current.canResume)) {
      await this.resumeDownload();
      return;
    }
    if (!wasInitialized && current.status === 'ready' && !current.updateAvailable) {
      return;
    }
    const state = useAIStore.getState();
    await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
    state.resetProvisioningError();
    state.markRuntimeReady(false);
    state.setWarmupPending(false);
    await this.provision();
  }

  async pauseDownload(reason = 'Model download paused.') {
    const pauseToken = ++this.downloadToken;
    this.pendingDeferredRecovery = null;
    const resumable = this.downloadResumable;
    this.downloadResumable = null;
    this.inFlightDownloadPromise = null;

    let pauseSnapshot: DownloadPauseSnapshot | undefined;
    try {
      if (resumable) {
        pauseSnapshot = await resumable.pauseAsync();
      }
    } catch (error) {
      this.log('warn', 'pause-failed-fallback-cancel', 'Resumable pauseAsync threw, falling back to cancel.', {
        error: getErrorMessage(error),
      });
      pauseSnapshot = undefined;
    }

    if (this.downloadToken !== pauseToken) {
      return;
    }

    const resumeData = pauseSnapshot?.resumeData;
    if (!resumeData) {
      this.downloadResumable = resumable;
      await this.cancelDownload(reason);
      return;
    }

    useAIStore.getState().updateTransfer({
      resumeData,
    });
    this.updateProvisioning({
      status: 'paused',
      canResume: true,
      pausedReason: reason,
      lastError: null,
    });

    await this.persistTransferManifest({
      status: 'paused',
      resumeData,
      pausedReason: reason,
      updatedAt: nowIso(),
    });

    if (this.downloadToken !== pauseToken) {
      return;
    }

    this.log('info', 'download-paused', reason, {
      tempPath: getTempDownloadPath(),
      hasResumeData: true,
    });
  }

  async resumeDownload() {
    void requestDownloadNotificationPermission();
    await this.ensureInitialized();
    const wifiAllowed = await this.checkWifiRequirement();
    if (!wifiAllowed) {
      return;
    }

    const manifest = await readTransferManifest();
    if (manifest?.resumeData) {
      const resumeToken = ++this.downloadToken;
      this.lastPersistedProgressAt = 0;

      useAIStore.getState().updateTransfer({
        downloadUrl: manifest.downloadUrl || getActiveModelConfig().downloadUrl,
        resumableUri: manifest.targetPath || getTempDownloadPath(),
        resumeData: manifest.resumeData,
        startedAt: manifest.startedAt,
        sessionId: manifest.sessionId,
      });

      this.updateProvisioning({
        status: 'queued',
        tempPath: manifest.tempPath || getTempDownloadPath(),
        pausedReason: null,
        lastError: null,
        totalBytes: manifest.totalBytes,
        downloadedBytes: manifest.downloadedBytes,
        progress: manifest.progress,
        canResume: false,
      });

      this.inFlightDownloadPromise = this.runResumableDownload(manifest.resumeData, manifest, resumeToken).finally(() => {
        if (this.downloadToken === resumeToken) {
          this.inFlightDownloadPromise = null;
        }
      });
      return this.inFlightDownloadPromise;
    }

    await this.retryProvisioning();
  }

  async cancelDownload(reason = 'Cancelled model download and cleared temporary files.') {
    const cancelToken = ++this.downloadToken;
    this.pendingDeferredRecovery = null;
    const resumable = this.downloadResumable;
    this.downloadResumable = null;

    try {
      if (resumable) {
        await resumable.cancelAsync();
      } else if (isNativeModelDownloadAvailable()) {
        // Paused: drop the notification (and partial file) the download service still shows.
        cancelNativeModelDownload(MODEL_DOWNLOAD_ID);
      }
      if (this.downloadToken !== cancelToken) {
        return;
      }
      await this.resetProvisioningArtifacts();
      if (this.downloadToken !== cancelToken) {
        return;
      }
      this.log('warn', 'download-cancelled', reason);
    } catch (error) {
      if (this.downloadToken !== cancelToken) {
        return;
      }
      this.failProvisioning(error, 'Unable to cancel model download.');
    }
  }

  async deleteInstalledModel(): Promise<void> {
    this.pendingDeferredRecovery = null;
    try {
      this.log('info', 'model-deletion-requested', 'User requested full deletion of offline AI model.');

      // Cancel any active downloads first
      await this.cancelDownload('Model deletion requested by user.');

      // Release native llama context if loaded
      try {
        if (typeof (this.inferenceAdapter as any).releaseContext === 'function') {
          await (this.inferenceAdapter as any).releaseContext();
        }
      } catch (releaseErr) {
        this.log('warn', 'model-release-failed', 'Failed to release native model context during deletion.', { error: getErrorMessage(releaseErr) });
      }

      // Delete target model file and any temporary download chunks
      const config = getActiveModelConfig();
      const targetPath = getActiveModelFileUri();
      const legacyPaths = [
        targetPath,
        getTempDownloadPath(),
        getDocumentDirectory() ? `${getDocumentDirectory()}${config.fileName}` : '',
      ].filter(Boolean);

      for (const p of legacyPaths) {
        await safeDelete(p);
      }

      // Remove the dependent vision add-on (and cancel any in-flight projector download) so no orphaned projector remains on disk
      await deleteVisionProjector();

      await clearManifest();
      await clearTransferManifest();

      // If local AI vision receipt reading was active, fall back to OCR so app settings stay consistent
      const settingsState = useSettingsStore.getState();
      if (settingsState.aiInferenceMode === 'local' && settingsState.receiptReadingMode === 'vision') {
        try {
          await settingsState.setReceiptReadingMode('ocr');
        } catch (settingsErr) {
          useSettingsStore.setState({ receiptReadingMode: 'ocr' });
          this.log(
            'warn',
            'vision-mode-reset-persist-failed',
            'Failed to persist OCR fallback after deleting offline AI model.',
            { error: getErrorMessage(settingsErr) },
          );
        }
      }

      // Reset AI store state
      const state = useAIStore.getState();
      state.setRuntimeModelLoaded(false, null);
      state.setRuntimeHealth(false, null);
      state.setRuntimeInfo(null);
      state.setRuntimeState(state.runtime.availability.available ? 'detected' : 'unavailable');
      state.markRuntimeReady(false);
      state.setWarmupPending(false);
      state.setRuntimeError(null);
      state.resetTransfer();

      this.updateProvisioning({
        ...createInitialProvisioningSnapshot(),
        status: 'not-installed',
      });

      this.log('info', 'model-deleted-success', 'Offline AI model weights and metadata removed successfully.');
    } catch (error) {
      this.log('error', 'model-delete-failed', 'Failed to delete offline AI model.', { error: getErrorMessage(error) });
      throw error;
    }
  }

  private async checkWifiRequirement(): Promise<boolean> {
    if (!useSettingsStore.getState().aiWifiOnlyDownload) {
      return true;
    }

    let networkType: Network.NetworkStateType | undefined;
    try {
      const networkState = await Network.getNetworkStateAsync();
      networkType = networkState.type;
    } catch {
      networkType = undefined;
    }

    if (networkType !== Network.NetworkStateType.WIFI) {
      const message = 'Wi-Fi required (change in Settings)';
      this.updateProvisioning({
        status: 'failed',
        pausedReason: null,
        lastError: message,
        canResume: false,
      });
      this.log('warn', 'wifi-required-download-blocked', message, {
        networkType: networkType ?? 'unknown',
      });
      return false;
    }

    return true;
  }

  private async provision() {
    try {
      if (!getDocumentDirectory()) {
        throw new Error('Document storage is unavailable on this device.');
      }

      const freeSpace = await checkDiskStorageHealth(getActiveModelConfig().minFreeSpaceBytes);
      if (!freeSpace.ok) {
        this.updateProvisioning({
          status: 'failed',
          pausedReason: null,
          lastError: freeSpace.message ?? `Insufficient free storage for local AI model download. Free at least ${Math.round(getActiveModelConfig().minFreeSpaceBytes / 1024 / 1024 / 1024)} GB and retry.`,
          canResume: false,
        });
        this.log('warn', 'low-storage', 'Insufficient free storage for local AI model download.', { freeBytes: freeSpace.freeBytes ?? undefined });
        return;
      }

      const installedModelPath = await findExistingModelPath(useAIStore.getState().provisioning.modelPath);
      if (installedModelPath) {
        if (installedModelPath !== useAIStore.getState().provisioning.modelPath) {
          this.updateProvisioning({ modelPath: installedModelPath, lastError: null, pausedReason: null });
        }
        await this.verifyAndFinalizeInstalledModel(installedModelPath);
        return;
      }

      const transferManifest = await readTransferManifest();
      if (transferManifest) {
        this.log('warn', 'stale-transfer-reset', 'Found persisted transfer state. Clearing stale download artifacts before restarting atomic download.', {
          tempPath: transferManifest.tempPath,
          downloadedBytes: transferManifest.downloadedBytes,
          status: transferManifest.status,
        });
        await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
      }

      const tempInfo = await safeGetInfo(getTempDownloadPath());
      if (tempInfo.exists && (transferManifest || useAIStore.getState().provisioning.downloadedBytes > 0)) {
        this.log('warn', 'partial-download-reset', 'Found a partial model download without resumable state. Clearing stale artifacts before restarting download.', {
          tempPath: getTempDownloadPath(),
          downloadedBytes: transferManifest?.downloadedBytes ?? useAIStore.getState().provisioning.downloadedBytes,
        });
        await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
      }

      await this.beginDownload();
    } catch (error) {
      this.failProvisioning(error, 'Provisioning failed before download started.');
    }
  }

  private async beginDownload() {
    const token = ++this.downloadToken;
    const wifiAllowed = await this.checkWifiRequirement();
    if (this.downloadToken !== token || !wifiAllowed) {
      return;
    }

    await ensureDirectory(getAiTempDirectory());
    if (this.downloadToken !== token) {
      return;
    }

    this.lastPersistedProgressAt = 0;
    const sessionId = createSessionId();
    const startedAt = nowIso();

    useAIStore.getState().updateTransfer({
      downloadUrl: getActiveModelConfig().downloadUrl,
      resumableUri: getTempDownloadPath(),
      resumeData: null,
      startedAt,
      updatedAt: startedAt,
      bytesPerSecond: null,
      lastProgressAt: null,
      sessionId,
    });

    this.updateProvisioning({
      status: 'queued',
      tempPath: getTempDownloadPath(),
      pausedReason: null,
      lastError: null,
      totalBytes: null,
      downloadedBytes: 0,
      progress: 0,
      canResume: false,
      transfer: {
        downloadUrl: getActiveModelConfig().downloadUrl,
        resumableUri: getTempDownloadPath(),
        resumeData: null,
        startedAt,
        updatedAt: startedAt,
        bytesPerSecond: null,
        lastProgressAt: null,
        sessionId,
      },
    });

    await this.persistTransferManifest({
      status: 'queued',
      resumeData: persistableResumeData(),
      sessionId,
      startedAt,
      downloadedBytes: 0,
      progress: 0,
      totalBytes: null,
      lastProgressAt: null,
      bytesPerSecond: null,
      updatedAt: startedAt,
    });
    if (this.downloadToken !== token) {
      return;
    }

    this.inFlightDownloadPromise = this.runResumableDownload(null, null, token).finally(() => {
      if (this.downloadToken === token) {
        this.inFlightDownloadPromise = null;
      }
    });
  }

  private async runResumableDownload(_resumeData: string | null, _manifest: TransferManifest | null, token: number) {
    if (this.downloadToken !== token) {
      return;
    }

    const useNative = isNativeModelDownloadAvailable();
    const downloadResumableFactory = FileSystemModule.createDownloadResumable;
    if (!useNative && !downloadResumableFactory) {
      throw new Error('Download API unavailable in current runtime. Use a custom dev client or production build.');
    }

    const wifiAllowed = await this.checkWifiRequirement();
    if (this.downloadToken !== token || !wifiAllowed) {
      return;
    }

    const health = await checkDiskStorageHealth(getActiveModelConfig().minFreeSpaceBytes);
    if (this.downloadToken !== token) {
      return;
    }
    if (!health.ok) {
      this.updateProvisioning({
        status: 'failed',
        pausedReason: null,
        lastError: health.message ?? 'Insufficient storage for model download.',
        canResume: false,
      });
      this.log('warn', 'low-storage-download', 'Aborted download due to low storage.', { freeBytes: health.freeBytes ?? undefined });
      return;
    }

    const sessionId = _manifest?.sessionId ?? useAIStore.getState().provisioning.transfer.sessionId ?? createSessionId();
    const startedAt = _manifest?.startedAt ?? useAIStore.getState().provisioning.transfer.startedAt ?? nowIso();
    const backgroundSessionType = FileSystemModule.FileSystemSessionType?.BACKGROUND ?? 1;

    const onProgress = (progress: DownloadProgress) => {
      void this.handleProgressUpdate(progress, sessionId, startedAt, token);
    };
    const config = getActiveModelConfig();
    this.downloadResumable = useNative
      ? createNativeDownloadResumable(
          config.downloadUrl,
          getTempDownloadPath(),
          {
            id: MODEL_DOWNLOAD_ID,
            title: 'Downloading Silo AI model',
            doneTitle: 'Silo AI model downloaded',
            totalBytes: config.sizeBytes,
            sha256: config.sha256,
            wifiOnly: useSettingsStore.getState().aiWifiOnlyDownload,
            pausable: true,
            onExternalStop: (state) => this.handleExternalStop(state, token),
          },
          onProgress,
        )
      : downloadResumableFactory!(
          config.downloadUrl,
          getTempDownloadPath(),
          {
            sessionType: backgroundSessionType,
          },
          onProgress,
          _resumeData && _resumeData !== NATIVE_RESUME_DATA ? _resumeData : undefined,
        );

    this.log(
      'info',
      'download-started',
      'Starting atomic OTA model download.',
      {
        version: getActiveModelConfig().version,
        url: getActiveModelConfig().downloadUrl,
        resumed: Boolean(_resumeData),
      },
    );

    this.updateProvisioning({
      status: 'downloading',
      pausedReason: null,
      lastError: null,
      canResume: false,
      tempPath: getTempDownloadPath(),
      ...(_manifest ? {
        downloadedBytes: _manifest.downloadedBytes,
        totalBytes: _manifest.totalBytes,
        progress: _manifest.progress,
      } : {}),
    });

    try {
      // resumeAsync() resolves undefined when paused again; never restart from zero in that case.
      const result = _resumeData
        ? await this.downloadResumable.resumeAsync()
        : await this.downloadResumable.downloadAsync();
      if (this.downloadToken !== token) {
        return;
      }
      this.downloadResumable = null;

      if (!result?.uri) {
        await this.resetProvisioningArtifacts();
        return;
      }

      await this.handleDownloadFinished(result.uri, token);
    } catch (error) {
      if (this.downloadToken !== token) {
        return;
      }
      this.downloadResumable = null;
      const message = error instanceof Error ? error.message : 'Model download failed.';

      if (/cancel/i.test(message)) {
        await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
        if (this.downloadToken !== token) {
          return;
        }
        this.updateProvisioning({
          status: 'not-installed',
          lastError: null,
          pausedReason: null,
          canResume: false,
        });
        return;
      }

      this.failProvisioning(error, 'Model download failed during transfer.');
    }
  }

  /** Paused or cancelled from the notification (or paused by Android / a long loss of connection). */
  private handleExternalStop(state: NativeDownloadState, token: number) {
    if (this.downloadToken !== token) {
      return;
    }
    const stopToken = ++this.downloadToken;
    this.downloadResumable = null;
    this.inFlightDownloadPromise = null;

    if (state.status === 'cancelled') {
      void this.resetProvisioningArtifacts().then(() => {
        if (this.downloadToken === stopToken) {
          this.log('warn', 'download-cancelled', 'Model download cancelled from the notification.');
        }
      });
      return;
    }

    const reason = state.message || 'Model download paused.';
    const totalBytes = state.totalBytes ?? useAIStore.getState().provisioning.totalBytes;
    const progress = totalBytes ? Math.min(1, state.downloadedBytes / totalBytes) : useAIStore.getState().provisioning.progress;
    useAIStore.getState().updateTransfer({ resumeData: NATIVE_RESUME_DATA });
    this.updateProvisioning({
      status: 'paused',
      canResume: true,
      pausedReason: reason,
      lastError: null,
      downloadedBytes: state.downloadedBytes,
      totalBytes,
      progress,
    });
    void this.persistTransferManifest({
      status: 'paused',
      resumeData: NATIVE_RESUME_DATA,
      pausedReason: reason,
      downloadedBytes: state.downloadedBytes,
      totalBytes,
      progress,
      updatedAt: nowIso(),
    });
  }

  private async handleProgressUpdate(progress: DownloadProgress, sessionId: string, startedAt: string, token: number) {
    if (this.downloadToken !== token) {
      return;
    }

    const current = useAIStore.getState().provisioning;
    if (current.status !== 'queued' && current.status !== 'downloading') {
      return;
    }

    const totalBytes = progress.totalBytesExpectedToWrite > 0 ? progress.totalBytesExpectedToWrite : null;
    const downloadedBytes = progress.totalBytesWritten;
    const percent = totalBytes ? downloadedBytes / totalBytes : 0;
    const lastDownloadedBytes = current.downloadedBytes;
    const nowMs = Date.now();
    const previousProgressAt = current.transfer.lastProgressAt ? new Date(current.transfer.lastProgressAt).getTime() : null;
    const elapsedMs = previousProgressAt ? Math.max(1, nowMs - previousProgressAt) : null;
    const computedBytesPerSecond = elapsedMs ? Math.max(0, ((downloadedBytes - lastDownloadedBytes) / elapsedMs) * 1000) : current.transfer.bytesPerSecond;
    const bytesPerSecond = Number.isFinite(computedBytesPerSecond ?? NaN) ? computedBytesPerSecond ?? null : null;
    const timestamp = new Date(nowMs).toISOString();

    useAIStore.getState().updateTransfer({
      downloadUrl: getActiveModelConfig().downloadUrl,
      resumableUri: getTempDownloadPath(),
      startedAt,
      sessionId,
      lastProgressAt: timestamp,
      bytesPerSecond,
    });

    this.updateProvisioning({
      status: 'downloading',
      totalBytes,
      downloadedBytes,
      progress: percent,
      tempPath: getTempDownloadPath(),
      canResume: false,
    });

    if (nowMs - this.lastPersistedProgressAt >= AI_BOOTSTRAP_OPTIONS.progressPersistIntervalMs) {
      this.lastPersistedProgressAt = nowMs;
      await this.persistTransferManifest({
        status: 'downloading',
        sessionId,
        startedAt,
        downloadedBytes,
        totalBytes,
        progress: percent,
        lastProgressAt: timestamp,
        bytesPerSecond,
        resumeData: persistableResumeData(),
        updatedAt: timestamp,
      });
      if (this.downloadToken !== token) {
        return;
      }
    }
  }

  private async handleDownloadFinished(downloadedUri: string, token: number) {
    if (this.downloadToken !== token) {
      return;
    }

    const current = useAIStore.getState().provisioning;
    this.downloadResumable = null;

    this.updateProvisioning({
      status: 'verifying',
      progress: 1,
      downloadedBytes: current.totalBytes ?? current.downloadedBytes,
      tempPath: downloadedUri,
      canResume: false,
      pausedReason: null,
      lastError: null,
    });

    await this.persistTransferManifest({
      status: 'verifying',
      resumeData: null,
      progress: 1,
      downloadedBytes: current.totalBytes ?? current.downloadedBytes,
      totalBytes: current.totalBytes,
      tempPath: downloadedUri,
      updatedAt: nowIso(),
    });
    if (this.downloadToken !== token) {
      return;
    }

    await this.resumeVerification(downloadedUri, token);
  }

  private async resumeVerification(downloadedUri: string, token?: number) {
    if (this.inFlightVerificationPromise) {
      return this.inFlightVerificationPromise;
    }

    const verificationPromise = this.verifyAndFinalizeInstalledModel(downloadedUri, true, token).finally(() => {
      this.inFlightVerificationPromise = null;
    });

    this.inFlightVerificationPromise = verificationPromise;
    return verificationPromise;
  }

  private async verifyAndFinalizeInstalledModel(sourcePath: string, moveIntoActiveDirectory = false, token?: number) {
    const isStale = () => token !== undefined && this.downloadToken !== token;
    if (isStale()) {
      return;
    }

    const config = getActiveModelConfig();
    const activeModelUri = getActiveModelFileUri();
    const fileInfo = await safeGetInfo(sourcePath, { md5: true });
    if (isStale()) {
      return;
    }

    this.log('info', 'verify-started', 'Verifying local Qwen model artifact integrity.', {
      sourcePath,
      resolvedSourceUri: fileInfo.uri ?? sourcePath,
      fileSize: fileInfo.size ?? null,
      expectedSizeBytes: config.sizeBytes ?? null,
      moveIntoActiveDirectory,
      activeModelPath: activeModelUri,
      documentDirectory: getDocumentDirectory(),
      cacheDirectory: FileSystemModule.cacheDirectory ?? null,
    });
    let installedModelPath: string | null = null;
    try {
      if (!fileInfo.exists) {
        throw new Error('Model artifact missing after download.');
      }

      const expectedSizeBytes = config.sizeBytes;
      if (typeof expectedSizeBytes === 'number' && expectedSizeBytes > 0 && fileInfo.size !== expectedSizeBytes) {
        throw new Error(
          `Model size verification failed (expected ${expectedSizeBytes} bytes, got ${fileInfo.size ?? 'unknown'}).`,
        );
      }

      const expectedMd5 = config.md5?.trim().toLowerCase();
      let checksumVerified = false;
      let lastVerifiedAt: string | null = null;

      if (expectedMd5) {
        if (fileInfo.md5?.trim().toLowerCase() !== expectedMd5) {
          throw new Error('Model MD5 checksum verification failed.');
        }
        checksumVerified = true;
        lastVerifiedAt = nowIso();
      }

      this.updateProvisioning({
        checksumVerified,
        lastVerifiedAt,
        lastError: null,
        canResume: false,
      });

      await ensureDirectory(getActiveModelDirectory());
      if (isStale()) {
        return;
      }

      if (moveIntoActiveDirectory) {
        this.updateProvisioning({ status: 'unpacking' });
        const previousInfo = await safeGetInfo(activeModelUri);
        if (isStale()) {
          return;
        }
        const rollbackPath = `${getActiveModelDirectory()}${config.fileName}.rollback`;

        if (previousInfo.exists) {
          await safeDelete(rollbackPath);
          await safeMove(activeModelUri, rollbackPath);
          if (isStale()) {
            return;
          }
        }

        try {
          await safeMove(sourcePath, activeModelUri);
          const installedInfo = await safeGetInfo(activeModelUri);
          this.log('info', 'install-move-complete', 'Moved verified GGUF model into active directory.', {
            sourcePath,
            activeModelPath: activeModelUri,
            activeModelUri: installedInfo.uri ?? activeModelUri,
            activeModelExists: installedInfo.exists,
            activeModelSize: installedInfo.size ?? null,
          });
          await safeDelete(rollbackPath);
        } catch (error) {
          const rollbackInfo = await safeGetInfo(rollbackPath);
          if (rollbackInfo.exists) {
            await safeMove(rollbackPath, activeModelUri);
          }
          throw error;
        }
      }

      if (isStale()) {
        return;
      }

      installedModelPath = await findExistingModelPath(activeModelUri);
      if (isStale()) {
        return;
      }
      if (!installedModelPath) {
        throw new Error(`GGUF model file does not exist at path: ${activeModelUri}`);
      }
    } catch (error) {
      await safeDelete(sourcePath);
      await clearTransferManifest();
      useAIStore.getState().resetTransfer();
      if (!moveIntoActiveDirectory) {
        await clearManifest();
      }
      this.updateProvisioning({
        checksumVerified: false,
        lastVerifiedAt: null,
        tempPath: null,
        modelPath: moveIntoActiveDirectory ? useAIStore.getState().provisioning.modelPath : null,
      });
      throw error;
    }

    await this.registerWarmupAndIndex(installedModelPath, false, token);
  }

  private async registerWarmupAndIndex(modelPath: string, preserveInstalledReadyState = false, token?: number) {
    const isStale = () => token !== undefined && this.downloadToken !== token;
    const state = useAIStore.getState();
    const existingRuntimeInfo = state.runtime.runtimeInfo;
    const normalizedRequestedPath = normalizeCandidatePath(modelPath);
    const alreadyLoaded = Boolean(
      preserveInstalledReadyState
      && state.runtimeReady
      && state.runtime.modelLoaded
      && state.runtime.generationHealthy
      && existingRuntimeInfo?.isModelLoaded
      && normalizeCandidatePath(existingRuntimeInfo.loadedModelPath) === normalizedRequestedPath,
    );

    if (alreadyLoaded) {
      this.log('info', 'runtime-reuse', 'Skipping redundant model registration, warmup, and health-check because the requested GGUF is already active and healthy.', {
        modelPath,
      });
      state.setWarmupPending(false);
      state.markRuntimeReady(true);
      state.setRuntimeState('healthy');
      this.updateProvisioning({
        status: 'ready',
        modelPath,
        tempPath: null,
        pausedReason: null,
        lastError: null,
        canResume: false,
      });
      return;
    }

    state.markRuntimeReady(false);
    state.setWarmupPending(true);
    state.setRuntimeHealth(false, null);
    state.setRuntimeModelLoaded(false, null);
    state.setRuntimeError(null);
    state.refreshRuntimeAvailability();

    try {
      this.updateProvisioning({
        status: 'registering',
        modelPath,
        tempPath: null,
        canResume: false,
        pausedReason: null,
        lastError: null,
      });
      state.setRuntimeState('loading');
      const resolvedModelPath = await findExistingModelPath(modelPath);
      if (isStale()) {
        return;
      }
      if (!resolvedModelPath) {
        await this.clearInvalidInstalledState('The downloaded model file could not be found at the expected location. The stale installation metadata was cleared so setup can restart safely.', {
          expectedModelPath: modelPath,
        });
        throw new Error(`Offline AI model file is missing. Expected it at: ${modelPath}`);
      }

      if (resolvedModelPath !== modelPath) {
        this.updateProvisioning({ modelPath: resolvedModelPath, lastError: null, pausedReason: null });
      }

      const resolvedModelInfo = await safeGetInfo(resolvedModelPath);
      if (isStale()) {
        return;
      }
      const registerStartedAt = Date.now();
      this.log('info', 'register-started', 'Registering local Qwen model with inference runtime.', {
        requestedModelPath: modelPath,
        resolvedModelPath,
        runtimeAccessiblePath: resolvedModelInfo.uri ?? resolvedModelPath,
        fileExists: resolvedModelInfo.exists,
        fileSize: resolvedModelInfo.size ?? null,
      });
      await this.inferenceAdapter.registerModel(resolvedModelPath);
      if (isStale()) {
        return;
      }
      this.log('info', 'register-finished', 'Local model registration finished.', {
        resolvedModelPath,
        durationMs: Date.now() - registerStartedAt,
      });

      const runtimeInfo = await this.inferenceAdapter.getRuntimeInfo();
      if (isStale()) {
        return;
      }
      const runtimeInfoValidation = validateRuntimeInfo(runtimeInfo);
      if (!runtimeInfoValidation.ok) {
        throw new Error(runtimeInfoValidation.reason ?? 'Native runtime returned invalid runtime information.');
      }
      state.setRuntimeInfo(runtimeInfo);
      state.setRuntimeModelLoaded(Boolean(runtimeInfo.isModelLoaded ?? true), runtimeInfo);
      void recordMemoryTelemetry(runtimeInfo.fileSizeBytes ?? null);

      this.updateProvisioning({ status: 'warming', pausedReason: null, lastError: null });
      state.setRuntimeState('warming');
      this.log('info', 'warmup-skipped', 'Skipping local inference warmup for mobile to avoid blocking UI on expensive generation.');
      state.setRuntimeHealth(true, nowIso());
      this.log('info', 'health-check-skipped', 'Marking local inference runtime healthy without probe generation to avoid mobile startup delay.', {
        bypassed: true,
      });

      this.updateProvisioning({ status: 'indexing', pausedReason: null, lastError: null });
      this.log('info', 'index-init-started', 'Initializing local AI indices and caches.', {
        implementation: 'noop',
      });
      await this.inferenceAdapter.indexLocalKnowledge();
      if (isStale()) {
        return;
      }

      const initializedAt = preserveInstalledReadyState ? state.provisioning.initializedAt ?? nowIso() : nowIso();
      const finalModelPath = await findExistingModelPath(useAIStore.getState().provisioning.modelPath ?? modelPath);
      if (isStale()) {
        return;
      }
      if (!finalModelPath) {
        await this.clearInvalidInstalledState('The model file disappeared before installation metadata could be finalized. Setup metadata was reset to avoid a broken ready state.', {
          expectedModelPath: useAIStore.getState().provisioning.modelPath ?? modelPath,
        });
        throw new Error('Offline AI model file was not available after registration completed.');
      }

      const latestProvisioning = useAIStore.getState().provisioning;
      await writeManifest({
        version: getActiveModelConfig().version,
        modelPath: finalModelPath,
        checksumVerified: latestProvisioning.checksumVerified,
        initializedAt,
        lastVerifiedAt: latestProvisioning.checksumVerified ? (latestProvisioning.lastVerifiedAt ?? nowIso()) : null,
      });
      if (isStale()) {
        return;
      }

      await clearTransferManifest();
      state.resetTransfer();
      state.setWarmupPending(false);
      state.markRuntimeReady(true);
      state.setRuntimeState('healthy');
      this.updateProvisioning({
        status: 'ready',
        progress: 1,
        modelPath: finalModelPath,
        initializedAt,
        pausedReason: null,
        lastError: null,
        updateAvailable: false,
        canResume: false,
        tempPath: null,
      });
      this.log('info', 'provisioning-ready', 'Local Qwen model is ready for offline use.', {
        modelPath: finalModelPath,
        backend: runtimeInfo.backend,
        maxContextTokens: runtimeInfo.maxContextTokens,
      });
    } catch (error) {
      const runtimeError = this.normalizeRuntimeError(error, modelPath);
      state.setWarmupPending(false);
      state.markRuntimeReady(false);
      state.setRuntimeHealth(false, null);
      state.setRuntimeState('failed');
      state.setRuntimeError(runtimeError);
      this.updateProvisioning({
        status: 'failed',
        pausedReason: null,
        lastError: runtimeError.message,
      });
      this.log('error', 'runtime-init-failed', runtimeError.message, runtimeError.details);
      throw error;
    }
  }

  private async ensureFilesystemLayout() {
    await ensureDirectory(getAiRootDirectory());
    await ensureDirectory(getAiModelsDirectory());
    await ensureDirectory(getAiTempDirectory());
  }

  private async isRuntimeActiveOrLoaded(): Promise<boolean> {
    const state = useAIStore.getState();
    if (
      state.runtimeReady ||
      state.runtime.modelLoaded ||
      state.runtime.activeGenerationRequestId !== null ||
      state.runtime.runtimeState === 'loading' ||
      state.runtime.runtimeState === 'loaded' ||
      state.runtime.runtimeState === 'warming' ||
      state.runtime.runtimeState === 'busy' ||
      state.runtime.runtimeState === 'healthy'
    ) {
      return true;
    }

    try {
      const { getGenerationService } = require('./generationService') as typeof import('./generationService');
      const genSnapshot = getGenerationService().getSnapshot();
      if (genSnapshot.isPreparingRuntime || genSnapshot.isGenerating) {
        return true;
      }
    } catch {
      // Ignore if generationService is unavailable in isolated tests.
    }

    try {
      const adapterInfo = await getLlamaRnAdapter().getRuntimeInfo();
      if (adapterInfo?.isModelLoaded) {
        return true;
      }
    } catch {
      // Ignore native probe errors during persisted-state restore.
    }

    return false;
  }

  private async restorePersistedProvisioningMetadata(generation: number) {
    const startDownloadToken = this.downloadToken;
    const isStale = () => this.lifecycleGeneration !== generation || this.downloadToken !== startDownloadToken;
    if (typeof waitForSettingsLoaded === 'function') {
      await waitForSettingsLoaded();
    }
    if (isStale()) {
      return;
    }

    const state = useAIStore.getState();
    const runtimeAlreadyActive = await this.isRuntimeActiveOrLoaded();
    if (isStale()) {
      return;
    }

    if (!runtimeAlreadyActive) {
      state.markRuntimeReady(false);
      state.setWarmupPending(false);
      state.setRuntimeHealth(false, null);
      state.setRuntimeModelLoaded(false, null);
    }

    const availability = state.refreshRuntimeAvailability();
    if (!availability.available && !runtimeAlreadyActive) {
      state.setRuntimeState('unavailable');
      state.setRuntimeError({
        code: 'backend-unavailable',
        message: availability.message,
        recoverable: false,
      });
    }

    const manifest = await readManifest();
    if (isStale()) {
      return;
    }
    if (manifest?.modelPath) {
      const resolvedManifestPath = await findExistingModelPath(manifest.modelPath);
      if (isStale()) {
        return;
      }
      if (resolvedManifestPath) {
        if (resolvedManifestPath !== manifest.modelPath) {
          await writeManifest({
            ...manifest,
            modelPath: resolvedManifestPath,
          });
        }

        state.replaceProvisioning({
          status: 'ready',
          progress: 1,
          downloadedBytes: 0,
          totalBytes: null,
          version: manifest.version,
          modelPath: resolvedManifestPath,
          checksumVerified: manifest.checksumVerified,
          initializedAt: manifest.initializedAt,
          lastVerifiedAt: manifest.lastVerifiedAt,
          updateAvailable: manifest.version !== getActiveModelConfig().version,
          canResume: false,
          lastError: null,
          pausedReason: null,
          tempPath: null,
        });

        if (availability.available && !(await this.isRuntimeActiveOrLoaded())) {
          state.setRuntimeState('model-unloaded');
        }
      } else {
        await clearManifest();
        state.replaceProvisioning({
          ...createInitialProvisioningSnapshot(),
          lastError: 'Saved AI model installation metadata pointed to a file that no longer exists. Download the model again to reinstall it cleanly.',
        });
      }
    }

    const transferManifest = await readTransferManifest();
    if (isStale()) {
      return;
    }
    if (!transferManifest) {
      this.pendingDeferredRecovery = { kind: 'cleanup-orphan-temp' };
      return;
    }

    const tempInfo = await safeGetInfo(transferManifest.tempPath);
    if (isStale()) {
      return;
    }
    if (!tempInfo.exists) {
      await clearTransferManifest();
      state.resetTransfer();
      this.pendingDeferredRecovery = null;
      return;
    }

    if (transferManifest.status === 'verifying') {
      state.replaceProvisioning({
        status: 'verifying',
        progress: transferManifest.progress,
        downloadedBytes: transferManifest.downloadedBytes,
        totalBytes: transferManifest.totalBytes,
        version: transferManifest.version,
        tempPath: transferManifest.tempPath,
        canResume: false,
        pausedReason: null,
        lastError: null,
        transfer: createTransferSnapshot(transferManifest),
      });
      this.pendingDeferredRecovery = { kind: 'verify', tempPath: transferManifest.tempPath };
      return;
    }

    const nativeState = isNativeModelDownloadAvailable() ? getNativeModelDownload(MODEL_DOWNLOAD_ID) : null;
    // Resumed from the notification while Silo was closed: re-attach, pick up the finished file, or (when Android
    // killed the service mid-download, so no pause was ever recorded) carry on from the partial file.
    const nativeMovedOn =
      transferManifest.status === 'paused' &&
      nativeState !== null &&
      (nativeState.active === true ||
        nativeState.status === 'done' ||
        nativeState.status === 'downloading' ||
        nativeState.status === 'waiting');
    if (nativeMovedOn) {
      transferManifest.status = 'downloading';
      transferManifest.resumeData = NATIVE_RESUME_DATA;
      transferManifest.pausedReason = null;
    }
    const nativeBytes = nativeState?.downloadedBytes ?? 0;
    const nativeHasNewerBytes =
      transferManifest.resumeData === NATIVE_RESUME_DATA &&
      nativeBytes > 0 &&
      nativeBytes !== transferManifest.downloadedBytes;
    if (nativeHasNewerBytes && nativeState) {
      // The service kept going (or paused) without Silo open: the partial file is the truth.
      transferManifest.downloadedBytes = nativeBytes;
      if (transferManifest.totalBytes) {
        transferManifest.progress = Math.min(1, nativeBytes / transferManifest.totalBytes);
      }
      if (transferManifest.status === 'paused' && nativeState.status === 'paused' && nativeState.message) {
        transferManifest.pausedReason = nativeState.message;
      }
    }
    if (nativeMovedOn || nativeHasNewerBytes) {
      await writeTransferManifest(transferManifest);
      if (isStale()) {
        return;
      }
    }

    if (transferManifest.status === 'paused') {
      state.replaceProvisioning({
        status: 'paused',
        progress: transferManifest.progress,
        downloadedBytes: transferManifest.downloadedBytes,
        totalBytes: transferManifest.totalBytes,
        version: transferManifest.version,
        tempPath: transferManifest.tempPath,
        canResume: Boolean(transferManifest.resumeData),
        pausedReason: transferManifest.pausedReason ?? null,
        lastError: null,
        transfer: createTransferSnapshot(transferManifest),
      });
      this.pendingDeferredRecovery = null;
      return;
    }

    // The native download service resumes from the partial file itself, so any interrupted download can continue.
    if (
      (transferManifest.status === 'downloading' || transferManifest.status === 'queued') &&
      (transferManifest.resumeData || isNativeModelDownloadAvailable())
    ) {
      state.replaceProvisioning({
        status: 'downloading',
        progress: transferManifest.progress,
        downloadedBytes: transferManifest.downloadedBytes,
        totalBytes: transferManifest.totalBytes,
        version: transferManifest.version,
        tempPath: transferManifest.tempPath,
        canResume: true,
        pausedReason: null,
        lastError: null,
        transfer: createTransferSnapshot(transferManifest),
      });
      this.pendingDeferredRecovery = { kind: 'resume-download', manifest: transferManifest };
      return;
    }

    this.pendingDeferredRecovery = { kind: 'cleanup-partial', manifest: transferManifest };
  }

  private async restorePersistedState(generation: number = this.lifecycleGeneration) {
    const tokenBeforeRestore = this.downloadToken;
    await this.hydratePersistedState();
    if (this.lifecycleGeneration !== generation || this.downloadToken !== tokenBeforeRestore) {
      this.pendingDeferredRecovery = null;
      return;
    }

    const recovery = this.pendingDeferredRecovery;
    this.pendingDeferredRecovery = null;
    if (!recovery) {
      return;
    }

    if (recovery.kind === 'cleanup-orphan-temp') {
      const tempInfo = await safeGetInfo(getTempDownloadPath());
      if (this.lifecycleGeneration !== generation || this.downloadToken !== tokenBeforeRestore) {
        return;
      }
      if (tempInfo.exists) {
        await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
      }
      return;
    }

    if (recovery.kind === 'verify') {
      const [liveManifest, liveTemp] = await Promise.all([readTransferManifest(), safeGetInfo(recovery.tempPath)]);
      if (
        this.lifecycleGeneration !== generation ||
        this.downloadToken !== tokenBeforeRestore ||
        !liveManifest ||
        liveManifest.status !== 'verifying' ||
        !liveTemp.exists
      ) {
        return;
      }
      try {
        await this.resumeVerification(recovery.tempPath);
      } catch (error) {
        this.failProvisioning(error, 'Restored model verification failed.');
      }
      return;
    }

    if (recovery.kind === 'resume-download') {
      const liveManifest = await readTransferManifest();
      if (
        this.lifecycleGeneration !== generation ||
        this.downloadToken !== tokenBeforeRestore ||
        !liveManifest ||
        !(liveManifest.resumeData || isNativeModelDownloadAvailable()) ||
        (liveManifest.status !== 'downloading' && liveManifest.status !== 'queued')
      ) {
        return;
      }
      const transferManifest = { ...liveManifest, resumeData: liveManifest.resumeData ?? NATIVE_RESUME_DATA };
      this.log('info', 'resuming-background-workmanager-download', 'Restoring Android WorkManager background model download session.', {
        tempPath: transferManifest.tempPath,
        downloadedBytes: transferManifest.downloadedBytes,
      });
      const restoredToken = ++this.downloadToken;
      this.inFlightDownloadPromise = this.runResumableDownload(transferManifest.resumeData, transferManifest, restoredToken).finally(() => {
        if (this.downloadToken === restoredToken) {
          this.inFlightDownloadPromise = null;
        }
      });
      return;
    }

    if (recovery.kind === 'cleanup-partial') {
      const liveManifest = await readTransferManifest();
      if (
        this.lifecycleGeneration !== generation ||
        this.downloadToken !== tokenBeforeRestore ||
        !liveManifest
      ) {
        return;
      }
      const transferManifest = liveManifest;
      this.log('warn', 'restored-partial-download-cleared', 'Discarding restored partial model download to preserve atomic install behavior.', {
        tempPath: transferManifest.tempPath,
        downloadedBytes: transferManifest.downloadedBytes,
        status: transferManifest.status,
      });
      await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
      if (this.lifecycleGeneration !== generation || this.downloadToken !== tokenBeforeRestore) {
        return;
      }
      const latestState = useAIStore.getState();
      const hasInstalledModel = latestState.provisioning.status === 'ready' && Boolean(latestState.provisioning.modelPath);
      latestState.replaceProvisioning({
        ...latestState.provisioning,
        status: hasInstalledModel ? 'ready' : 'not-installed',
        progress: hasInstalledModel ? latestState.provisioning.progress : 0,
        downloadedBytes: 0,
        totalBytes: null,
        tempPath: null,
        canResume: false,
        pausedReason: null,
        lastError: hasInstalledModel
          ? null
          : 'An incomplete model download was discarded. Restart setup to download the full model in one pass.',
      });
    }
  }

  private watchAppState() {
    this.appStateSubscription?.remove();
    this.appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      // Expo resumable downloads can be restored across launches and foreground returns, but true OS-managed
      // terminated-app background execution still requires native background transfer services.
      if (nextState === 'active' && AI_BOOTSTRAP_OPTIONS.resumeOnForeground) {
        void this.startProvisioningIfNeeded();
      }
    });
  }

  private updateProvisioning(snapshot: Partial<AIProvisioningSnapshot>) {
    useAIStore.getState().replaceProvisioning(snapshot);
  }

  private async persistTransferManifest(overrides: Partial<TransferManifest>) {
    const provisioning = useAIStore.getState().provisioning;
    const transfer = provisioning.transfer;

    const manifest: TransferManifest = {
      version: provisioning.version,
      status: overrides.status ?? provisioning.status,
      downloadUrl: overrides.downloadUrl ?? transfer.downloadUrl ?? getActiveModelConfig().downloadUrl,
      targetPath: overrides.targetPath ?? transfer.resumableUri ?? getTempDownloadPath(),
      tempPath: overrides.tempPath ?? provisioning.tempPath ?? getTempDownloadPath(),
      totalBytes: overrides.totalBytes !== undefined ? overrides.totalBytes : provisioning.totalBytes,
      downloadedBytes: overrides.downloadedBytes !== undefined ? overrides.downloadedBytes : provisioning.downloadedBytes,
      progress: overrides.progress !== undefined ? overrides.progress : provisioning.progress,
      resumeData: overrides.resumeData !== undefined ? overrides.resumeData : transfer.resumeData,
      startedAt: overrides.startedAt ?? transfer.startedAt,
      updatedAt: overrides.updatedAt ?? nowIso(),
      lastProgressAt: overrides.lastProgressAt !== undefined ? overrides.lastProgressAt : transfer.lastProgressAt,
      bytesPerSecond: overrides.bytesPerSecond !== undefined ? overrides.bytesPerSecond : transfer.bytesPerSecond,
      sessionId: overrides.sessionId ?? transfer.sessionId ?? createSessionId(),
      pausedReason: overrides.pausedReason !== undefined ? overrides.pausedReason : provisioning.pausedReason,
    };

    await writeTransferManifest(manifest);
  }

  private log(level: 'info' | 'warn' | 'error', event: string, message: string, details?: Record<string, unknown>) {
    useAIStore.getState().appendLog({ level, event, message, details });
  }

  private normalizeRuntimeError(error: unknown, modelPath?: string): LocalInferenceError {
    if (error instanceof LocalInferenceException && (!modelPath || error.details?.modelPath === modelPath)) {
      return error;
    }

    if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
      const typedError = error as LocalInferenceError;
      return new LocalInferenceException(
        typedError.code ?? 'unknown',
        typedError.message,
        {
          modelPath,
          ...typedError.details,
        },
        typedError.recoverable ?? true,
      );
    }

    if (error instanceof Error) {
      return new LocalInferenceException('load-failed', error.message, modelPath ? { modelPath } : undefined, true);
    }

    return new LocalInferenceException('unknown', getErrorMessage(error, 'Unknown local inference runtime failure.'), modelPath ? { modelPath } : undefined, true);
  }

  private async clearInvalidInstalledState(message: string, details?: Record<string, unknown>) {
    await clearManifest();
    await this.resetProvisioningArtifacts({ preserveInstalledModel: false });
    useAIStore.getState().setRuntimeModelLoaded(false, null);
    useAIStore.getState().setRuntimeHealth(false, null);
    useAIStore.getState().setRuntimeInfo(null);
    useAIStore.getState().setRuntimeState('detected');
    useAIStore.getState().setRuntimeError({
      code: 'model-file-missing',
      message,
      details,
      recoverable: true,
    });
    this.updateProvisioning({
      modelPath: null,
      checksumVerified: false,
      initializedAt: null,
      lastVerifiedAt: null,
      updateAvailable: false,
      lastError: message,
      status: 'not-installed',
    });
    this.log('warn', 'installed-model-state-cleared', message, details);
  }

  private async resetProvisioningArtifacts(options?: { preserveInstalledModel?: boolean }) {
    this.pendingDeferredRecovery = null;
    this.downloadResumable = null;
    this.inFlightDownloadPromise = null;
    this.inFlightVerificationPromise = null;
    this.lastPersistedProgressAt = 0;

    await safeDelete(getTempDownloadPath());
    await clearTransferManifest();
    const store = useAIStore.getState();
    store.resetTransfer();
    const currentProvisioning = store.provisioning;
    const preserveInstalled = Boolean(options?.preserveInstalledModel && currentProvisioning.status === 'ready');
    const preserveRuntime = preserveInstalled && (await this.isRuntimeActiveOrLoaded());

    if (!preserveRuntime) {
      store.markRuntimeReady(false);
      store.setWarmupPending(false);
    }

    this.updateProvisioning(
      preserveInstalled
        ? {
            tempPath: null,
            lastError: null,
            pausedReason: null,
            canResume: false,
            downloadedBytes: 0,
            totalBytes: null,
          }
        : {
            ...createInitialProvisioningSnapshot(),
            status: options?.preserveInstalledModel ? currentProvisioning.status : 'not-installed',
            tempPath: null,
            lastError: null,
            pausedReason: null,
            canResume: false,
          },
    );
  }

  private failProvisioning(error: unknown, fallbackMessage: string) {
    const message = error instanceof Error ? error.message : fallbackMessage;
    const current = useAIStore.getState().provisioning;
    const runtimeError = this.normalizeRuntimeError(error, current.modelPath ?? undefined);
    this.downloadResumable = null;
    useAIStore.getState().setWarmupPending(false);
    useAIStore.getState().markRuntimeReady(false);
    useAIStore.getState().setRuntimeError(runtimeError);
    useAIStore.getState().setRuntimeState('failed');
    this.updateProvisioning({
      status: 'failed',
      lastError: message,
      retryCount: current.retryCount + 1,
      pausedReason: null,
    });
    void this.persistTransferManifest({
      status: 'failed',
      resumeData: current.transfer.resumeData,
      downloadedBytes: current.downloadedBytes,
      totalBytes: current.totalBytes,
      progress: current.progress,
      lastProgressAt: current.transfer.lastProgressAt,
      bytesPerSecond: current.transfer.bytesPerSecond,
    });
    this.log('error', 'provisioning-failed', message, runtimeError.details);
  }
}

let singletonManager: QModelLifecycleManager | null = null;

export function getModelLifecycleManager() {
  if (!singletonManager) {
    singletonManager = new QModelLifecycleManager();
  }

  return singletonManager;
}
