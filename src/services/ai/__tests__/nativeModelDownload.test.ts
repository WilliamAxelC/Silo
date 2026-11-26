import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import {
  NATIVE_RESUME_DATA,
  createNativeDownloadResumable,
  setModelDownloadNativeForTests,
  type NativeDownloadState,
} from '../nativeModelDownload';
import {
  QModelLifecycleManager,
  getActiveModelFileUri,
  type LocalInferenceAdapter,
} from '../modelLifecycle';
import { useAIStore, createInitialProvisioningSnapshot } from '../../../store/useAIStore';
import { useSettingsStore } from '../../../store/useSettingsStore';

jest.mock('expo-network', () => ({
  NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI' },
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
const TEMP_URI =
  'file:///mock/data/user/0/com.LCSdev.silo/files/ai/tmp/Qwen3.5-2B-Q4_K_M.gguf.part';

/** Stands in for the Android download service: records calls and lets a test send its events. */
function createFakeNative() {
  const listeners = new Set<(state: NativeDownloadState) => void>();
  let current: NativeDownloadState | null = null;
  const emit = (
    state: Partial<NativeDownloadState> & { status: NativeDownloadState['status'] },
  ) => {
    const full: NativeDownloadState = {
      id: 'model',
      path: TEMP_URI,
      downloadedBytes: 0,
      totalBytes: EXPECTED_SIZE,
      ...state,
    };
    current = { ...full, active: ['downloading', 'waiting', 'verifying'].includes(full.status) };
    listeners.forEach((listener) => listener(full));
  };
  const native = {
    startModelDownload: jest.fn((options: { id: string }) => {
      current = {
        id: options.id,
        status: 'downloading',
        path: TEMP_URI,
        downloadedBytes: 0,
        totalBytes: EXPECTED_SIZE,
        active: true,
      };
      return true;
    }),
    pauseModelDownload: jest.fn((id: string) => {
      emit({ id, status: 'paused', downloadedBytes: 500_000, message: 'Paused.' });
      return true;
    }),
    cancelModelDownload: jest.fn((id: string) => {
      emit({ id, status: 'cancelled' });
      return true;
    }),
    getModelDownload: jest.fn((_id: string) => current),
    dismissModelDownloadNotification: jest.fn(() => true),
    addListener: jest.fn(
      (_event: 'onModelDownload', listener: (state: NativeDownloadState) => void) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    ),
  };
  return {
    native,
    emit,
    setState: (state: NativeDownloadState | null) => {
      current = state;
    },
  };
}

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('createNativeDownloadResumable', () => {
  afterEach(() => setModelDownloadNativeForTests(undefined));

  it('starts a fresh download, forwards progress and resolves with the file when the service is done', async () => {
    const fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    const onProgress = jest.fn();
    const resumable = createNativeDownloadResumable(
      'https://example.com/m.gguf',
      TEMP_URI,
      { id: 'model', title: 'Downloading', totalBytes: EXPECTED_SIZE, sha256: EXPECTED_SHA256 },
      onProgress,
    );

    const result = resumable.downloadAsync();
    expect(fake.native.startModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model',
        url: 'https://example.com/m.gguf',
        path: TEMP_URI,
        restart: true,
        sha256: EXPECTED_SHA256,
      }),
    );
    fake.emit({ status: 'downloading', downloadedBytes: 1000 });
    fake.emit({ status: 'done', downloadedBytes: EXPECTED_SIZE });

    await expect(result).resolves.toEqual({ uri: TEMP_URI });
    expect(onProgress).toHaveBeenCalledWith({
      totalBytesWritten: 1000,
      totalBytesExpectedToWrite: EXPECTED_SIZE,
    });
  });

  it('resumeAsync keeps the partial file (no restart)', () => {
    const fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    const resumable = createNativeDownloadResumable('https://example.com/m.gguf', TEMP_URI, {
      id: 'model',
      title: 'x',
    });
    void resumable.resumeAsync();
    expect(fake.native.startModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({ restart: false }),
    );
  });

  it('rejects with the service message when the download fails', async () => {
    const fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    const resumable = createNativeDownloadResumable('https://example.com/m.gguf', TEMP_URI, {
      id: 'model',
      title: 'x',
    });
    const result = resumable.downloadAsync();
    fake.emit({ status: 'failed', message: 'The downloaded file is damaged. Download it again.' });
    await expect(result).rejects.toThrow('The downloaded file is damaged');
  });

  it('rejects when Android refuses to start the service', async () => {
    const fake = createFakeNative();
    fake.native.startModelDownload.mockReturnValue(false);
    setModelDownloadNativeForTests(fake.native);
    const resumable = createNativeDownloadResumable('https://example.com/m.gguf', TEMP_URI, {
      id: 'model',
      title: 'x',
    });
    await expect(resumable.downloadAsync()).rejects.toThrow(/Open Silo and try again/);
  });

  it('pauseAsync returns native resume data and is not reported as an outside pause', async () => {
    const fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    const onExternalStop = jest.fn();
    const resumable = createNativeDownloadResumable('https://example.com/m.gguf', TEMP_URI, {
      id: 'model',
      title: 'x',
      onExternalStop,
    });
    const result = resumable.downloadAsync();
    await expect(resumable.pauseAsync()).resolves.toEqual({ resumeData: NATIVE_RESUME_DATA });
    await expect(result).resolves.toBeUndefined();
    expect(onExternalStop).not.toHaveBeenCalled();
  });

  it('reports a pause from the notification through onExternalStop', async () => {
    const fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    const onExternalStop = jest.fn();
    const resumable = createNativeDownloadResumable('https://example.com/m.gguf', TEMP_URI, {
      id: 'model',
      title: 'x',
      onExternalStop,
    });
    const result = resumable.downloadAsync();
    fake.emit({
      status: 'paused',
      downloadedBytes: 42,
      message: 'Paused: no connection. Tap Resume to continue.',
    });
    await expect(result).resolves.toBeUndefined();
    expect(onExternalStop).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused', downloadedBytes: 42 }),
    );
  });

  it('ignores events for another download', async () => {
    const fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    const resumable = createNativeDownloadResumable('https://example.com/p.gguf', TEMP_URI, {
      id: 'projector',
      title: 'x',
    });
    const result = resumable.downloadAsync();
    fake.emit({ id: 'model', status: 'done' });
    fake.emit({ id: 'projector', status: 'done' });
    await expect(result).resolves.toEqual({ uri: TEMP_URI });
  });
});

