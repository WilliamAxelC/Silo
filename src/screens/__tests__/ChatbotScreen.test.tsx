import React from 'react';
import { FlatList, Text } from 'react-native';
import { ChatbotScreen } from '../ChatbotScreen';
import { useAIStore, createInitialProvisioningSnapshot, createInitialRuntimeSnapshot } from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
  }),
  useRoute: () => ({ params: {} }),
  useFocusEffect: () => {},
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('react-native-markdown-display', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return (props: any) => React.createElement(Text, null, props.children);
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(true),
}));

jest.mock('react-native-gifted-charts', () => {
  const React = require('react');
  return {
    BarChart: (props: any) => React.createElement('BarChart', props),
    LineChart: (props: any) => React.createElement('LineChart', props),
    PieChart: (props: any) => React.createElement('PieChart', props),
  };
});

jest.mock('../../services/ai/generationService', () => ({
  getGenerationService: () => ({
    getSnapshot: () => ({
      isPreparingRuntime: false,
      runtimeStatus: null,
      isGenerating: false,
      generationStatus: null,
    }),
    subscribe: () => ({ unsubscribe: () => {} }),
    scheduleModelUnload: () => {},
    startGeneration: jest.fn(),
    cancelGeneration: jest.fn(),
  }),
}));

jest.mock('../../services/ai/chatRuntimePreloadService', () => ({
  getChatRuntimePreloadService: () => ({
    requestPreload: jest.fn().mockResolvedValue(undefined),
  }),
}));

describe('ChatbotScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({
      aiInferenceMode: 'local',
      externalApiProvider: 'openai',
      externalApiModel: 'gpt-4o-mini',
    });
    const runtime = createInitialRuntimeSnapshot();
    runtime.availability = { available: true, reason: 'android-supported', message: 'Ready' };
    useAIStore.setState({
      chatHistory: [],
      selectedMode: 'rag',
      runtimeReady: false,
      warmupPending: false,
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

    const firstSuggestion = renderer.root.findByProps({ accessibilityLabel: 'What is my total balance?' });
    expect(firstSuggestion.props.accessibilityRole).toBe('button');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
