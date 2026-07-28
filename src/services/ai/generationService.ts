import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';

import type { LocalAiMode } from './agent';
import { buildPromptForMode, buildRetrievedContext, buildExternalMessagesForMode } from './agent';
import {
  QWEN_MODEL_DEFAULT_TEMPERATURE,
  QWEN_MODEL_DEFAULT_TOP_P,
  QWEN_MODEL_FILE_NAME,
  QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS,
  QWEN_MODEL_MAX_OUTPUT_TOKENS,
  QWEN_MODEL_GROUNDED_TEMPERATURE,
  QWEN_MODEL_GROUNDED_TOP_P,
  QWEN_MODEL_STOP_TOKENS,
} from './config';
import { getLlamaRnAdapter } from './llamaRnAdapter';
import { useAIStore, getAIRuntimeAvailability } from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  LocalInferenceException,
  getErrorMessage,
  type LocalInferenceError,
  type LocalRuntimeInfo,
} from './localInferenceTypes';

type FileInfoResult = {
  exists: boolean;
  size?: number;
  uri?: string;
};

type FileSystemLegacyModule = typeof ExpoFileSystemLegacy & {
  getInfoAsync?: (path: string, options?: { size?: boolean }) => Promise<FileInfoResult>;
};

const FileSystemModule = ExpoFileSystemLegacy as FileSystemLegacyModule;
const STREAMING_UPDATE_INTERVAL_MS = 80;
const STREAMING_UPDATE_MIN_CHAR_DELTA = 12;
const LATENCY_TRACE_ENABLED = typeof __DEV__ !== 'undefined' && __DEV__;

export type GenerationServiceSubscription = {
  unsubscribe: () => void;
};

export type GenerationServiceRuntimeSnapshot = {
  isPreparingRuntime: boolean;
  runtimeStatus: string;
  isGenerating: boolean;
  generationStatus: string;
};

export type GenerationServiceListener = (snapshot: GenerationServiceRuntimeSnapshot) => void;

export type StartGenerationParams = {
  prompt: string;
  mode: LocalAiMode;
};

export type PreparePromptParams = {
  userPrompt: string;
  mode: LocalAiMode;
};

function createSnapshot(state: GenerationService['state']): GenerationServiceRuntimeSnapshot {
  return {
    isPreparingRuntime: state.isPreparingRuntime,
    runtimeStatus: state.runtimeStatus,
    isGenerating: state.isGenerating,
    generationStatus: state.generationStatus,
  };
}

function getConfiguredModelPath() {
  const provisioningPath = useAIStore.getState().provisioning.modelPath;
  return provisioningPath ?? `file:///data/user/0/com.LCSdev.silo/files/ai/models/${QWEN_MODEL_FILE_NAME}`;
}

const STREAM_SANITIZER_TOKENS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|assistant|>',
  '<|user|>',
  '<think>',
  '</think>',
] as const;

function removeGeneratedControlTokens(value: string) {
  let text = value.replace(/\u0000/g, '');
  STREAM_SANITIZER_TOKENS.forEach((token) => {
    if (token !== '<think>' && token !== '</think>') {
      text = text.split(token).join('');
    }
  });
  text = text.replace(/<\|im_start\|>[a-z0-9_-]*/gi, '');
  text = text.replace(/<\|[a-z0-9_-]+\|>/gi, '');
  return text;
}

function stripThinkingBlocks(value: string): string {
  let cleaned = value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (cleaned.toLowerCase().includes('<think>')) {
    cleaned = cleaned.replace(/<think>[\s\S]*$/i, '').trim();
  }
  return cleaned;
}

function getControlTokenPrefixRemainder(value: string) {
  let remainder = '';
  STREAM_SANITIZER_TOKENS.forEach((token) => {
    const maxLength = Math.min(token.length - 1, value.length);
    for (let length = 1; length <= maxLength; length += 1) {
      const suffix = value.slice(-length);
      if (token.startsWith(suffix) && suffix.length > remainder.length) {
        remainder = suffix;
      }
    }
  });

  return remainder;
}

function sanitizeGeneratedText(value: string) {
  const withoutControlTokens = removeGeneratedControlTokens(value);
  return stripThinkingBlocks(withoutControlTokens);
}

