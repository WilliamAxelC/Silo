import { create } from 'zustand';
import { eq } from 'drizzle-orm';

import { db } from '../db/index';
import { appSettings } from '../db/schema';
import { parseSettingsRows, serializeSettingValue, getInitialAppSettings } from '../features/transactions/categories';
import type { AppSettings, ThemeMode } from '../features/transactions/types';

interface SettingsState extends AppSettings {
  isLoaded: boolean;
  isDarkMode: boolean;
  loadSettings: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setCurrencyCode: (currencyCode: string) => Promise<void>;
  setUseThousandsSeparator: (enabled: boolean) => Promise<void>;
  setDateFormat: (dateFormat: string) => Promise<void>;
  setShowIncomeInReportsFirst: (enabled: boolean) => Promise<void>;
  setFontScale: (fontScale: number) => Promise<void>;
}

function deriveIsDarkMode(themeMode: ThemeMode): boolean {
  if (themeMode === 'light') {
    return false;
  }

  return themeMode === 'dark';
}

async function saveSetting(key: keyof AppSettings, value: string | boolean | number) {
  const stringValue = serializeSettingValue(value);
  const existing = await db.select().from(appSettings).where(eq(appSettings.key, key));

  if (existing.length > 0) {
    await db.update(appSettings).set({ value: stringValue }).where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value: stringValue });
  }
}

const initialSettings = getInitialAppSettings();

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initialSettings,
  isLoaded: false,
  isDarkMode: deriveIsDarkMode(initialSettings.themeMode),

  loadSettings: async () => {
    const rows = await db.select().from(appSettings);
    const parsed = parseSettingsRows(rows);
    set({
      ...parsed,
      isDarkMode: deriveIsDarkMode(parsed.themeMode),
      isLoaded: true,
    });
  },

  setThemeMode: async (themeMode) => {
    await saveSetting('themeMode', themeMode);
    set({ themeMode, isDarkMode: deriveIsDarkMode(themeMode) });
  },

  setCurrencyCode: async (currencyCode) => {
    await saveSetting('currencyCode', currencyCode);
    set({ currencyCode });
  },

  setUseThousandsSeparator: async (useThousandsSeparator) => {
    await saveSetting('useThousandsSeparator', useThousandsSeparator);
    set({ useThousandsSeparator });
  },

  setDateFormat: async (dateFormat) => {
    await saveSetting('dateFormat', dateFormat);
    set({ dateFormat });
  },

  setShowIncomeInReportsFirst: async (showIncomeInReportsFirst) => {
    await saveSetting('showIncomeInReportsFirst', showIncomeInReportsFirst);
    set({ showIncomeInReportsFirst });
  },

  setFontScale: async (fontScale) => {
    await saveSetting('fontScale', fontScale);
    set({ fontScale });
  },
}));
