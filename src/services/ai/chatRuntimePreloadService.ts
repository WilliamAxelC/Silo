import { getAIRuntimeAvailability, useAIStore } from '../../store/useAIStore';
import { isSettingsLoadPending, useSettingsStore, waitForSettingsLoaded } from '../../store/useSettingsStore';
import { getGenerationService, type GenerationServiceRuntimeSnapshot } from './generationService';
import { getErrorMessage } from './localInferenceTypes';
import { getModelLifecycleManager } from './modelLifecycle';

export type ChatRuntimePreloadSnapshot = {
  requested: boolean;
  isPreloading: boolean;
  status: string;
  canPreload: boolean;
  error: string | null;
};

export type ChatRuntimePreloadListener = (snapshot: ChatRuntimePreloadSnapshot) => void;

export type ChatRuntimePreloadSubscription = {
  unsubscribe: () => void;
};

function createSnapshot(state: ChatRuntimePreloadService['state']): ChatRuntimePreloadSnapshot {
  return {
    requested: state.requested,
    isPreloading: state.isPreloading,
    status: state.status,
    canPreload: state.canPreload,
    error: state.error,
  };
}

class ChatRuntimePreloadService {
  private state = {
    requested: false,
    isPreloading: false,
    status: '',
    canPreload: false,
    error: null as string | null,
  };

  private readonly listeners = new Set<ChatRuntimePreloadListener>();
  private readonly generationService = getGenerationService();
  private generationSubscription: { unsubscribe: () => void } | null = null;
  private storeSubscription: (() => void) | null = null;
  private preloadPromise: Promise<void> | null = null;
  private lifecycleInitPromise: Promise<void> | null = null;
  private attemptedForCurrentRequest = false;
  private isPreloadInFlight = false;
  private isSyncing = false;

  constructor() {
    this.syncFromStoreAndRuntime(this.generationService.getSnapshot());
    this.generationSubscription = this.generationService.subscribe((snapshot) => {
      this.syncFromStoreAndRuntime(snapshot);
    });
    this.storeSubscription = useAIStore.subscribe(() => {
      this.syncFromStoreAndRuntime(this.generationService.getSnapshot());
    });
  }