function sanitizeStreamingGeneratedText(
  _previousRawText: string,
  nextRawText: string,
  _previousCleanText: string,
  _pendingRemainder: string,
) {
  const nextRemainder = getControlTokenPrefixRemainder(nextRawText);
  const safeText = nextRemainder ? nextRawText.slice(0, -nextRemainder.length) : nextRawText;
  return {
    cleanText: sanitizeGeneratedText(safeText),
    pendingRemainder: nextRemainder,
  };
}

function isLlamaRnBackend(runtimeInfo: LocalRuntimeInfo | null | undefined) {
  return runtimeInfo?.backend === 'llama.rn-cpu';
}

async function getConfiguredModelInfo() {
  const configuredModelPath = getConfiguredModelPath();
  const fileInfo = FileSystemModule.getInfoAsync
    ? await FileSystemModule.getInfoAsync(configuredModelPath, { size: true })
    : { exists: false, uri: configuredModelPath };

  return {
    configuredModelPath,
    exists: Boolean(fileInfo.exists),
    modelFileSizeBytes: fileInfo.size ?? 0,
    fileUri: fileInfo.uri ?? configuredModelPath,
  };
}

function traceLatency(event: string, details: Record<string, unknown>) {
  if (!LATENCY_TRACE_ENABLED) {
    return;
  }

  useAIStore.getState().appendLog({
    level: 'info',
    event,
    message: 'Local llama.rn latency checkpoint.',
    details,
  });
}

function normalizeRuntimeError(error: unknown): LocalInferenceError {
  if (error instanceof LocalInferenceException) {
    return error;
  }

  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const typedError = error as LocalInferenceError;
    return new LocalInferenceException(
      typedError.code ?? 'unknown',
      typedError.message,
      typedError.details,
      typedError.recoverable ?? true,
    );
  }

  if (error instanceof Error) {
    return new LocalInferenceException('generation-failed', error.message, undefined, true);
  }

  return new LocalInferenceException('unknown', getErrorMessage(error, 'Unknown local inference runtime failure.'), undefined, true);
}

class GenerationService {
  private state = {
    isPreparingRuntime: false,
    runtimeStatus: '',
    isGenerating: false,
    generationStatus: '',
  };

  private readonly listeners = new Set<GenerationServiceListener>();
  private runtimeInitPromise: Promise<void> | null = null;
  private completionStopPromise: Promise<void> | null = null;
  private activeExternalXhr: XMLHttpRequest | null = null;
  private readonly llamaRnAdapter = getLlamaRnAdapter();

  private applyLlamaRuntimeLoading(runtimeInfo?: LocalRuntimeInfo | null) {
    const state = useAIStore.getState();
    state.setRuntimeInfo(runtimeInfo ?? state.runtime.runtimeInfo);
    state.setRuntimeModelLoaded(Boolean(runtimeInfo?.isModelLoaded), runtimeInfo ?? state.runtime.runtimeInfo);
    state.setRuntimeHealth(false, null);
    state.markRuntimeReady(false);
    state.setRuntimeState(runtimeInfo?.isModelLoaded ? 'loaded' : 'loading');
    state.setRuntimeError(null);
  }

