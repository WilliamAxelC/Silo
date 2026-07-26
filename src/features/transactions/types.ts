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

export interface AppSettings {
  themeMode: ThemeMode;
  currencyCode: string;
  useThousandsSeparator: boolean;
  dateFormat: string;
  showIncomeInReportsFirst: boolean;
  fontScale: number;
}

export type TransactionInput = Omit<Transaction, 'id'>;
export type TransactionUpdate = Partial<TransactionInput>;