  subscribe(listener: ChatRuntimePreloadListener): ChatRuntimePreloadSubscription {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  getSnapshot(): ChatRuntimePreloadSnapshot {
    return createSnapshot(this.state);
  }

  requestPreload(): Promise<void> {
    this.generationService.cancelScheduledUnload();
    this.setState({ requested: true });
    return this.maybePreload();
  }

  retryPreload(): Promise<void> {
    if (this.preloadPromise) {
      this.attemptedForCurrentRequest = true;
      return this.preloadPromise;
    }

    this.generationService.cancelScheduledUnload();
    useAIStore.getState().setRuntimeError(null);
    this.attemptedForCurrentRequest = false;
    this.setState({ requested: true, error: null });
    return this.maybePreload();
  }

  clearRequest() {
    this.attemptedForCurrentRequest = false;
    this.setState({ requested: false });
  }

  dispose() {
    this.generationSubscription?.unsubscribe();
    this.generationSubscription = null;
    this.storeSubscription?.();
    this.storeSubscription = null;
    this.listeners.clear();
    this.preloadPromise = null;
    this.lifecycleInitPromise = null;
    this.attemptedForCurrentRequest = false;
    this.isPreloadInFlight = false;
    this.isSyncing = false;
    this.state = {
      requested: false,
      isPreloading: false,
      status: '',
      canPreload: false,
      error: null,
    };
  }

  private async maybePreload(): Promise<void> {
    if (this.preloadPromise) {
      if (this.state.requested) {
        this.attemptedForCurrentRequest = true;
      }
      return this.preloadPromise;
    }

    if (isSettingsLoadPending()) {
      await waitForSettingsLoaded();
      if (!this.state.requested) {
        return;
      }
    }

    const lifecycle = getModelLifecycleManager?.();
    if (
      useSettingsStore.getState().aiInferenceMode === 'local' &&
      lifecycle &&
      typeof lifecycle.ensureInitialized === 'function' &&
      !lifecycle.isInitialized?.()
    ) {
      if (!this.lifecycleInitPromise) {
        this.lifecycleInitPromise = lifecycle.ensureInitialized().finally(() => {
          this.lifecycleInitPromise = null;
        });
      }
      await this.lifecycleInitPromise;
      if (!this.state.requested) {
        return;
      }
    }

    const runtimeSnapshot = this.generationService.getSnapshot();
    const readiness = this.getReadiness();
    const nextError = this.resolveNextError(runtimeSnapshot, readiness.error);

    this.setState({
      canPreload: readiness.canPreload,
      isPreloading: runtimeSnapshot.isPreparingRuntime || this.isPreloadInFlight,
      status: runtimeSnapshot.runtimeStatus || nextError || readiness.status,
      error: nextError,
    });

    if (
      !this.state.requested ||
      !readiness.canPreload ||
      this.attemptedForCurrentRequest ||
      this.isPreloadInFlight ||
      runtimeSnapshot.isPreparingRuntime ||
      runtimeSnapshot.isGenerating
    ) {
      return;
    }

    this.attemptedForCurrentRequest = true;
    this.isPreloadInFlight = true;

    this.preloadPromise = (async () => {
      this.setState({
        isPreloading: true,
        error: null,
        status: this.generationService.getSnapshot().runtimeStatus || 'Opening local chatbot...',
      });

      try {
        await this.generationService.ensureChatRuntimeReady();
        this.setState({ error: null });
      } catch (error) {
        const message = getErrorMessage(error, 'Unable to load the local AI model on this device.');
        this.setState({
          isPreloading: false,
          error: message,
          status: message,
        });
      } finally {
        this.isPreloadInFlight = false;
        this.preloadPromise = null;
        this.syncFromStoreAndRuntime(this.generationService.getSnapshot());
      }
    })();

    return this.preloadPromise;
  }

  private syncFromStoreAndRuntime(runtimeSnapshot: GenerationServiceRuntimeSnapshot) {
    if (this.isSyncing) {
      return;
    }

    let shouldPreload = false;
    this.isSyncing = true;
    try {
      const readiness = this.getReadiness();
      const nextError = this.resolveNextError(runtimeSnapshot, readiness.error);

      this.setState({
        isPreloading: runtimeSnapshot.isPreparingRuntime || this.isPreloadInFlight,
        status: runtimeSnapshot.runtimeStatus || nextError || readiness.status,
        canPreload: readiness.canPreload,
        error: nextError,
      });

      shouldPreload =
        this.state.requested &&
        !this.lifecycleInitPromise &&
        readiness.canPreload &&
        !this.attemptedForCurrentRequest &&
        !this.isPreloadInFlight &&
        !runtimeSnapshot.isPreparingRuntime &&
        !runtimeSnapshot.isGenerating;
    } finally {
      this.isSyncing = false;
    }

    if (shouldPreload) {
      void this.maybePreload();
    }
  }

  private getReadiness() {
    const store = useAIStore.getState();
    const settings = useSettingsStore.getState();
    const availability = getAIRuntimeAvailability({
      provisioning: store.provisioning,
      runtimeReady: store.runtimeReady,
      warmupPending: store.warmupPending,
      runtime: store.runtime,
      provisioningHydrated: store.provisioningHydrated,
    });

    const isLocalMode = settings.aiInferenceMode === 'local';
    const isBusyProvisioning =
      availability.hasUsableLocalInferenceBackend &&
      ['queued', 'downloading', 'verifying', 'unpacking', 'registering', 'warming', 'indexing'].includes(
        store.provisioning.status,
      );

    const activeLoadError =
      isLocalMode &&
      store.provisioning.status === 'ready' &&
      store.runtime.lastRuntimeError &&
      store.runtime.lastRuntimeError.code !== 'generation-cancelled'
        ? store.runtime.lastRuntimeError
        : null;

    // Preload is only needed when local mode has an installed model that is not loaded/ready yet
    // and has not already errored.
    const canPreload =
      isLocalMode &&
      availability.hasUsableLocalInferenceBackend &&
      store.provisioning.status === 'ready' &&
      !availability.canRunNativeChat &&
      !availability.runtimePhaseActive &&
      !isBusyProvisioning &&
      !activeLoadError &&
      !store.runtime.activeGenerationRequestId;

    return {
      canPreload,
      status: availability.localInferenceStatusMessage,
      error: activeLoadError?.message ?? null,
    };
  }

  private resolveNextError(
    runtimeSnapshot: GenerationServiceRuntimeSnapshot,
    readinessError: string | null,
  ): string | null {
    const store = useAIStore.getState();
    const settings = useSettingsStore.getState();
    if (
      settings.aiInferenceMode !== 'local' ||
      store.runtimeReady ||
      store.provisioning.status !== 'ready' ||
      runtimeSnapshot.isPreparingRuntime ||
      this.isPreloadInFlight
    ) {
      return null;
    }

    return readinessError ?? this.state.error;
  }

  private setState(patch: Partial<ChatRuntimePreloadService['state']>) {
    const nextState = {
      ...this.state,
      ...patch,
    };
    if (
      nextState.requested === this.state.requested &&
      nextState.isPreloading === this.state.isPreloading &&
      nextState.status === this.state.status &&
      nextState.canPreload === this.state.canPreload &&
      nextState.error === this.state.error
    ) {
      return;
    }
    this.state = nextState;
    this.emit();
  }

  private emit() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

let preloadService: ChatRuntimePreloadService | null = null;

export function getChatRuntimePreloadService() {
  if (!preloadService) {
    preloadService = new ChatRuntimePreloadService();
  }

  return preloadService;
}

export function resetChatRuntimePreloadService() {
  if (preloadService) {
    preloadService.dispose();
    preloadService = null;
  }
}
