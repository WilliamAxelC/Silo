import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { ReportsScreen, getCategoryColor } from '../ReportsScreen';
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
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

jest.mock('react-native-gifted-charts', () => {
  const React = require('react');
  return {
    PieChart: (props: any) =>
      React.createElement('PieChart', props, props.centerLabelComponent ? props.centerLabelComponent() : null),
  };
});

describe('ReportsScreen', () => {
  const mockFetchTransactions = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    const now = new Date();
    useSettingsStore.setState({
      isLoaded: false,
      showIncomeInReportsFirst: false,
      dateFormat: 'id-ID',
      currencyCode: 'IDR',
      useThousandsSeparator: true,
      monthStartDay: 1,
    });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 42,
          merchantName: 'Kopi Kenangan',
          totalAmount: -30000,
          type: 'expense',
          category: '',
          date: now.getTime(),
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
        {
          id: 43,
          merchantName: 'Gaji',
          totalAmount: 5000000,
          type: 'income',
          category: 'Salary',
          date: now.getTime(),
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
      ],
      fetchTransactions: mockFetchTransactions,
    } as any);
  });

  it('syncs reportType when settings isLoaded becomes true unless user already toggled, navigates on row press, and uses id-ID + UNCATEGORIZED_EXPENSE_LABEL', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });

    const textsInitial = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    const expectedMonthTitle = new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    expect(textsInitial.some((t: string) => t === expectedMonthTitle)).toBe(true);
    expect(textsInitial.some((t: string) => t === UNCATEGORIZED_EXPENSE_LABEL)).toBe(true);

    // Expand category and press transaction row to navigate to edit
    const categoryCard = renderer.root.findByProps({ accessibilityLabel: `${UNCATEGORIZED_EXPENSE_LABEL}, 100%` });
    ReactTestRenderer.act(() => {
      categoryCard.props.onPress();
    });
    const txRow = renderer.root.findByProps({ accessibilityLabel: 'Kopi Kenangan, -30000' });
    ReactTestRenderer.act(() => {
      txRow.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('AddTransactionStack', { transactionId: 42 });

    // Now simulate settings finishing load with showIncomeInReportsFirst: true
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ isLoaded: true, showIncomeInReportsFirst: true });
    });

    const textsAfterLoad = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(textsAfterLoad.some((t: string) => t === 'Total Income')).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('does not clobber user toggle when settings finishes loading later', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });

    const expenseToggle = renderer.root.findByProps({ accessibilityLabel: 'Show expense reports' });
    ReactTestRenderer.act(() => {
      expenseToggle.props.onPress();
    });

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ isLoaded: true, showIncomeInReportsFirst: true });
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(texts.some((t: string) => t === 'Total Expense')).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('assigns deterministic colors by category name that remain stable across months and rank changes', () => {
    // Deterministic independent of case/whitespace
    expect(getCategoryColor('Food & Dining', 'expense')).toBe(getCategoryColor('food & dining', 'expense'));
    expect(getCategoryColor('Food & Dining', 'expense')).not.toBe(getCategoryColor('Groceries', 'expense'));

    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    useTransactionStore.setState({
      transactionsList: [
        // Current month: Groceries is #1, Food & Dining is #2
        {
          id: 1,
          merchantName: 'Supermarket',
          totalAmount: -900000,
          type: 'expense',
          category: 'Groceries',
          date: now.getTime(),
        },
        {
          id: 2,
          merchantName: 'Cafe',
          totalAmount: -100000,
          type: 'expense',
          category: 'Food & Dining',
          date: now.getTime(),
        },
        // Previous month: Food & Dining is #1, Transport is #2 (no Groceries)
        {
          id: 3,
          merchantName: 'Dinner',
          totalAmount: -500000,
          type: 'expense',
          category: 'Food & Dining',
          date: prevMonth.getTime(),
        },
        {
          id: 4,
          merchantName: 'Train',
          totalAmount: -150000,
          type: 'expense',
          category: 'Transport',
          date: prevMonth.getTime(),
        },
      ],
      fetchTransactions: mockFetchTransactions,
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });

    const pieCurrent = renderer.root.findByType('PieChart');
    const foodSliceCurrent = pieCurrent.props.data.find((d: any) => d.category === 'Food & Dining');
    expect(foodSliceCurrent).toBeDefined();

    // Navigate to previous month
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Previous month' }).props.onPress();
    });

    const piePrev = renderer.root.findByType('PieChart');
    const foodSlicePrev = piePrev.props.data.find((d: any) => d.category === 'Food & Dining');
    expect(foodSlicePrev).toBeDefined();
    expect(foodSlicePrev.color).toBe(foodSliceCurrent.color);
    expect(foodSlicePrev.color).toBe(getCategoryColor('Food & Dining', 'expense'));

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('labels and filters reports using custom monthStartDay period bounds', () => {
    const now = new Date();
    const { getPeriodBounds, formatPeriodLabel } = require('../../features/transactions/periods');
    const bounds = getPeriodBounds(now, 25);
    const expectedLabel = formatPeriodLabel(bounds, 'en-GB');

    useSettingsStore.setState({ dateFormat: 'en-GB', monthStartDay: 25 });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 101,
          merchantName: 'Inside Custom Cycle',
          totalAmount: -120000,
          type: 'expense',
          category: 'Groceries',
          date: bounds.startMs + 60_000,
        },
        {
          id: 102,
          merchantName: 'Before Custom Cycle',
          totalAmount: -900000,
          type: 'expense',
          category: 'Bills',
          date: bounds.startMs - 60_000,
        },
      ],
      fetchTransactions: mockFetchTransactions,
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(texts).toContain(expectedLabel);
    expect(texts).toContain('Groceries');
    expect(texts).not.toContain('Bills');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('scales toggle, donut center, breakdown header, and expanded transaction rows with fontScale (R3A-08)', () => {
    useSettingsStore.setState({ fontScale: 1.0 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });

    const categoryCard = renderer.root.findByProps({ accessibilityLabel: `${UNCATEGORIZED_EXPENSE_LABEL}, 100%` });
    ReactTestRenderer.act(() => {
      categoryCard.props.onPress();
    });

    const getSize = (label: string) => {
      const node = renderer.root.findAllByType(Text).find((t: any) => {
        const text = Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '');
        return text === label;
      });
      return StyleSheet.flatten(node.props.style).fontSize;
    };

    const sizes100 = {
      toggle: getSize('Expenses'),
      donutLabel: getSize('Total Expense'),
      breakdownHeader: getSize('CATEGORY BREAKDOWN (1)'),
      txMerchant: getSize('Kopi Kenangan'),
    };

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });

    expect(getSize('Expenses')).toBeGreaterThan(sizes100.toggle);
    expect(getSize('Total Expense')).toBeGreaterThan(sizes100.donutLabel);
    expect(getSize('CATEGORY BREAKDOWN (1)')).toBeGreaterThan(sizes100.breakdownHeader);
    expect(getSize('Kopi Kenangan')).toBeGreaterThan(sizes100.txMerchant);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('hides CATEGORY BREAKDOWN (0) when empty, renders donut legend, exact insight amount, distinct income colors, and 6-month trend chart (F-27)', () => {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    useSettingsStore.setState({
      isLoaded: true,
      showIncomeInReportsFirst: false,
      dateFormat: 'en-GB',
      currencyCode: 'IDR',
      useThousandsSeparator: true,
      monthStartDay: 1,
    });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 201,
          merchantName: 'Groceries Mart',
          totalAmount: -450000,
          type: 'expense',
          category: 'Groceries',
          date: now.getTime(),
        },
        {
          id: 202,
          merchantName: 'Last Month Rent',
          totalAmount: -1200000,
          type: 'expense',
          category: 'Bills',
          date: prevMonth.getTime(),
        },
        {
          id: 203,
          merchantName: 'Employer',
          totalAmount: 5000000,
          type: 'income',
          category: 'Salary',
          date: now.getTime(),
        },
        {
          id: 204,
          merchantName: 'Side Gig',
          totalAmount: 1500000,
          type: 'income',
          category: 'Freelance',
          date: now.getTime(),
        },
      ],
      fetchTransactions: mockFetchTransactions,
    } as any);

    // Distinct colors for different income categories
    expect(getCategoryColor('Salary', 'income')).not.toBe(getCategoryColor('Freelance', 'income'));

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });

    // Donut legend and exact formatted currency amount in Insight callout
    const donutLegend = renderer.root.findByProps({ testID: 'reports-donut-legend' });
    expect(donutLegend).toBeDefined();
    const legendPill = renderer.root.findByProps({ accessibilityLabel: 'Groceries 100%' });
    const legendPillStyle = StyleSheet.flatten(legendPill.props.style);
    expect(legendPillStyle.minHeight).toBeGreaterThanOrEqual(44);
    expect(legendPillStyle.justifyContent).toBe('center');
    const allTexts = renderer.root
      .findAllByType(Text)
      .map((t: any) =>
        (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')).replace(/\u00a0/g, ' ')
      );
    expect(allTexts.some((t: string) => t.includes('Rp 450.000'))).toBe(true);
    expect(renderer.root.findByProps({ testID: 'reports-trend-chart' })).toBeDefined();

    // Navigate to next month (no records) -> CATEGORY BREAKDOWN (0) must be hidden
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Next month' }).props.onPress();
    });
    const emptyTexts = renderer.root
      .findAllByType(Text)
      .map((t: any) => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')));
    expect(emptyTexts.some((t: string) => t.includes('CATEGORY BREAKDOWN'))).toBe(false);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('groups the breakdown by account or by tag', () => {
    const now = new Date();
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null },
        { id: 2, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null },
      ],
      transactionsList: [
        { id: 1, merchantName: 'Sushi', totalAmount: -400000, type: 'expense', category: 'Food & Dining', date: now.getTime(), walletId: 1, tags: ['date', 'Japan 2026'] },
        { id: 2, merchantName: 'Cinema', totalAmount: -100000, type: 'expense', category: 'Entertainment', date: now.getTime(), walletId: 2, tags: ['date'] },
        { id: 3, merchantName: 'Bus', totalAmount: -50000, type: 'expense', category: 'Transport', date: now.getTime(), walletId: 2, tags: [] },
      ],
      hasLoadedTransactions: true,
      transactionsDirty: false,
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });
    const labels = () =>
      renderer.root
        .findAll((n: any) => typeof n.props.accessibilityLabel === 'string' && n.props.onPress)
        .map((n: any) => n.props.accessibilityLabel as string);

    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Group by Account' }).props.onPress());
    expect(labels()).toEqual(expect.arrayContaining([expect.stringMatching(/^BCA, 73%/), expect.stringMatching(/^GoPay, 27%/)]));

    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Group by Tag' }).props.onPress());
    const tagLabels = labels();
    expect(tagLabels).toEqual(
      expect.arrayContaining([expect.stringMatching(/^#date, 91%/), expect.stringMatching(/^#Japan 2026, 73%/), expect.stringMatching(/^No tag, 9%/)])
    );
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('narrows every total, the chart and the trend with filters and search, and shows the Filters button as on', () => {
    const now = Date.now();
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 },
        { id: 2, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
      ],
      categories: [
        { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1 },
        { id: 2, name: 'Transport', type: 'expense', isSystem: true, createdAt: 1 },
      ],
      tags: [{ id: 1, name: 'date', usage: 1 }],
      transactionsList: [
        { id: 1, merchantName: 'Kopi Kenangan', totalAmount: -30000, type: 'expense', category: 'Food & Dining', date: now, walletId: 2, tags: ['date'] },
        { id: 2, merchantName: 'Shell', totalAmount: -200000, type: 'expense', category: 'Transport', date: now, walletId: 1, tags: [] },
        { id: 3, merchantName: 'Gaji', totalAmount: 5000000, type: 'income', category: 'Salary', date: now, walletId: 1, tags: [] },
      ],
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReportsScreen />);
    });
    const texts = () =>
      renderer.root
        .findAllByType(Text)
        .map((t: any) => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')));
    const filterButton = () => renderer.root.findByProps({ testID: 'toolbar-filter-button' });
    const offColor = StyleSheet.flatten(filterButton().props.style).backgroundColor;
    expect(texts().some((t: string) => t.includes('230.000'))).toBe(true);

    // Account filter: only GoPay spending is left, in the summary and the chart total.
    ReactTestRenderer.act(() => filterButton().props.onPress());
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Account option GoPay' }).props.onPress();
    });
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Done filtering' }).props.onPress());
    expect(texts().some((t: string) => t.includes('230.000'))).toBe(false);
    expect(texts().filter((t: string) => t.includes('30.000')).length).toBeGreaterThan(0);
    expect(texts().some((t: string) => t.includes('5.000.000'))).toBe(false);
    expect(filterButton().props.accessibilityLabel).toBe('Filters, 1 on');
    expect(StyleSheet.flatten(filterButton().props.style).backgroundColor).not.toBe(offColor);

    // Removing the chip restores everything; a search that matches nothing explains why it's empty.
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Remove filter GoPay' }).props.onPress();
    });
    expect(texts().some((t: string) => t.includes('230.000'))).toBe(true);
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Open search' }).props.onPress());
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Search reports' }).props.onChangeText('indomaret');
    });
    expect(texts().some((t: string) => t.includes('match your filters'))).toBe(true);

    ReactTestRenderer.act(() => renderer.unmount());
  });
});
