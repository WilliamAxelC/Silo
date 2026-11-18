import React from 'react';
import { FlatList } from 'react-native';
import { SystemLogsScreen } from '../SystemLogsScreen';
import { useAIStore, createInitialProvisioningSnapshot, createInitialRuntimeSnapshot } from '../../store/useAIStore';

const ReactTestRenderer = require('react-test-renderer');

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(true),
}));

describe('SystemLogsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAIStore.setState({
      logs: [
        {
          id: 'log-1',
          level: 'info',
          event: 'model.load',
          message: 'Loaded model cleanly',
          timestamp: '2026-01-01T10:00:00.000Z',
        },
      ],
      provisioning: createInitialProvisioningSnapshot(),
      runtime: createInitialRuntimeSnapshot(),
    });
  });

  it('renders logs in a FlatList with accessible header and copy buttons', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<SystemLogsScreen />);
    });

    const flatList = renderer.root.findByType(FlatList);
    expect(flatList.props.data).toHaveLength(1);

    const backBtn = renderer.root.findByProps({ accessibilityLabel: 'Go back' });
    expect(backBtn.props.accessibilityRole).toBe('button');

    const copyAllBtn = renderer.root.findByProps({ accessibilityLabel: 'Copy all logs' });
    expect(copyAllBtn.props.accessibilityRole).toBe('button');

    const copySingleBtn = renderer.root.findByProps({ accessibilityLabel: 'Copy this log' });
    expect(copySingleBtn.props.accessibilityRole).toBe('button');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
