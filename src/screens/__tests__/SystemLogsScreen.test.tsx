import React from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import { SystemLogsScreen } from '../SystemLogsScreen';
import { useAIStore, createInitialProvisioningSnapshot, createInitialRuntimeSnapshot } from '../../store/useAIStore';
import { useSettingsStore } from '../../store/useSettingsStore';

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

  it('scales filter pills, runtime diagnostics summary, and log rows with fontScale (R3A-08)', () => {
    useSettingsStore.setState({ fontScale: 1.0 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<SystemLogsScreen />);
    });

    const getSize = (label: string) => {
      const node = renderer.root.findAllByType(Text).find((t: any) => {
        const text = Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '');
        return text === label;
      });
      return StyleSheet.flatten(node.props.style).fontSize;
    };

    const sizes100 = {
      filterPill: getSize('ALL'),
      summaryTitle: getSize('Runtime Diagnostics'),
      logEvent: getSize('model.load'),
      logMessage: getSize('Loaded model cleanly'),
    };

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });

    expect(getSize('ALL')).toBeGreaterThan(sizes100.filterPill);
    expect(getSize('Runtime Diagnostics')).toBeGreaterThan(sizes100.summaryTitle);
    expect(getSize('model.load')).toBeGreaterThan(sizes100.logEvent);
    expect(getSize('Loaded model cleanly')).toBeGreaterThan(sizes100.logMessage);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
