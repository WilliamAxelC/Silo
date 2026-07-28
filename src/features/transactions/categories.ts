import type { AppSettings, CategoryRecord, CategoryType, TransactionType } from './types';
import {
  APP_SETTING_KEYS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  UNCATEGORIZED_EXPENSE_LABEL,
  UNCATEGORIZED_INCOME_LABEL,
} from './constants';

export const DEFAULT_CATEGORY_SEEDS: Array<Omit<CategoryRecord, 'id' | 'createdAt'>> = [
  ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ name, type: 'expense' as const, isSystem: true })),
  ...DEFAULT_INCOME_CATEGORIES.map((name) => ({ name, type: 'income' as const, isSystem: true })),
  { name: UNCATEGORIZED_EXPENSE_LABEL, type: 'expense', isSystem: true },
  { name: UNCATEGORIZED_INCOME_LABEL, type: 'income', isSystem: true },
];

const LEGACY_INCOME_CATEGORY_NAMES = new Set<string>(['salary', 'freelance', 'bonus', 'interest', 'investment']);
const LEGACY_EXPENSE_CATEGORY_NAMES = new Set<string>([
  'food & dining',
  'transport',
  'groceries',
  'bills',
  'entertainment',
  'shopping',
  'health',
  'education',
  'travel',
  'home',
]);

export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function getCategoryTypeForTransaction(type: TransactionType): CategoryType {
  return type === 'income' ? 'income' : 'expense';
}

export function getUncategorizedLabel(type: CategoryType): string {
  return type === 'income' ? UNCATEGORIZED_INCOME_LABEL : UNCATEGORIZED_EXPENSE_LABEL;
}

export function inferCategoryType(name: string, transactionType?: string | null): CategoryType {
  const normalized = normalizeCategoryName(name).toLowerCase();

  if (LEGACY_INCOME_CATEGORY_NAMES.has(normalized)) {
    return 'income';
  }

  if (LEGACY_EXPENSE_CATEGORY_NAMES.has(normalized)) {
    return 'expense';
  }

  if (transactionType === 'income') {
    return 'income';
  }

  return 'expense';
}

export function isDuplicateCategory(categories: CategoryRecord[], name: string, type: CategoryType, excludeId?: number): boolean {
  const normalized = normalizeCategoryName(name).toLowerCase();
  return categories.some(
    (category) => category.type === type && category.id !== excludeId && normalizeCategoryName(category.name).toLowerCase() === normalized
  );
}

export function getCategoriesForType(categories: CategoryRecord[], type: CategoryType): CategoryRecord[] {
  return categories.filter((category) => category.type === type).sort((a, b) => a.name.localeCompare(b.name));
}

export function getInitialAppSettings(): AppSettings {
  return {
    themeMode: DEFAULT_APP_SETTINGS.themeMode,
    currencyCode: DEFAULT_APP_SETTINGS.currencyCode,
    useThousandsSeparator: DEFAULT_APP_SETTINGS.useThousandsSeparator,
    dateFormat: DEFAULT_APP_SETTINGS.dateFormat,
    showIncomeInReportsFirst: DEFAULT_APP_SETTINGS.showIncomeInReportsFirst,
    fontScale: DEFAULT_APP_SETTINGS.fontScale,
    aiInferenceMode: DEFAULT_APP_SETTINGS.aiInferenceMode,
    activeModelId: DEFAULT_APP_SETTINGS.activeModelId,
    ocrEngineId: DEFAULT_APP_SETTINGS.ocrEngineId,
    aiWifiOnlyDownload: DEFAULT_APP_SETTINGS.aiWifiOnlyDownload,
    externalApiProvider: DEFAULT_APP_SETTINGS.externalApiProvider,
    externalApiUrl: DEFAULT_APP_SETTINGS.externalApiUrl,
    externalApiModel: DEFAULT_APP_SETTINGS.externalApiModel,
    externalApiKey: DEFAULT_APP_SETTINGS.externalApiKey,
    externalApiCustomHeaders: DEFAULT_APP_SETTINGS.externalApiCustomHeaders,
    localSystemPrompt: DEFAULT_APP_SETTINGS.localSystemPrompt,
    externalSystemPrompt: DEFAULT_APP_SETTINGS.externalSystemPrompt,
  };
}

