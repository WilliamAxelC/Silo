import { Appearance } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useSettingsStore, handleAppearanceChange } from '../useSettingsStore';
import { db } from '../../db/index';
import { useAIStore } from '../useAIStore';
import { EXTERNAL_API_PRESETS, MODEL_CATALOG } from '../../features/transactions/constants';

// Mock DB
jest.mock('../../db/index', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => []),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn(() => Promise.resolve()),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve()),
      })),
    })),
  },
}));

// Mock useAIStore
jest.mock('../useAIStore', () => {
  const state = {
    setLocalModelTarget: jest.fn(),
  };
  return {
    useAIStore: {
      getState: jest.fn(() => state),
    },
  };
});

describe('useSettingsStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadSettings', () => {
    it('loads settings from appSettings database table and resolves dark mode and model target', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => [
          { key: 'themeMode', value: 'dark' },
          { key: 'currencyCode', value: 'USD' },
          { key: 'useThousandsSeparator', value: 'false' },
          { key: 'activeModelId', value: 'qwen3.5-2b' },
          { key: 'fontScale', value: '1.1' },
        ]),
      });

      await useSettingsStore.getState().loadSettings();

      const state = useSettingsStore.getState();
      expect(state.isLoaded).toBe(true);
      expect(state.themeMode).toBe('dark');
      expect(state.isDarkMode).toBe(true);
      expect(state.currencyCode).toBe('USD');
      expect(state.useThousandsSeparator).toBe(false);
      expect(state.activeModelId).toBe('qwen3.5-2b');
      expect(state.fontScale).toBe(1.1);

      const aiStore = useAIStore.getState();
      expect(aiStore.setLocalModelTarget).toHaveBeenCalledWith('qwen3.5-2b', 'Qwen 3.5 2B (Offline)');
    });
  });

  describe('Theme resolution', () => {
    it('sets theme mode to light and updates isDarkMode to false', async () => {
      await useSettingsStore.getState().setThemeMode('light');

      const state = useSettingsStore.getState();
      expect(state.themeMode).toBe('light');
      expect(state.isDarkMode).toBe(false);
    });

    it('sets theme mode to dark and updates isDarkMode to true', async () => {
      await useSettingsStore.getState().setThemeMode('dark');

      const state = useSettingsStore.getState();
      expect(state.themeMode).toBe('dark');
      expect(state.isDarkMode).toBe(true);
    });

    it('sets theme mode to system and derives isDarkMode from Appearance', async () => {
      const spy = jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('dark');
      await useSettingsStore.getState().setThemeMode('system');

      let state = useSettingsStore.getState();
      expect(state.themeMode).toBe('system');
      expect(state.isDarkMode).toBe(true);

      spy.mockReturnValue('light');
      await useSettingsStore.getState().setThemeMode('system');
      state = useSettingsStore.getState();
      expect(state.themeMode).toBe('system');
      expect(state.isDarkMode).toBe(false);

      spy.mockRestore();
    });

    it('syncs isDarkMode when Appearance change listener triggers for system theme', () => {
      useSettingsStore.setState({ themeMode: 'system', isDarkMode: false });

      handleAppearanceChange({ colorScheme: 'dark' });
      expect(useSettingsStore.getState().isDarkMode).toBe(true);

      handleAppearanceChange({ colorScheme: 'light' });
      expect(useSettingsStore.getState().isDarkMode).toBe(false);

      // Does not alter dark mode if themeMode is manual
      useSettingsStore.setState({ themeMode: 'light', isDarkMode: false });
      handleAppearanceChange({ colorScheme: 'dark' });
      expect(useSettingsStore.getState().isDarkMode).toBe(false);
    });

    it('subscribes once to Appearance change listener upon module load', () => {
      let registeredListener: any;
      jest.isolateModules(() => {
        const { Appearance: isolatedAppearance } = require('react-native');
        const spy = jest.spyOn(isolatedAppearance, 'addChangeListener');
        require('../useSettingsStore');
        expect(spy).toHaveBeenCalledWith(expect.any(Function));
        registeredListener = spy.mock.calls[0][0];
      });
      expect(typeof registeredListener).toBe('function');
    });
  });

  describe('Currency and display preferences', () => {
    it('updates currency code and persists to db', async () => {
      await useSettingsStore.getState().setCurrencyCode('EUR');
      expect(useSettingsStore.getState().currencyCode).toBe('EUR');
    });

    it('toggles useThousandsSeparator', async () => {
      await useSettingsStore.getState().setUseThousandsSeparator(false);
      expect(useSettingsStore.getState().useThousandsSeparator).toBe(false);

      await useSettingsStore.getState().setUseThousandsSeparator(true);
      expect(useSettingsStore.getState().useThousandsSeparator).toBe(true);
    });

    it('updates date format', async () => {
      await useSettingsStore.getState().setDateFormat('dd.MM.yyyy');
      expect(useSettingsStore.getState().dateFormat).toBe('dd.MM.yyyy');
    });

    it('updates showIncomeInReportsFirst', async () => {
      await useSettingsStore.getState().setShowIncomeInReportsFirst(true);
      expect(useSettingsStore.getState().showIncomeInReportsFirst).toBe(true);
    });

    it('updates font scale', async () => {
      await useSettingsStore.getState().setFontScale(1.2);
      expect(useSettingsStore.getState().fontScale).toBe(1.2);
    });
  });

  describe('AI and OCR settings', () => {
    it('updates AI inference mode between local and external', async () => {
      await useSettingsStore.getState().setAiInferenceMode('external');
      expect(useSettingsStore.getState().aiInferenceMode).toBe('external');

      await useSettingsStore.getState().setAiInferenceMode('local');
      expect(useSettingsStore.getState().aiInferenceMode).toBe('local');
    });

    it('updates active model ID and syncs with AI store', async () => {
      await useSettingsStore.getState().setActiveModelId('qwen3.5-2b');
      expect(useSettingsStore.getState().activeModelId).toBe('qwen3.5-2b');

      const aiStore = useAIStore.getState();
      expect(aiStore.setLocalModelTarget).toHaveBeenCalledWith('qwen3.5-2b', 'Qwen 3.5 2B (Offline)');
    });

    it('toggles AI wifi-only download', async () => {
      await useSettingsStore.getState().setAiWifiOnlyDownload(false);
      expect(useSettingsStore.getState().aiWifiOnlyDownload).toBe(false);
    });
  });

  describe('External API provider configuration', () => {
    it('auto-populates presets when setting known external API providers', async () => {
      await useSettingsStore.getState().setExternalApiProvider('deepseek');
      const state = useSettingsStore.getState();
      expect(state.externalApiProvider).toBe('deepseek');
      expect(state.externalApiUrl).toBe(EXTERNAL_API_PRESETS.deepseek.url);
      expect(state.externalApiModel).toBe(EXTERNAL_API_PRESETS.deepseek.model);

      await useSettingsStore.getState().setExternalApiProvider('groq');
      expect(useSettingsStore.getState().externalApiUrl).toBe(EXTERNAL_API_PRESETS.groq.url);
      expect(useSettingsStore.getState().externalApiModel).toBe(EXTERNAL_API_PRESETS.groq.model);
    });

    it('maintains custom parameters when provider is "custom"', async () => {
      await useSettingsStore.getState().setExternalApiProvider('custom');
      expect(useSettingsStore.getState().externalApiProvider).toBe('custom');
    });

    it('sets external API credentials and custom headers to SecureStore only', async () => {
      (db.insert as jest.Mock).mockClear();

      await useSettingsStore.getState().setExternalApiKey('sk-123456');
      expect(useSettingsStore.getState().externalApiKey).toBe('sk-123456');
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith('externalApiKey', 'sk-123456');
      expect(db.insert).not.toHaveBeenCalled();

      await useSettingsStore.getState().setExternalApiCustomHeaders('{"Authorization": "Bearer custom"}');
      expect(useSettingsStore.getState().externalApiCustomHeaders).toBe('{"Authorization": "Bearer custom"}');
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith('externalApiCustomHeaders', '{"Authorization": "Bearer custom"}');
      expect(db.insert).not.toHaveBeenCalled();

      await useSettingsStore.getState().setExternalApiUrl('https://my-custom-proxy.com/v1');
      expect(useSettingsStore.getState().externalApiUrl).toBe('https://my-custom-proxy.com/v1');
      expect(db.insert).toHaveBeenCalled();

      await useSettingsStore.getState().setExternalApiModel('custom-llm-v1');
      expect(useSettingsStore.getState().externalApiModel).toBe('custom-llm-v1');
    });

    it('migrates legacy plaintext externalApiKey and headers from app_settings to SecureStore and deletes them', async () => {
      (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => [
          { key: 'externalApiKey', value: 'sk-legacy-secret' },
          { key: 'externalApiCustomHeaders', value: '{"X-Legacy": "1"}' },
          { key: 'themeMode', value: 'dark' },
        ]),
      });

      await useSettingsStore.getState().loadSettings();

      expect(SecureStore.setItemAsync).toHaveBeenCalledWith('externalApiKey', 'sk-legacy-secret');
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith('externalApiCustomHeaders', '{"X-Legacy": "1"}');
      expect(db.delete).toHaveBeenCalledTimes(2);
      expect(useSettingsStore.getState().externalApiKey).toBe('sk-legacy-secret');
      expect(useSettingsStore.getState().externalApiCustomHeaders).toBe('{"X-Legacy": "1"}');
    });
  });

  describe('System prompt customization', () => {
    it('sets local and external system prompts', async () => {
      await useSettingsStore.getState().setLocalSystemPrompt('You are a strictly offline accountant.');
      expect(useSettingsStore.getState().localSystemPrompt).toBe('You are a strictly offline accountant.');

      await useSettingsStore.getState().setExternalSystemPrompt('You are an expert cloud financial planner.');
      expect(useSettingsStore.getState().externalSystemPrompt).toBe('You are an expert cloud financial planner.');
    });
  });

  describe('Receipt reading mode', () => {
    it('defaults to ocr', () => {
      expect(useSettingsStore.getState().receiptReadingMode).toBe('ocr');
    });

    it('sets receipt reading mode to vision and persists to db', async () => {
      (db.insert as jest.Mock).mockClear();
      await useSettingsStore.getState().setReceiptReadingMode('vision');
      expect(useSettingsStore.getState().receiptReadingMode).toBe('vision');
      expect(db.insert).toHaveBeenCalled();

      await useSettingsStore.getState().setReceiptReadingMode('ocr');
      expect(useSettingsStore.getState().receiptReadingMode).toBe('ocr');
    });

    it('loads receipt reading mode from database rows', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => [
          { key: 'receiptReadingMode', value: 'vision' },
        ]),
      });

      await useSettingsStore.getState().loadSettings();
      expect(useSettingsStore.getState().receiptReadingMode).toBe('vision');
    });
  });

  describe('Daily reminder and period start preferences', () => {
    it('updates dailyReminderEnabled, dailyReminderTime, monthStartDay (clamped), and weekStartDay', async () => {
      await useSettingsStore.getState().setDailyReminderEnabled(true);
      expect(useSettingsStore.getState().dailyReminderEnabled).toBe(true);

      await useSettingsStore.getState().setDailyReminderTime('09:15');
      expect(useSettingsStore.getState().dailyReminderTime).toBe('09:15');

      await useSettingsStore.getState().setMonthStartDay(25);
      expect(useSettingsStore.getState().monthStartDay).toBe(25);

      await useSettingsStore.getState().setMonthStartDay(35);
      expect(useSettingsStore.getState().monthStartDay).toBe(28);

      await useSettingsStore.getState().setWeekStartDay('sunday');
      expect(useSettingsStore.getState().weekStartDay).toBe('sunday');

      // Restore defaults
      await useSettingsStore.getState().setDailyReminderEnabled(false);
      await useSettingsStore.getState().setDailyReminderTime('20:00');
      await useSettingsStore.getState().setMonthStartDay(1);
      await useSettingsStore.getState().setWeekStartDay('monday');
    });

    it('loads daily reminder and period start settings from database rows', async () => {
      (db.select as jest.Mock).mockReturnValueOnce({
        from: jest.fn(() => [
          { key: 'dailyReminderEnabled', value: 'true' },
          { key: 'dailyReminderTime', value: '21:30' },
          { key: 'monthStartDay', value: '25' },
          { key: 'weekStartDay', value: 'sunday' },
        ]),
      });

      await useSettingsStore.getState().loadSettings();
      const state = useSettingsStore.getState();
      expect(state.dailyReminderEnabled).toBe(true);
      expect(state.dailyReminderTime).toBe('21:30');
      expect(state.monthStartDay).toBe(25);
      expect(state.weekStartDay).toBe('sunday');
    });
  });
});
