import { create } from 'zustand';
import { eq } from 'drizzle-orm';

import { db } from '../db/index';
import { appSettings } from '../db/schema';
import { parseSettingsRows, serializeSettingValue, getInitialAppSettings } from '../features/transactions/categories';
import { EXTERNAL_API_PRESETS, GGUF_QUANTIZATION_PRESETS } from '../features/transactions/constants';
import type { AppSettings, ThemeMode, AIInferenceMode, ExternalAPIProvider, GGUFQuantizationTier } from '../features/transactions/types';
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
  setAiModelQuantization: (quantization: GGUFQuantizationTier) => Promise<void>;
  setAiWifiOnlyDownload: (enabled: boolean) => Promise<void>;
  setAiAutoQuantizationFallback: (enabled: boolean) => Promise<void>;
  setExternalApiProvider: (provider: ExternalAPIProvider) => Promise<void>;
  setExternalApiUrl: (url: string) => Promise<void>;
  setExternalApiModel: (model: string) => Promise<void>;
  setExternalApiKey: (apiKey: string) => Promise<void>;
  setExternalApiCustomHeaders: (headers: string) => Promise<void>;
  setLocalSystemPrompt: (prompt: string) => Promise<void>;
  setExternalSystemPrompt: (prompt: string) => Promise<void>;
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
    const preset = GGUF_QUANTIZATION_PRESETS[parsed.aiModelQuantization] || GGUF_QUANTIZATION_PRESETS.Q5_K_M;
    useAIStore.getState().setLocalModelTarget(preset.version, preset.label);
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

  setAiModelQuantization: async (aiModelQuantization) => {
    await saveSetting('aiModelQuantization', aiModelQuantization);
    set({ aiModelQuantization });
    const preset = GGUF_QUANTIZATION_PRESETS[aiModelQuantization] || GGUF_QUANTIZATION_PRESETS.Q5_K_M;
    useAIStore.getState().setLocalModelTarget(preset.version, preset.label);
  },

  setAiWifiOnlyDownload: async (aiWifiOnlyDownload) => {
    await saveSetting('aiWifiOnlyDownload', aiWifiOnlyDownload);
    set({ aiWifiOnlyDownload });
  },

  setAiAutoQuantizationFallback: async (aiAutoQuantizationFallback) => {
    await saveSetting('aiAutoQuantizationFallback', aiAutoQuantizationFallback);
    set({ aiAutoQuantizationFallback });
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
}));
