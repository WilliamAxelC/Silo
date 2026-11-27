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
import { isAccentColor, type AccentColor } from '../theme/colors';

interface SettingsState extends AppSettings {
  isLoaded: boolean;
  secretsLoaded: boolean;
  secretsHydrationError: string | null;
  isDarkMode: boolean;
  loadSettings: () => Promise<void>;
  waitForSettingsLoaded: () => Promise<void>;
  waitForSecretsHydrated: () => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setCurrencyCode: (currencyCode: string) => Promise<void>;
  setUseThousandsSeparator: (enabled: boolean) => Promise<void>;
  setDateFormat: (dateFormat: string) => Promise<void>;
  setShowIncomeInReportsFirst: (enabled: boolean) => Promise<void>;
  setHideTotals: (hidden: boolean) => Promise<void>;
  setAccentColor: (accent: AccentColor) => Promise<void>;
  setPureBlack: (enabled: boolean) => Promise<void>;
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

let secureHydrationToken = 0;
let apiKeyWriteSeq = 0;
let customHeadersWriteSeq = 0;
let activeSettingsLoadPromise: Promise<void> | null = null;
let activeSecretsHydrationPromise: Promise<void> | null = null;

export function isSettingsLoadPending(): boolean {
  return activeSettingsLoadPromise !== null;
}

export function isSecretsHydrationPending(): boolean {
  return activeSecretsHydrationPromise !== null;
}

export async function waitForSettingsLoaded(): Promise<void> {
  while (activeSettingsLoadPromise) {
    const pending = activeSettingsLoadPromise;
    await pending;
  }
}

export async function waitForSecretsHydrated(): Promise<void> {
  while (activeSecretsHydrationPromise) {
    const pending = activeSecretsHydrationPromise;
    await pending;
  }
}

export async function retrySecretsHydrationIfNeeded(): Promise<void> {
  if (activeSecretsHydrationPromise) {
    await waitForSecretsHydrated();
    return;
  }
  const current = useSettingsStore.getState();
  if (!current.secretsHydrationError) {
    return;
  }

  const hydrationToken = ++secureHydrationToken;
  const initialApiKeyWriteSeq = apiKeyWriteSeq;
  const initialHeadersWriteSeq = customHeadersWriteSeq;

  let retryPromise!: Promise<void>;
  retryPromise = (async () => {
    try {
      const [storedApiKey, storedCustomHeaders] = await Promise.all([
        SecureStore.getItemAsync('externalApiKey'),
        SecureStore.getItemAsync('externalApiCustomHeaders'),
      ]);

      if (hydrationToken !== secureHydrationToken) {
        return;
      }

      useSettingsStore.setState((state) => ({
        externalApiKey:
          apiKeyWriteSeq === initialApiKeyWriteSeq ? (storedApiKey ?? state.externalApiKey) : state.externalApiKey,
        externalApiCustomHeaders:
          customHeadersWriteSeq === initialHeadersWriteSeq
            ? (storedCustomHeaders ?? state.externalApiCustomHeaders)
            : state.externalApiCustomHeaders,
        secretsLoaded: true,
        secretsHydrationError: null,
      }));
    } catch (error) {
      console.warn('Failed to retry secure settings hydration:', error);
      if (hydrationToken === secureHydrationToken) {
        useSettingsStore.setState({
          secretsLoaded: false,
          secretsHydrationError: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (activeSecretsHydrationPromise === retryPromise) {
        activeSecretsHydrationPromise = null;
      }
    }
  })();

  activeSecretsHydrationPromise = retryPromise;
  await retryPromise;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initialSettings,
  isLoaded: false,
  secretsLoaded: false,
  secretsHydrationError: null,
  isDarkMode: deriveIsDarkMode(initialSettings.themeMode),

  waitForSettingsLoaded,
  waitForSecretsHydrated,

  loadSettings: () => {
    const hydrationToken = ++secureHydrationToken;
    const initialApiKeyWriteSeq = apiKeyWriteSeq;
    const initialHeadersWriteSeq = customHeadersWriteSeq;

    let resolveSettingsLoaded!: () => void;
    const settingsLoadedPromise = new Promise<void>((resolve) => {
      resolveSettingsLoaded = resolve;
    });
    activeSettingsLoadPromise = settingsLoadedPromise;

    let hydrationPromise!: Promise<void>;
    hydrationPromise = (async () => {
      try {
        let parsed: AppSettings;
        let legacyApiKeyRow: { key: string; value: string } | undefined;
        let legacyHeadersRow: { key: string; value: string } | undefined;

        try {
          const rows = await db.select().from(appSettings);
          parsed = parseSettingsRows(rows);
          legacyApiKeyRow = rows.find((r) => r.key === 'externalApiKey');
          legacyHeadersRow = rows.find((r) => r.key === 'externalApiCustomHeaders');

          // Commit SQLite settings (including appLockEnabled) immediately so startup & AppLockGate
          // never block on Android Keystore IPC (~900 ms) from SecureStore.
          set((state) => ({
            ...parsed,
            externalApiKey: state.externalApiKey || parsed.externalApiKey,
            externalApiCustomHeaders: state.externalApiCustomHeaders || parsed.externalApiCustomHeaders,
            isDarkMode: deriveIsDarkMode(parsed.themeMode),
            isLoaded: true,
            secretsLoaded: false,
            secretsHydrationError: null,
          }));
          const preset = MODEL_CATALOG[parsed.activeModelId] || MODEL_CATALOG[DEFAULT_APP_SETTINGS.activeModelId];
          useAIStore.getState().setLocalModelTarget(preset.id, preset.displayName);
        } finally {
          if (activeSettingsLoadPromise === settingsLoadedPromise) {
            activeSettingsLoadPromise = null;
          }
          resolveSettingsLoaded();
        }

        try {
          const [storedApiKey, storedCustomHeaders] = await Promise.all([
            SecureStore.getItemAsync('externalApiKey'),
            SecureStore.getItemAsync('externalApiCustomHeaders'),
          ]);

          let externalApiKey = storedApiKey;
          if (legacyApiKeyRow) {
            if (externalApiKey === null) {
              externalApiKey = legacyApiKeyRow.value;
              await SecureStore.setItemAsync('externalApiKey', externalApiKey);
            }
            await db.delete(appSettings).where(eq(appSettings.key, 'externalApiKey'));
          }

          let externalApiCustomHeaders = storedCustomHeaders;
          if (legacyHeadersRow) {
            if (externalApiCustomHeaders === null) {
              externalApiCustomHeaders = legacyHeadersRow.value;
              await SecureStore.setItemAsync('externalApiCustomHeaders', externalApiCustomHeaders);
            }
            await db.delete(appSettings).where(eq(appSettings.key, 'externalApiCustomHeaders'));
          }

          if (hydrationToken !== secureHydrationToken) {
            return;
          }

          const resolvedApiKey = externalApiKey ?? parsed.externalApiKey;
          const resolvedCustomHeaders = externalApiCustomHeaders ?? parsed.externalApiCustomHeaders;

          set((state) => {
            const nextApiKey = apiKeyWriteSeq === initialApiKeyWriteSeq ? resolvedApiKey : state.externalApiKey;
            const nextCustomHeaders =
              customHeadersWriteSeq === initialHeadersWriteSeq
                ? resolvedCustomHeaders
                : state.externalApiCustomHeaders;
            if (
              state.secretsLoaded &&
              state.secretsHydrationError === null &&
              nextApiKey === state.externalApiKey &&
              nextCustomHeaders === state.externalApiCustomHeaders
            ) {
              return state;
            }
            return {
              externalApiKey: nextApiKey,
              externalApiCustomHeaders: nextCustomHeaders,
              secretsLoaded: true,
              secretsHydrationError: null,
            };
          });
        } catch (error) {
          console.warn('Failed to hydrate secure settings:', error);
          if (hydrationToken === secureHydrationToken) {
            set({
              secretsLoaded: false,
              secretsHydrationError: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        if (activeSecretsHydrationPromise === hydrationPromise) {
          activeSecretsHydrationPromise = null;
        }
      }
    })();

    activeSecretsHydrationPromise = hydrationPromise;
    return hydrationPromise;
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

  // Flip the screen first so one tap hides the totals instantly, then persist.
  // A failed save only means the choice is forgotten on restart, so it never throws.
  setHideTotals: async (hideTotals) => {
    set({ hideTotals });
    try {
      await saveSetting('hideTotals', hideTotals);
    } catch (error) {
      console.warn('[Settings] Could not save hideTotals', error);
    }
  },

  setAccentColor: async (accentColor) => {
    if (!isAccentColor(accentColor)) return;
    await saveSetting('accentColor', accentColor);
    set({ accentColor });
  },

  setPureBlack: async (pureBlack) => {
    await saveSetting('pureBlack', pureBlack);
    set({ pureBlack });
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
    apiKeyWriteSeq += 1;
    await saveSetting('externalApiKey', externalApiKey);
    set({ externalApiKey, secretsHydrationError: null });
  },

  setExternalApiCustomHeaders: async (externalApiCustomHeaders) => {
    customHeadersWriteSeq += 1;
    await saveSetting('externalApiCustomHeaders', externalApiCustomHeaders);
    set({ externalApiCustomHeaders, secretsHydrationError: null });
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

