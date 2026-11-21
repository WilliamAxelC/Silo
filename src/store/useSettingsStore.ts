import { create } from 'zustand';
import { eq } from 'drizzle-orm';
import { Appearance, type ColorSchemeName } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { db } from '../db/index';
import { appSettings } from '../db/schema';
import { parseSettingsRows, serializeSettingValue, getInitialAppSettings } from '../features/transactions/categories';
import { DEFAULT_APP_SETTINGS, EXTERNAL_API_PRESETS, MODEL_CATALOG } from '../features/transactions/constants';
import { clampMonthStartDay } from '../features/transactions/periods';
import type { AppSettings, ThemeMode, AIInferenceMode, ExternalAPIProvider, WeekStartDay } from '../features/transactions/types';
import { useAIStore } from './useAIStore';

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
  setAiInferenceMode: (mode: AIInferenceMode) => Promise<void>;
  setActiveModelId: (modelId: string) => Promise<void>;
  setAiWifiOnlyDownload: (enabled: boolean) => Promise<void>;
  setExternalApiProvider: (provider: ExternalAPIProvider) => Promise<void>;
  setExternalApiUrl: (url: string) => Promise<void>;
  setExternalApiModel: (model: string) => Promise<void>;
  setExternalApiKey: (apiKey: string) => Promise<void>;
  setExternalApiCustomHeaders: (headers: string) => Promise<void>;
  setLocalSystemPrompt: (prompt: string) => Promise<void>;
  setExternalSystemPrompt: (prompt: string) => Promise<void>;
  setReceiptReadingMode: (mode: 'ocr' | 'vision') => Promise<void>;
  setAppLockEnabled: (enabled: boolean) => Promise<void>;
  setDailyReminderEnabled: (enabled: boolean) => Promise<void>;
  setDailyReminderTime: (time: string) => Promise<void>;
  setMonthStartDay: (day: number) => Promise<void>;
  setWeekStartDay: (day: WeekStartDay) => Promise<void>;
  setHasCompletedOnboarding: (completed: boolean) => Promise<void>;
}

function deriveIsDarkMode(themeMode: ThemeMode): boolean {
  if (themeMode === 'light') {
    return false;
  }
  if (themeMode === 'dark') {
    return true;
  }

  return Appearance.getColorScheme() === 'dark';
}

async function saveSetting(key: keyof AppSettings, value: string | boolean | number) {
  if (key === 'externalApiKey' || key === 'externalApiCustomHeaders') {
    await SecureStore.setItemAsync(key, String(value));
    return;
  }

  const stringValue = serializeSettingValue(value);
  await db
    .insert(appSettings)
    .values({ key, value: stringValue })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: stringValue },
    });
}

