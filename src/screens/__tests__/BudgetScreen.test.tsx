import React from 'react';
import { Animated, RefreshControl, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { BudgetScreen } from '../BudgetScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

let focusCallback: (() => void) | null = null;

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    focusCallback = cb;
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

describe('BudgetScreen', () => {
  const mockFetchTransactions = jest.fn().mockResolvedValue(undefined);
  const mockFetchBudgets = jest.fn().mockResolvedValue(undefined);
  const mockFetchCategories = jest.fn().mockResolvedValue(undefined);
  const mockSetBudget = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    focusCallback = null;
    jest.spyOn(Animated, 'timing').mockImplementation(
      () =>
        ({
          start: jest.fn(),
          stop: jest.fn(),
          reset: jest.fn(),
        }) as any
    );

    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, dateFormat: 'en-GB', monthStartDay: 1 });
    useTransactionStore.setState({
      transactionsList: [],
      budgets: { Groceries: 1000000 },
      categories: [{ id: 1, name: 'Groceries', type: 'expense', isSystem: true, createdAt: 1000 }],
      fetchTransactions: mockFetchTransactions,
      fetchBudgets: mockFetchBudgets,
      fetchCategories: mockFetchCategories,
      setBudget: mockSetBudget,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refreshes month data on focus and via RefreshControl', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    expect(focusCallback).not.toBeNull();
    await ReactTestRenderer.act(async () => {
      focusCallback?.();
    });

    expect(mockFetchTransactions).toHaveBeenCalledTimes(1);
    expect(mockFetchBudgets).toHaveBeenCalledTimes(1);
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);

    const scrollView = renderer.root.findByType(ScrollView);
    const refreshControl = scrollView.props.refreshControl;
    expect(refreshControl.type).toBe(RefreshControl);

    await ReactTestRenderer.act(async () => {
      await refreshControl.props.onRefresh();
    });

    expect(mockFetchTransactions).toHaveBeenCalledTimes(2);
    expect(mockFetchBudgets).toHaveBeenCalledTimes(2);
    expect(mockFetchCategories).toHaveBeenCalledTimes(2);
    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('formats and parses Rupiah budget limits with amount.ts helpers', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    const card = renderer.root.findByProps({ accessibilityLabel: 'Groceries budget limit' });
    ReactTestRenderer.act(() => {
      card.props.onPress();
    });

    const input = renderer.root.findByType(TextInput);
    expect(input.props.value).toBe('1.000.000');

    ReactTestRenderer.act(() => {
      input.props.onChangeText('1500000');
    });
    expect(renderer.root.findByType(TextInput).props.value).toBe('1.500.000');

    const saveBtn = renderer.root.findByProps({ accessibilityLabel: 'Save budget limit' });
    await ReactTestRenderer.act(async () => {
      await saveBtn.props.onPress();
    });

    expect(mockSetBudget).toHaveBeenCalledWith('Groceries', 1500000);
    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('opens calculator keypad in budget modal and saves decimal USD limits', async () => {
    useSettingsStore.setState({ currencyCode: 'USD', useThousandsSeparator: true });
    useTransactionStore.setState({
      budgets: { Groceries: 250.5 },
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Groceries budget limit' }).props.onPress();
    });

    // Preserves existing decimals when opening modal
    expect(renderer.root.findByType(TextInput).props.value).toBe('250.5');

    // Open inline calculator keypad and add 49.75 -> 300.25
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Edit budget amount' }).props.onPress();
    });

    for (const label of ['Add', '4', '9', 'Decimal point', '7', '5', 'Done']) {
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
      });
    }

    expect(renderer.root.findByType(TextInput).props.value).toBe('300.25');

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save budget limit' }).props.onPress();
    });

    expect(mockSetBudget).toHaveBeenCalledWith('Groceries', 300.25);
    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('bounds the budget modal height and scrolls its content when the inline calculator is open (R-03)', () => {
    useSettingsStore.setState({ currencyCode: 'USD', useThousandsSeparator: true, fontScale: 1.2 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Groceries budget limit' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Edit budget amount' }).props.onPress();
    });

    const modalCard = renderer.root.findByProps({ testID: 'budget-modal-card' });
    const flattenedCardStyle = StyleSheet.flatten(modalCard.props.style);
    expect(flattenedCardStyle.maxHeight).toBe('90%');

    const modalScroll = renderer.root.findByProps({ testID: 'budget-modal-scroll' });
    expect(modalScroll.type).toBe(ScrollView);
    // Both header and bottom calculator Done key live inside the scrollable container
    expect(modalScroll.findByProps({ accessibilityLabel: 'Done' })).toBeDefined();
    expect(modalScroll.findByProps({ accessibilityLabel: 'Close' })).toBeDefined();

    // Tapping the sibling backdrop closes the modal cleanly
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Close budget modal backdrop' }).props.onPress();
    });
    expect(renderer.root.findAllByProps({ testID: 'budget-modal-card' })).toHaveLength(0);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('blocks saving a budget limit above the safe maximum amount (R-05)', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Groceries budget limit' }).props.onPress();
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('999999999999998');
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children ?? ''));
    expect(texts).toContain('Amount is too large');

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save budget limit' }).props.onPress();
    });
    expect(mockSetBudget).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('tracks budget spending and shows custom period label when monthStartDay > 1', () => {
    const now = new Date();
    const { getPeriodBounds, formatPeriodLabel } = require('../../features/transactions/periods');
    const bounds = getPeriodBounds(now, 25);
    const expectedLabel = formatPeriodLabel(bounds, 'en-GB');

    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, dateFormat: 'en-GB', monthStartDay: 25 });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 1,
          merchantName: 'In Cycle Grocery',
          totalAmount: -400000,
          type: 'expense',
          category: 'Groceries',
          date: bounds.startMs + 10_000,
        },
        {
          id: 2,
          merchantName: 'Prior Cycle Grocery',
          totalAmount: -700000,
          type: 'expense',
          category: 'Groceries',
          date: bounds.startMs - 10_000,
        },
      ],
      budgets: { Groceries: 1000000 },
      categories: [{ id: 1, name: 'Groceries', type: 'expense', isSystem: true, createdAt: 1000 }],
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) =>
      Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')
    );
    expect(texts).toContain(expectedLabel);
    // Only the 400.000 in-cycle expense counts (40% of 1.000.000 cap, not 110%)
    expect(texts.some((t: string) => t.includes('40% of cap used'))).toBe(true);
    expect(texts.some((t: string) => t.includes('On Pace'))).toBe(true);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
