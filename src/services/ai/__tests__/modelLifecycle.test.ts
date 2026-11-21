import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import {
  QModelLifecycleManager,
  getActiveModelFileUri,
  isActiveModelInstalled,
  getVisionProjectorUri,
  isVisionProjectorInstalled,
  downloadVisionProjector,
  cancelVisionProjectorDownload,
  deleteVisionProjector,
  type LocalInferenceAdapter,
} from '../modelLifecycle';
import { MODEL_CATALOG } from '../../../features/transactions/constants';
import { useAIStore, createInitialProvisioningSnapshot, createInitialRuntimeSnapshot } from '../../../store/useAIStore';
import { useSettingsStore } from '../../../store/useSettingsStore';

jest.mock('expo-network', () => ({
  NetworkStateType: {
    NONE: 'NONE',
    UNKNOWN: 'UNKNOWN',
    CELLULAR: 'CELLULAR',
    WIFI: 'WIFI',
  },
  getNetworkStateAsync: jest.fn(async () => ({
    type: 'WIFI',
    isConnected: true,
    isInternetReachable: true,
  })),
}));

jest.mock('../hardware', () => ({
  recordMemoryTelemetry: jest.fn(async () => {}),
}));

const EXPECTED_SIZE = 1280835840;
const EXPECTED_MD5 = '6899b2510c7b0c480730d48c3117bd32';
const EXPECTED_SHA256 = 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223';

function createMockAdapter(): LocalInferenceAdapter {
  return {
    isAvailable: () => true,
    registerModel: jest.fn(async () => {}),
    warmup: jest.fn(async () => {}),
    getRuntimeInfo: jest.fn(async () => ({
      backend: 'llama.rn',
      version: '0.0.0',
      isModelLoaded: true,
      loadedModelPath: getActiveModelFileUri(),
      loadedModelFamily: 'qwen',
      supportsStreaming: true,
      maxContextTokens: 1024,
    })),
    runHealthCheck: jest.fn(async () => ({
      ok: true,
      prompt: 'ping',
      responseText: 'pong',
      matchedExpectedSubstring: true,
      durationMs: 1,
    })),
    indexLocalKnowledge: jest.fn(async () => {}),
    releaseContext: jest.fn(async () => {}),
  };
}

