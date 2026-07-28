import { Platform } from 'react-native';
import { create } from 'zustand';

import { useSettingsStore } from './useSettingsStore';
import {
  AI_RUNTIME_PHASE_STATUSES,
  AI_STATUS_LABELS,
  AIProvisioningStatus,
} from '../services/ai/config';
import type {
  LocalInferenceAvailability,
  LocalInferenceError,
  LocalInferenceRuntimeState,
  LocalRuntimeInfo,
} from '../services/ai/localInferenceTypes';

export interface Message {
  id?: string;
  role: 'user' | 'ai';
  text: string;
  status?: 'streaming' | 'complete' | 'error' | 'cancelled';
  createdAt?: string;
}

export interface AIModel {
  name: string;
  displayName: string;
  inputTokenLimit: number;
  description: string;
}

export interface AITransferSnapshot {
  downloadUrl: string | null;
  resumableUri: string | null;
  resumeData: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  bytesPerSecond: number | null;
  lastProgressAt: string | null;
  sessionId: string | null;
}

export interface AIProvisioningSnapshot {
  status: AIProvisioningStatus;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  version: string;
  modelPath: string | null;
  tempPath: string | null;
  checksumVerified: boolean;
  initializedAt: string | null;
  lastError: string | null;
  retryCount: number;
  pausedReason: string | null;
  canResume: boolean;
  updateAvailable: boolean;
  lastUpdatedAt: string | null;
  lastVerifiedAt: string | null;
  transfer: AITransferSnapshot;
}

export interface AIStorageHealthSnapshot {
  freeBytes: number | null;
  totalBytes: number | null;
  status: 'ok' | 'warning' | 'critical' | 'unknown';
  lastCheckedAt: string | null;
  message: string | null;
}

export interface AIMemoryTelemetrySnapshot {
  pssBytes: number | null;
  totalRamBytes: number | null;
  recommendedQuantization: string;
  activeQuantization: string;
  fallbackTriggered: boolean;
  lastUpdated: string | null;
}

export interface AIContextWindowSnapshot {
  currentTokens: number;
  maxTokens: number;
  summarizationActive: boolean;
  windowTurnCount: number;
  summaryText: string | null;
}

