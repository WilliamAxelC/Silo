import * as ExpoFileSystemLegacy from 'expo-file-system/legacy';

import type { ExternalChatMessage, LocalAiMode } from './agent';
import {
  buildLocalMessagesForMode,
  buildPromptForMode,
  buildRetrievedContext,
  buildGuardRetryMessages,
  checkLocalChatReply,
  GUARD_RETRY_TEMPERATURE,
  buildExternalMessagesForMode,
} from './agent';
import {
  QWEN_MODEL_DEFAULT_TEMPERATURE,
  QWEN_MODEL_DEFAULT_TOP_P,
  QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS,
  QWEN_MODEL_MAX_OUTPUT_TOKENS,
  QWEN_MODEL_GROUNDED_TEMPERATURE,
  QWEN_MODEL_GROUNDED_TOP_P,
  QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS,
  QWEN_MODEL_STOP_TOKENS,
} from './config';
import { getLlamaRnAdapter } from './llamaRnAdapter';
import {
  getActiveModelFileUri,
  getModelLifecycleManager,
  isActiveModelInstalled,
  isVisionProjectorInstalled,
} from './modelLifecycle';
import { useAIStore, getAIRuntimeAvailability } from '../../store/useAIStore';
import {
  isSecretsHydrationPending,
  isSettingsLoadPending,
  retrySecretsHydrationIfNeeded,
  useSettingsStore,
  waitForSecretsHydrated,
  waitForSettingsLoaded,
} from '../../store/useSettingsStore';
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
  readAsStringAsync?: (path: string, options?: { encoding?: 'base64' | 'utf8' }) => Promise<string>;
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
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  bypassChatTemplate?: boolean;
  systemPrompt?: string;
  jsonSchema?: object;
  disableThinking?: boolean;
  imageUri?: string;
};

export async function isVisionAvailable(): Promise<boolean> {
  if (isSettingsLoadPending()) {
    await waitForSettingsLoaded();
  }
  let settings = useSettingsStore.getState();
  if (settings.aiInferenceMode === 'external') {
    if (isSecretsHydrationPending()) {
      await waitForSecretsHydrated();
    } else if (settings.secretsHydrationError) {
      await retrySecretsHydrationIfNeeded();
    }
    return isExternalAccessConfigured(useSettingsStore.getState());
  }

  try {
    await getModelLifecycleManager?.()?.ensureInitialized?.();
    const localInstalled = (await isActiveModelInstalled()) && (await isVisionProjectorInstalled());
    if (localInstalled) {
      return true;
    }
  } catch {
    // Fall through to external vision availability check.
  }

  if (isSecretsHydrationPending()) {
    await waitForSecretsHydrated();
  } else if (useSettingsStore.getState().secretsHydrationError) {
    await retrySecretsHydrationIfNeeded();
  }
  settings = useSettingsStore.getState();
  return isExternalAccessConfigured(settings);
}


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
  return provisioningPath || getActiveModelFileUri();
}

