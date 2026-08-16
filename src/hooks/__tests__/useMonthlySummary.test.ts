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

  describe('Month boundary transitions & Leap years', () => {
    it('accurately handles leap year Feb 29 boundary (2024)', () => {
      const feb2024 = new Date(2024, 1, 15); // February 2024 (leap year)
      const feb29End = new Date(2024, 1, 29, 23, 59, 59, 999).getTime();
      const mar1Start = new Date(2024, 2, 1, 0, 0, 0, 0).getTime();

      useTransactionStore.setState({
        transactionsList: [
          {
            id: 101,
            merchantName: 'Leap Day Dinner',
            totalAmount: -450000,
            type: 'expense',
            category: 'Food & Dining',
            date: feb29End,
          },
          {
            id: 102,
            merchantName: 'March 1st Coffee',
            totalAmount: -50000,
            type: 'expense',
            category: 'Food & Dining',
            date: mar1Start,
          },
        ],
      });

      const harnessFeb = renderHookHarness(useMonthlySummary, feb2024);
      expect(harnessFeb.current.currentMonthData.length).toBe(1);
      expect(harnessFeb.current.currentMonthData[0].merchantName).toBe('Leap Day Dinner');
      expect(harnessFeb.current.totalExpense).toBe(450000);
      harnessFeb.unmount();

      const mar2024 = new Date(2024, 2, 15); // March 2024
      const harnessMar = renderHookHarness(useMonthlySummary, mar2024);
      expect(harnessMar.current.currentMonthData.length).toBe(1);
      expect(harnessMar.current.currentMonthData[0].merchantName).toBe('March 1st Coffee');
      expect(harnessMar.current.totalExpense).toBe(50000);
      harnessMar.unmount();
    });

    it('accurately handles non-leap year Feb 28 boundary (2023)', () => {
      const feb2023 = new Date(2023, 1, 15); // February 2023 (non-leap year)
      const feb28End = new Date(2023, 1, 28, 23, 59, 59, 999).getTime();
      const mar1Start = new Date(2023, 2, 1, 0, 0, 0, 0).getTime();

      useTransactionStore.setState({
        transactionsList: [
          {
            id: 201,
            merchantName: 'Feb 28 Midnight Expense',
            totalAmount: -120000,
            type: 'expense',
            category: 'Bills',
            date: feb28End,
          },
          {
            id: 202,
            merchantName: 'March 1st Expense',
            totalAmount: -80000,
            type: 'expense',
            category: 'Bills',
            date: mar1Start,
          },
        ],
      });

      const harnessFeb = renderHookHarness(useMonthlySummary, feb2023);
      expect(harnessFeb.current.currentMonthData.length).toBe(1);
      expect(harnessFeb.current.currentMonthData[0].merchantName).toBe('Feb 28 Midnight Expense');
      expect(harnessFeb.current.totalExpense).toBe(120000);
      harnessFeb.unmount();
    });

    it('accurately handles year turnover from Dec 31 to Jan 1', () => {
      const dec2024 = new Date(2024, 11, 15); // December 2024
      const jan2025 = new Date(2025, 0, 15); // January 2025

      const dec31End = new Date(2024, 11, 31, 23, 59, 59, 999).getTime();
      const jan1Start = new Date(2025, 0, 1, 0, 0, 0, 0).getTime();

      useTransactionStore.setState({
        transactionsList: [
          {
            id: 301,
            merchantName: 'New Year Eve Gala',
            totalAmount: -1500000,
            type: 'expense',
            category: 'Entertainment',
            date: dec31End,
          },
          {
            id: 302,
            merchantName: 'New Year Day Brunch',
            totalAmount: -350000,
            type: 'expense',
            category: 'Food & Dining',
            date: jan1Start,
          },
        ],
      });

      const harnessDec = renderHookHarness(useMonthlySummary, dec2024);
      expect(harnessDec.current.currentMonthData.length).toBe(1);
      expect(harnessDec.current.currentMonthData[0].merchantName).toBe('New Year Eve Gala');
      expect(harnessDec.current.totalExpense).toBe(1500000);
      harnessDec.unmount();

      const harnessJan = renderHookHarness(useMonthlySummary, jan2025);
      expect(harnessJan.current.currentMonthData.length).toBe(1);
      expect(harnessJan.current.currentMonthData[0].merchantName).toBe('New Year Day Brunch');
      expect(harnessJan.current.totalExpense).toBe(350000);
      harnessJan.unmount();
    });

    it('handles extreme amount aggregations without precision overflow', () => {
      const may2024 = new Date(2024, 4, 15);
      useTransactionStore.setState({
        transactionsList: [
          {
            id: 401,
            merchantName: 'Large Business Income',
            totalAmount: 1_000_000_000_000, // 1 Trillion
            type: 'income',
            category: 'Investment',
            date: new Date(2024, 4, 10).getTime(),
          },
          {
            id: 402,
            merchantName: 'Large Asset Expense',
            totalAmount: -250_000_000_000, // 250 Billion
            type: 'expense',
            category: 'Shopping',
            date: new Date(2024, 4, 12).getTime(),
          },
        ],
      });

      const harness = renderHookHarness(useMonthlySummary, may2024);
      expect(harness.current.totalIncome).toBe(1_000_000_000_000);
      expect(harness.current.totalExpense).toBe(250_000_000_000);
      expect(harness.current.balance).toBe(750_000_000_000);
      harness.unmount();
    });
  });
});
