import type { LocalRuntimeInfo } from './localInferenceTypes';


export const QWEN_MODEL_ASSET_VERSION = 'qwen3.5-2b-q5km-v1';
export const QWEN_MODEL_FILE_NAME = 'Qwen3.5-2B-Q5_K_M.gguf';
export const QWEN_MODEL_DOWNLOAD_URL = 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q5_K_M.gguf';
export const QWEN_MODEL_SHA256 = '1885b3a9195f8cc09da9a7a7a75afdc1e8d5cbf9fc4a499c3961dddea37098ac';
export const QWEN_MODEL_MIN_FREE_SPACE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB minimum free space required
export const QWEN_MODEL_WARMUP_PROMPT = 'Reply with the single word READY.';
export const QWEN_MODEL_HEALTHCHECK_EXPECTED_SUBSTRING = 'READY';
export const QWEN_MODEL_PREFERRED_MAX_CONTEXT_TOKENS = 1024;
export const QWEN_MODEL_MAX_PROMPT_CHARS = 2200;
export const QWEN_MODEL_MAX_RAG_CONTEXT_CHARS = 900;
export const QWEN_MODEL_MAX_OUTPUT_TOKENS = 150;
export const QWEN_MODEL_MAX_GROUNDED_OUTPUT_TOKENS = 80;
export const QWEN_MODEL_DEFAULT_TEMPERATURE = 0.3;
export const QWEN_MODEL_DEFAULT_TOP_P = 0.85;
export const QWEN_MODEL_GROUNDED_TEMPERATURE = 0.12;
export const QWEN_MODEL_GROUNDED_TOP_P = 0.75;
export const QWEN_MODEL_HISTORY_TURN_LIMIT = 3;
export const QWEN_MODEL_RETRIEVAL_ITEM_LIMIT = 2;
export const QWEN_MODEL_DEFAULT_CPU_THREADS = 4;
export const QWEN_MODEL_DEFAULT_GPU_LAYERS = 99;
export const QWEN_MODEL_DEFAULT_BATCH_TOKENS = 128;
export const QWEN_MODEL_DEFAULT_USE_FLASH_ATTENTION = true;
export const QWEN_MODEL_STOP_TOKENS = ['<|im_end|>', '<|endoftext|>', '</s>', '<|im_start|>user', '\nUser:', '\n<|im_start|>user'] as const;
export const QWEN_MODEL_DISPLAY_NAME = 'Qwen3.5-2B Q5_K_M';

export const AI_BOOTSTRAP_OPTIONS = {
  autoStartOnLaunch: false,
  requireUnmeteredConnection: false,
  warmupOnReady: false,
  healthPollIntervalMs: 1500,
  lowStorageRetryDelayMs: 60_000,
  maxRetryCount: 3,
  resumeOnForeground: false,
  restoreStaleDownloadAfterMs: 120_000,
  progressPersistIntervalMs: 1_500,
} as const;

export type AIProvisioningStatus =
  | 'not-installed'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'unpacking'
  | 'registering'
  | 'warming'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'update-available';

export const AI_RUNTIME_PHASE_STATUSES: readonly AIProvisioningStatus[] = ['registering', 'warming', 'indexing'];

export const AI_STATUS_LABELS: Record<AIProvisioningStatus, string> = {
  'not-installed': 'Not installed',
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  verifying: 'Verifying',
  unpacking: 'Preparing model files',
  registering: 'Registering local model',
  warming: 'Warming up local inference',
  indexing: 'Initializing AI data',
  ready: 'Ready',
  failed: 'Setup failed',
  'update-available': 'Update available',
};


export function isSupportedLocalModelPath(modelPath: string | null | undefined): modelPath is string {
  if (!modelPath) {
    return false;
  }

  return modelPath.toLowerCase().endsWith('.gguf');
}

export function validateRuntimeInfo(runtimeInfo: LocalRuntimeInfo | null | undefined): { ok: boolean; reason: string | null } {
  if (!runtimeInfo) {
    return { ok: false, reason: 'Native runtime info is unavailable.' };
  }

  if (!runtimeInfo.backend) {
    return { ok: false, reason: 'Native runtime did not report a backend name.' };
  }

  if (runtimeInfo.maxContextTokens !== undefined && runtimeInfo.maxContextTokens <= 0) {
    return { ok: false, reason: 'Native runtime reported an invalid max context token count.' };
  }

  return { ok: true, reason: null };
}
