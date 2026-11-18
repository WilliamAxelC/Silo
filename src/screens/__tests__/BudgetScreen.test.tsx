import React from 'react';
import { Animated, RefreshControl, ScrollView, TextInput } from 'react-native';
import { BudgetScreen } from '../BudgetScreen';
import { useTransactionStore } from '../../store/useTransactionStore';

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
});
