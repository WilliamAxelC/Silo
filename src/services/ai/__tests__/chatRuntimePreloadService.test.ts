import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import {
  getChatRuntimePreloadService,
  resetChatRuntimePreloadService,
} from '../chatRuntimePreloadService';
import { getGenerationService, type GenerationServiceRuntimeSnapshot } from '../generationService';
import { getLlamaRnAdapter } from '../llamaRnAdapter';
import { LocalInferenceException } from '../localInferenceTypes';
import { getActiveModelFileUri } from '../modelLifecycle';
import {
  useAIStore,
  createInitialProvisioningSnapshot,
  createInitialRuntimeSnapshot,
} from '../../../store/useAIStore';
import { useSettingsStore } from '../../../store/useSettingsStore';

jest.mock('../llamaRnAdapter', () => {
  let loaded = false;
  let loadedModelPath: string | null = null;
  let configuredContextTokens = 0;

  const adapter = {
    initContext: jest.fn(async ({ modelPath, contextTokens }: { modelPath: string; contextTokens?: number }) => {
      loaded = true;
      loadedModelPath = modelPath;
      configuredContextTokens = Math.max(contextTokens ?? 0, 2048);
    }),
    completion: jest.fn(),
    stopCompletion: jest.fn(async () => {}),
    releaseContext: jest.fn(async () => {
      loaded = false;
      loadedModelPath = null;
      configuredContextTokens = 0;
    }),
    dispose: jest.fn(async () => {
      loaded = false;
      loadedModelPath = null;
      configuredContextTokens = 0;
    }),
    getContextTokens: jest.fn(() => configuredContextTokens),
    getRuntimeInfo: jest.fn(async () => ({
      backend: 'llama.rn-cpu',
      version: null,
      supportsStreaming: true,
      isModelLoaded: loaded,
      loadedModelFamily: 'qwen',
      loadedModelPath,
    })),
  };

  return {
    getLlamaRnAdapter: jest.fn(() => adapter),
  };
});

async function flushMicrotasks(ticks = 30) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