  subscribe(listener: GenerationServiceListener): GenerationServiceSubscription {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  getSnapshot(): GenerationServiceRuntimeSnapshot {
    return createSnapshot(this.state);
  }

  async ensureChatRuntimeReady(): Promise<void> {
    if (this.runtimeInitPromise) {
      return this.runtimeInitPromise;
    }

    this.runtimeInitPromise = (async () => {
      this.setState({
        isPreparingRuntime: true,
        runtimeStatus: 'Opening local chatbot...',
      });

      try {
        const modelInfo = await getConfiguredModelInfo();
        this.setState({
          runtimeStatus: modelInfo.exists ? 'Loading local model into llama.rn...' : 'Checking local model installation...',
        });

        this.applyLlamaRuntimeLoading(await this.llamaRnAdapter.getRuntimeInfo());
        await this.llamaRnAdapter.initContext({
          modelPath: modelInfo.configuredModelPath,
          modelFileSizeBytes: modelInfo.modelFileSizeBytes,
        });

        const runtimeInfo = await this.llamaRnAdapter.getRuntimeInfo();
        this.applyLlamaRuntimeReady(runtimeInfo, modelInfo.configuredModelPath);
      } finally {
        this.runtimeInitPromise = null;
        this.setState({
          isPreparingRuntime: false,
          runtimeStatus: '',
        });
      }
    })();

    return this.runtimeInitPromise;
  }



  async startGeneration({ prompt, mode }: StartGenerationParams): Promise<string> {
    const settings = useSettingsStore.getState();
    if (settings.aiInferenceMode === 'external') {
      return this.startExternalGeneration({ prompt, mode });
    }

    const state = useAIStore.getState();
    const availability = getAIRuntimeAvailability(state);

    if (!availability.hasUsableLocalInferenceBackend && settings.externalApiUrl && settings.externalApiModel) {
      console.log('Local backend unavailable (e.g. low memory or crash), failing over to external API...');
      return this.startExternalGeneration({ prompt, mode });
    }

    const requestStartedAtMs = Date.now();
    this.setState({
      isGenerating: true,
      generationStatus: mode === 'rag' ? 'Retrieving grounded local context...' : 'Checking local inference runtime...',
    });

    await this.ensureChatRuntimeReady();
    const runtimeReadyAtMs = Date.now();

    const store = useAIStore.getState();
    const requestId = `llama-rn-${runtimeReadyAtMs}`;
    const runtimeInfo = await this.llamaRnAdapter.getRuntimeInfo();

    store.setActiveGenerationRequestId(requestId);
    store.setStreamingResponseText('');
    store.setActiveStatusLabel(mode === 'rag' ? 'Retrieving grounded local context...' : 'Running local inference...');
    store.setRuntimeError(null);
    store.setRuntimeInfo(runtimeInfo);
    store.setRuntimeModelLoaded(Boolean(runtimeInfo.isModelLoaded), runtimeInfo);
    store.setRuntimeState('busy');

    let lastStreamUpdateAtMs = 0;
    let lastRawStreamText = '';
    let lastStreamedText = '';
    let pendingStreamingSanitizerRemainder = '';
    let firstTokenAtMs: number | null = null;
    let generationStatusPublished = false;

    try {
      const promptStartedAtMs = Date.now();
      const preparedPrompt = await this.preparePrompt({ userPrompt: prompt, mode });
      const promptPreparedAtMs = Date.now();

      traceLatency('llama-rn-generation-start', {
        requestId,
        mode,
        runtimeWaitMs: runtimeReadyAtMs - requestStartedAtMs,
        promptPrepMs: promptPreparedAtMs - promptStartedAtMs,
        promptChars: preparedPrompt.length,
        modelLoaded: runtimeInfo.isModelLoaded ?? null,
      });

      const result = await this.llamaRnAdapter.completion(requestId, {
        prompt: preparedPrompt,
        maxTokens: mode === 'rag' ? QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS : QWEN_MODEL_MAX_OUTPUT_TOKENS,
        temperature: mode === 'rag' ? QWEN_MODEL_GROUNDED_TEMPERATURE : QWEN_MODEL_DEFAULT_TEMPERATURE,
        topP: mode === 'rag' ? QWEN_MODEL_GROUNDED_TOP_P : QWEN_MODEL_DEFAULT_TOP_P,
        stop: [...QWEN_MODEL_STOP_TOKENS],
        onToken: (text) => {
          const now = Date.now();
          const latestState = useAIStore.getState();
          if (latestState.runtime.activeGenerationRequestId !== requestId) {
            return;
          }

          if (firstTokenAtMs === null) {
            firstTokenAtMs = now;
            traceLatency('llama-rn-first-token', {
              requestId,
              firstTokenMs: now - promptPreparedAtMs,
              totalElapsedMs: now - requestStartedAtMs,
            });
          }

          const shouldPublish = now - lastStreamUpdateAtMs >= STREAMING_UPDATE_INTERVAL_MS
            || text.length - lastRawStreamText.length >= STREAMING_UPDATE_MIN_CHAR_DELTA;
          if (!shouldPublish) {
            return;
          }

          const streamUpdate = sanitizeStreamingGeneratedText(
            lastRawStreamText,
            text,
            lastStreamedText,
            pendingStreamingSanitizerRemainder,
          );
          if (streamUpdate.cleanText === lastStreamedText && streamUpdate.pendingRemainder === pendingStreamingSanitizerRemainder) {
            lastRawStreamText = text;
            return;
          }

          latestState.setStreamingResponseText(streamUpdate.cleanText);
          lastStreamUpdateAtMs = now;
          lastRawStreamText = text;
          lastStreamedText = streamUpdate.cleanText;
          pendingStreamingSanitizerRemainder = streamUpdate.pendingRemainder;

          if (!generationStatusPublished) {
            latestState.setActiveStatusLabel('Generating response locally...');
            this.setState({ generationStatus: 'Generating response locally...' });
            generationStatusPublished = true;
          }
        },
      });

      const latestRuntimeInfo = await this.llamaRnAdapter.getRuntimeInfo();
      const cleanedText = sanitizeGeneratedText(result.text);
      store.setRuntimeInfo(latestRuntimeInfo);
      store.setRuntimeModelLoaded(Boolean(latestRuntimeInfo.isModelLoaded), latestRuntimeInfo);
      store.setRuntimeHealth(result.stopReason !== 'error');
      store.markRuntimeReady(result.stopReason !== 'error');
      store.setRuntimeState(result.stopReason === 'error' ? 'failed' : 'healthy');
      store.setStreamingResponseText(cleanedText);
      store.setActiveStatusLabel(result.stopReason === 'cancelled' ? 'Cancelled' : 'Response ready', null);
      traceLatency('llama-rn-generation-complete', {
        requestId,
        mode,
        totalElapsedMs: Date.now() - requestStartedAtMs,
        runtimeWaitMs: runtimeReadyAtMs - requestStartedAtMs,
        promptPrepMs: promptPreparedAtMs - promptStartedAtMs,
        firstTokenMs: result.firstTokenDurationMs ?? (firstTokenAtMs === null ? null : firstTokenAtMs - promptPreparedAtMs),
        promptEvalDurationMs: result.promptEvalDurationMs ?? null,
        generationEvalDurationMs: result.generationEvalDurationMs ?? null,
        nativeTotalDurationMs: result.totalDurationMs ?? null,
        tokensPerSecond: result.tokensPerSecond ?? null,
        promptTokens: result.promptTokens ?? null,
        completionTokens: result.completionTokens ?? null,
        stopReason: result.stopReason ?? null,
      });
      return cleanedText.trim();
    } catch (error) {
      const runtimeError = normalizeRuntimeError(error);
      if (runtimeError.code === 'generation-cancelled') {
        const latestState = useAIStore.getState();
        latestState.setActiveStatusLabel('Cancelled', null);
        latestState.setRuntimeError({
          code: 'generation-cancelled',
          message: runtimeError.message,
          recoverable: true,
        });
      } else {
        store.setRuntimeError(runtimeError);
      }
      throw error;
    } finally {
      const latestState = useAIStore.getState();
      if (latestState.runtime.activeGenerationRequestId === requestId) {
        latestState.setActiveGenerationRequestId(null);
      }
      if (this.completionStopPromise) {
        await this.completionStopPromise.catch(() => undefined);
        this.completionStopPromise = null;
      }
      latestState.setActiveStatusLabel(null, null);
      this.setState({
        isGenerating: false,
        generationStatus: '',
      });
    }
  }

  private async startExternalGeneration({ prompt, mode }: StartGenerationParams): Promise<string> {
    const requestStartedAtMs = Date.now();
    this.setState({
      isGenerating: true,
      generationStatus: mode === 'rag' ? 'Retrieving grounded local context...' : 'Connecting to external API...',
    });

    const store = useAIStore.getState();
    const settings = useSettingsStore.getState();
    const requestId = `ext-api-${requestStartedAtMs}`;
    const url = settings.externalApiUrl.trim().replace(/\/$/, '');
    const model = settings.externalApiModel.trim() || 'gpt-4o-mini';
    const apiKey = settings.externalApiKey.trim();

    store.setActiveGenerationRequestId(requestId);
    store.setStreamingResponseText('');
    store.setActiveStatusLabel(mode === 'rag' ? 'Retrieving grounded local context...' : `Running inference via ${model}...`);
    store.setRuntimeError(null);
    store.setRuntimeState('busy');

    const retrievedContext = mode === 'rag' ? buildRetrievedContext(prompt) : undefined;
    const messages = buildExternalMessagesForMode(prompt, mode, store, retrievedContext);

    let lastStreamUpdateAtMs = 0;
    let lastRawStreamText = '';
    let lastStreamedText = '';
    let pendingStreamingSanitizerRemainder = '';
    let generationStatusPublished = false;
    let fullContent = '';
    let processedLineCount = 0;

    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.activeExternalXhr = xhr;
      const endpoint = `${url}/chat/completions`;

      xhr.open('POST', endpoint, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (apiKey) {
        xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
      }

      if (settings.externalApiCustomHeaders) {
        try {
          const customHeaders = JSON.parse(settings.externalApiCustomHeaders);
          if (typeof customHeaders === 'object' && customHeaders !== null) {
            Object.entries(customHeaders).forEach(([headerKey, headerVal]) => {
              xhr.setRequestHeader(headerKey, String(headerVal));
            });
          }
        } catch (e) {
          console.warn('Failed to parse externalApiCustomHeaders', e);
        }
      }

      xhr.onprogress = () => {
        if (store.runtime.activeGenerationRequestId !== requestId) {
          xhr.abort();
          return;
        }

        const lines = (xhr.responseText || '').split('\n');
        const completeLinesCount = lines.length - 1;

        while (processedLineCount < completeLinesCount) {
          const line = lines[processedLineCount].trim();
          processedLineCount += 1;

          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const json = JSON.parse(line.slice(6));
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContent += delta;
                const now = Date.now();
                const shouldPublish =
                  now - lastStreamUpdateAtMs >= STREAMING_UPDATE_INTERVAL_MS ||
                  fullContent.length - lastRawStreamText.length >= STREAMING_UPDATE_MIN_CHAR_DELTA;
                if (shouldPublish) {
                  const streamUpdate = sanitizeStreamingGeneratedText(
                    lastRawStreamText,
                    fullContent,
                    lastStreamedText,
                    pendingStreamingSanitizerRemainder,
                  );
                  store.setStreamingResponseText(streamUpdate.cleanText);
                  lastStreamUpdateAtMs = now;
                  lastRawStreamText = fullContent;
                  lastStreamedText = streamUpdate.cleanText;
                  pendingStreamingSanitizerRemainder = streamUpdate.pendingRemainder;

                  if (!generationStatusPublished) {
                    store.setActiveStatusLabel(`Generating response via ${model}...`);
                    this.setState({ generationStatus: `Generating response via ${model}...` });
                    generationStatusPublished = true;
                  }
                }
              }
            } catch {
              // ignore malformed JSON chunk
            }
          }
        }
      };