function normalizeModelPath(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function parseExternalUrlParts(rawUrl: string): { protocol: string; hostname: string } | null {
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/^(https?):\/\/([^/?#]+)/i);
  if (!match) {
    return null;
  }
  const protocol = match[1].toLowerCase();
  const authority = match[2];
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  let hostname: string;
  if (hostPort.startsWith('[')) {
    const endBracket = hostPort.indexOf(']');
    hostname = endBracket > 0 ? hostPort.slice(1, endBracket) : hostPort;
  } else {
    hostname = hostPort.split(':')[0];
  }
  return { protocol, hostname: hostname.toLowerCase() };
}

function isLoopbackOrPrivateLanHost(hostname: string): boolean {
  if (!hostname) {
    return false;
  }
  if (hostname === 'localhost' || hostname === '::1') {
    return true;
  }
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) {
    return false;
  }
  const octets = ipv4Match.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function isExternalAccessConfigured(settings: {
  externalApiUrl?: string;
  externalApiModel?: string;
  externalApiKey?: string;
}): boolean {
  const url = (settings.externalApiUrl ?? '').trim();
  const model = (settings.externalApiModel ?? '').trim();
  if (!url || !model) {
    return false;
  }
  if ((settings.externalApiKey ?? '').trim().length > 0) {
    return true;
  }
  const parsed = parseExternalUrlParts(url);
  return Boolean(parsed && isLoopbackOrPrivateLanHost(parsed.hostname));
}

function stripChatMlToMessages(rawPrompt: string): ExternalChatMessage[] {
  const messages: ExternalChatMessage[] = [];
  const blockRegex = /<\|im_start\|>(system|user|assistant)\s*([\s\S]*?)(?=<\|im_start\|>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(rawPrompt)) !== null) {
    const role = match[1].toLowerCase() as ExternalChatMessage['role'];
    const rawBody = match[2];
    const hasEndTag = rawBody.includes('<|im_end|>');
    const content = rawBody.replace(/<\|im_end\|>/g, '').replace(/<\|endoftext\|>/g, '').trim();
    if (!content) {
      continue;
    }
    if (role === 'assistant' && !hasEndTag) {
      continue;
    }
    messages.push({ role, content });
  }
  if (messages.length === 0) {
    const stripped = rawPrompt
      .replace(/<\|im_start\|>(?:system|user|assistant)?/gi, '')
      .replace(/<\|im_end\|>/g, '')
      .replace(/<\|endoftext\|>/g, '')
      .trim();
    return [{ role: 'user', content: stripped }];
  }
  return messages;
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

/**
 * Facts from the user's records for every question, in both Grounded and Chat mode. A lookup failure must not
 * break the chat: the model then answers without facts.
 */
function safeRetrieve(prompt: string) {
  try {
    const history = useAIStore.getState().chatHistory ?? [];
    const previousUserPrompts = history
      .filter((msg) => msg.role === 'user' && msg.status !== 'streaming')
      .map((msg) => msg.text);
    // The current question is usually already in history; it is not a previous one.
    if (previousUserPrompts[previousUserPrompts.length - 1] === prompt) previousUserPrompts.pop();
    return buildRetrievedContext(prompt, { previousUserPrompts });
  } catch (error) {
    console.warn('Finance fact lookup failed:', error);
    return undefined;
  }
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
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  // One model context: chat, single scans and the background receipt queue take turns.
  private generationTail: Promise<unknown> = Promise.resolve();
  private pendingGenerations = 0;

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

  cancelScheduledUnload(): void {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
  }

  async ensureChatRuntimeReady(options?: { minContextTokens?: number }): Promise<void> {
    this.cancelScheduledUnload();

    if (this.runtimeInitPromise) {
      return this.runtimeInitPromise;
    }

    // Wait for the shared model lifecycle initialization before loading llama.rn so
    // deferred restorePersistedState() can never race and overwrite a live runtime.
    const lifecycle = getModelLifecycleManager?.();
    if (lifecycle && typeof lifecycle.ensureInitialized === 'function' && !lifecycle.isInitialized?.()) {
      await lifecycle.ensureInitialized();
      if (this.runtimeInitPromise) {
        return this.runtimeInitPromise;
      }
    }

    const configuredModelPath = getConfiguredModelPath();
    const requestedContextTokens = Math.max(options?.minContextTokens ?? 0, QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS);
    const currentStore = useAIStore.getState();

    // Fast path: model is already loaded, healthy, matches configured path, and satisfies context requirement.
    if (
      currentStore.runtimeReady &&
      currentStore.runtime.modelLoaded &&
      currentStore.runtime.generationHealthy &&
      !currentStore.runtime.lastRuntimeError &&
      this.llamaRnAdapter.getContextTokens() >= requestedContextTokens
    ) {
      const existingRuntimeInfo = await this.llamaRnAdapter.getRuntimeInfo();
      if (
        existingRuntimeInfo.isModelLoaded &&
        existingRuntimeInfo.loadedModelPath &&
        normalizeModelPath(existingRuntimeInfo.loadedModelPath) === normalizeModelPath(configuredModelPath)
      ) {
        return;
      }
    }

    if (this.runtimeInitPromise) {
      return this.runtimeInitPromise;
    }

    this.runtimeInitPromise = (async () => {
      this.setState({
        isPreparingRuntime: true,
        runtimeStatus: 'Opening local chatbot...',
      });
      useAIStore.getState().setRuntimeError(null);

      try {
        const modelInfo = await getConfiguredModelInfo();
        this.setState({
          runtimeStatus: modelInfo.exists ? 'Loading local model (0%)...' : 'Checking local model installation...',
        });

        this.applyLlamaRuntimeLoading(await this.llamaRnAdapter.getRuntimeInfo());
        let lastReportedBucket = -1;
        await this.llamaRnAdapter.initContext({
          modelPath: modelInfo.configuredModelPath,
          modelFileSizeBytes: modelInfo.modelFileSizeBytes,
          contextTokens: options?.minContextTokens,
          onProgress: (percent) => {
            const clamped = Math.max(0, Math.min(100, Math.round(percent)));
            const bucket = clamped >= 100 ? 100 : Math.floor(clamped / 5) * 5;
            if (bucket <= lastReportedBucket) {
              return;
            }
            lastReportedBucket = bucket;
            this.setState({
              runtimeStatus: bucket >= 100
                ? 'Finalizing local model...'
                : `Loading local model (${bucket}%)...`,
            });
          },
        });

        const runtimeInfo = await this.llamaRnAdapter.getRuntimeInfo();
        this.applyLlamaRuntimeReady(runtimeInfo, modelInfo.configuredModelPath);
      } catch (error) {
        const runtimeError = normalizeRuntimeError(error);
        const latestStore = useAIStore.getState();
        const latestInfo = await this.llamaRnAdapter.getRuntimeInfo().catch(() => null);
        latestStore.markRuntimeReady(false);
        latestStore.setRuntimeHealth(false, null);
        latestStore.setRuntimeModelLoaded(Boolean(latestInfo?.isModelLoaded), latestInfo);
        latestStore.setRuntimeError(runtimeError);
        throw error;
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


  async scheduleModelUnload(delayMs: number): Promise<void> {
    this.cancelScheduledUnload();

    this.unloadTimer = setTimeout(async () => {
      this.unloadTimer = null;
      const store = useAIStore.getState();
      if (this.state.isGenerating || store.runtime.activeGenerationRequestId !== null || this.runtimeInitPromise !== null) {
        void this.scheduleModelUnload(delayMs);
        return;
      }
      try {
        await this.llamaRnAdapter.releaseContext();
        const latestStore = useAIStore.getState();
        latestStore.setRuntimeModelLoaded(false, await this.llamaRnAdapter.getRuntimeInfo());
        latestStore.setRuntimeHealth(false, null);
        latestStore.setRuntimeState('model-unloaded'); // or idle/unloaded
        latestStore.markRuntimeReady(false);
      } catch (err) {
        console.error('Failed to automatically unload model context', err);
      }
    }, delayMs);
  }

  startGeneration(params: StartGenerationParams): Promise<string> {
    const start = () => this.runGeneration(params);
    // Start synchronously when idle; otherwise wait for every earlier request to settle.
    const run = this.pendingGenerations === 0 ? start() : this.generationTail.then(start, start);
    this.pendingGenerations += 1;
    this.generationTail = run.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      this.pendingGenerations -= 1;
    });
    return run;
  }

  private async runGeneration(params: StartGenerationParams): Promise<string> {
    const { prompt, mode, maxTokens, temperature, topP, stop, bypassChatTemplate, systemPrompt, jsonSchema } = params;
    const disableThinking = params.disableThinking ?? true;
    if (isSettingsLoadPending()) {
      await waitForSettingsLoaded();
    }
    const settings = useSettingsStore.getState();
    if (settings.aiInferenceMode === 'external') {
      return this.startExternalGeneration(params);
    }

    const state = useAIStore.getState();
    const availability = getAIRuntimeAvailability(state);

    if (!availability.hasUsableLocalInferenceBackend) {
      if (isSecretsHydrationPending()) {
        await waitForSecretsHydrated();
      } else if (settings.secretsHydrationError) {
        await retrySecretsHydrationIfNeeded();
      }
      if (isExternalAccessConfigured(useSettingsStore.getState())) {
        return this.startExternalGeneration(params, 'Using external API (local model unavailable)');
      }
      throw new LocalInferenceException(
        'backend-unavailable',
        'Local model not ready — download it in Settings or configure an external API',
        undefined,
        true,
      );
    }

    const requestStartedAtMs = Date.now();
    this.setState({
      isGenerating: true,
      generationStatus: mode === 'rag' ? 'Retrieving grounded local context...' : 'Checking local inference runtime...',
    });

    const store = useAIStore.getState();
    let requestId: string | null = null;

    let lastStreamUpdateAtMs = 0;
    let lastRawStreamText = '';
    let lastStreamedText = '';
    let pendingStreamingSanitizerRemainder = '';
    let firstTokenAtMs: number | null = null;
    let generationStatusPublished = false;

    try {
      await this.ensureChatRuntimeReady({ minContextTokens: params.imageUri ? 4096 : undefined });
      const runtimeReadyAtMs = Date.now();

      const activeRequestId = `llama-rn-${runtimeReadyAtMs}`;
      requestId = activeRequestId;
      const runtimeInfo = await this.llamaRnAdapter.getRuntimeInfo();

      store.setActiveGenerationRequestId(activeRequestId);
      store.setStreamingResponseText('');
      store.setActiveStatusLabel(mode === 'rag' ? 'Retrieving grounded local context...' : 'Running local inference...');
      store.setRuntimeError(null);
      store.setRuntimeInfo(runtimeInfo);
      store.setRuntimeModelLoaded(Boolean(runtimeInfo.isModelLoaded), runtimeInfo);
      store.setRuntimeState('busy');

      const promptStartedAtMs = Date.now();
      let preparedPrompt: string | undefined;
      let preparedMessages: Array<{
        role: string;
        content?: string | Array<{ type: string; text?: string; image_url?: { url?: string } }>;
      }> | undefined;
      let localChatMessages: ExternalChatMessage[] | undefined;

      if (params.imageUri) {
        preparedMessages = [
          ...(systemPrompt !== undefined ? [{ role: 'system', content: systemPrompt }] : []),
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: params.imageUri },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ];
      } else if (bypassChatTemplate) {
        preparedPrompt = prompt;
      } else if (systemPrompt !== undefined) {
        preparedMessages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ];
      } else if (disableThinking) {
        localChatMessages = await this.prepareLocalMessages({ userPrompt: prompt, mode });
        preparedMessages = localChatMessages;
      } else {
        preparedPrompt = await this.preparePrompt({ userPrompt: prompt, mode });
      }
      const promptPreparedAtMs = Date.now();
      const promptChars = preparedMessages
        ? preparedMessages.reduce((sum, message) => {
            if (typeof message.content === 'string') {
              return sum + message.content.length;
            }
            if (Array.isArray(message.content)) {
              return sum + message.content.reduce((pSum, part) => pSum + (part.text?.length ?? 0), 0);
            }
            return sum;
          }, 0)
        : (preparedPrompt?.length ?? 0);

      traceLatency('llama-rn-generation-start', {
        requestId: activeRequestId,
        mode,
        runtimeWaitMs: runtimeReadyAtMs - requestStartedAtMs,
        promptPrepMs: promptPreparedAtMs - promptStartedAtMs,
        promptChars,
        modelLoaded: runtimeInfo.isModelLoaded ?? null,
      });

      const effectiveStop = stop ? Array.from(new Set([...stop, ...QWEN_MODEL_STOP_TOKENS])) : [...QWEN_MODEL_STOP_TOKENS];

      const result = await this.llamaRnAdapter.completion(activeRequestId, {
        ...(preparedMessages ? { messages: preparedMessages } : { prompt: preparedPrompt }),
        imageUri: params.imageUri,
        maxTokens: maxTokens ?? (mode === 'rag' ? QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS : QWEN_MODEL_MAX_OUTPUT_TOKENS),
        temperature: temperature ?? (mode === 'rag' ? QWEN_MODEL_GROUNDED_TEMPERATURE : QWEN_MODEL_DEFAULT_TEMPERATURE),
        topP: topP ?? (mode === 'rag' ? QWEN_MODEL_GROUNDED_TOP_P : QWEN_MODEL_DEFAULT_TOP_P),
        stop: effectiveStop,
        jsonSchema,
        disableThinking,
        onToken: (text) => {
          const now = Date.now();
          const latestState = useAIStore.getState();
          if (latestState.runtime.activeGenerationRequestId !== activeRequestId) {
            return;
          }

          if (firstTokenAtMs === null) {
            firstTokenAtMs = now;
            traceLatency('llama-rn-first-token', {
              requestId: activeRequestId,
              firstTokenMs: now - promptPreparedAtMs,
              totalElapsedMs: now - requestStartedAtMs,
            });
          }

          const shouldPublish =
            lastStreamedText.length === 0
            || now - lastStreamUpdateAtMs >= STREAMING_UPDATE_INTERVAL_MS
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

      const sanitizedText = sanitizeGeneratedText(result.text);
      // Chat replies built from the user's records never show amounts the records do not contain. A rejected
      // reply gets one stricter retry before the facts themselves are shown (chat benchmark 2026-11-25).
      let cleanedText = sanitizedText;
      if (localChatMessages && result.stopReason !== 'cancelled') {
        const check = checkLocalChatReply(sanitizedText.trim(), localChatMessages, mode);
        cleanedText = check.text;
        if (!check.ok && useAIStore.getState().runtime.activeGenerationRequestId === activeRequestId) {
          store.setStreamingResponseText('');
          store.setActiveStatusLabel('Checking the numbers...');
          this.setState({ generationStatus: 'Checking the numbers...' });
          const retry = await this.llamaRnAdapter.completion(activeRequestId, {
            messages: buildGuardRetryMessages(localChatMessages),
            maxTokens: maxTokens ?? QWEN_MODEL_MAX_OUTPUT_TOKENS,
            temperature: GUARD_RETRY_TEMPERATURE,
            topP: topP ?? QWEN_MODEL_DEFAULT_TOP_P,
            stop: effectiveStop,
            disableThinking,
          });
          if (retry.stopReason !== 'cancelled' && retry.stopReason !== 'error') {
            const retryCheck = checkLocalChatReply(sanitizeGeneratedText(retry.text).trim(), localChatMessages, mode);
            if (retryCheck.ok) cleanedText = retryCheck.text;
          }
        }
      }
      const latestRuntimeInfo = await this.llamaRnAdapter.getRuntimeInfo();
      store.setRuntimeInfo(latestRuntimeInfo);
      store.setRuntimeModelLoaded(Boolean(latestRuntimeInfo.isModelLoaded), latestRuntimeInfo);
      store.setRuntimeHealth(result.stopReason !== 'error');
      store.markRuntimeReady(result.stopReason !== 'error');
      store.setRuntimeState(result.stopReason === 'error' ? 'failed' : 'healthy');
      store.setStreamingResponseText(cleanedText);
      store.setActiveStatusLabel(result.stopReason === 'cancelled' ? 'Cancelled' : 'Response ready', null);
      traceLatency('llama-rn-generation-complete', {
        requestId: activeRequestId,
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
        useAIStore.getState().setActiveStatusLabel('Cancelled', null);
      } else {
        store.setRuntimeError(runtimeError);
      }
      throw error;
    } finally {
      const latestState = useAIStore.getState();
      if (requestId && latestState.runtime.activeGenerationRequestId === requestId) {
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

  private async startExternalGeneration(
    params: StartGenerationParams,
    initialGenerationStatus?: string,
  ): Promise<string> {
    const { prompt, mode, maxTokens, temperature, topP, stop, bypassChatTemplate, systemPrompt, jsonSchema, imageUri } = params;
    // Always await background SecureStore hydration before reading API credentials or sending a request.
    if (isSecretsHydrationPending()) {
      await waitForSecretsHydrated();
    } else if (useSettingsStore.getState().secretsHydrationError) {
      await retrySecretsHydrationIfNeeded();
    }
    const settings = useSettingsStore.getState();
    const url = settings.externalApiUrl.trim().replace(/\/$/, '');
    const parsedUrl = parseExternalUrlParts(url);
    if (!parsedUrl) {
      throw new LocalInferenceException(
        'external-api-error',
        'Invalid external API URL. Must start with https:// (or http:// for localhost/private LAN).',
        { url },
        true,
      );
    }
    if (parsedUrl.protocol === 'http' && !isLoopbackOrPrivateLanHost(parsedUrl.hostname)) {
      throw new LocalInferenceException(
        'external-api-error',
        'Insecure http:// external API URLs are only allowed for localhost or private LAN hosts. Use https:// instead.',
        { url },
        true,
      );
    }
    if (
      settings.secretsHydrationError &&
      !settings.externalApiKey.trim() &&
      !isLoopbackOrPrivateLanHost(parsedUrl.hostname)
    ) {
      throw new LocalInferenceException(
        'external-api-error',
        'Unable to read stored external API credentials from secure storage. Please re-enter your API key in Settings.',
        { url },
        true,
      );
    }

    const requestStartedAtMs = Date.now();
    this.setState({
      isGenerating: true,
      generationStatus:
        initialGenerationStatus ??
        (mode === 'rag' ? 'Retrieving grounded local context...' : 'Connecting to external API...'),
    });

    const store = useAIStore.getState();
    const requestId = `ext-api-${requestStartedAtMs}`;
    const model = settings.externalApiModel.trim() || 'gpt-4o-mini';
    const apiKey = settings.externalApiKey.trim();

    store.setActiveGenerationRequestId(requestId);
    store.setStreamingResponseText('');
    store.setActiveStatusLabel(mode === 'rag' ? 'Retrieving grounded local context...' : `Running inference via ${model}...`);
    store.setRuntimeError(null);
    store.setRuntimeState('busy');

    let messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content:
        | string
        | Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string } }
          >;
    }>;

    if (imageUri) {
      let base64Data = '';
      if (typeof FileSystemModule.readAsStringAsync === 'function') {
        base64Data = await FileSystemModule.readAsStringAsync(imageUri, { encoding: 'base64' });
      }
      const mimeType = imageUri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${base64Data}`;

      messages = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: dataUrl,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      });
    } else if (bypassChatTemplate && prompt.includes('<|im_start|>')) {
      messages = stripChatMlToMessages(prompt);
      if (systemPrompt !== undefined) {
        const existingSystemIndex = messages.findIndex((message) => message.role === 'system');
        if (existingSystemIndex >= 0) {
          messages[existingSystemIndex] = { role: 'system', content: systemPrompt };
        } else {
          messages.unshift({ role: 'system', content: systemPrompt });
        }
      }
    } else if (systemPrompt !== undefined) {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ];
    } else {
      const retrievedContext = safeRetrieve(prompt);
      messages = buildExternalMessagesForMode(prompt, mode, store, retrievedContext);
    }

    if (jsonSchema) {
      const schemaInstruction = `Respond with JSON matching this schema: ${JSON.stringify(jsonSchema)}`;
      if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
        messages[0] = {
          ...messages[0],
          content: messages[0].content ? `${messages[0].content}\n\n${schemaInstruction}` : schemaInstruction,
        };
      } else {
        messages.unshift({ role: 'system', content: schemaInstruction });
      }
    }

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

      const finalizeExternalRequest = (
        statusLabel: string | null,
        runtimeState?: 'healthy' | 'failed',
        error?: LocalInferenceException,
      ) => {
        const latestStore = useAIStore.getState();
        this.activeExternalXhr = null;
        if (error) {
          latestStore.setRuntimeError(error);
        }
        if (runtimeState) {
          latestStore.setRuntimeState(runtimeState);
        }
        latestStore.setActiveStatusLabel(statusLabel, null);
        this.setState({ isGenerating: false, generationStatus: '' });
        if (latestStore.runtime.activeGenerationRequestId === requestId) {
          latestStore.setActiveGenerationRequestId(null);
        }
      };

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
        const latestStore = useAIStore.getState();
        if (latestStore.runtime.activeGenerationRequestId !== requestId) {
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
                    this.setState({ generationStatus: initialGenerationStatus ?? `Generating response via ${model}...` });
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
          store.setStreamingResponseText(cleanedText);
          finalizeExternalRequest(null, 'healthy');
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
          finalizeExternalRequest(null, 'failed', error);
          reject(error);
        }
      };

      xhr.onerror = () => {
        const error = new LocalInferenceException('external-api-error', 'Network error connecting to external API.', undefined, true);
        finalizeExternalRequest(null, 'failed', error);
        reject(error);
      };

      xhr.onabort = () => {
        const error = new LocalInferenceException('generation-cancelled', 'Generation cancelled by user.', undefined, true);
        finalizeExternalRequest(null);
        reject(error);
      };

      const payload: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        temperature: temperature ?? (mode === 'rag' ? QWEN_MODEL_GROUNDED_TEMPERATURE : QWEN_MODEL_DEFAULT_TEMPERATURE),
        top_p: topP ?? (mode === 'rag' ? QWEN_MODEL_GROUNDED_TOP_P : QWEN_MODEL_DEFAULT_TOP_P),
        stop,
      };
      if (jsonSchema) {
        payload.response_format = { type: 'json_object' };
      }

      xhr.send(JSON.stringify(payload));
    });
  }

  private async prepareLocalMessages({ userPrompt, mode }: PreparePromptParams): Promise<ExternalChatMessage[]> {
    const retrievedContext = safeRetrieve(userPrompt);
    return buildLocalMessagesForMode(userPrompt, mode, useAIStore.getState(), retrievedContext);
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
      const retrievedContext = safeRetrieve(userPrompt);
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
      const xhr = this.activeExternalXhr;
      this.activeExternalXhr = null;
      xhr.abort();
      const latestState = useAIStore.getState();
      latestState.setActiveStatusLabel(null, null);
      this.setState({ isGenerating: false, generationStatus: '' });
      if (latestState.runtime.activeGenerationRequestId === requestId) {
        latestState.setActiveGenerationRequestId(null);
      }
      return true;
    }

    state.appendLog({
      level: 'warn',
      event: 'generation-cancel-requested',
      message: reason,
      details: { requestId, backend: 'llama.rn-cpu' },
    });

    state.setActiveStatusLabel('Cancelling local generation...');
    this.completionStopPromise = this.llamaRnAdapter.stopCompletion();
    await this.completionStopPromise;
    return true;
  }

  async dispose(): Promise<void> {
    this.cancelScheduledUnload();
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
    const nextState = {
      ...this.state,
      ...patch,
    };
    if (
      nextState.isPreparingRuntime === this.state.isPreparingRuntime &&
      nextState.runtimeStatus === this.state.runtimeStatus &&
      nextState.isGenerating === this.state.isGenerating &&
      nextState.generationStatus === this.state.generationStatus
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

const generationService = new GenerationService();

export function getGenerationService() {
  return generationService;
}
