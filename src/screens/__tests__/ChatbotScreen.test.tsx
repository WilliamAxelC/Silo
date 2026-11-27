import React from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, Text, TextInput } from 'react-native';
import { ChatbotScreen } from '../ChatbotScreen';
import {
  getAIRuntimeAvailability,
  useAIStore,
  createInitialProvisioningSnapshot,
  createInitialRuntimeSnapshot,
} from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { ChatRuntimePreloadSnapshot } from '../../services/ai/chatRuntimePreloadService';
import type { GenerationServiceRuntimeSnapshot } from '../../services/ai/generationService';

const ReactTestRenderer = require('react-test-renderer');

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => {
  const ReactLib = require('react');
  return {
    useNavigation: () => ({
      navigate: mockNavigate,
      goBack: mockGoBack,
    }),
    useRoute: () => ({ params: {} }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      ReactLib.useEffect(() => effect(), [effect]);
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('react-native-markdown-display', () => {
  const ReactLib = require('react');
  const { Text: RNText } = require('react-native');
  return (props: any) => ReactLib.createElement(RNText, null, props.children);
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(true),
}));

jest.mock('react-native-gifted-charts', () => {
  const ReactLib = require('react');
  return {
    BarChart: (props: any) => ReactLib.createElement('BarChart', props),
    LineChart: (props: any) => ReactLib.createElement('LineChart', props),
    PieChart: (props: any) => ReactLib.createElement('PieChart', props),
  };
});

const mockLifecycleEnsureInitialized = jest.fn().mockResolvedValue(undefined);
const mockLifecycleRetryProvisioning = jest.fn().mockResolvedValue(undefined);
const mockLifecycleCancelDownload = jest.fn().mockResolvedValue(undefined);

jest.mock('../../services/ai/modelLifecycle', () => ({
  getModelLifecycleManager: () => ({
    ensureInitialized: mockLifecycleEnsureInitialized,
    retryProvisioning: mockLifecycleRetryProvisioning,
    cancelDownload: mockLifecycleCancelDownload,
  }),
}));

let mockGenerationSnapshot: GenerationServiceRuntimeSnapshot = {
  isPreparingRuntime: false,
  runtimeStatus: '',
  isGenerating: false,
  generationStatus: '',
};
const mockScheduleModelUnload = jest.fn();
const mockCancelScheduledUnload = jest.fn();
const mockStartGeneration = jest.fn();
const mockCancelGeneration = jest.fn();

jest.mock('../../services/ai/generationService', () => ({
  getGenerationService: () => ({
    getSnapshot: () => mockGenerationSnapshot,
    subscribe: (listener: (s: GenerationServiceRuntimeSnapshot) => void) => {
      listener(mockGenerationSnapshot);
      return { unsubscribe: () => {} };
    },
    scheduleModelUnload: mockScheduleModelUnload,
    cancelScheduledUnload: mockCancelScheduledUnload,
    startGeneration: mockStartGeneration,
    cancelGeneration: mockCancelGeneration,
  }),
}));

let mockPreloadSnapshot: ChatRuntimePreloadSnapshot = {
  requested: false,
  isPreloading: false,
  status: '',
  canPreload: false,
  error: null,
};
const mockRequestPreload = jest.fn().mockResolvedValue(undefined);
const mockRetryPreload = jest.fn().mockResolvedValue(undefined);
const mockClearRequest = jest.fn();

jest.mock('../../services/ai/chatRuntimePreloadService', () => ({
  getChatRuntimePreloadService: () => ({
    getSnapshot: () => mockPreloadSnapshot,
    subscribe: (listener: (s: ChatRuntimePreloadSnapshot) => void) => {
      listener(mockPreloadSnapshot);
      return { unsubscribe: () => {} };
    },
    requestPreload: mockRequestPreload,
    retryPreload: mockRetryPreload,
    clearRequest: mockClearRequest,
  }),
}));

function collectText(renderer: any): string {
  return renderer.root
    .findAllByType(Text)
    .map((t: any) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    })
    .join(' ');
}

describe('ChatbotScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerationSnapshot = {
      isPreparingRuntime: false,
      runtimeStatus: '',
      isGenerating: false,
      generationStatus: '',
    };
    mockPreloadSnapshot = {
      requested: false,
      isPreloading: false,
      status: '',
      canPreload: false,
      error: null,
    };

    useSettingsStore.setState({
      aiInferenceMode: 'local',
      externalApiProvider: 'openai',
      externalApiModel: 'gpt-4o-mini',
    });
    const runtime = createInitialRuntimeSnapshot();
    runtime.availability = { available: true, reason: 'android-supported', message: 'Ready' };
    useAIStore.setState({
      chatHistory: [],
      runtimeReady: false,
      warmupPending: false,
      provisioningHydrated: true,
      localModelDisplayName: 'Qwen 3.5 2B',
      provisioning: { ...createInitialProvisioningSnapshot(), status: 'not-installed' },
      runtime,
    });
  });

  it('uses FlatList for messages and renders "Set up" when not-installed', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ChatbotScreen />);
    });

    const flatList = renderer.root.findByType(FlatList);
    expect(flatList).toBeDefined();

    const setupBtn = renderer.root.findByProps({ accessibilityLabel: 'Set up AI model' });
    const setupTexts = setupBtn.findAllByType(Text).map((t: any) => t.props.children);
    expect(setupTexts).toContain('Set up');

    // Without the model nothing can answer, so the quick questions wait until it is set up.
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'What is my total balance?' })).toHaveLength(0);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('shows setup guidance instead of a loading message when the model is not installed in Chat mode', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ChatbotScreen />);
    });

    const text = collectText(renderer);
    expect(text).toContain('Download the local AI model in Settings');
    expect(text).not.toContain('Loading the offline chatbot on device...');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Set Up AI Model' })).toBeTruthy();

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('shows one stable readable error message with a Retry action when model load fails', () => {
    const errorMessage = 'Model load blocked because the estimated RAM requirement exceeds the safe device memory budget.';
    const runtime = createInitialRuntimeSnapshot();
    runtime.availability = { available: true, reason: 'android-supported', message: 'Ready' };
    runtime.runtimeState = 'failed';
    runtime.lastRuntimeError = {
      code: 'insufficient-memory',
      message: errorMessage,
      recoverable: true,
    };

    mockPreloadSnapshot = {
      requested: true,
      isPreloading: false,
      status: errorMessage,
      canPreload: false,
      error: errorMessage,
    };

    useAIStore.setState({
      provisioning: { ...createInitialProvisioningSnapshot(), status: 'ready', progress: 1 },
      runtime,
      runtimeReady: false,
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ChatbotScreen />);
    });

    const text = collectText(renderer);
    expect(text).toContain(errorMessage);
    expect(text).toContain('Load failed');
    expect(text).not.toContain('Loading the offline chatbot on device...');
    expect(mockRequestPreload).toHaveBeenCalledTimes(1);

    const retryButtons = renderer.root.findAllByProps({ accessibilityLabel: 'Retry loading AI model' });
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);

    ReactTestRenderer.act(() => {
      retryButtons[0].props.onPress();
    });
    expect(mockRetryPreload).toHaveBeenCalledTimes(1);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('has one mode (no Grounded/Chat toggle), preloads on mount and cleans up on screen leave', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ChatbotScreen />);
    });

    expect(mockCancelScheduledUnload).toHaveBeenCalledTimes(1);
    expect(mockRequestPreload).toHaveBeenCalledTimes(1);
    expect(mockScheduleModelUnload).not.toHaveBeenCalled();
    // Merged 2026-11-25: both modes saw the same facts and needed the same model.
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Switch to Grounded mode' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Switch to Chat mode' })).toHaveLength(0);
    expect(collectText(renderer)).not.toContain('Grounded');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
    expect(mockClearRequest).toHaveBeenCalled();
    expect(mockScheduleModelUnload).toHaveBeenCalledWith(30000);
  });

  it('sends quick questions and typed messages in chat mode with thinking off', async () => {
    const runtime = createInitialRuntimeSnapshot();
    runtime.availability = { available: true, reason: 'android-supported', message: 'Ready' };
    runtime.modelLoaded = true;
    runtime.generationHealthy = true;
    runtime.runtimeState = 'healthy';
    mockStartGeneration.mockResolvedValue('Done');

    useAIStore.setState({
      provisioning: { ...createInitialProvisioningSnapshot(), status: 'ready', progress: 1 },
      runtime,
      runtimeReady: true,
    });

    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });

      const ragSuggestion = renderer.root.findByProps({ accessibilityLabel: 'What is my total balance?' });
      await ReactTestRenderer.act(async () => {
        await ragSuggestion.props.onPress();
      });
      // Thinking stays off: Qwen 0.8B and 2B think past the 2048-token context without answering (bench 2026-11-25).
      expect(mockStartGeneration).toHaveBeenLastCalledWith({
        prompt: 'What is my total balance?',
        mode: 'chat',
        disableThinking: true,
      });

      const input = renderer.root.findByType(TextInput);
      ReactTestRenderer.act(() => {
        input.props.onChangeText('How can I save 20% of my income?');
      });
      const sendBtn = renderer.root.findByProps({ accessibilityLabel: 'Send message' });
      await ReactTestRenderer.act(async () => {
        await sendBtn.props.onPress();
      });
      expect(mockStartGeneration).toHaveBeenLastCalledWith({
        prompt: 'How can I save 20% of my income?',
        mode: 'chat',
        disableThinking: true,
      });
    } finally {
      ReactTestRenderer.act(() => {
        renderer?.unmount();
      });
    }
  });

  it('shows Setup failed instead of Load failed when a model download fails', () => {
    const runtime = createInitialRuntimeSnapshot();
    runtime.availability = { available: true, reason: 'android-supported', message: 'Ready' };
    runtime.runtimeState = 'failed';
    runtime.lastRuntimeError = {
      code: 'load-failed',
      message: 'Download interrupted.',
      recoverable: true,
    };

    useAIStore.setState({
      provisioning: {
        ...createInitialProvisioningSnapshot(),
        status: 'failed',
        lastError: 'Download interrupted.',
      },
      runtime,
      runtimeReady: false,
    });

    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });

      const text = collectText(renderer);
      expect(text).toContain('Setup failed');
      expect(text).toContain('Download interrupted.');
      expect(text).not.toContain('Load failed');
      expect(renderer.root.findByProps({ accessibilityLabel: 'Retry AI model setup' })).toBeTruthy();
      expect(renderer.root.findAllByProps({ accessibilityLabel: 'Retry loading AI model' })).toHaveLength(0);
    } finally {
      ReactTestRenderer.act(() => {
        renderer?.unmount();
      });
    }
  });

  it('does not show Load failed or disable chat input on a generation-cancelled error', () => {
    const runtime = createInitialRuntimeSnapshot();
    runtime.availability = { available: true, reason: 'android-supported', message: 'Ready' };
    runtime.modelLoaded = true;
    runtime.generationHealthy = true;
    runtime.runtimeState = 'healthy';
    runtime.lastRuntimeError = {
      code: 'generation-cancelled',
      message: 'Generation cancelled by user.',
      recoverable: true,
    };

    useAIStore.setState({
      provisioning: { ...createInitialProvisioningSnapshot(), status: 'ready', progress: 1 },
      runtime,
      runtimeReady: true,
    });

    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });

      const text = collectText(renderer);
      expect(text).toContain('Ready');
      expect(text).not.toContain('Load failed');
      expect(text).not.toContain('Generation cancelled by user.');

      const input = renderer.root.findByType(TextInput);
      expect(input.props.editable).toBe(true);
      expect(input.props.placeholder).toBe('Ask about your finances or spending...');
    } finally {
      ReactTestRenderer.act(() => {
        renderer?.unmount();
      });
    }
  });

  it('enables KeyboardAvoidingView only while the keyboard is visible on Android', () => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    const listeners: Record<string, Array<() => void>> = {};
    const addListenerSpy = jest.spyOn(Keyboard, 'addListener').mockImplementation((event: any, cb: any) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      return { remove: jest.fn() } as any;
    });

    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });

      const getEnabled = () => renderer.root.findByType(KeyboardAvoidingView).props.enabled;
      expect(getEnabled()).toBe(false);

      ReactTestRenderer.act(() => {
        listeners.keyboardDidShow?.forEach((cb) => cb());
      });
      expect(getEnabled()).toBe(true);

      ReactTestRenderer.act(() => {
        listeners.keyboardDidHide?.forEach((cb) => cb());
      });
      expect(getEnabled()).toBe(false);
    } finally {
      ReactTestRenderer.act(() => {
        renderer?.unmount();
      });
      addListenerSpy.mockRestore();
    }
  });

  it('shows a clear unconfigured message in external API mode when URL or model is missing', () => {
    useSettingsStore.setState({
      aiInferenceMode: 'external',
      externalApiProvider: 'openai',
      externalApiUrl: '',
      externalApiModel: '',
    });
    useAIStore.setState({
      chatHistory: [
        { id: 'u1', role: 'user', text: 'Hello' },
        { id: 'a1', role: 'ai', text: 'Hi there!' },
      ],
    });

    const availability = getAIRuntimeAvailability(useAIStore.getState());
    expect(availability.canRunNativeChat).toBe(false);
    expect(availability.localInferenceStatusMessage).toBe(
      'External API is not configured yet. Set a URL and model in Settings.',
    );

    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });

      const text = collectText(renderer);
      expect(text).toContain('External API is not configured yet. Set a URL and model in Settings.');
      expect(text).toContain('Setup needed');
      expect(text).toContain('OPENAI · Not configured');
      expect(text).not.toContain('Using external API');
      expect(renderer.root.findByProps({ accessibilityLabel: 'Configure external API' })).toBeTruthy();
    } finally {
      ReactTestRenderer.act(() => {
        renderer?.unmount();
      });
    }
  });

  it('calls ensureInitialized on mount and shows checking state instead of Download prompt before provisioning is hydrated (R4-03)', async () => {
    let resolveInit!: () => void;
    mockLifecycleEnsureInitialized.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );

    useAIStore.setState({
      provisioningHydrated: false,
      provisioning: { ...createInitialProvisioningSnapshot(), status: 'not-installed' },
    });

    let renderer: any;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });

      expect(mockLifecycleEnsureInitialized).toHaveBeenCalledTimes(1);
      const beforeText = collectText(renderer);
      expect(beforeText).toContain('Checking');
      expect(beforeText).not.toContain('Download the local AI model in Settings');
      expect(renderer.root.findAllByProps({ accessibilityLabel: 'Set Up AI Model' })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ accessibilityLabel: 'Set up AI model' })).toHaveLength(0);

      // Once hydration finishes with installed model, Download prompt is never shown
      await ReactTestRenderer.act(async () => {
        useAIStore.setState({
          provisioning: { ...createInitialProvisioningSnapshot(), status: 'ready', progress: 1 },
          provisioningHydrated: true,
        });
        resolveInit();
        await Promise.resolve();
      });

      const afterText = collectText(renderer);
      expect(afterText).not.toContain('Download the local AI model in Settings');
      expect(afterText).toContain('Ready');
    } finally {
      ReactTestRenderer.act(() => {
        renderer?.unmount();
      });
    }
  });

  it('lets the user report a finished Silo AI answer, prefilled with the question and answer (Play AI content policy)', () => {
    const { buildAiReportPrefill } = require('../ChatbotScreen');
    expect(buildAiReportPrefill('How much on food?', 'Rp 50.000')).toEqual({
      title: 'Silo AI answer',
      description: "What's wrong with this answer: \n\nQuestion:\nHow much on food?\n\nAnswer:\nRp 50.000",
    });
    expect(buildAiReportPrefill(undefined, 'x'.repeat(5000)).description.length).toBeLessThan(3000);

    useAIStore.setState({
      chatHistory: [
        { id: 'u1', role: 'user', text: 'How much on food?' },
        { id: 'a1', role: 'ai', text: 'Rp 50.000', status: 'complete' },
        { id: 'a2', role: 'ai', text: '', status: 'streaming' },
      ] as any,
    });
    let renderer: any;
    try {
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<ChatbotScreen />);
      });
      const buttons = renderer.root.findAll((n: any) => n.props.testID === 'report-ai-answer' && n.props.onPress, { deep: false });
      expect(buttons).toHaveLength(1);
      ReactTestRenderer.act(() => buttons[0].props.onPress());
      expect(mockNavigate).toHaveBeenCalledWith('Report', {
        kind: 'bug',
        title: 'Silo AI answer',
        description: expect.stringContaining('Question:\nHow much on food?\n\nAnswer:\nRp 50.000'),
      });
    } finally {
      ReactTestRenderer.act(() => renderer?.unmount());
      useAIStore.setState({ chatHistory: [] } as any);
    }
  });
});
