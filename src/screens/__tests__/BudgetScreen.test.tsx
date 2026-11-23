import React from 'react';
import { Alert, Animated, Text } from 'react-native';
import { BudgetScreen } from '../BudgetScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { BudgetPlan, BudgetStatus } from '../../features/budgets/engine';

const ReactTestRenderer = require('react-test-renderer');

let focusCallback: (() => void) | null = null;
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    focusCallback = cb;
  },
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('../../services/fx/rates', () => ({
  getCachedRate: jest.fn(() => ({ rate: 104.6, date: '2026-11-22' })),
  refreshDailyRates: jest.fn(async () => null),
}));
const mockCompute = jest.fn();
jest.mock('../../features/budgets/engine', () => ({
  ...jest.requireActual('../../features/budgets/engine'),
  computeBudgetStatus: (...args: unknown[]) => mockCompute(...args),
}));

const plan = (over: Partial<BudgetPlan>): BudgetPlan => ({
  id: 1, name: 'Groceries', amount: 3_000_000, currency: null, kind: 'recurring',
  startDate: new Date(2026, 10, 1).getTime(), endDate: null, every: 1, unit: 'month', rollover: 'reset', carryOverspend: false,
  categories: ['Groceries'], walletIds: [], tags: [], archived: false, ...over,
});
const status = (p: BudgetPlan, over: Partial<BudgetStatus>): BudgetStatus => ({
  plan: p, currency: p.currency ?? 'IDR', periodIndex: 0, periodStart: new Date(2026, 10, 1).getTime(),
  periodEnd: new Date(2026, 11, 1).getTime(), spent: 0, carried: 0, available: p.amount, remaining: p.amount, isOver: false,
  daysLeft: 9, perDayLeft: null, notStarted: false, ended: false, unconvertedHome: 0, ...over,
});
const texts = (renderer: any) => renderer.root.findAllByType(Text).map((t: any) => [].concat(t.props.children).join(''));

