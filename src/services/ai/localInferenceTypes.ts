export type LocalInferenceErrorCode =
  | 'backend-unavailable'
  | 'native-method-missing'
  | 'model-file-missing'
  | 'checksum-mismatch'
  | 'load-failed'
  | 'warmup-failed'
  | 'health-check-failed'
  | 'generation-failed'
  | 'generation-cancelled'
  | 'runtime-busy'
  | 'unsupported-device'
  | 'insufficient-memory'
  | 'context-too-large'
  | 'external-api-error'
  | 'unknown';

export type LocalInferenceError = {
  code: LocalInferenceErrorCode;
  message: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
};

export type LocalGenerationRequest = {
  requestId?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  grammar?: string;
};

export type LocalGenerationResult = {
  requestId?: string;
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  totalDurationMs?: number;
  queueDurationMs?: number;
  promptEvalDurationMs?: number;
  generationEvalDurationMs?: number;
  firstTokenDurationMs?: number;
  tokensPerSecond?: number;
  stopReason?: 'stop' | 'max-tokens' | 'cancelled' | 'error' | 'unknown';
};

export type LocalGenerationMetrics = {
  requestId: string;
  startedAt: string;
  finishedAt?: string | null;
  promptChars: number;
  promptTokens?: number;
  completionTokens?: number;
  totalDurationMs?: number;
  queueDurationMs?: number;
  promptEvalDurationMs?: number;
  generationEvalDurationMs?: number;
  tokensPerSecond?: number;
  mode?: 'rag' | 'chat';
  status: 'queued' | 'running' | 'complete' | 'cancelled' | 'error';
  stopReason?: string | null;
  errorMessage?: string | null;
};

export type LocalRuntimeInfo = {
  backend: string;
  version: string | null;
  supportsStreaming: boolean;
  maxContextTokens?: number;
  loadedModelPath?: string | null;
  loadedModelFamily?: string | null;
  loadedModelQuantization?: string | null;
  isModelLoaded?: boolean;
  abi?: string | null;
  configuredContextTokens?: number;
  configuredCpuThreads?: number;
  configuredGpuLayers?: number;
  configuredBatchTokens?: number;
  configuredUseFlashAttention?: boolean;
  configuredUseMlock?: boolean;
  resolvedContextTokens?: number;
  resolvedBatchTokens?: number;
  resolvedMicroBatchTokens?: number;
  resolvedThreads?: number;
  resolvedThreadsBatch?: number;
  resolvedOffloadKqv?: boolean;
  estimatedGpuOffloadRequested?: boolean;
  gpuOffloadSupportedByBuild?: boolean;
  detectedBackendDeviceCount?: number;
  detectedVulkanDeviceCount?: number;
  detectedBackendSummary?: string | null;
  detectedVulkanDevices?: string | null;
  likelyCpuOnlyRuntime?: boolean;
  lastPromptTokens?: number;
  lastCompletionTokens?: number;
  lastPromptEvalDurationMs?: number;
  lastGenerationEvalDurationMs?: number;
  lastTotalDurationMs?: number;
  lastStopReason?: string | null;
};

export type LocalHealthCheckResult = {
  ok: boolean;
  prompt: string;
  responseText: string;
  matchedExpectedSubstring: boolean;
  durationMs?: number;
  error?: LocalInferenceError;
};

export type LocalInferenceAvailability = {
  available: boolean;
  reason:
    | 'android-supported'
    | 'platform-unsupported'
    | 'native-module-missing'
    | 'native-runtime-unavailable'
    | 'native-check-failed';
  message: string;
};

export type LocalInferenceRuntimeState =
  | 'unavailable'
  | 'detected'
  | 'model-unloaded'
  | 'loading'
  | 'loaded'
  | 'warming'
  | 'healthy'
  | 'busy'
  | 'failed';

export class LocalInferenceException extends Error implements LocalInferenceError {
  code: LocalInferenceErrorCode;
  details?: Record<string, unknown>;
  recoverable?: boolean;

  constructor(
    code: LocalInferenceErrorCode,
    message: string,
    details?: Record<string, unknown>,
    recoverable = true,
  ) {
    super(message);
    this.name = 'LocalInferenceException';
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;
    Object.setPrototypeOf(this, LocalInferenceException.prototype);
  }
}

export function getErrorMessage(error: unknown, fallbackMessage = 'An unexpected error occurred.'): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Record<string, unknown>).message === 'string') {
    const msg = (error as Record<string, unknown>).message as string;
    if (msg.trim().length > 0) {
      return msg;
    }
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return fallbackMessage;
}
