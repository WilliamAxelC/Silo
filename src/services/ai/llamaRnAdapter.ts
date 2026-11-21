import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import {
  initLlama,
  releaseAllLlama,
  type CompletionParams,
  type LlamaContext,
  type RNLlamaOAICompatibleMessage,
} from 'llama.rn';

import {
  QWEN_MODEL_DEFAULT_BATCH_TOKENS,
  QWEN_MODEL_DEFAULT_USE_FLASH_ATTENTION,
  QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
  QWEN_MODEL_STOP_TOKENS,
  isSupportedLocalModelPath,
} from './config';
import {
  LocalInferenceException,
  type LocalGenerationResult,
  type LocalInferenceError,
  type LocalRuntimeInfo,
} from './localInferenceTypes';
import {
  buildMemoryBudget,
  canLoadModelWithinMemoryBudget,
  getGpuLayersForDevice,
  getTotalDeviceMemoryBytes,
  parseResolvedThreadsFromSystemInfo,
  resolveRecommendedCpuThreads,
} from './hardware';
import { getVisionProjectorUri } from './modelLifecycle';

export type LlamaRnCompletionParams = {
  prompt?: string;
  messages?: RNLlamaOAICompatibleMessage[];
  imageUri?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  jsonSchema?: object;
  disableThinking?: boolean;
  onToken?: (text: string) => void;
  onFirstToken?: (durationMs: number) => void;
};

export type LlamaRnInitParams = {
  modelPath: string;
  modelFileSizeBytes: number;
  contextTokens?: number;
  onProgress?: (progress: number) => void;
};

type FileInfoResult = {
  exists: boolean;
  size?: number;
  uri?: string;
};

type FileSystemLegacyModule = typeof ExpoFileSystemLegacy & {
  getInfoAsync?: (path: string, options?: { size?: boolean }) => Promise<FileInfoResult>;
};

const FileSystemModule = ExpoFileSystemLegacy as FileSystemLegacyModule;

function toRuntimeError(code: LocalInferenceError['code'], message: string, details?: Record<string, unknown>): LocalInferenceError {
  return new LocalInferenceException(
    code,
    message,
    details,
    code !== 'unsupported-device' && code !== 'backend-unavailable',
  );
}

async function safeGetInfo(path: string): Promise<FileInfoResult> {
  return FileSystemModule.getInfoAsync ? FileSystemModule.getInfoAsync(path, { size: true }) : { exists: false, uri: path };
}

function normalizeModelPath(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function resolveStreamText(data?: { accumulated_text?: string; content?: string; token?: string } | null) {
  if (!data) {
    return '';
  }

  if (typeof data.accumulated_text === 'string' && data.accumulated_text.length > 0) {
    return data.accumulated_text;
  }

  if (typeof data.content === 'string' && data.content.length > 0) {
    return data.content;
  }

  if (typeof data.token === 'string' && data.token.length > 0) {
    return data.token;
  }

  return '';
}

function resolveFinalText(result: {
  content?: string;
  text?: string;
} | null | undefined, fallbackText: string) {
  if (typeof result?.content === 'string' && result.content.length > 0) {
    return result.content;
  }

  if (typeof result?.text === 'string' && result.text.length > 0) {
    return result.text;
  }

  return fallbackText;
}

function resolveStopReason(result: {
  interrupted?: boolean;
  stopped_limit?: number;
  truncated?: boolean;
  context_full?: boolean;
  stopped_eos?: boolean;
  stopped_word?: string;
  stopping_word?: string;
} | null | undefined, wasCancelled: boolean): LocalGenerationResult['stopReason'] {
  if (wasCancelled || result?.interrupted) {
    return 'cancelled';
  }

  if (Boolean(result?.stopped_limit) || result?.truncated || result?.context_full) {
    return 'max-tokens';
  }

  if (result?.stopped_eos || Boolean(result?.stopped_word) || Boolean(result?.stopping_word)) {
    return 'stop';
  }

  return 'unknown';
}

function logLlamaRuntimeWarning(event: string, details: Record<string, unknown>) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.warn('[LlamaRnAdapter]', event, details);
  }
}

function hasImageMessagePart(messages?: RNLlamaOAICompatibleMessage[]): boolean {
  if (!messages || !Array.isArray(messages)) {
    return false;
  }
  return messages.some((msg) =>
    Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image_url'),
  );
}

class LlamaRnAdapter {
  private context: LlamaContext | null = null;
  private initializedModelPath: string | null = null;
  private initializedModelFileSizeBytes = 0;
  private configuredContextTokens = 0;
  private resolvedGpuLayers = 0;
  private multimodalInitialized = false;
  private initPromise: Promise<void> | null = null;
  private activeCompletionRequestId: string | null = null;
  private stoppingRequestId: string | null = null;
  private lastCompletionText = '';
  private lastRuntimeInfo: LocalRuntimeInfo | null = null;