export function parseSettingsRows(rows: Array<{ key: string; value: string }>): AppSettings {
  const base = getInitialAppSettings();

  rows.forEach((row) => {
    switch (row.key) {
      case APP_SETTING_KEYS.themeMode:
        if (row.value === 'system' || row.value === 'light' || row.value === 'dark') {
          base.themeMode = row.value;
        }
        break;
      case APP_SETTING_KEYS.currencyCode:
        base.currencyCode = row.value || DEFAULT_APP_SETTINGS.currencyCode;
        break;
      case APP_SETTING_KEYS.useThousandsSeparator:
        base.useThousandsSeparator = row.value !== 'false';
        break;
      case APP_SETTING_KEYS.dateFormat:
        base.dateFormat = row.value || DEFAULT_APP_SETTINGS.dateFormat;
        break;
      case APP_SETTING_KEYS.showIncomeInReportsFirst:
        base.showIncomeInReportsFirst = row.value === 'true';
        break;
      case APP_SETTING_KEYS.fontScale: {
        const nextScale = Number(row.value);
        base.fontScale = Number.isFinite(nextScale) ? Math.min(Math.max(nextScale, 0.9), 1.3) : DEFAULT_APP_SETTINGS.fontScale;
        break;
      }
      case APP_SETTING_KEYS.aiInferenceMode:
        if (row.value === 'local' || row.value === 'external') {
          base.aiInferenceMode = row.value;
        }
        break;
      case APP_SETTING_KEYS.activeModelId:
        if (typeof row.value === 'string' && row.value.length > 0) {
          base.activeModelId = row.value;
        }
        break;
      case APP_SETTING_KEYS.ocrEngineId:
        if (row.value === 'mlkit' || row.value === 'paddleocr' || row.value === 'external') {
          base.ocrEngineId = row.value;
        }
        break;
      case APP_SETTING_KEYS.aiWifiOnlyDownload:
        base.aiWifiOnlyDownload = row.value === 'true';
        break;
      case APP_SETTING_KEYS.externalApiProvider:
        if (row.value === 'openai' || row.value === 'deepseek' || row.value === 'groq' || row.value === 'ollama' || row.value === 'together' || row.value === 'custom') {
          base.externalApiProvider = row.value;
        }
        break;
      case APP_SETTING_KEYS.externalApiUrl:
        base.externalApiUrl = row.value || DEFAULT_APP_SETTINGS.externalApiUrl;
        break;
      case APP_SETTING_KEYS.externalApiModel:
        base.externalApiModel = row.value || DEFAULT_APP_SETTINGS.externalApiModel;
        break;
      case APP_SETTING_KEYS.externalApiKey:
        base.externalApiKey = row.value ?? DEFAULT_APP_SETTINGS.externalApiKey;
        break;
      case APP_SETTING_KEYS.externalApiCustomHeaders:
        base.externalApiCustomHeaders = row.value ?? DEFAULT_APP_SETTINGS.externalApiCustomHeaders;
        break;
      case APP_SETTING_KEYS.localSystemPrompt:
        base.localSystemPrompt = row.value ?? DEFAULT_APP_SETTINGS.localSystemPrompt;
        break;
      case APP_SETTING_KEYS.externalSystemPrompt:
        base.externalSystemPrompt = row.value ?? DEFAULT_APP_SETTINGS.externalSystemPrompt;
        break;
      default:
        break;
    }
  });

  return base;
}

export function serializeSettingValue(value: string | boolean | number): string {
  return String(value);
}
