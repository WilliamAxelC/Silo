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

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

describe('CashflowScreen', () => {
  const mockClearError = jest.fn();
  const mockFetchTransactions = jest.fn().mockResolvedValue(undefined);
  const mockSearchTransactions = jest.fn().mockResolvedValue([]);
  const mockSummarizeSearchTransactions = jest
    .fn()
    .mockResolvedValue({ count: 0, totalIn: 0, totalOut: 0, net: 0 });

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
      wallets: [
        { id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 },
        { id: 2, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
      ],
      categories: [
        { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      ],
      clearError: mockClearError,
      fetchTransactions: mockFetchTransactions,
      searchTransactions: mockSearchTransactions,
      summarizeSearchTransactions: mockSummarizeSearchTransactions,
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

  it('filters with an empty search box and shows result count, in, out, and net excluding transfers', async () => {
    const now = Date.now();
    mockSearchTransactions.mockResolvedValue([
      {
        id: 10,
        merchantName: 'Salary',
        totalAmount: 500000,
        type: 'income',
        category: 'Salary',
        date: now,
        walletId: 2,
      },
      {
        id: 11,
        merchantName: 'Lunch',
        totalAmount: -120000,
        type: 'expense',
        category: 'Food & Dining',
        date: now,
        walletId: 2,
      },
      {
        id: 12,
        merchantName: 'Top up',
        totalAmount: -300000,
        type: 'transfer',
        category: 'Transfer',
        date: now,
        walletId: 1,
        toWalletId: 2,
      },
    ]);
    mockSummarizeSearchTransactions.mockResolvedValue({
      count: 3,
      totalIn: 500000,
      totalOut: 120000,
      net: 380000,
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    // Open Account filter with empty search box and select GoPay
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Filter by account' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Account option GoPay' }).props.onPress();
    });

    expect(mockSearchTransactions).toHaveBeenCalledWith('', { walletId: 2 });
    expect(mockSummarizeSearchTransactions).toHaveBeenCalledWith('', { walletId: 2 });

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(texts).toContain('3 transactions');
    // In = 500.000, Out = 120.000, Net = 380.000 (transfer of 300.000 excluded from both)
    expect(texts.some((t: string) => t.includes('500.000'))).toBe(true);
    expect(texts.some((t: string) => t.includes('120.000'))).toBe(true);
    expect(texts.some((t: string) => t.includes('380.000'))).toBe(true);
    // Not truncated when count === returned rows
    expect(texts.some((t: string) => t.includes('Showing first'))).toBe(false);

    // Clear filters returns to monthly view
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Clear filters' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Previous month' })).toBeDefined();

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('displays uncapped SQL totals and a truncation notice when matching rows exceed the displayed page', async () => {
    const now = Date.now();
    // Simulate a truncated page (only 2 items returned in list) out of 1,200 total matches in SQL
    mockSearchTransactions.mockResolvedValue([
      {
        id: 21,
        merchantName: 'Coffee',
        totalAmount: -25000,
        type: 'expense',
        category: 'Food & Dining',
        date: now,
        walletId: 1,
      },
      {
        id: 22,
        merchantName: 'Snack',
        totalAmount: -15000,
        type: 'expense',
        category: 'Food & Dining',
        date: now - 1000,
        walletId: 1,
      },
    ]);
    mockSummarizeSearchTransactions.mockResolvedValue({
      count: 1200,
      totalIn: 5000000,
      totalOut: 3200000,
      net: 1800000,
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Filter by account' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Account option Main Wallet' }).props.onPress();
    });

    expect(mockSearchTransactions).toHaveBeenCalledWith('', { walletId: 1 });
    expect(mockSummarizeSearchTransactions).toHaveBeenCalledWith('', { walletId: 1 });

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );

    // Totals must come from uncapped SQL summary (1200 matches), NOT the 2-row list slice (40.000)
    expect(texts).toContain('1200 transactions');
    expect(texts.some((t: string) => t.includes('5.000.000'))).toBe(true);
    expect(texts.some((t: string) => t.includes('3.200.000'))).toBe(true);
    expect(texts.some((t: string) => t.includes('1.800.000'))).toBe(true);
    expect(texts.some((t: string) => t.includes('Showing first 2 of 1200'))).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
