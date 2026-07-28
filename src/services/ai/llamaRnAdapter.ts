import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';
import { initLlama, releaseAllLlama, type LlamaContext } from 'llama.rn';

import {
  QWEN_MODEL_DEFAULT_BATCH_TOKENS,
  QWEN_MODEL_DEFAULT_CPU_THREADS,
  QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
  QWEN_MODEL_STOP_TOKENS,
  QWEN_MODEL_WARMUP_PROMPT,
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
  resolveRecommendedCpuThreads,
} from './hardware';

export type LlamaRnCompletionParams = {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  onToken?: (text: string) => void;
  onFirstToken?: (durationMs: number) => void;
};

export type LlamaRnInitParams = {
  modelPath: string;
  modelFileSizeBytes: number;
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
const LLAMA_RN_WARMUP_TIMEOUT_MS = 8_000;

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

class LlamaRnAdapter {
  private context: LlamaContext | null = null;
  private initializedModelPath: string | null = null;
  private initializedModelFileSizeBytes = 0;
  private initPromise: Promise<void> | null = null;
  private activeCompletionRequestId: string | null = null;
  private stoppingRequestId: string | null = null;
  private lastCompletionText = '';
  private lastRuntimeInfo: LocalRuntimeInfo | null = null;

  async initContext({ modelPath, modelFileSizeBytes }: LlamaRnInitParams): Promise<void> {
    const normalizedModelPath = normalizeModelPath(modelPath);
    if (this.context && this.initializedModelPath === normalizedModelPath) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
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

      const resolvedCpuThreads = resolveRecommendedCpuThreads(totalMemoryBytes);
      const requestedGpuLayers = getGpuLayersForDevice(totalMemoryBytes);
      let resolvedGpuLayers = requestedGpuLayers;
      let gpuAttemptFailed = false;

      const baseInitParams = {
        model: normalizedModelPath,
        use_progress_callback: false,
        n_ctx: QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
        n_batch: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        n_threads: resolvedCpuThreads,
        use_mlock: false,
        use_mmap: true,
        flash_attn_type: 'off' as const,
      };

      let context: LlamaContext;
      try {
        context = await initLlama({
          ...baseInitParams,
          n_gpu_layers: requestedGpuLayers,
        });
      } catch (error) {
        if (requestedGpuLayers <= 0) {
          throw error;
        }

        gpuAttemptFailed = true;
        resolvedGpuLayers = 0;
        logLlamaRuntimeWarning('gpu-init-fallback', {
          requestedGpuLayers,
          resolvedCpuThreads,
          message: error instanceof Error ? error.message : String(error),
        });
        context = await initLlama({
          ...baseInitParams,
          n_gpu_layers: 0,
        });
      }

      this.context = context;
      this.initializedModelPath = normalizedModelPath;
      this.initializedModelFileSizeBytes = resolvedModelFileSizeBytes;
      this.lastRuntimeInfo = {
        backend: resolvedGpuLayers > 0 ? 'llama.rn' : 'llama.rn-cpu',
        version: null,
        supportsStreaming: true,
        maxContextTokens: QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
        loadedModelPath: normalizedModelPath,
        loadedModelFamily: 'qwen',
        loadedModelQuantization: null,
        isModelLoaded: true,
        abi: null,
        configuredContextTokens: QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
        configuredCpuThreads: resolvedCpuThreads,
        configuredGpuLayers: resolvedGpuLayers,
        configuredBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        configuredUseFlashAttention: false,
        configuredUseMlock: false,
        resolvedContextTokens: QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
        resolvedBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
        resolvedThreads: resolvedCpuThreads,
        estimatedGpuOffloadRequested: requestedGpuLayers > 0,
        gpuOffloadSupportedByBuild: resolvedGpuLayers > 0,
        detectedBackendSummary: resolvedGpuLayers > 0
          ? `llama.rn with ${resolvedGpuLayers} requested GPU layers and ${resolvedCpuThreads} CPU threads`
          : `llama.rn CPU fallback with ${resolvedCpuThreads} CPU threads${gpuAttemptFailed ? ' after GPU init fallback' : ''}`,
        likelyCpuOnlyRuntime: resolvedGpuLayers <= 0,
      };

      await this.runWarmup(context, resolvedCpuThreads);
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async runWarmup(context: LlamaContext, resolvedCpuThreads: number): Promise<void> {
    const startedAtMs = Date.now();
    try {
      await withTimeout(
        context.completion({
          prompt: QWEN_MODEL_WARMUP_PROMPT,
          stop: [...QWEN_MODEL_STOP_TOKENS],
          n_predict: 1,
          temperature: 0,
          top_p: 0.1,
        }),
        LLAMA_RN_WARMUP_TIMEOUT_MS,
        'llama.rn warmup',
      );

      this.lastRuntimeInfo = this.lastRuntimeInfo
        ? {
            ...this.lastRuntimeInfo,
            lastTotalDurationMs: Date.now() - startedAtMs,
            lastStopReason: 'warmup-complete',
            resolvedThreads: resolvedCpuThreads,
          }
        : this.lastRuntimeInfo;
    } catch (error) {
      await context.stopCompletion().catch(() => undefined);
      logLlamaRuntimeWarning('warmup-skipped', {
        durationMs: Date.now() - startedAtMs,
        resolvedCpuThreads,
        message: error instanceof Error ? error.message : String(error),
      });
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

    this.activeCompletionRequestId = requestId;
    this.stoppingRequestId = null;
    this.lastCompletionText = '';

    try {
      const completionStartedAtMs = Date.now();
      let firstTokenDurationMs: number | undefined;
      const result = await this.context.completion(
        {
          prompt: params.prompt,
          stop: params.stop ?? [...QWEN_MODEL_STOP_TOKENS],
          n_predict: params.maxTokens,
          temperature: params.temperature,
          top_p: params.topP,
        },
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
      await this.context.release().catch(() => undefined);
      this.context = null;
    }

    await releaseAllLlama().catch(() => undefined);
    this.initializedModelPath = null;
    this.initializedModelFileSizeBytes = 0;

    this.lastRuntimeInfo = this.lastRuntimeInfo
      ? {
          ...this.lastRuntimeInfo,
          isModelLoaded: false,
          loadedModelPath: null,
        }
      : null;
  }

  async getRuntimeInfo(): Promise<LocalRuntimeInfo> {
    return this.lastRuntimeInfo ?? {
      backend: 'llama.rn-cpu',
      version: null,
      supportsStreaming: true,
      maxContextTokens: QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
      configuredContextTokens: QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
      configuredCpuThreads: resolveRecommendedCpuThreads(0, QWEN_MODEL_DEFAULT_CPU_THREADS),
      configuredGpuLayers: 0,
      configuredBatchTokens: QWEN_MODEL_DEFAULT_BATCH_TOKENS,
      configuredUseFlashAttention: false,
      configuredUseMlock: false,
      resolvedThreads: resolveRecommendedCpuThreads(0, QWEN_MODEL_DEFAULT_CPU_THREADS),
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
