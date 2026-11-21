import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { MoreScreen } from '../MoreScreen';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTransactionStore } from '../../store/useTransactionStore';

const ReactTestRenderer = require('react-test-renderer');

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

describe('MoreScreen (F-24, F-25, F-32, NIT-02)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ fontScale: 1 });
    useTransactionStore.setState({
      clearAllData: jest.fn(),
      injectDummyData: jest.fn(),
    } as any);
  });

  it('forwards quick-ask query with autoSend: true on arrow press and keyboard submit, and clears draft (F-32)', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<MoreScreen />);
    });

    const input = renderer.root.findByProps({ accessibilityLabel: 'Ask a finance question' });
    ReactTestRenderer.act(() => {
      input.props.onChangeText('  How much did I spend on food?  ');
    });

    const sendBtn = renderer.root.findByProps({ accessibilityLabel: 'Ask Silo AI' });
    ReactTestRenderer.act(() => {
      sendBtn.props.onPress();
    });

    expect(mockNavigate).toHaveBeenCalledWith('Chatbot', {
      initialMessage: 'How much did I spend on food?',
      autoSend: true,
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Ask a finance question' }).props.value).toBe('');

    // Submitting via keyboard returnKeyType="send" also auto-sends
    mockNavigate.mockClear();
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Ask a finance question' }).props.onChangeText('Compare this month');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Ask a finance question' }).props.onSubmitEditing();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Chatbot', {
      initialMessage: 'Compare this month',
      autoSend: true,
    });

    // Empty submit opens Chatbot without initialMessage or autoSend
    mockNavigate.mockClear();
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Open chatbot' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Chatbot', {});

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('removes top-level System Logs row from MoreScreen (F-24)', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<MoreScreen />);
    });

    const allTexts = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children ?? ''));
    expect(allTexts).not.toContain('System Logs');
    expect(allTexts).toContain('Accounts');
    expect(allTexts).toContain('Recurring');
    expect(allTexts).toContain('Receipt Inbox');
    expect(allTexts).toContain('App Settings');

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('meets >=44pt touch targets on quick-ask controls and scales Dev Tools typography with fontScale (F-25, NIT-02)', () => {
    useSettingsStore.setState({ fontScale: 1.0 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<MoreScreen />);
    });

    const inputStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Ask a finance question' }).props.style);
    const btnStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Open chatbot' }).props.style);
    expect(inputStyle.minHeight).toBeGreaterThanOrEqual(44);
    expect(btnStyle.width).toBeGreaterThanOrEqual(44);
    expect(btnStyle.height).toBeGreaterThanOrEqual(44);

    const getDevSize = () => {
      const node = renderer.root.findAllByType(Text).find((t: any) => t.props.children === 'Inject Dummy Data');
      return StyleSheet.flatten(node.props.style).fontSize;
    };
    const size100 = getDevSize();
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });
    expect(getDevSize()).toBeGreaterThan(size100);

    ReactTestRenderer.act(() => renderer.unmount());
  });
});
