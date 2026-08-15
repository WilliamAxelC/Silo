import React from 'react';
import { useMonthlySummary } from '../useMonthlySummary';
import { useTransactionStore } from '../../store/useTransactionStore';
import type { Transaction } from '../../features/transactions/types';

const ReactTestRenderer = require('react-test-renderer');

function renderHookHarness<TProps, TResult>(
  hook: (props: TProps) => TResult,
  initialProps: TProps
) {
  let result!: TResult;
  let currentProps = initialProps;

  function TestComponent() {
    result = hook(currentProps);
    return null;
  }

  let testRenderer: any;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(React.createElement(TestComponent));
  });

  return {
    get current() {
      return result;
    },
    rerender: (newProps: TProps) => {
      currentProps = newProps;
      ReactTestRenderer.act(() => {
        testRenderer.update(React.createElement(TestComponent));
      });
    },
    unmount: () => {
      ReactTestRenderer.act(() => {
        testRenderer.unmount();
      });
    },
  };
}

describe('useMonthlySummary', () => {
  beforeEach(() => {
    useTransactionStore.setState({
      transactionsList: [],
    });
  });

  it('returns zeroes and empty lists when transactions list is empty', () => {
    const date = new Date('2024-05-15T00:00:00.000Z');
    const harness = renderHookHarness(useMonthlySummary, date);

    expect(harness.current.totalIncome).toBe(0);
    expect(harness.current.totalExpense).toBe(0);
    expect(harness.current.balance).toBe(0);
    expect(harness.current.currentMonthData).toEqual([]);
    expect(harness.current.currentMonthExpenses).toEqual([]);

    harness.unmount();
  });

  it('aggregates transactions within the current month and calculates income, expense, and balance', () => {
    const mayDate = new Date('2024-05-15T00:00:00.000Z');

    const transactions: Transaction[] = [
      {
        id: 1,
        merchantName: 'Salary',
        totalAmount: 10000000,
        type: 'income',
        category: 'Salary',
        date: new Date('2024-05-01T08:00:00.000Z').getTime(),
      },
      {
        id: 2,
        merchantName: 'Freelance Project',
        totalAmount: 2500000,
        type: 'income',
        category: 'Freelance',
        date: new Date('2024-05-10T12:00:00.000Z').getTime(),
      },
      {
        id: 3,
        merchantName: 'Supermarket',
        totalAmount: -750000,
        type: 'expense',
        category: 'Groceries',
        date: new Date('2024-05-12T15:00:00.000Z').getTime(),
      },
      {
        id: 4,
        merchantName: 'Restaurant',
        totalAmount: -250000,
        type: 'expense',
        category: 'Food & Dining',
        date: new Date('2024-05-20T19:00:00.000Z').getTime(),
      },
    ];

    useTransactionStore.setState({ transactionsList: transactions });

    const harness = renderHookHarness(useMonthlySummary, mayDate);

    expect(harness.current.totalIncome).toBe(12500000); // 10,000,000 + 2,500,000
    expect(harness.current.totalExpense).toBe(1000000); // 750,000 + 250,000
    expect(harness.current.balance).toBe(11500000); // 12,500,000 - 1,000,000
    expect(harness.current.currentMonthData.length).toBe(4);
    expect(harness.current.currentMonthExpenses.length).toBe(2);
    expect(harness.current.currentMonthExpenses.map((t) => t.merchantName)).toEqual(['Supermarket', 'Restaurant']);

    harness.unmount();
  });

  it('filters out transactions from different months and different years', () => {
    const targetDate = new Date('2024-05-15T00:00:00.000Z');

    const transactions: Transaction[] = [
      {
        id: 1,
        merchantName: 'April Expense',
        totalAmount: -100000,
        type: 'expense',
        category: 'Bills',
        date: new Date('2024-04-30T23:59:59.000Z').getTime(),
      },
      {
        id: 2,
        merchantName: 'May Expense (Match)',
        totalAmount: -200000,
        type: 'expense',
        category: 'Bills',
        date: new Date('2024-05-01T00:00:00.000Z').getTime(),
      },
      {
        id: 3,
        merchantName: 'June Expense',
        totalAmount: -300000,
        type: 'expense',
        category: 'Bills',
        date: new Date('2024-06-01T00:00:00.000Z').getTime(),
      },
      {
        id: 4,
        merchantName: 'May 2023 Expense (Different Year)',
        totalAmount: -400000,
        type: 'expense',
        category: 'Bills',
        date: new Date('2023-05-15T00:00:00.000Z').getTime(),
      },
    ];

    useTransactionStore.setState({ transactionsList: transactions });

    const harness = renderHookHarness(useMonthlySummary, targetDate);

    expect(harness.current.currentMonthData.length).toBe(1);
    expect(harness.current.currentMonthData[0].merchantName).toBe('May Expense (Match)');
    expect(harness.current.totalExpense).toBe(200000);
    expect(harness.current.totalIncome).toBe(0);
    expect(harness.current.balance).toBe(-200000);

    harness.unmount();
  });

  it('updates reactively when currentDate or transaction store updates', () => {
    const mayDate = new Date('2024-05-15T00:00:00.000Z');
    const juneDate = new Date('2024-06-15T00:00:00.000Z');

    const transactions: Transaction[] = [
      {
        id: 1,
        merchantName: 'May Income',
        totalAmount: 5000000,
        type: 'income',
        category: 'Salary',
        date: new Date('2024-05-01T00:00:00.000Z').getTime(),
      },
      {
        id: 2,
        merchantName: 'June Income',
        totalAmount: 6000000,
        type: 'income',
        category: 'Salary',
        date: new Date('2024-06-01T00:00:00.000Z').getTime(),
      },
    ];

    useTransactionStore.setState({ transactionsList: transactions });

    const harness = renderHookHarness(useMonthlySummary, mayDate);
    expect(harness.current.totalIncome).toBe(5000000);

    harness.rerender(juneDate);
    expect(harness.current.totalIncome).toBe(6000000);

    harness.unmount();
  });

  it('handles transactions with zero amount safely', () => {
    const date = new Date('2024-05-15T00:00:00.000Z');
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 1,
          merchantName: 'Free item',
          totalAmount: 0,
          type: 'expense',
          category: 'Other',
          date: new Date('2024-05-10T00:00:00.000Z').getTime(),
        },
      ],
    });

    const harness = renderHookHarness(useMonthlySummary, date);
    expect(harness.current.totalIncome).toBe(0);
    expect(harness.current.totalExpense).toBe(0);
    expect(harness.current.balance).toBe(0);
    expect(harness.current.currentMonthData.length).toBe(1);
    expect(harness.current.currentMonthExpenses.length).toBe(0);

    harness.unmount();
  });
});
