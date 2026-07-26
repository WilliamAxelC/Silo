import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { AppState, AppStateStatus, Platform } from 'react-native';

import {
  AI_BOOTSTRAP_OPTIONS,
  isSupportedLocalModelPath,
  QWEN_MODEL_ASSET_VERSION,
  QWEN_MODEL_DOWNLOAD_URL,
  QWEN_MODEL_FILE_NAME,
  QWEN_MODEL_MIN_FREE_SPACE_BYTES,
  QWEN_MODEL_SHA256,
  QWEN_MODEL_WARMUP_PROMPT,
  validateRuntimeInfo,
} from './config';

import { getLlamaRnAdapter } from './llamaRnAdapter';
import type { LocalHealthCheckResult, LocalInferenceError, LocalRuntimeInfo } from './localInferenceTypes';
import {
  AIProvisioningSnapshot,
  AITransferSnapshot,
  createInitialProvisioningSnapshot,
  useAIStore,
} from '../../store/useAIStore';

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
  getInfoAsync?: (path: string, options?: { size?: boolean }) => Promise<FileInfoResult>;
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
};

export interface LocalInferenceAdapter {
  isAvailable(): boolean;
  registerModel(modelPath: string): Promise<void>;
  warmup(prompt: string): Promise<void>;
  getRuntimeInfo(): Promise<LocalRuntimeInfo>;
  runHealthCheck(): Promise<LocalHealthCheckResult>;
  indexLocalKnowledge(): Promise<void>;
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
}

function createDefaultInferenceAdapter(): LocalInferenceAdapter {
  return Platform.OS === 'android' ? new LlamaRnInferenceAdapter() : new NoopInferenceAdapter();
}

const DOCUMENT_DIRECTORY = FileSystemModule.documentDirectory ?? '';
const AI_ROOT_DIRECTORY = `${DOCUMENT_DIRECTORY}ai/`;
const AI_MODELS_DIRECTORY = `${AI_ROOT_DIRECTORY}models/`;
const AI_TEMP_DIRECTORY = `${AI_ROOT_DIRECTORY}tmp/`;
const AI_MANIFEST_FILE = `${AI_ROOT_DIRECTORY}model-manifest.json`;
const AI_TRANSFER_MANIFEST_FILE = `${AI_ROOT_DIRECTORY}download-manifest.json`;
const ACTIVE_MODEL_DIRECTORY = `${AI_MODELS_DIRECTORY}${QWEN_MODEL_ASSET_VERSION}/`;
const ACTIVE_MODEL_PATH = `${ACTIVE_MODEL_DIRECTORY}${QWEN_MODEL_FILE_NAME}`;
const TEMP_DOWNLOAD_PATH = `${AI_TEMP_DIRECTORY}${QWEN_MODEL_FILE_NAME}.part`;

const nowIso = () => new Date().toISOString();
const SHOULD_VERIFY_CHECKSUM = QWEN_MODEL_SHA256.trim().length > 0;
const MAX_JS_SAFE_CHECKSUM_BYTES = 16 * 1024 * 1024;

async function safeGetInfo(path: string): Promise<FileInfoResult> {
  return FileSystemModule.getInfoAsync ? FileSystemModule.getInfoAsync(path, { size: true }) : { exists: false, uri: path };
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
  const normalizedActive = normalizeCandidatePath(ACTIVE_MODEL_PATH);

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

  await ensureDirectory(AI_ROOT_DIRECTORY);
  await FileSystemModule.writeAsStringAsync(path, JSON.stringify(value, null, 2));
}

async function readManifest(): Promise<ModelManifest | null> {
  return readJsonFile<ModelManifest>(AI_MANIFEST_FILE);
}

async function writeManifest(manifest: ModelManifest) {
  await writeJsonFile(AI_MANIFEST_FILE, manifest);
}

async function clearManifest() {
  await safeDelete(AI_MANIFEST_FILE);
}

