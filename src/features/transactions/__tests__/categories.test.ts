import {
  inferCategoryType,
  normalizeCategoryName,
  isDuplicateCategory,
  getCategoriesForType,
  getCategoryTypeForTransaction,
  getUncategorizedLabel,
  getInitialAppSettings,
  parseSettingsRows,
  serializeSettingValue,
  DEFAULT_CATEGORY_SEEDS,
} from '../categories';
import { APP_SETTING_KEYS, DEFAULT_APP_SETTINGS } from '../constants';
import type { CategoryRecord } from '../types';

describe('categories utilities', () => {
  describe('normalizeCategoryName', () => {
    it('normalizes category names by trimming and collapsing multiple spaces', () => {
      expect(normalizeCategoryName('  Food   &    Dining  ')).toBe('Food & Dining');
      expect(normalizeCategoryName('\tTransport\n')).toBe('Transport');
      expect(normalizeCategoryName('Groceries')).toBe('Groceries');
    });

    it('returns empty string for null, undefined, or empty values', () => {
      expect(normalizeCategoryName('')).toBe('');
      expect(normalizeCategoryName(null)).toBe('');
      expect(normalizeCategoryName(undefined)).toBe('');
      expect(normalizeCategoryName('   ')).toBe('');
    });
  });

  describe('inferCategoryType', () => {
    it('infers legacy income category names as income', () => {
      expect(inferCategoryType('Salary')).toBe('income');
      expect(inferCategoryType('salary')).toBe('income');
      expect(inferCategoryType('  Freelance  ')).toBe('income');
      expect(inferCategoryType('Bonus')).toBe('income');
      expect(inferCategoryType('Interest')).toBe('income');
      expect(inferCategoryType('Investment')).toBe('income');
    });

    it('infers legacy expense category names as expense', () => {
      expect(inferCategoryType('Food & Dining')).toBe('expense');
      expect(inferCategoryType('food & dining')).toBe('expense');
      expect(inferCategoryType('Transport')).toBe('expense');
      expect(inferCategoryType('Groceries')).toBe('expense');
      expect(inferCategoryType('Bills')).toBe('expense');
      expect(inferCategoryType('Entertainment')).toBe('expense');
      expect(inferCategoryType('Shopping')).toBe('expense');
      expect(inferCategoryType('Health')).toBe('expense');
      expect(inferCategoryType('Education')).toBe('expense');
      expect(inferCategoryType('Travel')).toBe('expense');
      expect(inferCategoryType('Home')).toBe('expense');
    });

    it('infers type based on fallback transactionType for non-legacy names', () => {
      expect(inferCategoryType('Crypto Staking', 'income')).toBe('income');
      expect(inferCategoryType('Crypto Staking', 'expense')).toBe('expense');
      expect(inferCategoryType('Side Gig', 'income')).toBe('income');
      expect(inferCategoryType('Car Repair', null)).toBe('expense');
      expect(inferCategoryType(null, 'income')).toBe('income');
      expect(inferCategoryType(undefined, undefined)).toBe('expense');
    });
  });

  describe('isDuplicateCategory', () => {
    const existing: CategoryRecord[] = [
      { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
      { id: 2, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      { id: 3, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1000 },
    ];

    it('detects duplicate categories case-insensitively and space-insensitively', () => {
      expect(isDuplicateCategory(existing, 'food & dining', 'expense')).toBe(true);
      expect(isDuplicateCategory(existing, '  FOOD   &   DINING  ', 'expense')).toBe(true);
      expect(isDuplicateCategory(existing, 'salary', 'income')).toBe(true);
    });

    it('allows identical category names if they belong to different types', () => {
      expect(isDuplicateCategory(existing, 'Food & Dining', 'income')).toBe(false);
      expect(isDuplicateCategory(existing, 'Salary', 'expense')).toBe(false);
    });

    it('allows non-duplicate category names', () => {
      expect(isDuplicateCategory(existing, 'Groceries', 'expense')).toBe(false);
      expect(isDuplicateCategory(existing, 'Investments', 'income')).toBe(false);
    });

    it('excludes the specified id during editing/renaming', () => {
      // Editing category 1 with its own name should not be considered a duplicate
      expect(isDuplicateCategory(existing, 'Food & Dining', 'expense', 1)).toBe(false);
      // Editing category 1 with category 3's name should be a duplicate
      expect(isDuplicateCategory(existing, 'Transport', 'expense', 1)).toBe(true);
    });

    it('returns false for empty or whitespace-only names', () => {
      expect(isDuplicateCategory(existing, '', 'expense')).toBe(false);
      expect(isDuplicateCategory(existing, '   ', 'income')).toBe(false);
    });
  });

  describe('getCategoriesForType', () => {
    it('filters and sorts categories alphabetically by name', () => {
      const categories: CategoryRecord[] = [
        { id: 1, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
        { id: 3, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 4, name: 'Freelance', type: 'income', isSystem: true, createdAt: 1000 },
        { id: 5, name: 'Entertainment', type: 'expense', isSystem: true, createdAt: 1000 },
      ];

      const expenses = getCategoriesForType(categories, 'expense');
      expect(expenses.map((c) => c.name)).toEqual(['Bills', 'Entertainment', 'Transport']);

      const incomes = getCategoriesForType(categories, 'income');
      expect(incomes.map((c) => c.name)).toEqual(['Freelance', 'Salary']);
    });

    it('returns empty array when no categories match the type', () => {
      const categories: CategoryRecord[] = [
        { id: 1, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      ];
      expect(getCategoriesForType(categories, 'expense')).toEqual([]);
    });
  });

  describe('getCategoryTypeForTransaction & getUncategorizedLabel', () => {
    it('maps transaction types to category types', () => {
      expect(getCategoryTypeForTransaction('income')).toBe('income');
      expect(getCategoryTypeForTransaction('expense')).toBe('expense');
      expect(getCategoryTypeForTransaction('transfer')).toBe('expense');
    });

    it('returns correct uncategorized labels', () => {
      expect(getUncategorizedLabel('income')).toBe('Uncategorized Income');
      expect(getUncategorizedLabel('expense')).toBe('Uncategorized Expense');
    });

    it('includes default seeds for both types and uncategorized', () => {
      expect(DEFAULT_CATEGORY_SEEDS.length).toBeGreaterThan(0);
      const uncategorizedSeeds = DEFAULT_CATEGORY_SEEDS.filter((c) => c.name.includes('Uncategorized'));
      expect(uncategorizedSeeds.length).toBe(2);
    });
  });

  describe('parseSettingsRows & serializeSettingValue', () => {
    it('returns initial settings when row array is empty', () => {
      const settings = parseSettingsRows([]);
      expect(settings).toEqual(getInitialAppSettings());
      expect(settings.themeMode).toBe(DEFAULT_APP_SETTINGS.themeMode);
      expect(settings.currencyCode).toBe(DEFAULT_APP_SETTINGS.currencyCode);
    });

    it('parses valid settings rows correctly', () => {
      const rows = [
        { key: APP_SETTING_KEYS.themeMode, value: 'dark' },
        { key: APP_SETTING_KEYS.currencyCode, value: 'USD' },
        { key: APP_SETTING_KEYS.useThousandsSeparator, value: 'false' },
        { key: APP_SETTING_KEYS.dateFormat, value: 'yyyy/MM/dd' },
        { key: APP_SETTING_KEYS.showIncomeInReportsFirst, value: 'true' },
        { key: APP_SETTING_KEYS.fontScale, value: '1.2' },
        { key: APP_SETTING_KEYS.aiInferenceMode, value: 'external' },
        { key: APP_SETTING_KEYS.activeModelId, value: 'qwen3.5-0.5b' },
        { key: APP_SETTING_KEYS.ocrEngineId, value: 'paddleocr' },
        { key: APP_SETTING_KEYS.aiWifiOnlyDownload, value: 'true' },
        { key: APP_SETTING_KEYS.externalApiProvider, value: 'deepseek' },
        { key: APP_SETTING_KEYS.externalApiUrl, value: 'https://api.deepseek.com/v1' },
        { key: APP_SETTING_KEYS.externalApiModel, value: 'deepseek-chat' },
        { key: APP_SETTING_KEYS.externalApiKey, value: 'sk-test-key' },
        { key: APP_SETTING_KEYS.externalApiCustomHeaders, value: '{"X-Custom":"Header"}' },
        { key: APP_SETTING_KEYS.localSystemPrompt, value: 'Local Prompt' },
        { key: APP_SETTING_KEYS.externalSystemPrompt, value: 'External Prompt' },
      ];

      const parsed = parseSettingsRows(rows);
      expect(parsed.themeMode).toBe('dark');
      expect(parsed.currencyCode).toBe('USD');
      expect(parsed.useThousandsSeparator).toBe(false);
      expect(parsed.dateFormat).toBe('yyyy/MM/dd');
      expect(parsed.showIncomeInReportsFirst).toBe(true);
      expect(parsed.fontScale).toBe(1.2);
      expect(parsed.aiInferenceMode).toBe('external');
      expect(parsed.activeModelId).toBe('qwen3.5-0.5b');
      expect(parsed.ocrEngineId).toBe('paddleocr');
      expect(parsed.aiWifiOnlyDownload).toBe(true);
      expect(parsed.externalApiProvider).toBe('deepseek');
      expect(parsed.externalApiUrl).toBe('https://api.deepseek.com/v1');
      expect(parsed.externalApiModel).toBe('deepseek-chat');
      expect(parsed.externalApiKey).toBe('sk-test-key');
      expect(parsed.externalApiCustomHeaders).toBe('{"X-Custom":"Header"}');
      expect(parsed.localSystemPrompt).toBe('Local Prompt');
      expect(parsed.externalSystemPrompt).toBe('External Prompt');
    });

    it('clamps fontScale between 0.9 and 1.3', () => {
      const parsedLow = parseSettingsRows([{ key: APP_SETTING_KEYS.fontScale, value: '0.5' }]);
      expect(parsedLow.fontScale).toBe(0.9);

      const parsedHigh = parseSettingsRows([{ key: APP_SETTING_KEYS.fontScale, value: '2.0' }]);
      expect(parsedHigh.fontScale).toBe(1.3);

      const parsedInvalid = parseSettingsRows([{ key: APP_SETTING_KEYS.fontScale, value: 'not-a-number' }]);
      expect(parsedInvalid.fontScale).toBe(DEFAULT_APP_SETTINGS.fontScale);
    });

    it('ignores invalid enum values and unknown setting keys gracefully', () => {
      const parsed = parseSettingsRows([
        { key: APP_SETTING_KEYS.themeMode, value: 'invalid-theme' },
        { key: APP_SETTING_KEYS.aiInferenceMode, value: 'cloud-gpu' },
        { key: APP_SETTING_KEYS.ocrEngineId, value: 'tesseract' },
        { key: APP_SETTING_KEYS.externalApiProvider, value: 'unsupported-ai' },
        { key: 'unknown_future_key', value: 'future_value' },
      ]);

      expect(parsed.themeMode).toBe(DEFAULT_APP_SETTINGS.themeMode);
      expect(parsed.aiInferenceMode).toBe(DEFAULT_APP_SETTINGS.aiInferenceMode);
      expect(parsed.ocrEngineId).toBe(DEFAULT_APP_SETTINGS.ocrEngineId);
      expect(parsed.externalApiProvider).toBe(DEFAULT_APP_SETTINGS.externalApiProvider);
    });

    it('serializes primitive values to strings correctly', () => {
      expect(serializeSettingValue('hello')).toBe('hello');
      expect(serializeSettingValue(true)).toBe('true');
      expect(serializeSettingValue(false)).toBe('false');
      expect(serializeSettingValue(1.15)).toBe('1.15');
      expect(serializeSettingValue(0)).toBe('0');
    });
  });
});