  async initContext({ modelPath, modelFileSizeBytes, contextTokens, onProgress }: LlamaRnInitParams): Promise<void> {
    const normalizedModelPath = normalizeModelPath(modelPath);
    const requestedContextTokens = Math.max(contextTokens ?? 0, QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS);
    if (this.context && this.initializedModelPath === normalizedModelPath && this.configuredContextTokens >= requestedContextTokens) {
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      if (this.context && this.initializedModelPath === normalizedModelPath && this.configuredContextTokens >= requestedContextTokens) {
        return;
      }
    }

    this.initPromise = (async () => {
      if (!isSupportedLocalModelPath(normalizedModelPath)) {
        throw toRuntimeError('model-file-missing', 'Configured llama.rn model path is invalid or unsupported.', {
          modelPath: normalizedModelPath,
        });
      }

      const fileInfo = await safeGetInfo(normalizedModelPath);
      const resolvedModelFileSizeBytes = fileInfo.size ?? modelFileSizeBytes;
      if (!fileInfo.exists || !resolvedModelFileSizeBytes || resolvedModelFileSizeBytes <= 0) {
        throw toRuntimeError('model-file-missing', 'Local AI model is not installed yet. Please tap "Retry setup" above or download the model in Settings to enable offline AI.', {
          modelPath: normalizedModelPath,
          exists: fileInfo.exists,
          reportedSizeBytes: fileInfo.size ?? null,
          providedSizeBytes: modelFileSizeBytes,
        });
      }

      const totalMemoryBytes = await getTotalDeviceMemoryBytes();
      const canLoadModel = await canLoadModelWithinMemoryBudget(resolvedModelFileSizeBytes);
      if (!canLoadModel) {
        const budget = buildMemoryBudget(totalMemoryBytes, resolvedModelFileSizeBytes);
        throw toRuntimeError(
          'insufficient-memory',
          'Model load blocked because the estimated RAM requirement exceeds the safe device memory budget.',
          budget as unknown as Record<string, unknown>,
        );
      }

      await this.dispose();

      const requestedCpuThreads = resolveRecommendedCpuThreads();
      const requestedGpuLayers = getGpuLayersForDevice(totalMemoryBytes);
      let resolvedGpuLayers = requestedGpuLayers;
      let gpuAttemptFailed = false;
      const flashAttnType = QWEN_MODEL_DEFAULT_USE_FLASH_ATTENTION ? ('auto' as const) : ('off' as const);
      const progressCallback = onProgress
        ? (progress: number) => {
            onProgress(Math.max(0, Math.min(100, Math.round(progress))));
          }
        : undefined;

      const baseInitParams = {
        model: normalizedModelPath,
        use_progress_callback: Boolean(progressCallback),
        n_ctx: requestedContextTokens,
        n_batch: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        n_ubatch: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        n_threads: requestedCpuThreads,
        use_mlock: false,
        use_mmap: true,
        flash_attn_type: flashAttnType,
      };

      let context: LlamaContext;
      try {
        context = await initLlama(
          {
            ...baseInitParams,
            n_gpu_layers: requestedGpuLayers,
            ...(requestedGpuLayers <= 0 ? { no_gpu_devices: true } : {}),
          },
          progressCallback,
        );
      } catch (error) {
        if (requestedGpuLayers <= 0) {
          throw error;
        }

        gpuAttemptFailed = true;
        resolvedGpuLayers = 0;
        logLlamaRuntimeWarning('gpu-init-fallback', {
          requestedGpuLayers,
          requestedCpuThreads,
          message: error instanceof Error ? error.message : String(error),
        });
        context = await initLlama(
          {
            ...baseInitParams,
            n_gpu_layers: 0,
            no_gpu_devices: true,
          },
          progressCallback,
        );
      }

      const resolvedCpuThreads = parseResolvedThreadsFromSystemInfo(context.systemInfo) ?? requestedCpuThreads;
      const gpuActuallyEnabled = Boolean(context.gpu) && resolvedGpuLayers > 0;
      this.context = context;
      this.initializedModelPath = normalizedModelPath;
      this.initializedModelFileSizeBytes = resolvedModelFileSizeBytes;
      this.configuredContextTokens = requestedContextTokens;
      this.resolvedGpuLayers = gpuActuallyEnabled ? resolvedGpuLayers : 0;
      this.multimodalInitialized = false;
      this.lastRuntimeInfo = {
        backend: gpuActuallyEnabled ? 'llama.rn' : 'llama.rn-cpu',
        version: null,
        supportsStreaming: true,
        maxContextTokens: requestedContextTokens,
        loadedModelPath: normalizedModelPath,
        loadedModelFamily: 'qwen',
        loadedModelQuantization: null,
        isModelLoaded: true,
        abi: null,
        configuredContextTokens: requestedContextTokens,
        configuredCpuThreads: requestedCpuThreads,
        configuredGpuLayers: this.resolvedGpuLayers,
        configuredBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        configuredUseFlashAttention: QWEN_MODEL_DEFAULT_USE_FLASH_ATTENTION,
        configuredUseMlock: false,
        resolvedContextTokens: requestedContextTokens,
        resolvedBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        resolvedMicroBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        resolvedThreads: resolvedCpuThreads,
        estimatedGpuOffloadRequested: requestedGpuLayers > 0,
        gpuOffloadSupportedByBuild: gpuActuallyEnabled,
        detectedBackendSummary: gpuActuallyEnabled
          ? `llama.rn with ${resolvedGpuLayers} requested GPU layers and ${resolvedCpuThreads} CPU threads`
          : `llama.rn CPU runtime with ${resolvedCpuThreads} CPU threads${gpuAttemptFailed ? ' after GPU init fallback' : ''}`,
        likelyCpuOnlyRuntime: !gpuActuallyEnabled,
      };
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async ensureMultimodalInitialized(): Promise<void> {
    if (!this.context) {
      throw toRuntimeError('load-failed', 'llama.rn context is not initialized.');
    }
    if (this.multimodalInitialized) {
      return;
    }

    const projectorUri = getVisionProjectorUri();
    if (!projectorUri) {
      throw toRuntimeError('model-file-missing', 'Vision projector URI is not available.');
    }

    const useGpu = this.resolvedGpuLayers > 0;
    try {
      if (typeof this.context.initMultimodal !== 'function') {
        throw new Error('Native initMultimodal method is missing.');
      }
      const success = await this.context.initMultimodal({
        path: projectorUri,
        use_gpu: useGpu,
      });
      if (success === false) {
        throw new Error('Native initMultimodal returned false.');
      }
      this.multimodalInitialized = true;
    } catch (error) {
      this.multimodalInitialized = false;
      throw toRuntimeError(
        'backend-unavailable',
        `Failed to initialize vision multimodal projector: ${error instanceof Error ? error.message : String(error)}`,
        { projectorUri, useGpu, originalError: error },
      );
    }
  }

  async completion(requestId: string, params: LlamaRnCompletionParams): Promise<LocalGenerationResult> {
    if (!this.context) {
      throw toRuntimeError('load-failed', 'llama.rn context is not initialized.');
    }

    if (this.activeCompletionRequestId && this.activeCompletionRequestId !== requestId) {
      throw toRuntimeError('runtime-busy', 'llama.rn is already processing another completion request.', {
        activeCompletionRequestId: this.activeCompletionRequestId,
      });
    }

    if (!params.prompt && (!params.messages || params.messages.length === 0)) {
      throw toRuntimeError('generation-failed', 'Prompt or messages is required for llama.rn completion.');
    }

    const isImageRequest = Boolean(params.imageUri || hasImageMessagePart(params.messages));
    if (isImageRequest) {
      if (this.configuredContextTokens < 4096 && this.initializedModelPath) {
        await this.initContext({
          modelPath: this.initializedModelPath,
          modelFileSizeBytes: this.initializedModelFileSizeBytes,
          contextTokens: 4096,
        });
      }
      if (!this.multimodalInitialized) {
        await this.ensureMultimodalInitialized();
      }
    }

    this.activeCompletionRequestId = requestId;
    this.stoppingRequestId = null;
    this.lastCompletionText = '';

    try {
      const completionStartedAtMs = Date.now();
      let firstTokenDurationMs: number | undefined;
      const completionParams: CompletionParams = {
        ...(params.messages && params.messages.length > 0
          ? { messages: params.messages }
          : { prompt: params.prompt ?? '' }),
        stop: params.stop ?? [...QWEN_MODEL_STOP_TOKENS],
        n_predict: params.maxTokens,
        temperature: params.temperature,
        top_p: params.topP,
        ...(params.jsonSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { schema: params.jsonSchema },
              },
            }
          : {}),
        ...(params.disableThinking ? { enable_thinking: false } : {}),
      };

      const result = await this.context.completion(
        completionParams,
        (data) => {
          if (this.activeCompletionRequestId !== requestId || this.stoppingRequestId === requestId) {
            return;
          }

          const streamedText = resolveStreamText(data);
          if (!streamedText) {
            return;
          }

          if (firstTokenDurationMs === undefined) {
            firstTokenDurationMs = Date.now() - completionStartedAtMs;
            params.onFirstToken?.(firstTokenDurationMs);
          }

          this.lastCompletionText = data?.accumulated_text ?? streamedText;
          params.onToken?.(this.lastCompletionText);
        },
      );

      const stopReason = resolveStopReason(result, this.stoppingRequestId === requestId);
      const finalText = resolveFinalText(result, this.lastCompletionText);
      const totalDurationMs = (result.timings?.prompt_ms ?? 0) + (result.timings?.predicted_ms ?? 0);

      this.lastRuntimeInfo = {
        ...(this.lastRuntimeInfo ?? {
          backend: 'llama.rn-cpu',
          version: null,
          supportsStreaming: true,
        }),
        isModelLoaded: Boolean(this.context),
        loadedModelPath: this.initializedModelPath,
        lastPromptTokens: result.tokens_evaluated,
        lastCompletionTokens: result.tokens_predicted,
        lastPromptEvalDurationMs: result.timings?.prompt_ms,
        lastGenerationEvalDurationMs: result.timings?.predicted_ms,
        lastTotalDurationMs: totalDurationMs,
        lastStopReason: stopReason ?? 'unknown',
      };

      return {
        requestId,
        text: finalText,
        promptTokens: result.tokens_evaluated,
        completionTokens: result.tokens_predicted,
        totalDurationMs,
        promptEvalDurationMs: result.timings?.prompt_ms,
        generationEvalDurationMs: result.timings?.predicted_ms,
        firstTokenDurationMs,
        tokensPerSecond: result.timings?.predicted_per_second,
        stopReason,
      };
    } catch (error) {
      if (this.stoppingRequestId === requestId) {
        throw Object.assign(new Error('Generation cancelled by user.'), { code: 'generation-cancelled' });
      }
      throw error;
    } finally {
      if (this.activeCompletionRequestId === requestId) {
        this.activeCompletionRequestId = null;
      }
      if (this.stoppingRequestId === requestId) {
        this.stoppingRequestId = null;
      }
    }
  }

  async stopCompletion(): Promise<void> {
    if (!this.context || !this.activeCompletionRequestId) {
      return;
    }

    this.stoppingRequestId = this.activeCompletionRequestId;
    await this.context.stopCompletion();
  }

  async releaseContext(): Promise<void> {
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.activeCompletionRequestId = null;
    this.stoppingRequestId = null;
    this.lastCompletionText = '';

    if (this.context) {
      if (this.multimodalInitialized) {
        if (typeof this.context.releaseMultimodal === 'function') {
          await this.context.releaseMultimodal().catch(() => undefined);
        }
        this.multimodalInitialized = false;
      }
      await this.context.release().catch(() => undefined);
      this.context = null;
    }

    if (typeof releaseAllLlama === 'function') {
      await releaseAllLlama().catch(() => undefined);
    }
    this.initializedModelPath = null;
    this.initializedModelFileSizeBytes = 0;
    this.configuredContextTokens = 0;

    this.lastRuntimeInfo = this.lastRuntimeInfo
      ? {
          ...this.lastRuntimeInfo,
          isModelLoaded: false,
          loadedModelPath: null,
        }
      : null;
  }

  getContextTokens(): number {
    return this.configuredContextTokens;
  }

  isMultimodalReady(): boolean {
    return this.multimodalInitialized;
  }

  async getRuntimeInfo(): Promise<LocalRuntimeInfo> {
    const contextTokens = this.configuredContextTokens || QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS;
    return this.lastRuntimeInfo ?? {
      backend: 'llama.rn-cpu',
      version: null,
      supportsStreaming: true,
      maxContextTokens: contextTokens,
      configuredContextTokens: contextTokens,
      configuredCpuThreads: resolveRecommendedCpuThreads(),
      configuredGpuLayers: 0,
      configuredBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
      configuredUseFlashAttention: QWEN_MODEL_DEFAULT_USE_FLASH_ATTENTION,
      configuredUseMlock: false,
      resolvedThreads: resolveRecommendedCpuThreads(),
      likelyCpuOnlyRuntime: true,
      isModelLoaded: Boolean(this.context),
      loadedModelPath: this.initializedModelPath,
      loadedModelFamily: 'qwen',
      loadedModelQuantization: null,
    };
  }
}

const llamaRnAdapter = new LlamaRnAdapter();

export function getLlamaRnAdapter() {
  return llamaRnAdapter;
}
