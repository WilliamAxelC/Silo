import React from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { RecurringScreen } from '../RecurringScreen';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import type { RecurringRule } from '../../services/recurring';

const ReactTestRenderer = require('react-test-renderer');

const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
  }),
  useFocusEffect: (cb: () => void) => {
    const React = require('react');
    React.useEffect(() => {
      cb();
    }, [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const mockListRecurringRules = jest.fn();
const mockCreateRecurringRule = jest.fn();
const mockUpdateRecurringRule = jest.fn();
const mockSetRecurringRuleActive = jest.fn();
const mockDeleteRecurringRule = jest.fn();

jest.mock('../../services/recurring', () => ({
  RECURRING_FREQUENCIES: [
    { key: 'daily', label: 'Daily' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'yearly', label: 'Yearly' },
  ],
  listRecurringRules: (...args: any[]) => mockListRecurringRules(...args),
  createRecurringRule: (...args: any[]) => mockCreateRecurringRule(...args),
  updateRecurringRule: (...args: any[]) => mockUpdateRecurringRule(...args),
  setRecurringRuleActive: (...args: any[]) => mockSetRecurringRuleActive(...args),
  deleteRecurringRule: (...args: any[]) => mockDeleteRecurringRule(...args),
}));

function withInsets(element: React.ReactElement) {
  return (
    <SafeAreaInsetsContext.Provider value={{ top: 20, bottom: 24, left: 0, right: 0 }}>
      {element}
    </SafeAreaInsetsContext.Provider>
  );
}

const SAMPLE_RULES: RecurringRule[] = [
  {
    id: 1,
    frequency: 'monthly',
    startDate: new Date(2026, 9, 1).getTime(),
    nextDate: new Date(2026, 11, 1).getTime(),
    occurrences: 2,
    isActive: true,
    template: {
      merchantName: 'Apartment Rent',
      totalAmount: -3500000,
      type: 'expense',
      category: 'Bills',
      note: '',
      lineItemsText: '',
      walletId: 1,
      toWalletId: null,
    },
  },
  {
    id: 2,
    frequency: 'monthly',
    startDate: new Date(2026, 9, 5).getTime(),
    nextDate: new Date(2026, 11, 5).getTime(),
    occurrences: 2,
    isActive: true,
    template: {
      merchantName: 'Spotify',
      totalAmount: -55000,
      type: 'expense',
      category: 'Entertainment',
      note: '',
      lineItemsText: '',
      walletId: 1,
      toWalletId: null,
    },
  },
];

describe('RecurringScreen (F-19, F-25, NIT-02)', () => {
  let renderer: any = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockListRecurringRules.mockReturnValue(SAMPLE_RULES);
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({
        currencyCode: 'IDR',
        useThousandsSeparator: true,
        dateFormat: 'en-GB',
        fontScale: 1,
      });
      useTransactionStore.setState({
        wallets: [{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 }],
        categories: [
          { id: 1, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1 },
          { id: 2, name: 'Entertainment', type: 'expense', isSystem: true, createdAt: 1 },
          { id: 3, name: 'Salary', type: 'income', isSystem: true, createdAt: 1 },
        ],
      } as any);
    });
  });

  afterEach(() => {
    if (renderer) {
      ReactTestRenderer.act(() => {
        renderer.unmount();
      });
      renderer = null;
    }
  });

  it('adds a new recurring rule with inline validation for missing title and zero amount (F-19)', () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<RecurringScreen />));
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Add recurring transaction' }).props.onPress();
    });

    // Empty save shows inline validation errors instead of saving
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Save recurring rule' }).props.onPress();
    });
    expect(mockCreateRecurringRule).not.toHaveBeenCalled();
    const alerts = renderer.root.findAllByProps({ accessibilityRole: 'alert' }).map((n: any) => n.props.children);
    expect(alerts).toContain('Please enter a title');
    expect(alerts).toContain('Amount must be greater than 0');

    // Fill valid income rule and save
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Recurring type income' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Recurring title' }).props.onChangeText('Monthly Salary');
      renderer.root.findByProps({ accessibilityLabel: 'Recurring amount' }).props.onChangeText('10000000');
      renderer.root.findByProps({ accessibilityLabel: 'Schedule Weekly' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Save recurring rule' }).props.onPress();
    });

    expect(mockCreateRecurringRule).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Monthly Salary',
        totalAmount: 10000000,
        type: 'income',
        category: 'Salary',
      }),
      'weekly',
      expect.any(Number)
    );
  });

  it('opens an existing rule for editing on row tap and saves via updateRecurringRule (F-19)', () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<RecurringScreen />));
    });

    const rentRow = renderer.root
      .findAllByType(TouchableOpacity)
      .find((n: any) => typeof n.props?.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Edit recurring Apartment Rent'));
    ReactTestRenderer.act(() => {
      rentRow.props.onPress();
    });

    expect(renderer.root.findByProps({ accessibilityLabel: 'Recurring title' }).props.value).toBe('Apartment Rent');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Recurring amount' }).props.value).toBe('3.500.000');

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Recurring amount' }).props.onChangeText('3800000');
      renderer.root.findByProps({ accessibilityLabel: 'Schedule Yearly' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Save recurring rule' }).props.onPress();
    });

    expect(mockUpdateRecurringRule).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        merchantName: 'Apartment Rent',
        totalAmount: -3800000,
        type: 'expense',
        category: 'Bills',
      }),
      'yearly'
    );
  });

  it('toggles a recurring rule active state in place without jumping or reordering rows (F-19)', () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<RecurringScreen />));
    });

    const getRowOrder = () =>
      renderer.root
        .findAllByType(TouchableOpacity)
        .filter((n: any) => typeof n.props?.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Edit recurring '))
        .map((n: any) => n.props.accessibilityLabel);

    expect(getRowOrder()[0]).toContain('Apartment Rent');
    expect(getRowOrder()[1]).toContain('Spotify');

    const rentSwitch = renderer.root.findByProps({ accessibilityLabel: 'Apartment Rent repeating' });
    expect(rentSwitch.type).toBe(Switch);
    expect(rentSwitch.props.value).toBe(true);

    ReactTestRenderer.act(() => {
      rentSwitch.props.onValueChange(false);
    });

    expect(mockSetRecurringRuleActive).toHaveBeenCalledWith(1, false);
    // Row remains first instead of re-sorting to the bottom on toggle
    expect(getRowOrder()[0]).toContain('Apartment Rent');
    expect(getRowOrder()[1]).toContain('Spotify');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Apartment Rent repeating' }).props.value).toBe(false);
  });

  it('meets >=44pt touch targets and scales empty state typography with fontScale (F-25, NIT-02)', () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(withInsets(<RecurringScreen />));
    });

    const backStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Go back' }).props.style);
    const addStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Add recurring transaction' }).props.style);
    const deleteStyle = StyleSheet.flatten(renderer.root.findByProps({ accessibilityLabel: 'Stop repeating Apartment Rent' }).props.style);
    expect(backStyle.width).toBeGreaterThanOrEqual(44);
    expect(backStyle.height).toBeGreaterThanOrEqual(44);
    expect(addStyle.minHeight).toBeGreaterThanOrEqual(44);
    expect(deleteStyle.width).toBeGreaterThanOrEqual(44);
    expect(deleteStyle.height).toBeGreaterThanOrEqual(44);

    ReactTestRenderer.act(() => {
      renderer.unmount();
      renderer = null;
    });

    // Empty state scales with fontScale
    mockListRecurringRules.mockReturnValue([]);
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.0 });
      renderer = ReactTestRenderer.create(withInsets(<RecurringScreen />));
    });
    const getEmptyTitleSize = () => {
      const node = renderer.root.findAllByType(Text).find((t: any) => t.props.children === 'Nothing repeats yet');
      return StyleSheet.flatten(node.props.style).fontSize;
    };
    const size100 = getEmptyTitleSize();
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });
    expect(getEmptyTitleSize()).toBeGreaterThan(size100);
  });
});
