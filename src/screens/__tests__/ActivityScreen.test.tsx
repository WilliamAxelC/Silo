import React from 'react';
import { Text } from 'react-native';
import { ActivityScreen } from '../ActivityScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    const React = require('react');
    React.useEffect(cb, []);
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

describe('ActivityScreen', () => {
  it('lists recent changes, opens a transaction and undoes a change', async () => {
    const undoActivity = jest.fn(async () => ({ ok: true }));
    const now = Date.now();
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, dateFormat: 'en-GB', fontScale: 1 });
    useTransactionStore.setState({
      fetchActivity: jest.fn(),
      undoActivity,
      wallets: [],
      transactionsList: [{ id: 5, merchantName: 'Super Indo', totalAmount: -23695, type: 'expense', category: 'Groceries', date: 1 }],
      activity: [
        {
          id: 2, at: now, action: 'create', entity: 'transaction', entityId: 5, source: 'receipt', undone: false, before: null,
          after: { merchantName: 'Super Indo', totalAmount: -23695, date: new Date(2025, 10, 22).getTime() },
        },
        { id: 1, at: now - 1000, action: 'delete', entity: 'budget', entityId: 3, source: null, undone: true, before: { name: 'Food', amount: 1000000 }, after: null },
      ],
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ActivityScreen />);
    });
    const texts = renderer.root.findAllByType(Text).map((t: any) => [].concat(t.props.children).join(''));
    expect(texts).toContain('Added Super Indo');
    expect(texts.some((t: string) => t.includes('dated 22 Nov 2025 · from Receipt Inbox'))).toBe(true);
    expect(texts).toContain('Deleted budget Food');

    const open = renderer.root.findAll((n: any) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Added Super Indo'))[0];
    ReactTestRenderer.act(() => open.props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('AddTransactionStack', { transactionId: 5 });

    // Already-undone entries don't offer Undo again.
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Undo: Deleted budget Food' })).toHaveLength(0);
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Undo: Added Super Indo' }).props.onPress();
    });
    expect(undoActivity).toHaveBeenCalledWith(2);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
