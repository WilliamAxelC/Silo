import React from 'react';
import { StyleSheet, Text } from 'react-native';
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

jest.mock('../../db/index', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => []),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn(() => Promise.resolve()),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
  },
  expoDb: {
    execSync: jest.fn(),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn(() => null),
    runSync: jest.fn(() => ({ lastInsertRowId: 1, changes: 1 })),
    withTransactionSync: jest.fn((cb: () => void) => cb()),
  },
}));

describe('CashflowScreen', () => {
  const mockClearError = jest.fn();
  const mockFetchTransactions = jest.fn().mockResolvedValue(undefined);
  const mockSearchTransactions = jest.fn().mockResolvedValue([]);
  const mockSummarizeSearchTransactions = jest
    .fn()
    .mockResolvedValue({ count: 0, totalIn: 0, totalOut: 0, net: 0 });
  const mockGetDailyTotals = jest.fn().mockReturnValue([]);

  beforeEach(() => {
    jest.clearAllMocks();
    const now = new Date();
    useSettingsStore.setState({
      dateFormat: 'id-ID',
      currencyCode: 'IDR',
      useThousandsSeparator: true,
      monthStartDay: 1,
      weekStartDay: 'monday',
      isLoaded: false,
      hasCompletedOnboarding: true,
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
      getDailyTotals: mockGetDailyTotals,
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

  it('switches to Calendar view, queries SQL daily totals, lists tapped day transactions, and opens Add with initialDate', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const day5 = new Date(year, month, 5, 11, 0, 0, 0);
    const day5Key = `${year}-${String(month + 1).padStart(2, '0')}-05`;
    const shortDay5 = day5.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    useSettingsStore.setState({ dateFormat: 'en-GB', currencyCode: 'IDR', weekStartDay: 'sunday' });
    mockGetDailyTotals.mockReturnValue([
      { dayKey: day5Key, income: 1_200_000, expense: 45_000, count: 2 },
    ]);
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 50,
          merchantName: 'Bakery Day 5',
          totalAmount: -45000,
          type: 'expense',
          category: 'Food & Dining',
          date: day5.getTime(),
        },
      ],
      error: null,
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    // Switch to Calendar view
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Calendar view' }).props.onPress();
    });

    expect(mockGetDailyTotals).toHaveBeenCalledTimes(1);
    const [startArg, endArg] = mockGetDailyTotals.mock.calls[0];
    expect(new Date(startArg).getDate()).toBe(1);
    expect(new Date(endArg).getMonth()).toBe(month);

    // Compact totals from SQL render on day 5
    const day5Cell = renderer.root.findByProps({ testID: `calendar-day-${day5Key}` });
    const day5Texts = day5Cell.findAllByType(Text).map((t: any) => String(t.props.children));
    expect(day5Texts).toContain('1,2jt');
    expect(day5Texts).toContain('45rb');

    // Tap day 5 -> lists Bakery Day 5 and shows "Add on <date>"
    ReactTestRenderer.act(() => {
      day5Cell.props.onPress();
    });

    const allTexts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(allTexts).toContain('Bakery Day 5');

    const addOnDayBtn = renderer.root.findByProps({ accessibilityLabel: `Add on ${shortDay5}` });
    ReactTestRenderer.act(() => {
      addOnDayBtn.props.onPress();
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      'AddTransactionStack',
      expect.objectContaining({ initialDate: expect.any(Number) })
    );
    const passedDate = new Date(mockNavigate.mock.calls[0][1].initialDate);
    expect(passedDate.getFullYear()).toBe(year);
    expect(passedDate.getMonth()).toBe(month);
    expect(passedDate.getDate()).toBe(5);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('labels custom billing periods clearly when monthStartDay > 1', () => {
    const now = new Date();
    useSettingsStore.setState({ dateFormat: 'en-GB', monthStartDay: 25 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    const { getPeriodBounds, formatPeriodLabel } = require('../../features/transactions/periods');
    const expectedLabel = formatPeriodLabel(getPeriodBounds(now, 25), 'en-GB');

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(texts).toContain(expectedLabel);
    expect(expectedLabel).toContain(' - ');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('anchors Calendar on the current month containing today when monthStartDay > 1, and on periodBounds.end for non-current periods (R2B-4)', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 10, 26, 12, 0, 0)); // 26 Nov 2026 -> current cycle is 25 Nov - 24 Dec
    try {
      useSettingsStore.setState({ dateFormat: 'en-GB', monthStartDay: 25, weekStartDay: 'monday' });
      mockGetDailyTotals.mockReturnValue([]);

      let renderer: any;
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<CashflowScreen />);
      });

      // Switch to Calendar while on current custom period (25 Nov - 24 Dec) -> must open November 2026 with today selected
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Calendar view' }).props.onPress();
      });

      const textsNov = renderer.root.findAllByType(Text).map((t: any) =>
        Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
      );
      expect(textsNov).toContain('November 2026');
      expect(textsNov).not.toContain('December 2026');

      const [startNov, endNov] = mockGetDailyTotals.mock.calls[0];
      expect(new Date(startNov).getFullYear()).toBe(2026);
      expect(new Date(startNov).getMonth()).toBe(10); // November
      expect(new Date(endNov).getMonth()).toBe(10);

      const todayCell = renderer.root.findByProps({ testID: 'calendar-day-2026-11-26' });
      expect(todayCell.props.accessibilityState?.selected).toBe(true);

      // Switch back to List, navigate two periods earlier (25 Sep - 24 Oct), then open Calendar -> anchors on periodBounds.end (October 2026)
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'List view' }).props.onPress();
      });
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Previous month' }).props.onPress();
      });
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Previous month' }).props.onPress();
      });
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Calendar view' }).props.onPress();
      });

      const textsOct = renderer.root.findAllByType(Text).map((t: any) =>
        Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
      );
      expect(textsOct).toContain('October 2026');

      ReactTestRenderer.act(() => {
        renderer.unmount();
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the first-launch WelcomeSheet once settings finish loading when onboarding is incomplete, and hides once completed (F-14)', async () => {
    useSettingsStore.setState({
      isLoaded: true,
      hasCompletedOnboarding: false,
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    expect(renderer.root.findByProps({ testID: 'welcome-sheet' })).toBeTruthy();

    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Skip welcome setup' }).props.onPress();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(useSettingsStore.getState().hasCompletedOnboarding).toBe(true);
    expect(renderer.root.findAllByProps({ testID: 'welcome-sheet' })).toHaveLength(0);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('scales filter chips, filter sheet options, and search summary text with fontScale (R3A-08)', async () => {
    useSettingsStore.setState({ fontScale: 1.0, isLoaded: true, hasCompletedOnboarding: true });
    mockSearchTransactions.mockResolvedValue([]);
    mockSummarizeSearchTransactions.mockResolvedValue({ count: 0, totalIn: 0, totalOut: 0, net: 0 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<CashflowScreen />);
    });

    // Open type filter sheet
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Filter by type' }).props.onPress();
    });

    const getSize = (label: string) => {
      const node = renderer.root.findAllByType(Text).find((t: any) => {
        const text = Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '');
        return text === label;
      });
      return StyleSheet.flatten(node.props.style).fontSize;
    };

    const chip100 = getSize('Type');
    const sheetTitle100 = getSize('Filter by type');
    const sheetOption100 = getSize('Expense');

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });

    expect(getSize('Type')).toBeGreaterThan(chip100);
    expect(getSize('Filter by type')).toBeGreaterThan(sheetTitle100);
    expect(getSize('Expense')).toBeGreaterThan(sheetOption100);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
