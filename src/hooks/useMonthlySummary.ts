import { useMemo } from 'react';
import { isSameMonth } from 'date-fns';
import { useTransactionStore } from '../store/useTransactionStore';

export const useMonthlySummary = (currentDate: Date) => {
  const transactionsList = useTransactionStore((state) => state.transactionsList);

  return useMemo(() => {
    const { totalIncome, totalExpense, currentMonthData, currentMonthExpenses } = transactionsList.reduce(
      (acc, tx) => {
        if (tx.date && isSameMonth(new Date(tx.date), currentDate)) {
          acc.currentMonthData.push(tx);
          const amount = tx.totalAmount || 0;
          if (amount > 0) {
            acc.totalIncome += amount;
          } else if (amount < 0) {
            acc.currentMonthExpenses.push(tx);
            acc.totalExpense += Math.abs(amount);
          }
        }
        return acc;
      },
      {
        totalIncome: 0,
        totalExpense: 0,
        currentMonthData: [] as typeof transactionsList,
        currentMonthExpenses: [] as typeof transactionsList,
      }
    );

    const balance = totalIncome - totalExpense;

    return {
      currentMonthData,
      currentMonthExpenses,
      totalIncome,
      totalExpense,
      balance
    };
  }, [transactionsList, currentDate]);
};