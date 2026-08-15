export const DEFAULT_EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Groceries',
  'Bills',
  'Entertainment',
] as const;

export const DEFAULT_INCOME_CATEGORIES = [
  'Salary',
  'Freelance',
] as const;

export const UNCATEGORIZED_EXPENSE_LABEL = 'Uncategorized Expense';
export const UNCATEGORIZED_INCOME_LABEL = 'Uncategorized Income';
export const UNCATEGORIZED_LABEL = UNCATEGORIZED_EXPENSE_LABEL;
export const DEFAULT_WALLET_ID = 1;

export const EXTERNAL_API_PRESETS: Record<
  string,
  { label: string; url: string; model: string; requiresKey: boolean }
> = {
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresKey: true,
  },
  deepseek: {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresKey: true,
  },
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    requiresKey: true,
  },
  ollama: {
    label: 'Ollama (Local)',
    url: 'http://10.0.2.2:11434/v1',
    model: 'qwen2.5:3b',
    requiresKey: false,
  },
  together: {
    label: 'Together AI',
    url: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresKey: true,
  },
  custom: {
    label: 'Custom / Self-Hosted',
    url: 'https://api.example.com/v1',
    model: 'custom-model',
    requiresKey: false,
  },
};

import type { ModelCatalogEntry } from './types';

export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  'qwen3.5-2b': {
    id: 'qwen3.5-2b',
    displayName: 'Qwen 3.5 2B (Offline)',
    family: 'qwen',
    parameterSize: '2B',
    quantization: 'Q4_K_M',
    capabilities: ['text'],
    fileName: 'Qwen3.5-2B-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    sha256: '',
    fileSizeBytes: 1503238000,
    minFreeSpaceBytes: 2 * 1024 * 1024 * 1024,
    recommendedRamBytes: 3 * 1024 * 1024 * 1024,
    requiredRamBytes: 2 * 1024 * 1024 * 1024,
    description: 'High performance edge LLM. Fast, accurate, and completely offline.',
  },
};

export const DEFAULT_APP_SETTINGS = {
  themeMode: 'system',
  currencyCode: 'IDR',
  useThousandsSeparator: true,
  dateFormat: 'en-GB',
  showIncomeInReportsFirst: false,
  fontScale: 1,
  aiInferenceMode: 'local',
  activeModelId: 'qwen3.5-2b',
  ocrEngineId: 'mlkit',
  aiWifiOnlyDownload: false,
  externalApiProvider: 'openai',
  externalApiUrl: 'https://api.openai.com/v1',
  externalApiModel: 'gpt-4o-mini',
  externalApiKey: '',
  externalApiCustomHeaders: '{}',
  localSystemPrompt: '',
  externalSystemPrompt: '',
} as const;

export const APP_SETTING_KEYS = {
  themeMode: 'themeMode',
  currencyCode: 'currencyCode',
  useThousandsSeparator: 'useThousandsSeparator',
  dateFormat: 'dateFormat',
  showIncomeInReportsFirst: 'showIncomeInReportsFirst',
  fontScale: 'fontScale',
  aiInferenceMode: 'aiInferenceMode',
  activeModelId: 'activeModelId',
  ocrEngineId: 'ocrEngineId',
  aiWifiOnlyDownload: 'aiWifiOnlyDownload',
  externalApiProvider: 'externalApiProvider',
  externalApiUrl: 'externalApiUrl',
  externalApiModel: 'externalApiModel',
  externalApiKey: 'externalApiKey',
  externalApiCustomHeaders: 'externalApiCustomHeaders',
  localSystemPrompt: 'localSystemPrompt',
  externalSystemPrompt: 'externalSystemPrompt',
} as const;