const initialSettings = getInitialAppSettings();

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initialSettings,
  isLoaded: false,
  isDarkMode: deriveIsDarkMode(initialSettings.themeMode),

  loadSettings: async () => {
    const rows = await db.select().from(appSettings);
    const parsed = parseSettingsRows(rows);

    let externalApiKey = await SecureStore.getItemAsync('externalApiKey');
    const legacyApiKeyRow = rows.find((r) => r.key === 'externalApiKey');
    if (legacyApiKeyRow) {
      if (externalApiKey === null) {
        externalApiKey = legacyApiKeyRow.value;
        await SecureStore.setItemAsync('externalApiKey', externalApiKey);
      }
      await db.delete(appSettings).where(eq(appSettings.key, 'externalApiKey'));
    }

    let externalApiCustomHeaders = await SecureStore.getItemAsync('externalApiCustomHeaders');
    const legacyHeadersRow = rows.find((r) => r.key === 'externalApiCustomHeaders');
    if (legacyHeadersRow) {
      if (externalApiCustomHeaders === null) {
        externalApiCustomHeaders = legacyHeadersRow.value;
        await SecureStore.setItemAsync('externalApiCustomHeaders', externalApiCustomHeaders);
      }
      await db.delete(appSettings).where(eq(appSettings.key, 'externalApiCustomHeaders'));
    }

    const resolvedApiKey = externalApiKey ?? parsed.externalApiKey;
    const resolvedCustomHeaders = externalApiCustomHeaders ?? parsed.externalApiCustomHeaders;

    set({
      ...parsed,
      externalApiKey: resolvedApiKey,
      externalApiCustomHeaders: resolvedCustomHeaders,
      isDarkMode: deriveIsDarkMode(parsed.themeMode),
      isLoaded: true,
    });
    const preset = MODEL_CATALOG[parsed.activeModelId] || MODEL_CATALOG[DEFAULT_APP_SETTINGS.activeModelId];
    useAIStore.getState().setLocalModelTarget(preset.id, preset.displayName);
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

  setAiInferenceMode: async (aiInferenceMode) => {
    await saveSetting('aiInferenceMode', aiInferenceMode);
    set({ aiInferenceMode });
  },

  setActiveModelId: async (activeModelId) => {
    await saveSetting('activeModelId', activeModelId);
    set({ activeModelId });
    const preset = MODEL_CATALOG[activeModelId] || MODEL_CATALOG[DEFAULT_APP_SETTINGS.activeModelId];
    useAIStore.getState().setLocalModelTarget(preset.id, preset.displayName);
  },

  setAiWifiOnlyDownload: async (aiWifiOnlyDownload) => {
    await saveSetting('aiWifiOnlyDownload', aiWifiOnlyDownload);
    set({ aiWifiOnlyDownload });
  },

  setExternalApiProvider: async (externalApiProvider) => {
    await saveSetting('externalApiProvider', externalApiProvider);
    const preset = EXTERNAL_API_PRESETS[externalApiProvider];
    if (preset && externalApiProvider !== 'custom') {
      await saveSetting('externalApiUrl', preset.url);
      await saveSetting('externalApiModel', preset.model);
      set({ externalApiProvider, externalApiUrl: preset.url, externalApiModel: preset.model });
    } else {
      set({ externalApiProvider });
    }
  },

  setExternalApiUrl: async (externalApiUrl) => {
    await saveSetting('externalApiUrl', externalApiUrl);
    set({ externalApiUrl });
  },

  setExternalApiModel: async (externalApiModel) => {
    await saveSetting('externalApiModel', externalApiModel);
    set({ externalApiModel });
  },

  setExternalApiKey: async (externalApiKey) => {
    await saveSetting('externalApiKey', externalApiKey);
    set({ externalApiKey });
  },

  setExternalApiCustomHeaders: async (externalApiCustomHeaders) => {
    await saveSetting('externalApiCustomHeaders', externalApiCustomHeaders);
    set({ externalApiCustomHeaders });
  },

  setLocalSystemPrompt: async (localSystemPrompt) => {
    await saveSetting('localSystemPrompt', localSystemPrompt);
    set({ localSystemPrompt });
  },

  setExternalSystemPrompt: async (externalSystemPrompt) => {
    await saveSetting('externalSystemPrompt', externalSystemPrompt);
    set({ externalSystemPrompt });
  },

  setReceiptReadingMode: async (receiptReadingMode) => {
    await saveSetting('receiptReadingMode', receiptReadingMode);
    set({ receiptReadingMode });
  },

  setAppLockEnabled: async (appLockEnabled) => {
    await saveSetting('appLockEnabled', appLockEnabled);
    set({ appLockEnabled });
  },

  setDailyReminderEnabled: async (dailyReminderEnabled) => {
    await saveSetting('dailyReminderEnabled', dailyReminderEnabled);
    set({ dailyReminderEnabled });
  },

  setDailyReminderTime: async (dailyReminderTime) => {
    await saveSetting('dailyReminderTime', dailyReminderTime);
    set({ dailyReminderTime });
  },

  setMonthStartDay: async (day) => {
    const monthStartDay = clampMonthStartDay(day);
    await saveSetting('monthStartDay', monthStartDay);
    set({ monthStartDay });
  },

  setWeekStartDay: async (weekStartDay) => {
    await saveSetting('weekStartDay', weekStartDay);
    set({ weekStartDay });
  },

  setHasCompletedOnboarding: async (hasCompletedOnboarding) => {
    await saveSetting('hasCompletedOnboarding', hasCompletedOnboarding);
    set({ hasCompletedOnboarding });
  },
}));

export function handleAppearanceChange(preferences: { colorScheme?: ColorSchemeName | null }) {
  const current = useSettingsStore.getState();
  if (current.themeMode === 'system') {
    const isDark = preferences.colorScheme === 'dark';
    if (current.isDarkMode !== isDark) {
      useSettingsStore.setState({ isDarkMode: isDark });
    }
  }
}

Appearance.addChangeListener(handleAppearanceChange);

