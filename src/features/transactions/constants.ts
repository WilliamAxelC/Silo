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
/** Category stored on transfers; transfers are excluded from income, spending, budgets and reports. */
export const TRANSFER_CATEGORY_LABEL = 'Transfer';

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

export interface VisionProjectorConfig {
  url: string;
  fileName: string;
  sizeBytes: number;
  md5: string;
}

export const MODEL_CATALOG: Record<
  string,
  ModelCatalogEntry & {
    sizeBytes: number;
    md5: string;
    visionProjector?: VisionProjectorConfig;
  }
> = {
  // Default. On the receipt benchmark it matched or beat the 2B (93% vs 79% of totals on the owner's receipts)
  // at about half the time and a third of the download (bench/results/REPORT.md, Addendum 3).
  'qwen3.5-0.8b': {
    id: 'qwen3.5-0.8b',
    displayName: 'Qwen 3.5 0.8B (Offline)',
    family: 'qwen',
    parameterSize: '0.8B',
    quantization: 'Q4_K_M',
    capabilities: ['text'],
    fileName: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517',
    md5: '54e125d56fa41fe6eed66034f9fd4fa5',
    sizeBytes: 532517120,
    fileSizeBytes: 532517120,
    minFreeSpaceBytes: 1 * 1024 * 1024 * 1024,
    recommendedRamBytes: 2 * 1024 * 1024 * 1024,
    requiredRamBytes: 1.5 * 1024 * 1024 * 1024,
    description: 'Fastest and smallest. Reads receipts as accurately as 2B in our tests. Recommended.',
    visionProjector: {
      url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf',
      fileName: 'mmproj-F16.gguf',
      sizeBytes: 204987232,
      md5: '436b0222809f7a35fe0b9b8be038ebf1',
    },
  },
  'qwen3.5-2b': {
    id: 'qwen3.5-2b',
    displayName: 'Qwen 3.5 2B (Offline)',
    family: 'qwen',
    parameterSize: '2B',
    quantization: 'Q4_K_M',
    capabilities: ['text'],
    fileName: 'Qwen3.5-2B-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    md5: '6899b2510c7b0c480730d48c3117bd32',
    sizeBytes: 1280835840,
    fileSizeBytes: 1280835840,
    minFreeSpaceBytes: 2 * 1024 * 1024 * 1024,
    recommendedRamBytes: 3 * 1024 * 1024 * 1024,
    requiredRamBytes: 2 * 1024 * 1024 * 1024,
    description: 'Larger model: better for chat and questions about your spending, slower for receipts.',
    visionProjector: {
      url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/mmproj-F16.gguf',
      fileName: 'mmproj-F16.gguf',
      sizeBytes: 668227264,
      md5: 'bb3eddc16b7f19fd96b9eedf48a7248d',
    },
  },
};

export const DEFAULT_APP_SETTINGS = {
  themeMode: 'system',
  currencyCode: 'IDR',
  useThousandsSeparator: true,
  dateFormat: 'en-GB',
  showIncomeInReportsFirst: false,
  hideTotals: false,
  accentColor: 'ocean',
  pureBlack: false,
  fontScale: 1,
  aiInferenceMode: 'local',
  activeModelId: 'qwen3.5-0.8b',
  aiWifiOnlyDownload: false,
  externalApiProvider: 'openai',
  externalApiUrl: 'https://api.openai.com/v1',
  externalApiModel: 'gpt-4o-mini',
  externalApiKey: '',
  externalApiCustomHeaders: '{}',
  localSystemPrompt: '',
  externalSystemPrompt: '',
  appLockEnabled: false,
  dailyReminderEnabled: false,
  dailyReminderTime: '20:00',
  monthStartDay: 1,
  weekStartDay: 'monday',
  hasCompletedOnboarding: false,
} as const;

export const APP_SETTING_KEYS = {
  themeMode: 'themeMode',
  currencyCode: 'currencyCode',
  useThousandsSeparator: 'useThousandsSeparator',
  dateFormat: 'dateFormat',
  showIncomeInReportsFirst: 'showIncomeInReportsFirst',
  hideTotals: 'hideTotals',
  accentColor: 'accentColor',
  pureBlack: 'pureBlack',
  fontScale: 'fontScale',
  aiInferenceMode: 'aiInferenceMode',
  activeModelId: 'activeModelId',
  aiWifiOnlyDownload: 'aiWifiOnlyDownload',
  externalApiProvider: 'externalApiProvider',
  externalApiUrl: 'externalApiUrl',
  externalApiModel: 'externalApiModel',
  externalApiKey: 'externalApiKey',
  externalApiCustomHeaders: 'externalApiCustomHeaders',
  localSystemPrompt: 'localSystemPrompt',
  externalSystemPrompt: 'externalSystemPrompt',
  appLockEnabled: 'appLockEnabled',
  dailyReminderEnabled: 'dailyReminderEnabled',
  dailyReminderTime: 'dailyReminderTime',
  monthStartDay: 'monthStartDay',
  weekStartDay: 'weekStartDay',
  hasCompletedOnboarding: 'hasCompletedOnboarding',
} as const;