describe('modelLifecycle, catalog integrity, and download races', () => {
  const fsMock = ExpoFileSystemLegacy as unknown as {
    documentDirectory: string;
    getInfoAsync: jest.Mock;
    makeDirectoryAsync: jest.Mock;
    deleteAsync: jest.Mock;
    moveAsync: jest.Mock;
    readAsStringAsync: jest.Mock;
    writeAsStringAsync: jest.Mock;
    createDownloadResumable?: jest.Mock;
    getFreeDiskStorageAsync?: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fsMock.documentDirectory = 'file:///mock/data/user/0/com.LCSdev.silo/files/';
    fsMock.getFreeDiskStorageAsync = jest.fn(async () => 10 * 1024 * 1024 * 1024);
    fsMock.readAsStringAsync.mockRejectedValue(new Error('not found'));
    fsMock.getInfoAsync.mockResolvedValue({ exists: false, uri: '' });
    fsMock.createDownloadResumable = jest.fn();

    useSettingsStore.setState({
      activeModelId: 'qwen3.5-2b',
      aiWifiOnlyDownload: false,
    });
    useAIStore.setState({
      provisioning: createInitialProvisioningSnapshot(),
      runtimeReady: false,
      warmupPending: false,
      logs: [],
    });
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({
      type: Network.NetworkStateType.WIFI,
      isConnected: true,
      isInternetReachable: true,
    });
  });

  describe('A3 catalog & A8 single-path seam', () => {
    it('defines accurate sizeBytes, sha256, and md5 for qwen3.5-2b', () => {
      const entry = MODEL_CATALOG['qwen3.5-2b'];
      expect(entry.sizeBytes).toBe(EXPECTED_SIZE);
      expect(entry.fileSizeBytes).toBe(EXPECTED_SIZE);
      expect(entry.sha256).toBe(EXPECTED_SHA256);
      expect(entry.md5).toBe(EXPECTED_MD5);
      expect(entry.quantization).toBe('Q4_K_M');
    });

    it('returns the canonical active model file URI', () => {
      expect(getActiveModelFileUri()).toBe(
        'file:///mock/data/user/0/com.LCSdev.silo/files/ai/models/qwen3.5-2b/Qwen3.5-2B-Q4_K_M.gguf',
      );
    });

    it('isActiveModelInstalled checks existence and exact byte size', async () => {
      const activeUri = getActiveModelFileUri();
      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === activeUri) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });
      expect(await isActiveModelInstalled()).toBe(true);

      fsMock.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 12345, uri: activeUri });
      expect(await isActiveModelInstalled()).toBe(false);

      fsMock.getInfoAsync.mockResolvedValueOnce({ exists: false, uri: activeUri });
      expect(await isActiveModelInstalled()).toBe(false);
    });
  });

  describe('A3 download verification (size + native MD5)', () => {
    it('verifies exact byte size and MD5 via getInfoAsync({ md5: true }) and records checksumVerified=true', async () => {
      const activeUri = getActiveModelFileUri();
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      let movedToActive = false;

      fsMock.moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
        if (to === activeUri) {
          movedToActive = true;
        }
      });

      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempUri) {
          return {
            exists: !movedToActive,
            size: EXPECTED_SIZE,
            uri: tempUri,
            ...(opts?.md5 ? { md5: EXPECTED_MD5 } : {}),
          };
        }
        if (path === activeUri && movedToActive) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      await (manager as any).inFlightDownloadPromise;

      expect(fsMock.getInfoAsync).toHaveBeenCalledWith(tempUri, { md5: true });
      expect(movedToActive).toBe(true);
      expect(useAIStore.getState().provisioning.status).toBe('ready');
      expect(useAIStore.getState().provisioning.checksumVerified).toBe(true);

      const manifestWrites = fsMock.writeAsStringAsync.mock.calls.filter(([p]) =>
        String(p).endsWith('model-manifest.json'),
      );
      expect(manifestWrites.length).toBeGreaterThan(0);
      const lastManifest = JSON.parse(manifestWrites[manifestWrites.length - 1][1]);
      expect(lastManifest.checksumVerified).toBe(true);
    });

    it('deletes artifact, sets status=failed, and never installs on byte size mismatch', async () => {
      const activeUri = getActiveModelFileUri();
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';

      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempUri) {
          return {
            exists: true,
            size: 999,
            uri: tempUri,
            ...(opts?.md5 ? { md5: EXPECTED_MD5 } : {}),
          };
        }
        return { exists: false, uri: path };
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      await (manager as any).inFlightDownloadPromise;

      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempUri, { idempotent: true });
      expect(fsMock.moveAsync).not.toHaveBeenCalledWith(expect.objectContaining({ to: activeUri }));
      expect(useAIStore.getState().provisioning.status).toBe('failed');
      expect(useAIStore.getState().provisioning.lastError).toMatch(/size verification failed/i);
      expect(useAIStore.getState().provisioning.checksumVerified).toBe(false);
    });

    it('deletes artifact, sets status=failed, and never installs on MD5 mismatch', async () => {
      const activeUri = getActiveModelFileUri();
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';

      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempUri) {
          return {
            exists: true,
            size: EXPECTED_SIZE,
            uri: tempUri,
            ...(opts?.md5 ? { md5: '00000000000000000000000000000000' } : {}),
          };
        }
        return { exists: false, uri: path };
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      await (manager as any).inFlightDownloadPromise;

      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempUri, { idempotent: true });
      expect(fsMock.moveAsync).not.toHaveBeenCalledWith(expect.objectContaining({ to: activeUri }));
      expect(useAIStore.getState().provisioning.status).toBe('failed');
      expect(useAIStore.getState().provisioning.lastError).toMatch(/MD5 checksum verification failed/i);
      expect(useAIStore.getState().provisioning.checksumVerified).toBe(false);
    });

    it('fails closed (never installs) when native MD5 is unavailable but expected', async () => {
      const activeUri = getActiveModelFileUri();
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      let movedToActive = false;

      fsMock.moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
        if (to === activeUri) {
          movedToActive = true;
        }
      });

      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === tempUri) {
          return { exists: !movedToActive, size: EXPECTED_SIZE, uri: tempUri };
        }
        if (path === activeUri && movedToActive) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      await (manager as any).inFlightDownloadPromise;

      expect(useAIStore.getState().provisioning.status).toBe('failed');
      expect(useAIStore.getState().provisioning.checksumVerified).toBe(false);
      expect(movedToActive).toBe(false);
    });
  });

  describe('A4 cancel and progress race protection', () => {
    it('ignores undefined downloadAsync resolution and late progress callbacks after cancelDownload()', async () => {
      let resolveDownload!: (res: { uri: string } | undefined) => void;
      let progressCb!: (progress: { totalBytesExpectedToWrite: number; totalBytesWritten: number }) => void;
      const cancelAsync = jest.fn(async () => {});

      fsMock.createDownloadResumable!.mockImplementation(
        (_url: string, _uri: string, _opts: unknown, cb: typeof progressCb) => {
          progressCb = cb;
          return {
            downloadAsync: () =>
              new Promise<{ uri: string } | undefined>((resolve) => {
                resolveDownload = resolve;
              }),
            resumeAsync: jest.fn(),
            pauseAsync: jest.fn(),
            cancelAsync,
          };
        },
      );

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      const inFlight = (manager as any).inFlightDownloadPromise;

      expect(useAIStore.getState().provisioning.status).toBe('downloading');

      await manager.cancelDownload();
      expect(cancelAsync).toHaveBeenCalledTimes(1);
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      // Late progress callback arrives after cancel
      progressCb({ totalBytesExpectedToWrite: EXPECTED_SIZE, totalBytesWritten: 500_000 });
      await Promise.resolve();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      // downloadAsync resolves undefined after cancel — must NOT enter handleDownloadFinished/verifying
      resolveDownload(undefined);
      await inFlight;
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');
      expect(fsMock.moveAsync).not.toHaveBeenCalled();
    });

    it('pause persists resumeData and keeps temp file', async () => {
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":500000}';
      const pauseAsync = jest.fn(async () => ({ resumeData: mockResumeData }));
      let resolveDownload!: (res: { uri: string } | undefined) => void;

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: () =>
          new Promise<{ uri: string } | undefined>((resolve) => {
            resolveDownload = resolve;
          }),
        resumeAsync: jest.fn(),
        pauseAsync,
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      const inFlight = (manager as any).inFlightDownloadPromise;

      await manager.pauseDownload('User paused');
      expect(pauseAsync).toHaveBeenCalledTimes(1);

      // Temp file must NOT be deleted
      expect(fsMock.deleteAsync).not.toHaveBeenCalledWith(tempUri, expect.anything());

      // Provisioning status in store
      const provisioning = useAIStore.getState().provisioning;
      expect(provisioning.status).toBe('paused');
      expect(provisioning.canResume).toBe(true);
      expect(provisioning.pausedReason).toBe('User paused');
      expect(provisioning.transfer.resumeData).toBe(mockResumeData);

      // Persisted transfer manifest
      const transferManifestWrites = fsMock.writeAsStringAsync.mock.calls.filter(([p]) =>
        String(p).endsWith('download-manifest.json'),
      );
      expect(transferManifestWrites.length).toBeGreaterThan(0);
      const lastManifest = JSON.parse(transferManifestWrites[transferManifestWrites.length - 1][1]);
      expect(lastManifest.status).toBe('paused');
      expect(lastManifest.resumeData).toBe(mockResumeData);
      expect(lastManifest.pausedReason).toBe('User paused');

      resolveDownload(undefined);
      await inFlight;
    });

    it('resume passes resumeData to createDownloadResumable and ends ready after verification', async () => {
      const activeUri = getActiveModelFileUri();
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":500000}';
      let movedToActive = false;

      fsMock.moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
        if (to === activeUri) {
          movedToActive = true;
        }
      });

      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempUri) {
          return {
            exists: !movedToActive,
            size: EXPECTED_SIZE,
            uri: tempUri,
            ...(opts?.md5 ? { md5: EXPECTED_MD5 } : {}),
          };
        }
        if (path === activeUri && movedToActive) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });

      const persistedManifest = {
        version: 'qwen3.5-2b',
        status: 'paused',
        downloadUrl: 'https://example.com/model.gguf',
        targetPath: tempUri,
        tempPath: tempUri,
        totalBytes: EXPECTED_SIZE,
        downloadedBytes: 500000,
        progress: 500000 / EXPECTED_SIZE,
        resumeData: mockResumeData,
        startedAt: '2026-11-19T00:00:00.000Z',
        updatedAt: '2026-11-19T00:00:01.000Z',
        lastProgressAt: '2026-11-19T00:00:01.000Z',
        bytesPerSecond: 100000,
        sessionId: 'session-123',
      };
      fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
        if (path.endsWith('download-manifest.json')) {
          return JSON.stringify(persistedManifest);
        }
        throw new Error('not found');
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempUri })),
        resumeAsync: jest.fn(async () => ({ uri: tempUri })),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.resumeDownload();

      // createDownloadResumable must receive mockResumeData
      expect(fsMock.createDownloadResumable).toHaveBeenCalledWith(
        expect.any(String),
        tempUri,
        expect.any(Object),
        expect.any(Function),
        mockResumeData,
      );

      // Must complete verification and end in 'ready'
      expect(fsMock.getInfoAsync).toHaveBeenCalledWith(tempUri, { md5: true });
      expect(movedToActive).toBe(true);
      expect(useAIStore.getState().provisioning.status).toBe('ready');
      expect(useAIStore.getState().provisioning.checksumVerified).toBe(true);
    });

    it('pause with failing pauseAsync falls back to cancel', async () => {
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const cancelAsync = jest.fn(async () => {});
      const pauseAsync = jest.fn(async () => {
        throw new Error('Native pause error');
      });
      let resolveDownload!: (res: { uri: string } | undefined) => void;

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: () =>
          new Promise<{ uri: string } | undefined>((resolve) => {
            resolveDownload = resolve;
          }),
        resumeAsync: jest.fn(),
        pauseAsync,
        cancelAsync,
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      const inFlight = (manager as any).inFlightDownloadPromise;

      await manager.pauseDownload();
      expect(pauseAsync).toHaveBeenCalledTimes(1);
      expect(cancelAsync).toHaveBeenCalledTimes(1);
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempUri, { idempotent: true });
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');
      expect(useAIStore.getState().provisioning.canResume).toBe(false);

      resolveDownload(undefined);
      await inFlight;
    });

    it('cancel clears resumeData', async () => {
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":500000}';

      useAIStore.getState().replaceProvisioning({
        status: 'paused',
        canResume: true,
        pausedReason: 'Paused',
        transfer: {
          downloadUrl: 'https://example.com/model.gguf',
          resumableUri: tempUri,
          resumeData: mockResumeData,
          startedAt: null,
          updatedAt: null,
          bytesPerSecond: null,
          lastProgressAt: null,
          sessionId: null,
        },
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.cancelDownload();

      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempUri, { idempotent: true });
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(
        expect.stringMatching(/download-manifest\.json$/),
        { idempotent: true },
      );
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');
      expect(useAIStore.getState().provisioning.canResume).toBe(false);
      expect(useAIStore.getState().provisioning.transfer.resumeData).toBeNull();
    });

    it('restores paused state with canResume=true on initialize after app restart', async () => {
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":500000}';

      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === tempUri) {
          return { exists: true, size: 500000, uri: tempUri };
        }
        return { exists: false, uri: path };
      });

      const persistedManifest = {
        version: 'qwen3.5-2b',
        status: 'paused',
        downloadUrl: 'https://example.com/model.gguf',
        targetPath: tempUri,
        tempPath: tempUri,
        totalBytes: EXPECTED_SIZE,
        downloadedBytes: 500000,
        progress: 500000 / EXPECTED_SIZE,
        resumeData: mockResumeData,
        startedAt: '2026-11-19T00:00:00.000Z',
        updatedAt: '2026-11-19T00:00:01.000Z',
        lastProgressAt: '2026-11-19T00:00:01.000Z',
        bytesPerSecond: 100000,
        sessionId: 'session-123',
        pausedReason: 'Paused by user',
      };
      fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
        if (path.endsWith('download-manifest.json')) {
          return JSON.stringify(persistedManifest);
        }
        throw new Error('not found');
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.initialize();

      const provisioning = useAIStore.getState().provisioning;
      expect(provisioning.status).toBe('paused');
      expect(provisioning.canResume).toBe(true);
      expect(provisioning.pausedReason).toBe('Paused by user');
      expect(provisioning.transfer.resumeData).toBe(mockResumeData);
      expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
    });

    it('blocks resumeDownload when aiWifiOnlyDownload is true and not on Wi-Fi', async () => {
      useSettingsStore.setState({ aiWifiOnlyDownload: true });
      (Network.getNetworkStateAsync as jest.Mock).mockResolvedValueOnce({
        type: Network.NetworkStateType.CELLULAR,
        isConnected: true,
        isInternetReachable: true,
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.resumeDownload();

      expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
      expect(useAIStore.getState().provisioning.status).toBe('failed');
      expect(useAIStore.getState().provisioning.lastError).toBe('Wi-Fi required (change in Settings)');
    });
  });

  describe('A14 Wi-Fi only download setting', () => {
    it('blocks download with clear error message when aiWifiOnlyDownload is true and not on Wi-Fi', async () => {
      useSettingsStore.setState({ aiWifiOnlyDownload: true });
      (Network.getNetworkStateAsync as jest.Mock).mockResolvedValueOnce({
        type: Network.NetworkStateType.CELLULAR,
        isConnected: true,
        isInternetReachable: true,
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();

      expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
      expect(useAIStore.getState().provisioning.status).toBe('failed');
      expect(useAIStore.getState().provisioning.lastError).toBe('Wi-Fi required (change in Settings)');
    });

    it('allows download when aiWifiOnlyDownload is true and connected to Wi-Fi', async () => {
      useSettingsStore.setState({ aiWifiOnlyDownload: true });
      (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({
        type: Network.NetworkStateType.WIFI,
        isConnected: true,
        isInternetReachable: true,
      });

      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const activeUri = getActiveModelFileUri();
      let movedToActive = false;

      fsMock.moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
        if (to === activeUri) movedToActive = true;
      });
      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempUri) {
          return { exists: !movedToActive, size: EXPECTED_SIZE, uri: tempUri, ...(opts?.md5 ? { md5: EXPECTED_MD5 } : {}) };
        }
        if (path === activeUri && movedToActive) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });
      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.startProvisioningIfNeeded();
      await (manager as any).inFlightDownloadPromise;

      expect(fsMock.createDownloadResumable).toHaveBeenCalledTimes(1);
      expect(useAIStore.getState().provisioning.status).toBe('ready');
    });
  });

  describe('Vision projector artifact (download/verify/delete)', () => {
    const PROJECTOR_SIZE = 668227264;
    const PROJECTOR_MD5 = 'bb3eddc16b7f19fd96b9eedf48a7248d';
    const projectorUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/models/qwen3.5-2b/mmproj-F16.gguf';
    const tempProjectorUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/mmproj-F16.gguf.part';

    beforeEach(async () => {
      await cancelVisionProjectorDownload().catch(() => {});
    });

    it('has correct catalog entry metadata for qwen3.5-2b vision projector', () => {
      const entry = MODEL_CATALOG['qwen3.5-2b'];
      expect(entry.visionProjector).toBeDefined();
      expect(entry.visionProjector?.url).toBe(
        'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/mmproj-F16.gguf',
      );
      expect(entry.visionProjector?.fileName).toBe('mmproj-F16.gguf');
      expect(entry.visionProjector?.sizeBytes).toBe(PROJECTOR_SIZE);
      expect(entry.visionProjector?.md5).toBe(PROJECTOR_MD5);
    });

    it('getVisionProjectorUri returns file:// URI next to the active model', () => {
      expect(getVisionProjectorUri()).toBe(projectorUri);
    });

    it('isVisionProjectorInstalled verifies file existence and exact byte size', async () => {
      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === projectorUri) {
          return { exists: true, size: PROJECTOR_SIZE, uri: projectorUri };
        }
        return { exists: false, uri: path };
      });
      expect(await isVisionProjectorInstalled()).toBe(true);

      // Size mismatch
      fsMock.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 12345, uri: projectorUri });
      expect(await isVisionProjectorInstalled()).toBe(false);

      // File does not exist
      fsMock.getInfoAsync.mockResolvedValueOnce({ exists: false, uri: projectorUri });
      expect(await isVisionProjectorInstalled()).toBe(false);
    });

    it('downloadVisionProjector success path downloads to .part, verifies size + md5, moves into place, and notifies progress', async () => {
      let movedToProjector = false;
      const progressUpdates: number[] = [];

      fsMock.moveAsync.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
        if (from === tempProjectorUri && to === projectorUri) {
          movedToProjector = true;
        }
      });

      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempProjectorUri) {
          return {
            exists: !movedToProjector,
            size: PROJECTOR_SIZE,
            uri: tempProjectorUri,
            ...(opts?.md5 ? { md5: PROJECTOR_MD5 } : {}),
          };
        }
        if (path === projectorUri && movedToProjector) {
          return { exists: true, size: PROJECTOR_SIZE, uri: projectorUri };
        }
        return { exists: false, uri: path };
      });

      let progressCb: ((p: { totalBytesExpectedToWrite: number; totalBytesWritten: number }) => void) | undefined;
      fsMock.createDownloadResumable!.mockImplementation((_url: string, _path: string, _opts: unknown, cb: any) => {
        progressCb = cb;
        return {
          downloadAsync: jest.fn(async () => {
            progressCb?.({ totalBytesExpectedToWrite: PROJECTOR_SIZE, totalBytesWritten: PROJECTOR_SIZE / 2 });
            return { uri: tempProjectorUri };
          }),
          resumeAsync: jest.fn(),
          pauseAsync: jest.fn(),
          cancelAsync: jest.fn(async () => {}),
        };
      });

      await downloadVisionProjector((fraction) => {
        progressUpdates.push(fraction);
      });

      expect(fsMock.createDownloadResumable).toHaveBeenCalledWith(
        'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/mmproj-F16.gguf',
        tempProjectorUri,
        expect.any(Object),
        expect.any(Function),
      );
      expect(fsMock.getInfoAsync).toHaveBeenCalledWith(tempProjectorUri, { md5: true });
      expect(movedToProjector).toBe(true);
      expect(progressUpdates).toContain(0.5);
      expect(progressUpdates).toContain(1);
    });

    it('downloadVisionProjector on MD5 mismatch deletes .part and throws Error("Vision projector verification failed")', async () => {
      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempProjectorUri) {
          return {
            exists: true,
            size: PROJECTOR_SIZE,
            uri: tempProjectorUri,
            ...(opts?.md5 ? { md5: 'wrong-md5-hash' } : {}),
          };
        }
        return { exists: false, uri: path };
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempProjectorUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      await expect(downloadVisionProjector()).rejects.toThrow('Vision projector verification failed');
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempProjectorUri, { idempotent: true });
      expect(fsMock.moveAsync).not.toHaveBeenCalled();
    });

    it('downloadVisionProjector on size mismatch deletes .part and throws Error("Vision projector verification failed")', async () => {
      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempProjectorUri) {
          return {
            exists: true,
            size: 9999,
            uri: tempProjectorUri,
            ...(opts?.md5 ? { md5: PROJECTOR_MD5 } : {}),
          };
        }
        return { exists: false, uri: path };
      });

      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(async () => ({ uri: tempProjectorUri })),
        resumeAsync: jest.fn(),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      await expect(downloadVisionProjector()).rejects.toThrow('Vision projector verification failed');
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempProjectorUri, { idempotent: true });
      expect(fsMock.moveAsync).not.toHaveBeenCalled();
    });

    it('downloadVisionProjector blocks on cellular when aiWifiOnlyDownload is enabled', async () => {
      useSettingsStore.setState({ aiWifiOnlyDownload: true });
      (Network.getNetworkStateAsync as jest.Mock).mockResolvedValueOnce({
        type: Network.NetworkStateType.CELLULAR,
        isConnected: true,
        isInternetReachable: true,
      });

      await expect(downloadVisionProjector()).rejects.toThrow('Wi-Fi required (change in Settings)');
      expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
    });

    it('downloadVisionProjector guards against concurrent calls by returning in-flight promise', async () => {
      let resolveDownload!: (res: { uri: string }) => void;
      const downloadCalled = new Promise<void>((r) => {
        fsMock.createDownloadResumable!.mockImplementation(() => ({
          downloadAsync: () => {
            r();
            return new Promise<{ uri: string }>((resolve) => {
              resolveDownload = resolve;
            });
          },
          resumeAsync: jest.fn(),
          pauseAsync: jest.fn(),
          cancelAsync: jest.fn(async () => {}),
        }));
      });

      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempProjectorUri) {
          return {
            exists: true,
            size: PROJECTOR_SIZE,
            uri: tempProjectorUri,
            ...(opts?.md5 ? { md5: PROJECTOR_MD5 } : {}),
          };
        }
        return { exists: false, uri: path };
      });

      const p1 = downloadVisionProjector();
      const p2 = downloadVisionProjector();
      expect(p1).toBe(p2);
      expect(fsMock.createDownloadResumable).toHaveBeenCalledTimes(1);

      await downloadCalled;
      resolveDownload({ uri: tempProjectorUri });
      await p1;
    });

    it('cancelVisionProjectorDownload cancels resumable and deletes .part file', async () => {
      const cancelAsync = jest.fn(async () => {});
      let resolveDownload!: (res: { uri: string } | undefined) => void;
      const downloadCalled = new Promise<void>((r) => {
        fsMock.createDownloadResumable!.mockImplementation(() => ({
          downloadAsync: () => {
            r();
            return new Promise<{ uri: string } | undefined>((resolve) => {
              resolveDownload = resolve;
            });
          },
          resumeAsync: jest.fn(),
          pauseAsync: jest.fn(),
          cancelAsync,
        }));
      });

      const downloadPromise = downloadVisionProjector();
      await downloadCalled;
      await cancelVisionProjectorDownload();

      expect(cancelAsync).toHaveBeenCalledTimes(1);
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempProjectorUri, { idempotent: true });

      resolveDownload(undefined);
      await downloadPromise.catch(() => {});
    });

    it('deleteVisionProjector cancels download, deletes installed projector and .part file', async () => {
      await deleteVisionProjector();
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(projectorUri, { idempotent: true });
      expect(fsMock.deleteAsync).toHaveBeenCalledWith(tempProjectorUri, { idempotent: true });
    });
  });

  describe('R4-01 & R4-03 startup lifecycle readiness & non-clobbering restore', () => {
    it('restorePersistedState never clobbers an already-loaded healthy llama.rn runtime (R4-01)', async () => {
      const activeUri = getActiveModelFileUri();
      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === activeUri) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });
      fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
        if (path.endsWith('model-manifest.json')) {
          return JSON.stringify({
            version: 'qwen3.5-2b',
            modelPath: activeUri,
            checksumVerified: true,
            initializedAt: '2026-11-21T00:00:00.000Z',
            lastVerifiedAt: '2026-11-21T00:00:00.000Z',
          });
        }
        throw new Error('not found');
      });

      const liveRuntime = createInitialRuntimeSnapshot();
      liveRuntime.modelLoaded = true;
      liveRuntime.generationHealthy = true;
      liveRuntime.runtimeState = 'healthy';
      liveRuntime.runtimeInfo = {
        backend: 'llama.rn-cpu',
        version: null,
        supportsStreaming: true,
        isModelLoaded: true,
        loadedModelPath: activeUri,
        loadedModelFamily: 'qwen',
      };

      useAIStore.setState({
        runtimeReady: true,
        warmupPending: false,
        runtime: liveRuntime,
        provisioning: createInitialProvisioningSnapshot(),
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.initialize();

      const after = useAIStore.getState();
      expect(after.provisioning.status).toBe('ready');
      expect(after.provisioning.modelPath).toBe(activeUri);
      expect(after.provisioningHydrated).toBe(true);
      expect(after.runtimeReady).toBe(true);
      expect(after.runtime.modelLoaded).toBe(true);
      expect(after.runtime.generationHealthy).toBe(true);
      expect(after.runtime.runtimeState).toBe('healthy');
    });

    it('shares one lifecycle-ready promise across concurrent initialize/ensureInitialized callers (R4-01)', async () => {
      const activeUri = getActiveModelFileUri();
      let resolveManifestRead!: (val: string) => void;
      let notifyManifestReadStarted!: () => void;
      const manifestReadStarted = new Promise<void>((resolve) => {
        notifyManifestReadStarted = resolve;
      });
      let manifestReads = 0;

      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === activeUri) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });
      fsMock.readAsStringAsync.mockImplementation((path: string) => {
        if (path.endsWith('model-manifest.json')) {
          manifestReads += 1;
          notifyManifestReadStarted();
          return new Promise<string>((resolve) => {
            resolveManifestRead = resolve;
          });
        }
        return Promise.reject(new Error('not found'));
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      let firstDone = false;
      let secondDone = false;
      const p1 = manager.initialize().then(() => { firstDone = true; });
      const p2 = manager.ensureInitialized().then(() => { secondDone = true; });

      await manifestReadStarted;
      for (let i = 0; i < 6; i++) await Promise.resolve();
      // Neither caller may resolve before restorePersistedState() completes
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);
      expect(manifestReads).toBe(1);

      resolveManifestRead(
        JSON.stringify({
          version: 'qwen3.5-2b',
          modelPath: activeUri,
          checksumVerified: true,
          initializedAt: '2026-11-21T00:00:00.000Z',
          lastVerifiedAt: '2026-11-21T00:00:00.000Z',
        }),
      );
      await Promise.all([p1, p2]);

      expect(firstDone).toBe(true);
      expect(secondDone).toBe(true);
      expect(manifestReads).toBe(1);
      expect(manager.isInitialized()).toBe(true);
      expect(useAIStore.getState().provisioning.status).toBe('ready');
    });

    it('hydratePersistedState eagerly restores paused download without creating dirs, while initialize finishes deferred setup (R4-03)', async () => {
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":500000}';

      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === tempUri) {
          return { exists: true, size: 500000, uri: tempUri };
        }
        return { exists: false, uri: path };
      });
      fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
        if (path.endsWith('download-manifest.json')) {
          return JSON.stringify({
            version: 'qwen3.5-2b',
            status: 'paused',
            downloadUrl: 'https://example.com/model.gguf',
            targetPath: tempUri,
            tempPath: tempUri,
            totalBytes: EXPECTED_SIZE,
            downloadedBytes: 500000,
            progress: 500000 / EXPECTED_SIZE,
            resumeData: mockResumeData,
            startedAt: '2026-11-21T00:00:00.000Z',
            updatedAt: '2026-11-21T00:00:01.000Z',
            lastProgressAt: '2026-11-21T00:00:01.000Z',
            bytesPerSecond: 100000,
            sessionId: 'sess-eager',
            pausedReason: 'Paused by user',
          });
        }
        throw new Error('not found');
      });

      const manager = new QModelLifecycleManager(createMockAdapter());
      await manager.hydratePersistedState();

      expect(useAIStore.getState().provisioningHydrated).toBe(true);
      expect(useAIStore.getState().provisioning.status).toBe('paused');
      expect(useAIStore.getState().provisioning.canResume).toBe(true);
      expect(fsMock.makeDirectoryAsync).not.toHaveBeenCalled();
      expect(manager.isInitialized()).toBe(false);

      await manager.initialize();
      expect(fsMock.makeDirectoryAsync).toHaveBeenCalled();
      expect(manager.isInitialized()).toBe(true);
    });

    it('retryProvisioning called before initialize() preserves and resumes a persisted paused download instead of deleting it (R4-03)', async () => {
      const activeUri = getActiveModelFileUri();
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":750000}';
      let movedToActive = false;

      fsMock.moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
        if (to === activeUri) movedToActive = true;
      });
      fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
        if (path === tempUri) {
          return {
            exists: !movedToActive,
            size: EXPECTED_SIZE,
            uri: tempUri,
            ...(opts?.md5 ? { md5: EXPECTED_MD5 } : {}),
          };
        }
        if (path === activeUri && movedToActive) {
          return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
        }
        return { exists: false, uri: path };
      });
      fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
        if (path.endsWith('download-manifest.json')) {
          return JSON.stringify({
            version: 'qwen3.5-2b',
            status: 'paused',
            downloadUrl: 'https://example.com/model.gguf',
            targetPath: tempUri,
            tempPath: tempUri,
            totalBytes: EXPECTED_SIZE,
            downloadedBytes: 750000,
            progress: 750000 / EXPECTED_SIZE,
            resumeData: mockResumeData,
            startedAt: '2026-11-21T00:00:00.000Z',
            updatedAt: '2026-11-21T00:00:01.000Z',
            lastProgressAt: '2026-11-21T00:00:01.000Z',
            bytesPerSecond: 100000,
            sessionId: 'sess-r403',
            pausedReason: 'Paused by user',
          });
        }
        throw new Error('not found');
      });
      fsMock.createDownloadResumable!.mockImplementation(() => ({
        downloadAsync: jest.fn(),
        resumeAsync: jest.fn(async () => ({ uri: tempUri })),
        pauseAsync: jest.fn(),
        cancelAsync: jest.fn(async () => {}),
      }));

      const manager = new QModelLifecycleManager(createMockAdapter());
      // Do NOT call manager.initialize() first — simulates tapping Download before deferred init ran
      await manager.retryProvisioning();

      // Must NOT have deleted the resumable partial download before resuming!
      expect(fsMock.deleteAsync).not.toHaveBeenCalledWith(tempUri, { idempotent: true });
      expect(fsMock.createDownloadResumable).toHaveBeenCalledWith(
        expect.any(String),
        tempUri,
        expect.any(Object),
        expect.any(Function),
        mockResumeData,
      );
      expect(useAIStore.getState().provisioning.status).toBe('ready');
    });

    it('clears pendingDeferredRecovery on cancelDownload, pauseDownload fallback, and deleteInstalledModel before deferred initialize() runs (R4B-01)', async () => {
      const tempUri = 'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';
      const mockResumeData = '{"url":"https://example.com/model.gguf","bytesWritten":500000}';
      let tempExists = true;
      let manifestText: string | null = JSON.stringify({
        version: 'qwen3.5-2b',
        status: 'downloading',
        downloadUrl: 'https://example.com/model.gguf',
        targetPath: tempUri,
        tempPath: tempUri,
        totalBytes: EXPECTED_SIZE,
        downloadedBytes: 500000,
        progress: 500000 / EXPECTED_SIZE,
        resumeData: mockResumeData,
        startedAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T00:00:01.000Z',
        lastProgressAt: '2026-11-21T00:00:01.000Z',
        bytesPerSecond: 100000,
        sessionId: 'sess-r4b01-dl',
        pausedReason: null,
      });

      fsMock.getInfoAsync.mockImplementation(async (path: string) => {
        if (path === tempUri) return { exists: tempExists, size: tempExists ? 500000 : 0, uri: tempUri };
        return { exists: false, uri: path };
      });
      fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
        if (path.endsWith('download-manifest.json') && manifestText) return manifestText;
        throw new Error('not found');
      });
      fsMock.deleteAsync.mockImplementation(async (path: string) => {
        if (path === tempUri) tempExists = false;
        if (path.endsWith('download-manifest.json')) manifestText = null;
      });

      // Case 1: cancelDownload() in the window after hydratePersistedState() and before initialize()
      const mgr1 = new QModelLifecycleManager(createMockAdapter());
      await mgr1.hydratePersistedState();
      expect(useAIStore.getState().provisioning.status).toBe('downloading');
      await mgr1.cancelDownload();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      await mgr1.initialize();
      expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      // Case 2: pauseDownload() fallback (resumable is null) after hydratePersistedState() and before initialize()
      tempExists = true;
      manifestText = JSON.stringify({
        version: 'qwen3.5-2b',
        status: 'downloading',
        downloadUrl: 'https://example.com/model.gguf',
        targetPath: tempUri,
        tempPath: tempUri,
        totalBytes: EXPECTED_SIZE,
        downloadedBytes: 500000,
        progress: 500000 / EXPECTED_SIZE,
        resumeData: mockResumeData,
        startedAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T00:00:01.000Z',
        lastProgressAt: '2026-11-21T00:00:01.000Z',
        bytesPerSecond: 100000,
        sessionId: 'sess-r4b01-pause',
        pausedReason: null,
      });
      const mgr2 = new QModelLifecycleManager(createMockAdapter());
      await mgr2.hydratePersistedState();
      await mgr2.pauseDownload();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      await mgr2.initialize();
      expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      // Case 3: verifying manifest cancelled/deleted before initialize() must NOT fail verification on deleted .part
      tempExists = true;
      manifestText = JSON.stringify({
        version: 'qwen3.5-2b',
        status: 'verifying',
        downloadUrl: 'https://example.com/model.gguf',
        targetPath: tempUri,
        tempPath: tempUri,
        totalBytes: EXPECTED_SIZE,
        downloadedBytes: EXPECTED_SIZE,
        progress: 1,
        resumeData: null,
        startedAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T00:00:01.000Z',
        lastProgressAt: '2026-11-21T00:00:01.000Z',
        bytesPerSecond: null,
        sessionId: 'sess-r4b01-verify',
        pausedReason: null,
      });
      const mgr3 = new QModelLifecycleManager(createMockAdapter());
      await mgr3.hydratePersistedState();
      expect(useAIStore.getState().provisioning.status).toBe('verifying');
      await mgr3.deleteInstalledModel();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');

      await mgr3.initialize();
      expect(useAIStore.getState().provisioning.status).toBe('not-installed');
      expect(useAIStore.getState().provisioning.lastError).toBeNull();
    });

    it('deleteInstalledModel removes the dependent vision projector and resets local vision receiptReadingMode to ocr while preserving external mode (NIT-R5-02)', async () => {
      const modelUri = getActiveModelFileUri();
      const projectorUri = getVisionProjectorUri();
      const setReceiptReadingModeMock = jest.fn(async (mode: 'ocr' | 'vision') => {
        useSettingsStore.setState({ receiptReadingMode: mode });
      });
      const prevSetter = useSettingsStore.getState().setReceiptReadingMode;

      try {
        useSettingsStore.setState({
          aiInferenceMode: 'local',
          receiptReadingMode: 'vision',
          setReceiptReadingMode: setReceiptReadingModeMock,
        });

        const mgr = new QModelLifecycleManager(createMockAdapter());
        await mgr.deleteInstalledModel();

        expect(fsMock.deleteAsync).toHaveBeenCalledWith(modelUri, { idempotent: true });
        expect(fsMock.deleteAsync).toHaveBeenCalledWith(projectorUri, { idempotent: true });
        expect(setReceiptReadingModeMock).toHaveBeenCalledWith('ocr');
        expect(useSettingsStore.getState().receiptReadingMode).toBe('ocr');
        expect(useAIStore.getState().provisioning.status).toBe('not-installed');

        // External AI mode vision setting must remain intact if local model is deleted
        setReceiptReadingModeMock.mockClear();
        useSettingsStore.setState({
          aiInferenceMode: 'external',
          receiptReadingMode: 'vision',
        });

        await mgr.deleteInstalledModel();
        expect(setReceiptReadingModeMock).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().receiptReadingMode).toBe('vision');
      } finally {
        useSettingsStore.setState({ setReceiptReadingMode: prevSetter });
      }
    });
  });
});