describe('model lifecycle with the Android download service', () => {
  const fsMock = ExpoFileSystemLegacy as unknown as {
    documentDirectory: string;
    getInfoAsync: jest.Mock;
    readAsStringAsync: jest.Mock;
    writeAsStringAsync: jest.Mock;
    moveAsync: jest.Mock;
    createDownloadResumable?: jest.Mock;
    getFreeDiskStorageAsync?: jest.Mock;
  };
  let fake: ReturnType<typeof createFakeNative>;

  const persistedManifest = (overrides: Record<string, unknown>) => ({
    version: 'qwen3.5-2b',
    status: 'downloading',
    downloadUrl: 'https://example.com/model.gguf',
    targetPath: TEMP_URI,
    tempPath: TEMP_URI,
    totalBytes: EXPECTED_SIZE,
    downloadedBytes: 500000,
    progress: 500000 / EXPECTED_SIZE,
    resumeData: null,
    startedAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:01.000Z',
    lastProgressAt: '2026-11-26T00:00:01.000Z',
    bytesPerSecond: 100000,
    sessionId: 'session-1',
    ...overrides,
  });

  const lastTransferManifest = () => {
    const writes = fsMock.writeAsStringAsync.mock.calls.filter(([p]) =>
      String(p).endsWith('download-manifest.json'),
    );
    return writes.length ? JSON.parse(writes[writes.length - 1][1]) : null;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fake = createFakeNative();
    setModelDownloadNativeForTests(fake.native);
    fsMock.documentDirectory = 'file:///mock/data/user/0/com.LCSdev.silo/files/';
    fsMock.getFreeDiskStorageAsync = jest.fn(async () => 10 * 1024 * 1024 * 1024);
    fsMock.readAsStringAsync.mockRejectedValue(new Error('not found'));
    fsMock.getInfoAsync.mockResolvedValue({ exists: false, uri: '' });
    fsMock.createDownloadResumable = jest.fn();
    useSettingsStore.setState({ activeModelId: 'qwen3.5-2b', aiWifiOnlyDownload: false });
    useAIStore.setState({
      provisioning: createInitialProvisioningSnapshot(),
      runtimeReady: false,
      warmupPending: false,
      logs: [],
    });
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({
      type: 'WIFI',
      isConnected: true,
      isInternetReachable: true,
    });
  });

  afterEach(() => setModelDownloadNativeForTests(undefined));

  it('downloads through the service with the catalog size and SHA-256, then verifies and installs', async () => {
    const activeUri = getActiveModelFileUri();
    let moved = false;
    fsMock.moveAsync.mockImplementation(async ({ to }: { to: string }) => {
      if (to === activeUri) moved = true;
    });
    fsMock.getInfoAsync.mockImplementation(async (path: string, opts?: { md5?: boolean }) => {
      if (path === TEMP_URI)
        return {
          exists: !moved,
          size: EXPECTED_SIZE,
          uri: TEMP_URI,
          ...(opts?.md5 ? { md5: EXPECTED_MD5 } : {}),
        };
      if (path === activeUri && moved) return { exists: true, size: EXPECTED_SIZE, uri: activeUri };
      return { exists: false, uri: path };
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.startProvisioningIfNeeded();
    await waitFor(() => fake.native.startModelDownload.mock.calls.length > 0, 'service start');

    expect(fake.native.startModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model',
        path: TEMP_URI,
        totalBytes: EXPECTED_SIZE,
        sha256: EXPECTED_SHA256,
        pausable: true,
        restart: true,
      }),
    );
    expect(fsMock.createDownloadResumable).not.toHaveBeenCalled();
    // Any interrupted download can resume from the partial file.
    expect(lastTransferManifest()?.resumeData).toBe(NATIVE_RESUME_DATA);

    fake.emit({ status: 'done', downloadedBytes: EXPECTED_SIZE });
    await (manager as any).inFlightDownloadPromise;
    expect(moved).toBe(true);
    expect(useAIStore.getState().provisioning.status).toBe('ready');
  });

  it('a pause from the notification leaves a paused download that resumes from the partial file', async () => {
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 500_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.startProvisioningIfNeeded();
    await waitFor(() => fake.native.startModelDownload.mock.calls.length > 0, 'service start');

    fake.emit({ status: 'paused', downloadedBytes: 500_000, message: 'Paused.' });
    await waitFor(() => useAIStore.getState().provisioning.status === 'paused', 'paused');
    await flush();

    const provisioning = useAIStore.getState().provisioning;
    expect(provisioning.canResume).toBe(true);
    expect(provisioning.downloadedBytes).toBe(500_000);
    expect(lastTransferManifest()).toEqual(
      expect.objectContaining({ status: 'paused', resumeData: NATIVE_RESUME_DATA }),
    );

    mockTransferManifest(lastTransferManifest());
    void manager.resumeDownload();
    await waitFor(() => fake.native.startModelDownload.mock.calls.length > 1, 'resume start');
    expect(fake.native.startModelDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'model', restart: false }),
    );
  });

  it('regression: a download cut off by Silo being killed resumes on the next launch instead of being discarded', async () => {
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 500_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    // Before the download service, progress was saved without resume data and the partial file was thrown away.
    mockTransferManifest(persistedManifest({ status: 'downloading', resumeData: null }));
    fake.setState({
      id: 'model',
      status: 'downloading',
      path: TEMP_URI,
      downloadedBytes: 500_000,
      totalBytes: EXPECTED_SIZE,
      active: false,
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.initialize();
    await waitFor(() => fake.native.startModelDownload.mock.calls.length > 0, 'service start');

    expect(fake.native.startModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'model', restart: false }),
    );
    expect(useAIStore.getState().provisioning.status).toBe('downloading');
    expect(useAIStore.getState().provisioning.lastError).toBeNull();
  });

  it('re-attaches to a download resumed from the notification while Silo was closed', async () => {
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 700_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    mockTransferManifest(
      persistedManifest({
        status: 'paused',
        resumeData: NATIVE_RESUME_DATA,
        pausedReason: 'Paused.',
      }),
    );
    fake.setState({
      id: 'model',
      status: 'downloading',
      path: TEMP_URI,
      downloadedBytes: 700_000,
      totalBytes: EXPECTED_SIZE,
      active: true,
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.initialize();
    await waitFor(() => fake.native.startModelDownload.mock.calls.length > 0, 'service attach');

    expect(fake.native.startModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({ restart: false }),
    );
    expect(useAIStore.getState().provisioning.status).toBe('downloading');
  });

  it('regression: a download resumed from the notification and then killed carries on at launch instead of showing paused', async () => {
    // Emulator, 2026-11-26: pause in the shade, swipe Silo away, Resume in the shade, Silo killed mid-download.
    // The app's manifest still said "paused" at 332 MB; the service had reached 472 MB and never paused.
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 900_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    mockTransferManifest(
      persistedManifest({
        status: 'paused',
        resumeData: NATIVE_RESUME_DATA,
        pausedReason: 'Paused.',
      }),
    );
    fake.setState({
      id: 'model',
      status: 'downloading',
      path: TEMP_URI,
      downloadedBytes: 900_000,
      totalBytes: EXPECTED_SIZE,
      active: false,
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.initialize();
    await waitFor(() => fake.native.startModelDownload.mock.calls.length > 0, 'service restart');

    expect(fake.native.startModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'model', restart: false }),
    );
    expect(useAIStore.getState().provisioning.status).toBe('downloading');
    expect(useAIStore.getState().provisioning.downloadedBytes).toBe(900_000);
  });

  it('shows the real partial size for a download paused while Silo was closed', async () => {
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 800_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    mockTransferManifest(
      persistedManifest({
        status: 'paused',
        resumeData: NATIVE_RESUME_DATA,
        pausedReason: 'Paused.',
      }),
    );
    fake.setState({
      id: 'model',
      status: 'paused',
      path: TEMP_URI,
      downloadedBytes: 800_000,
      totalBytes: EXPECTED_SIZE,
      message: 'Paused: no Wi-Fi. Tap Resume to continue.',
      active: false,
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.initialize();

    expect(fake.native.startModelDownload).not.toHaveBeenCalled();
    const provisioning = useAIStore.getState().provisioning;
    expect(provisioning.status).toBe('paused');
    expect(provisioning.downloadedBytes).toBe(800_000);
    expect(provisioning.progress).toBeCloseTo(800_000 / EXPECTED_SIZE);
    expect(provisioning.pausedReason).toBe('Paused: no Wi-Fi. Tap Resume to continue.');
  });

  it('keeps a paused download paused on launch when the service is idle', async () => {
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 500_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    mockTransferManifest(
      persistedManifest({
        status: 'paused',
        resumeData: NATIVE_RESUME_DATA,
        pausedReason: 'Paused.',
      }),
    );
    fake.setState({
      id: 'model',
      status: 'paused',
      path: TEMP_URI,
      downloadedBytes: 500_000,
      totalBytes: EXPECTED_SIZE,
      active: false,
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.initialize();

    expect(fake.native.startModelDownload).not.toHaveBeenCalled();
    expect(useAIStore.getState().provisioning.status).toBe('paused');
    expect(useAIStore.getState().provisioning.canResume).toBe(true);
  });

  it('cancelling a paused download asks the service to drop its notification and partial file', async () => {
    fsMock.getInfoAsync.mockImplementation(async (path: string) =>
      path === TEMP_URI
        ? { exists: true, size: 500_000, uri: TEMP_URI }
        : { exists: false, uri: path },
    );
    mockTransferManifest(persistedManifest({ status: 'paused', resumeData: NATIVE_RESUME_DATA }));
    fake.setState({
      id: 'model',
      status: 'paused',
      path: TEMP_URI,
      downloadedBytes: 500_000,
      totalBytes: EXPECTED_SIZE,
      active: false,
    });

    const manager = new QModelLifecycleManager(createMockAdapter());
    await manager.initialize();
    await manager.cancelDownload();

    expect(fake.native.cancelModelDownload).toHaveBeenCalledWith('model');
    expect(useAIStore.getState().provisioning.status).toBe('not-installed');
  });

  /** The transfer manifest behaves like a file: reads return the last write. */
  function mockTransferManifest(manifest: unknown) {
    let stored = JSON.stringify(manifest);
    fsMock.readAsStringAsync.mockImplementation(async (path: string) => {
      if (path.endsWith('download-manifest.json')) return stored;
      throw new Error('not found');
    });
    fsMock.writeAsStringAsync.mockImplementation(async (path: string, value: string) => {
      if (String(path).endsWith('download-manifest.json')) stored = value;
    });
  }
});
