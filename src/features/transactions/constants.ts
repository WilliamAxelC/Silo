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

export const DEFAULT_APP_SETTINGS = {
  themeMode: 'system',
  currencyCode: 'IDR',
  useThousandsSeparator: true,
  dateFormat: 'en-GB',
  showIncomeInReportsFirst: false,
  fontScale: 1,
} as const;

export const APP_SETTING_KEYS = {
  themeMode: 'themeMode',
  currencyCode: 'currencyCode',
  useThousandsSeparator: 'useThousandsSeparator',
  dateFormat: 'dateFormat',
  showIncomeInReportsFirst: 'showIncomeInReportsFirst',
  fontScale: 'fontScale',
} as const;