export interface AIEventLog {
  id: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface AIRuntimeSnapshot {
  backendDetected: boolean;
  backendName: string | null;
  runtimeState: LocalInferenceRuntimeState;
  modelLoaded: boolean;
  generationHealthy: boolean;
  activeGenerationRequestId: string | null;
  streamingResponseText: string;
  activeStatusLabel: string | null;
  activePhaseStartedAt: string | null;
  lastRuntimeError: LocalInferenceError | null;
  availability: LocalInferenceAvailability;
  runtimeInfo: LocalRuntimeInfo | null;
  lastHealthCheckAt: string | null;
  lastModelLoadPath: string | null;
  lastModelLoadCompletedAt: string | null;
}

export interface AIRuntimeAvailability {
  runtimePhaseActive: boolean;
  canRunGroundedQueries: boolean;
  canRunNativeChat: boolean;
  hasUsableLocalInferenceBackend: boolean;
  localInferenceStatusMessage: string;
  runtimeState: LocalInferenceRuntimeState;
  modelLoaded: boolean;
  generationHealthy: boolean;
  lastRuntimeError: LocalInferenceError | null;
}

function buildInitialAvailability(): LocalInferenceAvailability {
  if (Platform.OS === 'android') {
    return {
      available: true,
      reason: 'android-supported',
      message: 'llama.rn local inference available on Android.',
    };
  }

  return {
    available: false,
    reason: 'platform-unsupported',
    message: 'Local GGUF inference is Android-only in this build.',
  };
}

export function createInitialRuntimeSnapshot(): AIRuntimeSnapshot {
  const availability = buildInitialAvailability();
  return {
    backendDetected: availability.available,
    backendName: availability.available ? 'llama.rn' : null,
    runtimeState: availability.available ? 'detected' : 'unavailable',
    modelLoaded: false,
    generationHealthy: false,
    activeGenerationRequestId: null,
    streamingResponseText: '',
    activeStatusLabel: null,
    activePhaseStartedAt: null,
    lastRuntimeError: null,
    availability,
    runtimeInfo: null,
    lastHealthCheckAt: null,
    lastModelLoadPath: null,
    lastModelLoadCompletedAt: null,
  };
}

export function getAIRuntimeAvailability(
  state: Pick<AIStoreState, 'provisioning' | 'runtimeReady' | 'warmupPending' | 'runtime'>,
): AIRuntimeAvailability {
  const settings = useSettingsStore.getState();
  if (settings?.aiInferenceMode === 'external') {
    return {
      runtimePhaseActive: false,
      canRunGroundedQueries: true,
      canRunNativeChat: Boolean(settings.externalApiUrl && settings.externalApiModel),
      hasUsableLocalInferenceBackend: true,
      localInferenceStatusMessage: `Using external API (${settings.externalApiProvider.toUpperCase()}): ${settings.externalApiModel} at ${settings.externalApiUrl}`,
      runtimeState: 'healthy',
      modelLoaded: true,
      generationHealthy: true,
      lastRuntimeError: state.runtime.lastRuntimeError,
    };
  }

  const runtimePhaseActive = state.warmupPending || AI_RUNTIME_PHASE_STATUSES.includes(state.provisioning.status);
  const availability = state.runtime.availability;
  
  const isMemoryCriticallyLow = (state.runtime.runtimeInfo?.totalRamBytes ?? Infinity) < 3 * 1024 * 1024 * 1024;
  const hasUsableLocalInferenceBackend = availability.available && !isMemoryCriticallyLow;
  const canRunNativeChat =
    hasUsableLocalInferenceBackend &&
    state.provisioning.status === 'ready' &&
    state.runtimeReady &&
    state.runtime.modelLoaded &&
    state.runtime.generationHealthy &&
    !runtimePhaseActive;

  let localInferenceStatusMessage = availability.message;

  if (state.runtime.lastRuntimeError) {
    localInferenceStatusMessage = state.runtime.lastRuntimeError.message;
  } else if (!hasUsableLocalInferenceBackend) {
    localInferenceStatusMessage = availability.message;
  } else if (!state.runtime.modelLoaded) {
    localInferenceStatusMessage = 'Android local inference bridge detected, but no GGUF model is loaded into the native runtime yet.';
  } else if (!state.runtime.generationHealthy) {
    localInferenceStatusMessage = 'Model load is incomplete until the native runtime passes a real probe generation.';
  } else if (runtimePhaseActive) {
    localInferenceStatusMessage = 'Local GGUF runtime is still preparing and cannot accept chat generation yet.';
  } else {
    localInferenceStatusMessage = 'Android local GGUF inference is loaded, probed, and ready for local chat generation.';
  }

  return {
    runtimePhaseActive,
    canRunGroundedQueries: true,
    canRunNativeChat,
    hasUsableLocalInferenceBackend,
    localInferenceStatusMessage,
    runtimeState: state.runtime.runtimeState,
    modelLoaded: state.runtime.modelLoaded,
    generationHealthy: state.runtime.generationHealthy,
    lastRuntimeError: state.runtime.lastRuntimeError,
  };
}

export interface AIStoreState {
  localModelId: string;
  localModelDisplayName: string;
  selectedMode: 'rag' | 'chat';
  chatHistory: Message[];
  provisioning: AIProvisioningSnapshot;
  storageHealth: AIStorageHealthSnapshot;
  memoryTelemetry: AIMemoryTelemetrySnapshot;
  contextWindow: AIContextWindowSnapshot;
  logs: AIEventLog[];
  runtime: AIRuntimeSnapshot;
  runtimeReady: boolean;
  warmupPending: boolean;
  setLocalModelTarget: (localModelId: string, localModelDisplayName: string) => void;
  setSelectedMode: (mode: 'rag' | 'chat') => void;
  updateStorageHealth: (health: Partial<AIStorageHealthSnapshot>) => void;
  updateMemoryTelemetry: (telemetry: Partial<AIMemoryTelemetrySnapshot>) => void;
  updateContextWindow: (context: Partial<AIContextWindowSnapshot>) => void;
  addChatMessage: (msg: Message) => void;
  updateChatMessage: (messageId: string, updater: Partial<Message> | ((message: Message) => Message)) => void;
  removeChatMessage: (messageId: string) => void;
  clearChatHistory: () => void;
  replaceProvisioning: (snapshot: Partial<AIProvisioningSnapshot>) => void;
  updateTransfer: (snapshot: Partial<AITransferSnapshot>) => void;
  resetTransfer: () => void;
  appendLog: (entry: Omit<AIEventLog, 'id' | 'timestamp'> & { timestamp?: string }) => void;
  markRuntimeReady: (ready: boolean) => void;
  setWarmupPending: (pending: boolean) => void;
  refreshRuntimeAvailability: () => LocalInferenceAvailability;
  setRuntimeState: (runtimeState: LocalInferenceRuntimeState) => void;
  setRuntimeModelLoaded: (loaded: boolean, runtimeInfo?: LocalRuntimeInfo | null) => void;
  setRuntimeHealth: (healthy: boolean, lastHealthCheckAt?: string | null) => void;
  setRuntimeError: (error: LocalInferenceError | null) => void;
  setRuntimeInfo: (runtimeInfo: LocalRuntimeInfo | null) => void;
  setActiveGenerationRequestId: (requestId: string | null) => void;
  setStreamingResponseText: (text: string) => void;
  setActiveStatusLabel: (label: string | null, startedAt?: string | null) => void;
  resetProvisioningError: () => void;
}

export const createInitialTransferSnapshot = (): AITransferSnapshot => ({
  downloadUrl: null,
  resumableUri: null,
  resumeData: null,
  startedAt: null,
  updatedAt: null,
  bytesPerSecond: null,
  lastProgressAt: null,
  sessionId: null,
});

export const createInitialProvisioningSnapshot = (): AIProvisioningSnapshot => ({
  status: 'not-installed',
  progress: 0,
  downloadedBytes: 0,
  totalBytes: null,
  version: 'qwen3.5-2b',
  modelPath: null,
  tempPath: null,
  checksumVerified: false,
  initializedAt: null,
  lastError: null,
  retryCount: 0,
  pausedReason: null,
  canResume: false,
  updateAvailable: false,
  lastUpdatedAt: null,
  lastVerifiedAt: null,
  transfer: createInitialTransferSnapshot(),
});

const MAX_EVENT_LOGS = 60;

export const getProvisioningStatusLabel = (status: AIProvisioningStatus): string => AI_STATUS_LABELS[status];

export const createInitialStorageHealthSnapshot = (): AIStorageHealthSnapshot => ({
  freeBytes: null,
  totalBytes: null,
  status: 'unknown',
  lastCheckedAt: null,
  message: null,
});

export const createInitialMemoryTelemetrySnapshot = (): AIMemoryTelemetrySnapshot => ({
  pssBytes: null,
  totalRamBytes: null,
  recommendedQuantization: 'Q5_K_M',
  activeQuantization: 'Q5_K_M',
  fallbackTriggered: false,
  lastUpdated: null,
});

export const createInitialContextWindowSnapshot = (): AIContextWindowSnapshot => ({
  currentTokens: 0,
  maxTokens: 1024,
  summarizationActive: false,
  windowTurnCount: 0,
  summaryText: null,
});

export const useAIStore = create<AIStoreState>((set) => ({
  localModelId: 'qwen3.5-2b',
  localModelDisplayName: 'Qwen 3.5 2B',
  selectedMode: 'rag',
  chatHistory: [],
  provisioning: createInitialProvisioningSnapshot(),
  storageHealth: createInitialStorageHealthSnapshot(),
  memoryTelemetry: createInitialMemoryTelemetrySnapshot(),
  contextWindow: createInitialContextWindowSnapshot(),
  logs: [],
  runtime: createInitialRuntimeSnapshot(),
  runtimeReady: false,
  warmupPending: false,
  setLocalModelTarget: (localModelId, localModelDisplayName) =>
    set((state) => ({
      localModelId,
      localModelDisplayName,
      provisioning: {
        ...state.provisioning,
        version: localModelId,
      },
    })),
  setSelectedMode: (selectedMode) => set({ selectedMode }),
  addChatMessage: (msg) =>
    set((state) => ({
      chatHistory: [
        ...state.chatHistory,
        {
          createdAt: msg.createdAt ?? new Date().toISOString(),
          status: msg.status ?? 'complete',
          ...msg,
        },
      ],
    })),
  updateChatMessage: (messageId, updater) =>
    set((state) => ({
      chatHistory: state.chatHistory.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        if (typeof updater === 'function') {
          return updater(message);
        }

        return {
          ...message,
          ...updater,
        };
      }),
    })),
  removeChatMessage: (messageId) =>
    set((state) => ({
      chatHistory: state.chatHistory.filter((message) => message.id !== messageId),
    })),
  clearChatHistory: () => set({ chatHistory: [] }),
  replaceProvisioning: (snapshot) =>
    set((state) => ({
      provisioning: {
        ...state.provisioning,
        ...snapshot,
        transfer: {
          ...state.provisioning.transfer,
          ...snapshot.transfer,
        },
        lastUpdatedAt: new Date().toISOString(),
      },
    })),
  updateTransfer: (snapshot) =>
    set((state) => ({
      provisioning: {
        ...state.provisioning,
        transfer: {
          ...state.provisioning.transfer,
          ...snapshot,
          updatedAt: new Date().toISOString(),
        },
        lastUpdatedAt: new Date().toISOString(),
      },
    })),
  resetTransfer: () =>
    set((state) => ({
      provisioning: {
        ...state.provisioning,
        transfer: createInitialTransferSnapshot(),
        lastUpdatedAt: new Date().toISOString(),
      },
    })),
  appendLog: (entry) =>
    set((state) => ({
      logs: [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          timestamp: entry.timestamp ?? new Date().toISOString(),
          level: entry.level,
          event: entry.event,
          message: entry.message,
          details: entry.details,
        },
        ...state.logs,
      ].slice(0, MAX_EVENT_LOGS),
    })),
  markRuntimeReady: (runtimeReady) => set({ runtimeReady }),
  setWarmupPending: (warmupPending) => set({ warmupPending }),
  refreshRuntimeAvailability: () => {
    const availability = buildInitialAvailability();
    set((state) => ({
      runtime: {
        ...state.runtime,
        availability,
        backendDetected: availability.available,
        backendName: availability.available ? 'llama.rn' : null,
        runtimeState: availability.available ? (state.runtime.runtimeState === 'unavailable' ? 'detected' : state.runtime.runtimeState) : 'unavailable',
        lastRuntimeError: availability.available
          ? state.runtime.lastRuntimeError
          : {
              code: 'backend-unavailable',
              message: availability.message,
              recoverable: false,
            },
      },
    }));
    return availability;
  },
  setRuntimeState: (runtimeState) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        runtimeState,
      },
    })),
  setRuntimeModelLoaded: (modelLoaded, runtimeInfo = null) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        modelLoaded,
        runtimeInfo: runtimeInfo ?? state.runtime.runtimeInfo,
        runtimeState: modelLoaded ? 'loaded' : state.runtime.availability.available ? 'model-unloaded' : 'unavailable',
        lastModelLoadPath: modelLoaded ? runtimeInfo?.loadedModelPath ?? state.runtime.lastModelLoadPath : state.runtime.lastModelLoadPath,
        lastModelLoadCompletedAt: modelLoaded ? new Date().toISOString() : state.runtime.lastModelLoadCompletedAt,
      },
    })),
  setRuntimeHealth: (generationHealthy, lastHealthCheckAt = new Date().toISOString()) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        generationHealthy,
        lastHealthCheckAt,
        runtimeState: generationHealthy ? 'healthy' : state.runtime.modelLoaded ? 'loaded' : state.runtime.runtimeState,
      },
    })),
  setRuntimeError: (lastRuntimeError) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        lastRuntimeError,
        generationHealthy: lastRuntimeError ? false : state.runtime.generationHealthy,
        runtimeState: lastRuntimeError ? 'failed' : state.runtime.runtimeState,
      },
    })),
  setRuntimeInfo: (runtimeInfo) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        runtimeInfo,
        backendName: runtimeInfo?.backend ?? state.runtime.backendName,
      },
    })),
  setActiveGenerationRequestId: (activeGenerationRequestId) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        activeGenerationRequestId,
        runtimeState: activeGenerationRequestId ? 'busy' : state.runtime.generationHealthy ? 'healthy' : state.runtime.runtimeState,
        activePhaseStartedAt: activeGenerationRequestId ? state.runtime.activePhaseStartedAt ?? new Date().toISOString() : null,
      },
    })),
  setStreamingResponseText: (streamingResponseText) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        streamingResponseText,
      },
    })),
  setActiveStatusLabel: (activeStatusLabel, activePhaseStartedAt = activeStatusLabel ? new Date().toISOString() : null) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        activeStatusLabel,
        activePhaseStartedAt,
      },
    })),
  resetProvisioningError: () =>
    set((state) => ({
      provisioning: {
        ...state.provisioning,
        lastError: null,
        pausedReason: null,
        lastUpdatedAt: new Date().toISOString(),
      },
      runtime: {
        ...state.runtime,
        lastRuntimeError: null,
        activeStatusLabel: null,
        activePhaseStartedAt: null,
      },
    })),
  updateStorageHealth: (health) =>
    set((state) => ({
      storageHealth: {
        ...state.storageHealth,
        ...health,
        lastCheckedAt: health.lastCheckedAt ?? new Date().toISOString(),
      },
    })),
  updateMemoryTelemetry: (telemetry) =>
    set((state) => ({
      memoryTelemetry: {
        ...state.memoryTelemetry,
        ...telemetry,
        lastUpdated: telemetry.lastUpdated ?? new Date().toISOString(),
      },
    })),
  updateContextWindow: (context) =>
    set((state) => ({
      contextWindow: {
        ...state.contextWindow,
        ...context,
      },
    })),
}));