async function readTransferManifest(): Promise<TransferManifest | null> {
  return readJsonFile<TransferManifest>(AI_TRANSFER_MANIFEST_FILE);
}

async function writeTransferManifest(manifest: TransferManifest) {
  await writeJsonFile(AI_TRANSFER_MANIFEST_FILE, manifest);
}

async function clearTransferManifest() {
  await safeDelete(AI_TRANSFER_MANIFEST_FILE);
}

async function ensureFreeSpace(requiredBytes: number) {
  if (!FileSystemModule.getFreeDiskStorageAsync) {
    return { ok: true as const, freeBytes: null as number | null };
  }

  const freeBytes = await FileSystemModule.getFreeDiskStorageAsync();
  return {
    ok: freeBytes > requiredBytes,
    freeBytes,
  };
}

async function sha256ForFile(fileUri: string) {
  const fileInfo = await safeGetInfo(fileUri);
  const fileSize = fileInfo.size ?? null;

  if (fileSize !== null && fileSize > MAX_JS_SAFE_CHECKSUM_BYTES) {
    throw new Error(
      `Model checksum verification requires loading the entire file into JS memory, which is unsafe for large model artifacts (${fileSize} bytes).`,
    );
  }

  const readAsStringAsync = FileSystemModule.readAsStringAsync;
  if (!readAsStringAsync) {
    throw new Error('Unable to read downloaded model file for checksum verification.');
  }

  const contents = await readAsStringAsync(fileUri);
  if (!contents) {
    throw new Error('Unable to read downloaded model file for checksum verification.');
  }

  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, contents);
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

export class QModelLifecycleManager {
  private downloadResumable: DownloadResumableLike | null = null;
  private inferenceAdapter: LocalInferenceAdapter;
  private active = false;
  private appStateSubscription: { remove: () => void } | null = null;
  private inFlightDownloadPromise: Promise<void> | null = null;
  private inFlightVerificationPromise: Promise<void> | null = null;
  private lastPersistedProgressAt = 0;

  constructor(inferenceAdapter: LocalInferenceAdapter = createDefaultInferenceAdapter()) {
    this.inferenceAdapter = inferenceAdapter;
  }

  async initialize() {
    if (this.active) {
      return;
    }

    this.active = true;
    await this.ensureFilesystemLayout();
    await this.restorePersistedState();
    this.watchAppState();

    if (AI_BOOTSTRAP_OPTIONS.autoStartOnLaunch) {
      setTimeout(() => {
        void this.startProvisioningIfNeeded();
      }, 1_200);
    }
  }