describe('BudgetScreen', () => {
  const saveBudgetPlan = jest.fn(() => 7);
  const deleteBudgetPlan = jest.fn();
  const fetchBudgetPlans = jest.fn();
  const fetchTransactions = jest.fn().mockResolvedValue(undefined);
  const fetchCategories = jest.fn().mockResolvedValue(undefined);
  const fetchBudgets = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    focusCallback = null;
    jest.spyOn(Animated, 'timing').mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() }) as any);
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, dateFormat: 'en-GB', monthStartDay: 25, fontScale: 1 });
    useTransactionStore.setState({
      budgetPlans: [],
      wallets: [
        { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null },
        { id: 2, name: 'Japan Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: 'JPY', averageRate: 105 },
      ],
      tags: [{ id: 1, name: 'Japan 2026', usage: 3 }],
      categories: [{ id: 1, name: 'Groceries', type: 'expense', isSystem: true, createdAt: 1 }],
      hasLoadedTransactions: true, transactionsDirty: true, hasLoadedCategories: true, categoriesDirty: false,
      hasLoadedBudgets: false, budgetsDirty: false,
      saveBudgetPlan, deleteBudgetPlan, fetchBudgetPlans, fetchTransactions, fetchCategories, fetchBudgets,
    } as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it('refreshes stale transactions and budgets on focus', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });
    await ReactTestRenderer.act(async () => {
      focusCallback?.();
    });
    expect(fetchTransactions).toHaveBeenCalled();
    expect(fetchCategories).not.toHaveBeenCalled();
    expect(fetchBudgets).toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('creates a one-time yen holiday budget filtered by a tag', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });
    expect(texts(renderer)).toContain('No budgets yet');
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'New budget' }).props.onPress());
    const find = (label: string) => renderer.root.findByProps({ accessibilityLabel: label });

    ReactTestRenderer.act(() => find('Budget name').props.onChangeText('Japan trip'));
    ReactTestRenderer.act(() => find('Budget currency JPY').props.onPress());
    ReactTestRenderer.act(() => find('Budget amount').props.onChangeText('150000'));
    ReactTestRenderer.act(() => find('One-time').props.onPress());
    ReactTestRenderer.act(() => find('Start date').props.onPress());
    ReactTestRenderer.act(() => renderer.root.findByType('DateTimePicker').props.onChange({}, new Date(2026, 11, 1, 15)));
    ReactTestRenderer.act(() => find('End date').props.onPress());
    ReactTestRenderer.act(() => renderer.root.findByType('DateTimePicker').props.onChange({}, new Date(2026, 11, 10)));
    ReactTestRenderer.act(() => find('Budget tag Japan 2026').props.onPress());
    ReactTestRenderer.act(() => find('Save budget').props.onPress());

    expect(saveBudgetPlan).toHaveBeenCalledWith(null, expect.objectContaining({
      name: 'Japan trip', amount: 150000, currency: 'JPY', kind: 'once',
      startDate: new Date(2026, 11, 1).getTime(), endDate: new Date(2026, 11, 10).getTime(),
      tags: ['Japan 2026'], categories: [], walletIds: [],
    }));
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('creates a repeating budget every 2 weeks that carries leftovers and overspending', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'New budget' }).props.onPress());
    const find = (label: string) => renderer.root.findByProps({ accessibilityLabel: label });
    ReactTestRenderer.act(() => find('Budget name').props.onChangeText('Allowance'));
    ReactTestRenderer.act(() => find('Budget amount').props.onChangeText('500000'));
    ReactTestRenderer.act(() => find('Repeat every').props.onChangeText('2'));
    ReactTestRenderer.act(() => find('Repeat unit Weeks').props.onPress());
    ReactTestRenderer.act(() => find('Carry over').props.onPress());
    ReactTestRenderer.act(() => find('Also carry overspending').props.onValueChange(true));
    ReactTestRenderer.act(() => find('Budget account BCA').props.onPress());
    ReactTestRenderer.act(() => find('Save budget').props.onPress());

    expect(saveBudgetPlan).toHaveBeenCalledWith(null, expect.objectContaining({
      name: 'Allowance', amount: 500000, currency: null, kind: 'recurring', every: 2, unit: 'week',
      rollover: 'carry', carryOverspend: true, walletIds: [1],
    }));
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('shows progress, carry-over, per-day allowance and finished budgets', () => {
    const groceries = plan({ rollover: 'carry' });
    const trip = plan({ id: 2, name: 'Japan trip', kind: 'once', currency: 'JPY', amount: 150_000, categories: [], tags: ['Japan 2026'] });
    const old = plan({ id: 3, name: 'Bali', kind: 'once', categories: [] });
    mockCompute.mockImplementation((_db: unknown, p: BudgetPlan) =>
      p.id === 1
        ? status(p, { spent: 3_400_000, carried: 200_000, available: 3_200_000, remaining: -200_000, isOver: true })
        : p.id === 2
          ? status(p, { currency: 'JPY', spent: 13_200, remaining: 136_800, daysLeft: 7, perDayLeft: 19_543 })
          : status(p, { ended: true, daysLeft: 0, spent: 2_000_000, remaining: 1_000_000 })
    );
    useTransactionStore.setState({ budgetPlans: [groceries, trip, old] } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<BudgetScreen />);
    });
    const all = texts(renderer);
    expect(all).toContain('1 overspent');
    expect(all.some((t: string) => t.startsWith('Over by') && t.includes('200.000'))).toBe(true);
    expect(all.some((t: string) => t.startsWith('Includes') && t.includes('carried over'))).toBe(true);
    expect(all.some((t: string) => t.includes('19.543') && t.endsWith('/day'))).toBe(true);
    expect(all.some((t: string) => t.includes('7 days left'))).toBe(true);
    expect(all).toContain('#Japan 2026');
    expect(all).toContain('Finished');

    ReactTestRenderer.act(() => renderer.root.findByProps({ testID: 'budget-card-2' }).props.onPress());
    expect(renderer.root.findByProps({ accessibilityLabel: 'Budget name' }).props.value).toBe('Japan trip');
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Delete budget' }).props.onPress());
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    ReactTestRenderer.act(() => buttons[1].onPress());
    expect(deleteBudgetPlan).toHaveBeenCalledWith(2);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
