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

export const GGUF_QUANTIZATION_PRESETS: Record<
  string,
  {
    tier: 'Q5_K_M' | 'Q4_K_M' | 'Q2_K' | 'INT4';
    label: string;
    shortLabel: string;
    assetVersion: string;
    fileName: string;
    downloadUrl: string;
    sha256: string;
    sizeBytesEstimate: number;
    minFreeSpaceBytes: number;
  }
> = {
  Q5_K_M: {
    tier: 'Q5_K_M',
    label: 'Q5_K_M (High Quality · ~1.9 GB)',
    shortLabel: 'Q5_K_M',
    assetVersion: 'qwen3.5-2b-q5km-v1',
    fileName: 'Qwen3.5-2B-Q5_K_M.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q5_K_M.gguf',
    sha256: '1885b3a9195f8cc09da9a7a7a75afdc1e8d5cbf9fc4a499c3961dddea37098ac',
    sizeBytesEstimate: 1_920_000_000,
    minFreeSpaceBytes: 2 * 1024 * 1024 * 1024,
  },
  Q4_K_M: {
    tier: 'Q4_K_M',
    label: 'Q4_K_M (Balanced · ~1.6 GB)',
    shortLabel: 'Q4_K_M',
    assetVersion: 'qwen3.5-2b-q4km-v1',
    fileName: 'Qwen3.5-2B-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    sha256: '',
    sizeBytesEstimate: 1_600_000_000,
    minFreeSpaceBytes: 1.7 * 1024 * 1024 * 1024,
  },
  Q2_K: {
    tier: 'Q2_K',
    label: 'Q2_K (Low Memory · ~1.1 GB)',
    shortLabel: 'Q2_K',
    assetVersion: 'qwen3.5-2b-q2k-v1',
    fileName: 'Qwen3.5-2B-Q2_K.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q2_K.gguf',
    sha256: '',
    sizeBytesEstimate: 1_100_000_000,
    minFreeSpaceBytes: 1.2 * 1024 * 1024 * 1024,
  },
  INT4: {
    tier: 'INT4',
    label: 'INT4 (Compact · ~1.5 GB)',
    shortLabel: 'INT4',
    assetVersion: 'qwen3.5-2b-int4-v1',
    fileName: 'Qwen3.5-2B-Q4_0.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_0.gguf',
    sha256: '',
    sizeBytesEstimate: 1_500_000_000,
    minFreeSpaceBytes: 1.6 * 1024 * 1024 * 1024,
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
  aiModelQuantization: 'Q5_K_M',
  aiWifiOnlyDownload: false,
  aiAutoQuantizationFallback: true,
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
  aiModelQuantization: 'aiModelQuantization',
  aiWifiOnlyDownload: 'aiWifiOnlyDownload',
  aiAutoQuantizationFallback: 'aiAutoQuantizationFallback',
  externalApiProvider: 'externalApiProvider',
  externalApiUrl: 'externalApiUrl',
  externalApiModel: 'externalApiModel',
  externalApiKey: 'externalApiKey',
  externalApiCustomHeaders: 'externalApiCustomHeaders',
  localSystemPrompt: 'localSystemPrompt',
  externalSystemPrompt: 'externalSystemPrompt',
} as const;