  dispose() {
    this.active = false;
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  async startProvisioningIfNeeded() {
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
        await this.clearInvalidInstalledState('Previously installed GGUF model metadata pointed to a missing file. The stale path was cleared so setup can restart safely.');
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

    if (['queued', 'downloading', 'unpacking', 'registering', 'warming', 'indexing'].includes(snapshot.status)) {
      return;
    }

    if (snapshot.status === 'verifying' && snapshot.tempPath) {
      await this.resumeVerification(snapshot.tempPath);
      return;
    }

    await this.provision();
  }

  async retryProvisioning() {
    const state = useAIStore.getState();
    await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
    state.resetProvisioningError();
    state.markRuntimeReady(false);
    state.setWarmupPending(false);
    await this.provision();
  }

  async pauseDownload(reason = 'Paused by user') {
    await this.cancelDownload(reason);
  }

  async resumeDownload() {
    await this.retryProvisioning();
  }

  async cancelDownload(reason = 'Cancelled model download and cleared temporary files.') {
    try {
      await this.downloadResumable?.cancelAsync();
      await this.resetProvisioningArtifacts();
      this.log('warn', 'download-cancelled', reason);
    } catch (error) {
      this.failProvisioning(error, 'Unable to cancel model download.');
    }
  }

  private async provision() {
    try {
      if (!DOCUMENT_DIRECTORY) {
        throw new Error('Document storage is unavailable on this device.');
      }

      const freeSpace = await ensureFreeSpace(QWEN_MODEL_MIN_FREE_SPACE_BYTES);
      if (!freeSpace.ok) {
        this.updateProvisioning({
          status: 'failed',
          pausedReason: null,
          lastError: `Insufficient free storage for local AI model download. Free at least ${Math.round(QWEN_MODEL_MIN_FREE_SPACE_BYTES / 1024 / 1024 / 1024)} GB and retry.`,
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

      const tempInfo = await safeGetInfo(TEMP_DOWNLOAD_PATH);
      if (tempInfo.exists && (transferManifest || useAIStore.getState().provisioning.downloadedBytes > 0)) {
        this.log('warn', 'partial-download-reset', 'Found a partial model download without resumable state. Clearing stale artifacts before restarting download.', {
          tempPath: TEMP_DOWNLOAD_PATH,
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
    await ensureDirectory(AI_TEMP_DIRECTORY);
    this.lastPersistedProgressAt = 0;
    const sessionId = createSessionId();
    const startedAt = nowIso();

    useAIStore.getState().updateTransfer({
      downloadUrl: QWEN_MODEL_DOWNLOAD_URL,
      resumableUri: TEMP_DOWNLOAD_PATH,
      resumeData: null,
      startedAt,
      updatedAt: startedAt,
      bytesPerSecond: null,
      lastProgressAt: null,
      sessionId,
    });

    this.updateProvisioning({
      status: 'queued',
      tempPath: TEMP_DOWNLOAD_PATH,
      pausedReason: null,
      lastError: null,
      totalBytes: null,
      downloadedBytes: 0,
      progress: 0,
      canResume: false,
      transfer: {
        downloadUrl: QWEN_MODEL_DOWNLOAD_URL,
        resumableUri: TEMP_DOWNLOAD_PATH,
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
      resumeData: null,
      sessionId,
      startedAt,
      downloadedBytes: 0,
      progress: 0,
      totalBytes: null,
      lastProgressAt: null,
      bytesPerSecond: null,
      updatedAt: startedAt,
    });

    this.inFlightDownloadPromise = this.runResumableDownload(null, null);
    try {
      await this.inFlightDownloadPromise;
    } finally {
      this.inFlightDownloadPromise = null;
    }
  }

  private async runResumableDownload(_resumeData: string | null, _manifest: TransferManifest | null) {
    const downloadResumableFactory = FileSystemModule.createDownloadResumable;
    if (!downloadResumableFactory) {
      throw new Error('Download API unavailable in current runtime. Use a custom dev client or production build.');
    }

    const sessionId = useAIStore.getState().provisioning.transfer.sessionId ?? createSessionId();
    const startedAt = useAIStore.getState().provisioning.transfer.startedAt ?? nowIso();

    this.downloadResumable = downloadResumableFactory(
      QWEN_MODEL_DOWNLOAD_URL,
      TEMP_DOWNLOAD_PATH,
      {},
      (progress) => {
        void this.handleProgressUpdate(progress, sessionId, startedAt);
      },
    );

    this.log(
      'info',
      'download-started',
      'Starting atomic OTA model download.',
      {
        version: QWEN_MODEL_ASSET_VERSION,
        url: QWEN_MODEL_DOWNLOAD_URL,
        resumed: false,
      },
    );

    this.updateProvisioning({ status: 'downloading', pausedReason: null, lastError: null, canResume: false, tempPath: TEMP_DOWNLOAD_PATH });

    try {
      const result = await this.downloadResumable.downloadAsync();
      this.downloadResumable = null;
      await this.handleDownloadFinished(result?.uri ?? TEMP_DOWNLOAD_PATH);
    } catch (error) {
      this.downloadResumable = null;
      const message = error instanceof Error ? error.message : 'Model download failed.';
      const current = useAIStore.getState().provisioning;

      if (/cancel/i.test(message)) {
        await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
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

  private async handleProgressUpdate(progress: DownloadProgress, sessionId: string, startedAt: string) {
    const totalBytes = progress.totalBytesExpectedToWrite > 0 ? progress.totalBytesExpectedToWrite : null;
    const downloadedBytes = progress.totalBytesWritten;
    const percent = totalBytes ? downloadedBytes / totalBytes : 0;
    const current = useAIStore.getState().provisioning;
    const lastDownloadedBytes = current.downloadedBytes;
    const nowMs = Date.now();
    const previousProgressAt = current.transfer.lastProgressAt ? new Date(current.transfer.lastProgressAt).getTime() : null;
    const elapsedMs = previousProgressAt ? Math.max(1, nowMs - previousProgressAt) : null;
    const computedBytesPerSecond = elapsedMs ? Math.max(0, ((downloadedBytes - lastDownloadedBytes) / elapsedMs) * 1000) : current.transfer.bytesPerSecond;
    const bytesPerSecond = Number.isFinite(computedBytesPerSecond ?? NaN) ? computedBytesPerSecond ?? null : null;
    const timestamp = new Date(nowMs).toISOString();

    useAIStore.getState().updateTransfer({
      downloadUrl: QWEN_MODEL_DOWNLOAD_URL,
      resumableUri: TEMP_DOWNLOAD_PATH,
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
      tempPath: TEMP_DOWNLOAD_PATH,
      canResume: false,
    });

    if (nowMs - this.lastPersistedProgressAt >= AI_BOOTSTRAP_OPTIONS.progressPersistIntervalMs) {
      this.lastPersistedProgressAt = nowMs;
      const latestTransfer = useAIStore.getState().provisioning.transfer;
      await this.persistTransferManifest({
        status: 'downloading',
        sessionId,
        startedAt,
        downloadedBytes,
        totalBytes,
        progress: percent,
        lastProgressAt: timestamp,
        bytesPerSecond,
        resumeData: null,
        updatedAt: timestamp,
      });
    }
  }

  private async handleDownloadFinished(downloadedUri: string) {
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

    await this.resumeVerification(downloadedUri);
  }

  private async resumeVerification(downloadedUri: string) {
    if (this.inFlightVerificationPromise) {
      return this.inFlightVerificationPromise;
    }

    const verificationPromise = this.verifyAndFinalizeInstalledModel(downloadedUri, true).finally(() => {
      this.inFlightVerificationPromise = null;
    });

    this.inFlightVerificationPromise = verificationPromise;
    return verificationPromise;
  }

  private async verifyAndFinalizeInstalledModel(sourcePath: string, moveIntoActiveDirectory = false) {
    const fileInfo = await safeGetInfo(sourcePath);
    this.log('info', 'verify-started', 'Verifying local Qwen model artifact integrity.', {
      sourcePath,
      resolvedSourceUri: fileInfo.uri ?? sourcePath,
      fileSize: fileInfo.size ?? null,
      moveIntoActiveDirectory,
      checksumEnabled: SHOULD_VERIFY_CHECKSUM,
      activeModelPath: ACTIVE_MODEL_PATH,
      documentDirectory: DOCUMENT_DIRECTORY,
      cacheDirectory: FileSystemModule.cacheDirectory ?? null,
    });
    if (!fileInfo.exists) {
      throw new Error('Model artifact missing after download.');
    }

    try {
      if (SHOULD_VERIFY_CHECKSUM) {
        const hash = await sha256ForFile(sourcePath);
        if (hash !== QWEN_MODEL_SHA256) {
          await safeDelete(sourcePath);
          await clearTransferManifest();
          useAIStore.getState().resetTransfer();
          throw new Error('Model checksum verification failed.');
        }
      }

      this.updateProvisioning({
        checksumVerified: true,
        lastVerifiedAt: nowIso(),
        lastError: null,
        canResume: false,
      });

      await ensureDirectory(ACTIVE_MODEL_DIRECTORY);

      if (moveIntoActiveDirectory) {
        this.updateProvisioning({ status: 'unpacking' });
        const previousInfo = await safeGetInfo(ACTIVE_MODEL_PATH);
        const rollbackPath = `${ACTIVE_MODEL_DIRECTORY}${QWEN_MODEL_FILE_NAME}.rollback`;

        if (previousInfo.exists) {
          await safeDelete(rollbackPath);
          await safeMove(ACTIVE_MODEL_PATH, rollbackPath);
        }

        try {
          await safeMove(sourcePath, ACTIVE_MODEL_PATH);
          const installedInfo = await safeGetInfo(ACTIVE_MODEL_PATH);
          this.log('info', 'install-move-complete', 'Moved verified GGUF model into active directory.', {
            sourcePath,
            activeModelPath: ACTIVE_MODEL_PATH,
            activeModelUri: installedInfo.uri ?? ACTIVE_MODEL_PATH,
            activeModelExists: installedInfo.exists,
            activeModelSize: installedInfo.size ?? null,
          });
          await safeDelete(rollbackPath);
        } catch (error) {
          const rollbackInfo = await safeGetInfo(rollbackPath);
          if (rollbackInfo.exists) {
            await safeMove(rollbackPath, ACTIVE_MODEL_PATH);
          }
          throw error;
        }
      }

      const installedModelPath = await findExistingModelPath(ACTIVE_MODEL_PATH);
      if (!installedModelPath) {
        throw new Error(`GGUF model file does not exist at path: ${ACTIVE_MODEL_PATH}`);
      }
      await this.registerWarmupAndIndex(installedModelPath);
    } catch (error) {
      const isChecksumMemoryRisk = error instanceof Error && /checksum verification requires loading the entire file into js memory/i.test(error.message);
      if (isChecksumMemoryRisk) {
        this.log('warn', 'verify-skipped-memory-risk', 'Skipping checksum verification because current Expo file APIs would require loading the full model into JS memory.', {
          sourcePath,
          fileSize: fileInfo.size ?? null,
        });

        this.updateProvisioning({
          checksumVerified: false,
          lastVerifiedAt: null,
          lastError: null,
          canResume: false,
        });

        await ensureDirectory(ACTIVE_MODEL_DIRECTORY);

        if (moveIntoActiveDirectory) {
          this.updateProvisioning({ status: 'unpacking' });
          const previousInfo = await safeGetInfo(ACTIVE_MODEL_PATH);
          const rollbackPath = `${ACTIVE_MODEL_DIRECTORY}${QWEN_MODEL_FILE_NAME}.rollback`;

          if (previousInfo.exists) {
            await safeDelete(rollbackPath);
            await safeMove(ACTIVE_MODEL_PATH, rollbackPath);
          }

          try {
            await safeMove(sourcePath, ACTIVE_MODEL_PATH);
            const installedInfo = await safeGetInfo(ACTIVE_MODEL_PATH);
            this.log('info', 'install-move-complete', 'Moved verified GGUF model into active directory.', {
              sourcePath,
              activeModelPath: ACTIVE_MODEL_PATH,
              activeModelUri: installedInfo.uri ?? ACTIVE_MODEL_PATH,
              activeModelExists: installedInfo.exists,
              activeModelSize: installedInfo.size ?? null,
            });
            await safeDelete(rollbackPath);
          } catch (moveError) {
            const rollbackInfo = await safeGetInfo(rollbackPath);
            if (rollbackInfo.exists) {
              await safeMove(rollbackPath, ACTIVE_MODEL_PATH);
            }
            throw moveError;
          }
        }

        const installedModelPath = await findExistingModelPath(ACTIVE_MODEL_PATH);
        if (!installedModelPath) {
          throw new Error(`GGUF model file does not exist at path: ${ACTIVE_MODEL_PATH}`);
        }
        await this.registerWarmupAndIndex(installedModelPath);
        return;
      }
      if (moveIntoActiveDirectory) {
        await safeDelete(sourcePath);
      }
      throw error;
    }
  }

  private async registerWarmupAndIndex(modelPath: string, preserveInstalledReadyState = false) {
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
      if (!resolvedModelPath) {
        await this.clearInvalidInstalledState('The downloaded GGUF file could not be found at the expected location. The stale installation metadata was cleared so setup can restart safely.', {
          expectedModelPath: modelPath,
        });
        throw new Error(`Local GGUF model file is missing. Expected it at: ${modelPath}`);
      }

      if (resolvedModelPath !== modelPath) {
        this.updateProvisioning({ modelPath: resolvedModelPath, lastError: null, pausedReason: null });
      }

      const resolvedModelInfo = await safeGetInfo(resolvedModelPath);
      const registerStartedAt = Date.now();
      this.log('info', 'register-started', 'Registering local Qwen model with inference runtime.', {
        requestedModelPath: modelPath,
        resolvedModelPath,
        runtimeAccessiblePath: resolvedModelInfo.uri ?? resolvedModelPath,
        fileExists: resolvedModelInfo.exists,
        fileSize: resolvedModelInfo.size ?? null,
      });
      await this.inferenceAdapter.registerModel(resolvedModelPath);
      this.log('info', 'register-finished', 'Local model registration finished.', {
        resolvedModelPath,
        durationMs: Date.now() - registerStartedAt,
      });

      const runtimeInfo = await this.inferenceAdapter.getRuntimeInfo();
      const runtimeInfoValidation = validateRuntimeInfo(runtimeInfo);
      if (!runtimeInfoValidation.ok) {
        throw new Error(runtimeInfoValidation.reason ?? 'Native runtime returned invalid runtime information.');
      }
      state.setRuntimeInfo(runtimeInfo);
      state.setRuntimeModelLoaded(Boolean(runtimeInfo.isModelLoaded ?? true), runtimeInfo);

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

      const initializedAt = preserveInstalledReadyState ? state.provisioning.initializedAt ?? nowIso() : nowIso();
      const finalModelPath = await findExistingModelPath(useAIStore.getState().provisioning.modelPath ?? modelPath);
      if (!finalModelPath) {
        await this.clearInvalidInstalledState('The GGUF file disappeared before installation metadata could be finalized. Setup metadata was reset to avoid a broken ready state.', {
          expectedModelPath: useAIStore.getState().provisioning.modelPath ?? modelPath,
        });
        throw new Error('GGUF model file was not available after registration completed.');
      }

      await writeManifest({
        version: QWEN_MODEL_ASSET_VERSION,
        modelPath: finalModelPath,
        checksumVerified: true,
        initializedAt,
        lastVerifiedAt: nowIso(),
      });

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
    await ensureDirectory(AI_ROOT_DIRECTORY);
    await ensureDirectory(AI_MODELS_DIRECTORY);
    await ensureDirectory(AI_TEMP_DIRECTORY);
  }

  private async restorePersistedState() {
    const state = useAIStore.getState();
    state.markRuntimeReady(false);
    state.setWarmupPending(false);
    state.setRuntimeHealth(false, null);
    state.setRuntimeModelLoaded(false, null);

    const availability = state.refreshRuntimeAvailability();
    if (!availability.available) {
      state.setRuntimeState('unavailable');
      state.setRuntimeError({
        code: 'backend-unavailable',
        message: availability.message,
        recoverable: false,
      });
    }

    const manifest = await readManifest();
    if (manifest?.modelPath) {
      const resolvedManifestPath = await findExistingModelPath(manifest.modelPath);
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
          updateAvailable: manifest.version !== QWEN_MODEL_ASSET_VERSION,
          canResume: false,
          lastError: null,
          pausedReason: null,
          tempPath: null,
        });

        if (availability.available) {
          state.setRuntimeState('model-unloaded');
        }
      } else {
        await clearManifest();
        state.replaceProvisioning({
          ...createInitialProvisioningSnapshot(),
          lastError: 'Saved GGUF installation metadata pointed to a file that no longer exists. Download the model again to reinstall it cleanly.',
        });
      }
    }

    const transferManifest = await readTransferManifest();
    if (!transferManifest) {
      const tempInfo = await safeGetInfo(TEMP_DOWNLOAD_PATH);
      if (tempInfo.exists) {
        await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
      }
      return;
    }

    const tempInfo = await safeGetInfo(transferManifest.tempPath);
    if (!tempInfo.exists) {
      await clearTransferManifest();
      state.resetTransfer();
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
      await this.resumeVerification(transferManifest.tempPath);
      return;
    }

    this.log('warn', 'restored-partial-download-cleared', 'Discarding restored partial model download to preserve atomic install behavior.', {
      tempPath: transferManifest.tempPath,
      downloadedBytes: transferManifest.downloadedBytes,
      status: transferManifest.status,
    });
    await this.resetProvisioningArtifacts({ preserveInstalledModel: true });
    state.replaceProvisioning({
      ...state.provisioning,
      status: 'not-installed',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      tempPath: null,
      canResume: false,
      pausedReason: null,
      lastError: 'An incomplete model download was discarded. Restart setup to download the full model in one pass.',
    });
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
      downloadUrl: overrides.downloadUrl ?? transfer.downloadUrl ?? QWEN_MODEL_DOWNLOAD_URL,
      targetPath: overrides.targetPath ?? transfer.resumableUri ?? TEMP_DOWNLOAD_PATH,
      tempPath: overrides.tempPath ?? provisioning.tempPath ?? TEMP_DOWNLOAD_PATH,
      totalBytes: overrides.totalBytes ?? provisioning.totalBytes,
      downloadedBytes: overrides.downloadedBytes ?? provisioning.downloadedBytes,
      progress: overrides.progress ?? provisioning.progress,
      resumeData: overrides.resumeData ?? transfer.resumeData,
      startedAt: overrides.startedAt ?? transfer.startedAt,
      updatedAt: overrides.updatedAt ?? nowIso(),
      lastProgressAt: overrides.lastProgressAt ?? transfer.lastProgressAt,
      bytesPerSecond: overrides.bytesPerSecond ?? transfer.bytesPerSecond,
      sessionId: overrides.sessionId ?? transfer.sessionId ?? createSessionId(),
    };

    await writeTransferManifest(manifest);
  }

  private log(level: 'info' | 'warn' | 'error', event: string, message: string, details?: Record<string, unknown>) {
    useAIStore.getState().appendLog({ level, event, message, details });
  }

  private normalizeRuntimeError(error: unknown, modelPath?: string): LocalInferenceError {
    if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
      const typedError = error as LocalInferenceError;
      return {
        code: typedError.code ?? 'unknown',
        message: typedError.message,
        details: {
          modelPath,
          ...typedError.details,
        },
        recoverable: typedError.recoverable ?? true,
      };
    }

    if (error instanceof Error) {
      return {
        code: 'load-failed',
        message: error.message,
        details: modelPath ? { modelPath } : undefined,
        recoverable: true,
      };
    }

    return {
      code: 'unknown',
      message: 'Unknown local inference runtime failure.',
      details: modelPath ? { modelPath } : undefined,
      recoverable: true,
    };
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
    this.downloadResumable = null;
    this.inFlightDownloadPromise = null;
    this.inFlightVerificationPromise = null;
    this.lastPersistedProgressAt = 0;

    await safeDelete(TEMP_DOWNLOAD_PATH);
    await clearTransferManifest();
    useAIStore.getState().resetTransfer();
    useAIStore.getState().markRuntimeReady(false);
    useAIStore.getState().setWarmupPending(false);

    this.updateProvisioning({
      ...createInitialProvisioningSnapshot(),
      status: options?.preserveInstalledModel ? useAIStore.getState().provisioning.status : 'not-installed',
      tempPath: null,
      lastError: null,
      pausedReason: null,
      canResume: false,
    });
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
