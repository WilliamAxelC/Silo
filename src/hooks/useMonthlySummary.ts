import { useMemo } from 'react';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getPeriodBounds, isDateInPeriod } from '../features/transactions/periods';

export const useMonthlySummary = (currentDate: Date, monthStartDayOverride?: number) => {
  const transactionsList = useTransactionStore((state) => state.transactionsList);
  const configuredMonthStartDay = useSettingsStore((state) => state.monthStartDay);
  const monthStartDay = monthStartDayOverride ?? configuredMonthStartDay ?? 1;

  return useMemo(() => {
    const periodBounds = getPeriodBounds(currentDate, monthStartDay);
    const { totalIncome, totalExpense, currentMonthData, currentMonthExpenses } = transactionsList.reduce(
      (acc, tx) => {
        if (tx.date && isDateInPeriod(tx.date, periodBounds)) {
          acc.currentMonthData.push(tx);
          // Transfers move money between the user's own accounts: neither income nor spending.
          const amount = tx.type === 'transfer' ? 0 : tx.totalAmount || 0;
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
      balance,
      periodBounds,
    };
  }, [transactionsList, currentDate, monthStartDay]);
};