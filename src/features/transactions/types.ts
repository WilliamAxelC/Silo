export type TransactionType = 'income' | 'expense' | 'transfer';
export type TransactionUIInputMode = 'note' | 'receipt' | 'both';
export type CategoryType = 'expense' | 'income';
export type ThemeMode = 'system' | 'light' | 'dark';
export type WeekStartDay = 'monday' | 'sunday';

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
  /** Account the money left (expense, transfer) or arrived in (income). Defaults to the first account. */
  walletId?: number;
  /** Transfers only: the receiving account. */
  toWalletId?: number | null;
}

export type WalletType = 'cash' | 'bank' | 'ewallet' | 'card' | 'savings';

export interface Wallet {
  id: number;
  name: string;
  type: WalletType;
  isActive: boolean;
  initialBalance: number;
  /** initialBalance plus every income/expense in the account and transfers in and out. */
  balance: number;
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


export interface AppSettings {
  themeMode: ThemeMode;
  currencyCode: string;
  useThousandsSeparator: boolean;
  dateFormat: string;
  showIncomeInReportsFirst: boolean;
  fontScale: number;
  aiInferenceMode: AIInferenceMode;
  activeModelId: string;
  aiWifiOnlyDownload: boolean;
  externalApiProvider: ExternalAPIProvider;
  externalApiUrl: string;
  externalApiModel: string;
  externalApiKey: string;
  externalApiCustomHeaders: string;
  localSystemPrompt: string;
  externalSystemPrompt: string;
  /** Require fingerprint/face/device PIN to open Silo. */
  appLockEnabled: boolean;
  /** Local daily logging reminder notification toggle. */
  dailyReminderEnabled: boolean;
  /** 24-hour local reminder time in HH:MM format (default '20:00'). */
  dailyReminderTime: string;
  /** Day of month (1-28) when custom monthly billing periods start. */
  monthStartDay: number;
  /** First day of the week shown in calendar views ('monday' | 'sunday'). */
  weekStartDay: WeekStartDay;
}

export type TransactionInput = Omit<Transaction, 'id'>;
export type TransactionUpdate = Partial<TransactionInput>;
