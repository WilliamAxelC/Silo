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
});
