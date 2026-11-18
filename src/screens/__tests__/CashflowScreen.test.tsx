import React from 'react';
import { Text } from 'react-native';
import { CashflowScreen } from '../CashflowScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { UNCATEGORIZED_EXPENSE_LABEL } from '../../features/transactions/constants';

const ReactTestRenderer = require('react-test-renderer');

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
  useFocusEffect: () => {},
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  };
});

describe('CashflowScreen', () => {
  const mockClearError = jest.fn();
  const mockFetchTransactions = jest.fn().mockResolvedValue(undefined);
  const mockSearchTransactions = jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    jest.clearAllMocks();
    const now = new Date();
    useSettingsStore.setState({
      dateFormat: 'id-ID',
      currencyCode: 'IDR',
      useThousandsSeparator: true,
    });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 1,
          merchantName: 'Warung',
          totalAmount: -25000,
          type: 'expense',
          category: '',
          date: now.getTime(),
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
      ],
      error: 'Database read failed',
      clearError: mockClearError,
      fetchTransactions: mockFetchTransactions,
      searchTransactions: mockSearchTransactions,
    } as any);
  });

  it('drops bottom SafeArea edge, renders dismissible error banner, uses id-ID locale and UNCATEGORIZED_EXPENSE_LABEL', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    const safeArea = renderer.root.findByType('SafeAreaView');
    expect(safeArea.props.edges).toEqual(['top']);

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(texts.some((t: string) => t.includes('Database read failed'))).toBe(true);
    expect(texts.some((t: string) => t.includes(UNCATEGORIZED_EXPENSE_LABEL))).toBe(true);

    const expectedMonthTitle = new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    expect(texts.some((t: string) => t === expectedMonthTitle)).toBe(true);

    const dismissBtn = renderer.root.findByProps({ accessibilityLabel: 'Dismiss error' });
    ReactTestRenderer.act(() => {
      dismissBtn.props.onPress();
    });
    expect(mockClearError).toHaveBeenCalledTimes(1);

    const prevBtn = renderer.root.findByProps({ accessibilityLabel: 'Previous month' });
    const nextBtn = renderer.root.findByProps({ accessibilityLabel: 'Next month' });
    expect(prevBtn.props.accessibilityRole).toBe('button');
    expect(nextBtn.props.accessibilityRole).toBe('button');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
