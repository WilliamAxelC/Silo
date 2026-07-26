import { NativeModules, Platform } from 'react-native';

import type {
  LocalGenerationRequest,
  LocalGenerationResult,
  LocalHealthCheckRequest,
  LocalHealthCheckResult,
  LocalInferenceAvailability,
  LocalInferenceBackendBridge,
  LocalInferenceError,
  LocalModelLoadOptions,
  LocalRuntimeInfo,
} from './localInferenceTypes';

type AndroidBridgeModule = {
  isAvailable?: () => boolean;
  getRuntimeInfo?: () => Promise<LocalRuntimeInfo>;
  loadModel?: (modelPath: string, options?: LocalModelLoadOptions) => Promise<void>;
  warmup?: (prompt: string) => Promise<void>;
  runHealthCheck?: (request: LocalHealthCheckRequest) => Promise<LocalHealthCheckResult>;
  generate?: (request: LocalGenerationRequest) => Promise<LocalGenerationResult>;
  cancelGeneration?: (requestId: string) => Promise<void>;
  disposeModel?: () => Promise<void>;
};

const MODULE_NAME = 'SiloLocalInferenceModule';

function getNativeModule(): AndroidBridgeModule | null {
  const nativeModule = NativeModules[MODULE_NAME] as AndroidBridgeModule | undefined;
  return nativeModule ?? null;
}

function createError(code: LocalInferenceError['code'], message: string, details?: Record<string, unknown>): LocalInferenceError {
  return {
    code,
    message,
    details,
    recoverable: code !== 'unsupported-device' && code !== 'backend-unavailable',
  };
}

function appendBridgeLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  message: string,
  details?: Record<string, unknown>,
) {
  if (__DEV__) {
    const payload = details ? { level, event, message, details } : { level, event, message };
    console.log('[LocalInferenceBridge]', payload);
  }
}

function createAvailability(): LocalInferenceAvailability {
  if (Platform.OS !== 'android') {
    return {
      available: false,
      reason: 'platform-unsupported',
      message: 'Local GGUF inference is Android-only in this build.',
    };
  }

  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return {
      available: false,
      reason: 'native-module-missing',
      message: 'The Android local inference bridge module is not linked into this build.',
    };
  }

  if (!nativeModule.isAvailable) {
    return {
      available: false,
      reason: 'native-runtime-unavailable',
      message: 'The Android bridge module exists, but the GGUF runtime availability probe is not implemented.',
    };
  }

  try {
    const available = Boolean(nativeModule.isAvailable());
    return available
      ? {
          available: true,
          reason: 'android-supported',
          message: 'Android local inference bridge detected.',
        }
      : {
          available: false,
          reason: 'native-runtime-unavailable',
          message: 'The Android bridge is present, but the native GGUF runtime reported unavailable.',
        };
  } catch (error) {
    return {
      available: false,
      reason: 'native-check-failed',
      message: error instanceof Error ? error.message : 'Native runtime availability check failed.',
    };
  }
}

export function isLocalInferenceBackendAvailable(): boolean {
  return createAvailability().available;
}

export class NativeLocalInferenceBridge implements LocalInferenceBackendBridge {
  isAvailable(): boolean {
    return createAvailability().available;
  }

  getAvailability(): LocalInferenceAvailability {
    return createAvailability();
  }