      xhr.onload = () => {
        this.activeExternalXhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          const lines = (xhr.responseText || '').split('\n');
          while (processedLineCount < lines.length) {
            const line = lines[processedLineCount].trim();
            processedLineCount += 1;
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices?.[0]?.delta?.content || '';
                if (delta) fullContent += delta;
              } catch {
                // ignore
              }
            }
          }

          if (!fullContent && xhr.responseText) {
            try {
              const json = JSON.parse(xhr.responseText);
              fullContent = json.choices?.[0]?.message?.content || fullContent;
            } catch {
              // ignore
            }
          }

          const cleanedText = sanitizeGeneratedText(fullContent);
          store.setRuntimeState('healthy');
          store.setStreamingResponseText(cleanedText);
          store.setActiveStatusLabel('Response ready', null);
          this.setState({ isGenerating: false, generationStatus: '' });
          if (store.runtime.activeGenerationRequestId === requestId) {
            store.setActiveGenerationRequestId(null);
          }
          resolve(cleanedText.trim());
        } else {
          let errorMsg = `External API error (${xhr.status})`;
          try {
            const errJson = JSON.parse(xhr.responseText);
            errorMsg = errJson.error?.message || errJson.message || errorMsg;
          } catch {
            // ignore
          }
          const error = new LocalInferenceException('external-api-error', errorMsg, { status: xhr.status }, true);
          store.setRuntimeError(error);
          store.setRuntimeState('failed');
          store.setActiveStatusLabel(null, null);
          this.setState({ isGenerating: false, generationStatus: '' });
          if (store.runtime.activeGenerationRequestId === requestId) {
            store.setActiveGenerationRequestId(null);
          }
          reject(error);
        }
      };

      xhr.onerror = () => {
        this.activeExternalXhr = null;
        const error = new LocalInferenceException('external-api-error', 'Network error connecting to external API.', undefined, true);
        store.setRuntimeError(error);
        store.setRuntimeState('failed');
        store.setActiveStatusLabel(null, null);
        this.setState({ isGenerating: false, generationStatus: '' });
        if (store.runtime.activeGenerationRequestId === requestId) {
          store.setActiveGenerationRequestId(null);
        }
        reject(error);
      };

      xhr.onabort = () => {
        this.activeExternalXhr = null;
        const error = new LocalInferenceException('generation-cancelled', 'Generation cancelled by user.', undefined, true);
        store.setActiveStatusLabel('Cancelled', null);
        store.setRuntimeError(error);
        this.setState({ isGenerating: false, generationStatus: '' });
        if (store.runtime.activeGenerationRequestId === requestId) {
          store.setActiveGenerationRequestId(null);
        }
        reject(error);
      };

      xhr.send(
        JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: mode === 'rag' ? QWEN_MODEL_GROUNDED_TEMPERATURE : QWEN_MODEL_DEFAULT_TEMPERATURE,
          top_p: mode === 'rag' ? QWEN_MODEL_GROUNDED_TOP_P : QWEN_MODEL_DEFAULT_TOP_P,
        }),
      );
    });
  }

  private async preparePrompt({ userPrompt, mode }: PreparePromptParams): Promise<string> {
    const adapterRuntimeInfo = await this.llamaRnAdapter.getRuntimeInfo();
    const state = useAIStore.getState();
    const previousRuntimeInfo = state.runtime.runtimeInfo;

    state.setRuntimeInfo({
      ...adapterRuntimeInfo,
      backend: 'llama.rn-cpu',
      loadedModelFamily: adapterRuntimeInfo.loadedModelFamily ?? 'qwen',
      isModelLoaded: true,
    });

    try {
      const retrievedContext = mode === 'rag' ? buildRetrievedContext(userPrompt) : undefined;
      return buildPromptForMode(userPrompt, mode, useAIStore.getState(), retrievedContext);
    } finally {
      if (!isLlamaRnBackend(previousRuntimeInfo)) {
        state.setRuntimeInfo(previousRuntimeInfo);
      }
    }
  }

  async cancelGeneration(reason = 'Generation cancelled by user.'): Promise<boolean> {
    const state = useAIStore.getState();
    const requestId = state.runtime.activeGenerationRequestId;
    if (!requestId) {
      return false;
    }

    if (this.activeExternalXhr) {
      this.activeExternalXhr.abort();
      this.activeExternalXhr = null;
      state.setActiveStatusLabel('Cancelled', null);
      state.setRuntimeError({
        code: 'generation-cancelled',
        message: reason,
        recoverable: true,
      });
      this.setState({ isGenerating: false, generationStatus: '' });
      if (state.runtime.activeGenerationRequestId === requestId) {
        state.setActiveGenerationRequestId(null);
      }
      return true;
    }

    state.appendLog({
      level: 'warn',
      event: 'generation-cancel-requested',
      message: reason,
      details: { requestId, backend: 'llama.rn-cpu' },
    });

    this.completionStopPromise = this.llamaRnAdapter.stopCompletion();
    await this.completionStopPromise;
    const latestState = useAIStore.getState();
    latestState.setActiveStatusLabel('Cancelling local generation...');
    latestState.setRuntimeError({
      code: 'generation-cancelled',
      message: reason,
      recoverable: true,
    });
    return true;
  }

  async dispose(): Promise<void> {
    this.runtimeInitPromise = null;
    if (this.activeExternalXhr) {
      this.activeExternalXhr.abort();
      this.activeExternalXhr = null;
    }
    if (this.completionStopPromise) {
      await this.completionStopPromise.catch(() => undefined);
      this.completionStopPromise = null;
    }
    await this.llamaRnAdapter.dispose();
    const state = useAIStore.getState();
    state.markRuntimeReady(false);
    state.setRuntimeHealth(false, null);
    state.setRuntimeModelLoaded(false, null);
    state.setRuntimeInfo(null);
    state.setRuntimeState(state.runtime.availability.available ? 'model-unloaded' : 'unavailable');
  }

  private applyLlamaRuntimeReady(runtimeInfo: LocalRuntimeInfo, modelPath: string) {
    const state = useAIStore.getState();
    state.setRuntimeInfo(runtimeInfo);
    state.setRuntimeModelLoaded(Boolean(runtimeInfo.isModelLoaded), {
      ...runtimeInfo,
      loadedModelPath: runtimeInfo.loadedModelPath ?? modelPath,
      isModelLoaded: Boolean(runtimeInfo.isModelLoaded),
    });
    state.setRuntimeHealth(true);
    state.markRuntimeReady(true);
    state.setRuntimeState('healthy');
    state.replaceProvisioning({
      status: 'ready',
      modelPath,
      tempPath: null,
      pausedReason: null,
      lastError: null,
      canResume: false,
      progress: 1,
    });
  }

  private setState(patch: Partial<GenerationService['state']>) {
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

const generationService = new GenerationService();

export function getGenerationService() {
  return generationService;
}
