import { useSettingsStore } from '../useSettingsStore';
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
      values: jest.fn(() => Promise.resolve()),
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

    it('sets theme mode to system and derives isDarkMode as false', async () => {
      await useSettingsStore.getState().setThemeMode('system');

      const state = useSettingsStore.getState();
      expect(state.themeMode).toBe('system');
      expect(state.isDarkMode).toBe(false);
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
    it('updates OCR engine ID', async () => {
      await useSettingsStore.getState().setOcrEngineId('paddleocr');
      expect(useSettingsStore.getState().ocrEngineId).toBe('paddleocr');

      await useSettingsStore.getState().setOcrEngineId('external');
      expect(useSettingsStore.getState().ocrEngineId).toBe('external');
    });

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

    it('sets external API credentials and custom headers', async () => {
      await useSettingsStore.getState().setExternalApiKey('sk-123456');
      expect(useSettingsStore.getState().externalApiKey).toBe('sk-123456');

      await useSettingsStore.getState().setExternalApiCustomHeaders('{"Authorization": "Bearer custom"}');
      expect(useSettingsStore.getState().externalApiCustomHeaders).toBe('{"Authorization": "Bearer custom"}');

      await useSettingsStore.getState().setExternalApiUrl('https://my-custom-proxy.com/v1');
      expect(useSettingsStore.getState().externalApiUrl).toBe('https://my-custom-proxy.com/v1');

      await useSettingsStore.getState().setExternalApiModel('custom-llm-v1');
      expect(useSettingsStore.getState().externalApiModel).toBe('custom-llm-v1');
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
});
