export type TransactionType = 'income' | 'expense' | 'transfer';
export type TransactionUIInputMode = 'note' | 'receipt' | 'both';
export type CategoryType = 'expense' | 'income';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface TransactionReceiptLineItem {
  name: string;
  price?: number;
}

export interface CategoryRecord {
  id: number;
  name: string;
  type: CategoryType;
  isSystem: boolean;
  createdAt: number;
}

export interface Transaction {
  id: number;
  merchantName: string;
  totalAmount: number;
  type: TransactionType;
  category: string;
  date: number;
  imageUri?: string | null;
  note?: string;
  lineItemsText?: string;
}

export type AIInferenceMode = 'local' | 'external';
export type ExternalAPIProvider = 'openai' | 'deepseek' | 'groq' | 'ollama' | 'together' | 'custom';
export type ModelCapability = 'text' | 'multimodal';

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  family: 'qwen' | 'gemma';
  parameterSize: string;
  quantization: 'Q4_K_M';
  capabilities: ModelCapability[];
  fileName: string;
  downloadUrl: string;
  sha256: string;
  fileSizeBytes: number;
  minFreeSpaceBytes: number;
  recommendedRamBytes: number;
  requiredRamBytes: number;
  description: string;
}

export type OcrEngineId = 'mlkit' | 'paddleocr' | 'external';

export interface AppSettings {
  themeMode: ThemeMode;
  currencyCode: string;
  useThousandsSeparator: boolean;
  dateFormat: string;
  showIncomeInReportsFirst: boolean;
  fontScale: number;
  aiInferenceMode: AIInferenceMode;
  activeModelId: string;
  ocrEngineId: OcrEngineId;
  aiWifiOnlyDownload: boolean;
  externalApiProvider: ExternalAPIProvider;
  externalApiUrl: string;
  externalApiModel: string;
  externalApiKey: string;
  externalApiCustomHeaders: string;
  localSystemPrompt: string;
  externalSystemPrompt: string;
}

export type TransactionInput = Omit<Transaction, 'id'>;
export type TransactionUpdate = Partial<TransactionInput>;
