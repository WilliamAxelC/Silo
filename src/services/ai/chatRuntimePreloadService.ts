import { getAIRuntimeAvailability, useAIStore } from '../../store/useAIStore';
import { getGenerationService, type GenerationServiceRuntimeSnapshot } from './generationService';

export type ChatRuntimePreloadSnapshot = {
  requested: boolean;
  isPreloading: boolean;
  status: string;
  canPreload: boolean;
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
  };
}

class ChatRuntimePreloadService {
  private state = {
    requested: false,
    isPreloading: false,
    status: '',
    canPreload: false,
  };

  private readonly listeners = new Set<ChatRuntimePreloadListener>();
  private readonly generationService = getGenerationService();
  private generationSubscription: { unsubscribe: () => void } | null = null;
  private storeSubscription: (() => void) | null = null;
  private preloadPromise: Promise<void> | null = null;

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
    this.setState({ requested: true });
    return this.maybePreload();
  }

  clearRequest() {
    this.setState({ requested: false });
  }

  private async maybePreload(): Promise<void> {
    const readiness = this.getReadiness();
    this.setState({
      canPreload: readiness.canPreload,
      status: readiness.status,
    });

    if (!this.state.requested || !readiness.canPreload) {
      return;
    }

    if (this.preloadPromise) {
      return this.preloadPromise;
    }

    this.preloadPromise = (async () => {
      this.setState({
        isPreloading: true,
        status: this.generationService.getSnapshot().runtimeStatus || readiness.status || 'Opening local chatbot...',
      });

      try {
        await this.generationService.ensureChatRuntimeReady();
      } finally {
        this.preloadPromise = null;
        this.syncFromStoreAndRuntime(this.generationService.getSnapshot());
      }
    })();

    return this.preloadPromise;
  }

  private syncFromStoreAndRuntime(runtimeSnapshot: GenerationServiceRuntimeSnapshot) {
    const readiness = this.getReadiness();
    this.setState({
      isPreloading: runtimeSnapshot.isPreparingRuntime,
      status: runtimeSnapshot.runtimeStatus || readiness.status,
      canPreload: readiness.canPreload,
    });

    if (this.state.requested && readiness.canPreload && !runtimeSnapshot.isPreparingRuntime) {
      void this.maybePreload();
    }
  }

  private getReadiness() {
    const store = useAIStore.getState();
    const availability = getAIRuntimeAvailability({
      provisioning: store.provisioning,
      runtimeReady: store.runtimeReady,
      warmupPending: store.warmupPending,
      runtime: store.runtime,
    });

    const isBusyProvisioning = availability.hasUsableLocalInferenceBackend
      && ['queued', 'downloading', 'verifying', 'unpacking', 'registering', 'warming', 'indexing'].includes(store.provisioning.status);

    return {
      canPreload: availability.canRunNativeChat && !availability.runtimePhaseActive && !isBusyProvisioning,
      status: availability.localInferenceStatusMessage,
    };
  }

  private setState(patch: Partial<ChatRuntimePreloadService['state']>) {
    this.state = {
      ...this.state,
      ...patch,
    };
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