describe('ChatRuntimePreloadService regression', () => {
  const adapter = getLlamaRnAdapter() as unknown as {
    initContext: jest.Mock;
    releaseContext: jest.Mock;
    dispose: jest.Mock;
    getRuntimeInfo: jest.Mock;
    getContextTokens: jest.Mock;
  };
  const fsMock = ExpoFileSystemLegacy as unknown as {
    documentDirectory: string;
    getInfoAsync: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    fsMock.documentDirectory = 'file:///mock/data/user/0/com.LCSdev.silo/files/';
    fsMock.getInfoAsync.mockResolvedValue({
      exists: true,
      size: 1024,
      uri: getActiveModelFileUri(),
    });

    useSettingsStore.setState({
      aiInferenceMode: 'local',
      activeModelId: 'qwen3.5-0.8b',
    });

    useAIStore.setState({
      provisioning: createInitialProvisioningSnapshot(),
      runtime: createInitialRuntimeSnapshot(),
      runtimeReady: false,
      warmupPending: false,
      chatHistory: [],
      logs: [],
    });

    resetChatRuntimePreloadService();
    await getGenerationService().dispose();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    resetChatRuntimePreloadService();
    await flushMicrotasks();
    await getGenerationService().dispose();
    jest.useRealTimers();
  });

  it('does not loop Opening local chatbot status when the local model is already ready', async () => {
    const modelPath = getActiveModelFileUri();
    await adapter.initContext({ modelPath });
    adapter.initContext.mockClear();

    const runtime = createInitialRuntimeSnapshot();
    runtime.modelLoaded = true;
    runtime.generationHealthy = true;
    runtime.runtimeState = 'healthy';
    runtime.runtimeInfo = await adapter.getRuntimeInfo();

    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'ready',
        modelPath,
        progress: 1,
      },
      runtime,
      runtimeReady: true,
      warmupPending: false,
    });

    const generationService = getGenerationService();
    const preloadService = getChatRuntimePreloadService();
    const preparingSnapshots: GenerationServiceRuntimeSnapshot[] = [];
    const sub = generationService.subscribe((snapshot) => {
      if (snapshot.isPreparingRuntime) {
        preparingSnapshots.push(snapshot);
      }
    });

    try {
      await preloadService.requestPreload();
      await flushMicrotasks(40);
      preloadService.clearRequest();
      await flushMicrotasks(10);

      expect(preparingSnapshots).toHaveLength(0);
      expect(adapter.initContext).not.toHaveBeenCalled();
    } finally {
      sub.unsubscribe();
    }
  });

  it('preloads an installed-but-unloaded local model exactly once per screen visit without flickering', async () => {
    const modelPath = getActiveModelFileUri();
    const runtime = createInitialRuntimeSnapshot();
    runtime.runtimeState = 'model-unloaded';

    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'ready',
        modelPath,
        progress: 1,
      },
      runtime,
      runtimeReady: false,
      warmupPending: false,
    });

    const generationService = getGenerationService();
    const preloadService = getChatRuntimePreloadService();
    const transitions: boolean[] = [];
    let lastPreparing: boolean | null = null;
    const sub = generationService.subscribe((snapshot) => {
      if (snapshot.isPreparingRuntime !== lastPreparing) {
        lastPreparing = snapshot.isPreparingRuntime;
        transitions.push(snapshot.isPreparingRuntime);
      }
    });

    try {
      await preloadService.requestPreload();
      await flushMicrotasks(40);

      expect(adapter.initContext).toHaveBeenCalledTimes(1);
      expect(transitions).toEqual([false, true, false]);
      expect(useAIStore.getState().runtimeReady).toBe(true);
    } finally {
      sub.unsubscribe();
    }
  });

  it('records a stable error without looping when preload fails on a low-RAM device and supports manual retry', async () => {
    const modelPath = getActiveModelFileUri();
    const memoryError = new LocalInferenceException(
      'insufficient-memory',
      'Model load blocked because the estimated RAM requirement exceeds the safe device memory budget.',
    );
    adapter.initContext.mockRejectedValueOnce(memoryError);

    const runtime = createInitialRuntimeSnapshot();
    runtime.runtimeState = 'model-unloaded';
    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'ready',
        modelPath,
        progress: 1,
      },
      runtime,
      runtimeReady: false,
      warmupPending: false,
    });

    const generationService = getGenerationService();
    const preloadService = getChatRuntimePreloadService();

    await preloadService.requestPreload();
    await flushMicrotasks(40);

    expect(adapter.initContext).toHaveBeenCalledTimes(1);
    expect(generationService.getSnapshot().isPreparingRuntime).toBe(false);
    expect(preloadService.getSnapshot().isPreloading).toBe(false);
    expect(preloadService.getSnapshot().error).toBe(memoryError.message);
    expect(useAIStore.getState().runtime.lastRuntimeError?.message).toBe(memoryError.message);
    expect(useAIStore.getState().runtime.runtimeState).toBe('failed');

    // Manual retry tries once more and recovers when initContext succeeds.
    await preloadService.retryPreload();
    await flushMicrotasks(40);

    expect(adapter.initContext).toHaveBeenCalledTimes(2);
    expect(preloadService.getSnapshot().error).toBeNull();
    expect(useAIStore.getState().runtime.lastRuntimeError).toBeNull();
    expect(useAIStore.getState().runtimeReady).toBe(true);
  });

  it('does not attempt preload when the local model is not downloaded', async () => {
    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'not-installed',
      },
      runtime: createInitialRuntimeSnapshot(),
      runtimeReady: false,
      warmupPending: false,
    });

    const generationService = getGenerationService();
    const preloadService = getChatRuntimePreloadService();

    await preloadService.requestPreload();
    await flushMicrotasks(20);

    expect(adapter.initContext).not.toHaveBeenCalled();
    expect(generationService.getSnapshot().isPreparingRuntime).toBe(false);
    expect(preloadService.getSnapshot().error).toBeNull();
  });

  it('cancels pending model unload on quick revisit and reloads once after an actual unload', async () => {
    jest.useFakeTimers();
    const modelPath = getActiveModelFileUri();
    const runtime = createInitialRuntimeSnapshot();
    runtime.runtimeState = 'model-unloaded';
    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'ready',
        modelPath,
        progress: 1,
      },
      runtime,
      runtimeReady: false,
      warmupPending: false,
    });

    const generationService = getGenerationService();
    const preloadService = getChatRuntimePreloadService();

    // First visit loads model once.
    await preloadService.requestPreload();
    expect(adapter.initContext).toHaveBeenCalledTimes(1);

    // Leave screen, then return before the 30s unload fires.
    preloadService.clearRequest();
    await generationService.scheduleModelUnload(30000);
    jest.advanceTimersByTime(10000);
    await preloadService.requestPreload();
    jest.advanceTimersByTime(30000);
    await flushMicrotasks(10);

    expect(adapter.releaseContext).not.toHaveBeenCalled();
    expect(adapter.initContext).toHaveBeenCalledTimes(1);

    // Leave screen and let the unload fire.
    preloadService.clearRequest();
    await generationService.scheduleModelUnload(30000);
    jest.advanceTimersByTime(30000);
    await flushMicrotasks(10);

    expect(adapter.releaseContext).toHaveBeenCalledTimes(1);
    expect(useAIStore.getState().runtimeReady).toBe(false);

    // Next visit reloads once.
    await preloadService.requestPreload();
    await flushMicrotasks(10);
    expect(adapter.initContext).toHaveBeenCalledTimes(2);
    expect(useAIStore.getState().runtimeReady).toBe(true);
  });

  it('clears stale preload error when a new runtime load starts outside retryPreload', async () => {
    const modelPath = getActiveModelFileUri();
    const memoryError = new LocalInferenceException(
      'insufficient-memory',
      'Model load blocked because the estimated RAM requirement exceeds the safe device memory budget.',
    );
    adapter.initContext.mockRejectedValueOnce(memoryError);

    const runtime = createInitialRuntimeSnapshot();
    runtime.runtimeState = 'model-unloaded';
    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'ready',
        modelPath,
        progress: 1,
      },
      runtime,
      runtimeReady: false,
      warmupPending: false,
    });

    const generationService = getGenerationService();
    const preloadService = getChatRuntimePreloadService();

    // Initial Chat-mode preload fails and records the error.
    await preloadService.requestPreload();
    await flushMicrotasks(20);
    expect(preloadService.getSnapshot().error).toBe(memoryError.message);

    // User switches to Grounded mode and sends a query, triggering ensureChatRuntimeReady().
    preloadService.clearRequest();
    let resolveInit!: () => void;
    let notifyInitStarted!: () => void;
    const initStarted = new Promise<void>((resolve) => {
      notifyInitStarted = resolve;
    });
    adapter.initContext.mockImplementationOnce(
      async ({ modelPath: nextPath, contextTokens }: { modelPath: string; contextTokens?: number }) => {
        notifyInitStarted();
        await new Promise<void>((resolve) => {
          resolveInit = resolve;
        });
        await adapter.initContext.getMockImplementation()?.({ modelPath: nextPath, contextTokens });
      },
    );

    const loadPromise = generationService.ensureChatRuntimeReady();
    await initStarted;
    await flushMicrotasks(10);

    expect(generationService.getSnapshot().isPreparingRuntime).toBe(true);
    expect(useAIStore.getState().runtime.lastRuntimeError).toBeNull();
    expect(preloadService.getSnapshot().error).toBeNull();

    resolveInit();
    await loadPromise;
    await flushMicrotasks(10);
    expect(preloadService.getSnapshot().error).toBeNull();
    expect(useAIStore.getState().runtimeReady).toBe(true);
  });
});