  async getRuntimeInfo(): Promise<LocalRuntimeInfo> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.getRuntimeInfo) {
      throw createError(
        'native-method-missing',
        'Android local inference bridge is present, but getRuntimeInfo() is not implemented.',
      );
    }

    const startedAtMs = Date.now();
    appendBridgeLog('info', 'bridge-runtime-info-start', 'Requesting native runtime info from JS bridge.');
    try {
      const result = await nativeModule.getRuntimeInfo();
      appendBridgeLog('info', 'bridge-runtime-info-success', 'Native runtime info resolved in JS bridge.', {
        durationMs: Date.now() - startedAtMs,
        backend: result.backend,
        loadedModelPath: result.loadedModelPath ?? null,
        configuredGpuLayers: result.configuredGpuLayers ?? null,
        likelyCpuOnlyRuntime: result.likelyCpuOnlyRuntime ?? null,
      });
      return result;
    } catch (error) {
      appendBridgeLog('error', 'bridge-runtime-info-failed', 'Native runtime info request failed in JS bridge.', {
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : 'Unknown bridge runtime info failure.',
      });
      throw error;
    }
  }

  async loadModel(modelPath: string, options?: LocalModelLoadOptions): Promise<void> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.loadModel) {
      throw createError(
        'native-method-missing',
        'Android local inference bridge cannot load a GGUF model because loadModel() is not implemented.',
        { modelPath },
      );
    }

    const startedAtMs = Date.now();
    appendBridgeLog('info', 'bridge-load-model-start', 'Dispatching model load from JS bridge to native module.', {
      modelPath,
      options: options ?? null,
    });
    try {
      await nativeModule.loadModel(modelPath, options);
      appendBridgeLog('info', 'bridge-load-model-success', 'Native model load resolved in JS bridge.', {
        modelPath,
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      appendBridgeLog('error', 'bridge-load-model-failed', 'Native model load failed in JS bridge.', {
        modelPath,
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : 'Unknown bridge model load failure.',
      });
      throw error;
    }
  }

  async warmup(prompt: string): Promise<void> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.warmup) {
      throw createError(
        'native-method-missing',
        'Android local inference bridge cannot warm up the runtime because warmup() is not implemented.',
      );
    }

    const startedAtMs = Date.now();
    appendBridgeLog('info', 'bridge-warmup-start', 'Dispatching warmup from JS bridge to native module.', {
      promptChars: prompt.length,
    });
    try {
      await nativeModule.warmup(prompt);
      appendBridgeLog('info', 'bridge-warmup-success', 'Native warmup resolved in JS bridge.', {
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      appendBridgeLog('error', 'bridge-warmup-failed', 'Native warmup failed in JS bridge.', {
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : 'Unknown bridge warmup failure.',
      });
      throw error;
    }
  }

  async runHealthCheck(request: LocalHealthCheckRequest): Promise<LocalHealthCheckResult> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.runHealthCheck) {
      throw createError(
        'native-method-missing',
        'Android local inference bridge cannot run a probe generation because runHealthCheck() is not implemented.',
      );
    }

    const startedAtMs = Date.now();
    appendBridgeLog('info', 'bridge-health-check-start', 'Dispatching health check from JS bridge to native module.', {
      promptChars: request.prompt.length,
      maxTokens: request.maxTokens ?? null,
      expectedSubstring: request.expectedSubstring ?? null,
    });
    const result = await nativeModule.runHealthCheck(request);
    const normalizedError = result.error
      ?? ((result as LocalHealthCheckResult & { errorCode?: string | null; errorMessage?: string | null }).errorCode
        || (result as LocalHealthCheckResult & { errorCode?: string | null; errorMessage?: string | null }).errorMessage
        ? createError(
            'health-check-failed',
            (result as LocalHealthCheckResult & { errorCode?: string | null; errorMessage?: string | null }).errorMessage
              ?? 'Native local inference probe generation failed.',
            {
              nativeErrorCode: (result as LocalHealthCheckResult & { errorCode?: string | null; errorMessage?: string | null }).errorCode ?? null,
            },
          )
        : undefined);

    appendBridgeLog(normalizedError ? 'warn' : 'info', normalizedError ? 'bridge-health-check-failed' : 'bridge-health-check-success', 'Native health check completed in JS bridge.', {
      durationMs: Date.now() - startedAtMs,
      ok: result.ok,
      matchedExpectedSubstring: result.matchedExpectedSubstring,
      nativeDurationMs: result.durationMs ?? null,
      error: normalizedError ?? null,
    });

    return {
      ...result,
      error: normalizedError,
    };
  }

  async generate(request: LocalGenerationRequest): Promise<LocalGenerationResult> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.generate) {
      throw createError(
        'native-method-missing',
        'Android local inference bridge cannot generate text because generate() is not implemented.',
        { requestId: request.requestId },
      );
    }

    const startedAtMs = Date.now();
    appendBridgeLog('info', 'bridge-generate-start', 'Dispatching generation from JS bridge to native module.', {
      requestId: request.requestId ?? null,
      promptChars: request.prompt.length,
      maxTokens: request.maxTokens ?? null,
      temperature: request.temperature ?? null,
      topP: request.topP ?? null,
      stream: request.stream ?? false,
      stopTokens: request.stop ?? [],
    });
    try {
      const result = await nativeModule.generate(request);
      appendBridgeLog('info', 'bridge-generate-success', 'Native generation resolved in JS bridge.', {
        requestId: request.requestId ?? null,
        durationMs: Date.now() - startedAtMs,
        totalDurationMs: result.totalDurationMs ?? null,
        queueDurationMs: result.queueDurationMs ?? null,
        promptEvalDurationMs: result.promptEvalDurationMs ?? null,
        generationEvalDurationMs: result.generationEvalDurationMs ?? null,
        completionTokens: result.completionTokens ?? null,
        stopReason: result.stopReason ?? null,
      });
      return result;
    } catch (error) {
      appendBridgeLog('error', 'bridge-generate-failed', 'Native generation failed in JS bridge.', {
        requestId: request.requestId ?? null,
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : 'Unknown bridge generation failure.',
      });
      throw error;
    }
  }

  async cancelGeneration(requestId: string): Promise<void> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.cancelGeneration) {
      throw createError(
        'native-method-missing',
        'Android local inference bridge cannot cancel generation because cancelGeneration() is not implemented.',
        { requestId },
      );
    }

    const startedAtMs = Date.now();
    appendBridgeLog('warn', 'bridge-cancel-start', 'Dispatching generation cancellation from JS bridge to native module.', {
      requestId,
    });
    try {
      await nativeModule.cancelGeneration(requestId);
      appendBridgeLog('warn', 'bridge-cancel-success', 'Native generation cancellation resolved in JS bridge.', {
        requestId,
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      appendBridgeLog('error', 'bridge-cancel-failed', 'Native generation cancellation failed in JS bridge.', {
        requestId,
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : 'Unknown bridge cancellation failure.',
      });
      throw error;
    }
  }

  async disposeModel(): Promise<void> {
    const nativeModule = getNativeModule();
    if (!nativeModule?.disposeModel) {
      return;
    }

    const startedAtMs = Date.now();
    appendBridgeLog('info', 'bridge-dispose-start', 'Dispatching model disposal from JS bridge to native module.', undefined);
    try {
      await nativeModule.disposeModel();
      appendBridgeLog('info', 'bridge-dispose-success', 'Native model disposal resolved in JS bridge.', {
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      appendBridgeLog('error', 'bridge-dispose-failed', 'Native model disposal failed in JS bridge.', {
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : 'Unknown bridge dispose failure.',
      });
      throw error;
    }
  }
}

const nativeLocalInferenceBridge = new NativeLocalInferenceBridge();

export function getNativeLocalInferenceBridge() {
  return nativeLocalInferenceBridge;
}
