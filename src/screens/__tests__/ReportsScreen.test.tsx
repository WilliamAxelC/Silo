import React from 'react';
import { Text } from 'react-native';
import { ReportsScreen } from '../ReportsScreen';
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
});
