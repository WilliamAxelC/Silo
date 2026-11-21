import { useMemo } from 'react';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getPeriodBounds } from '../features/transactions/periods';

export const useMonthlySummary = (currentDate: Date, monthStartDayOverride?: number) => {
  const transactionsList = useTransactionStore((state) => state.transactionsList);
  const configuredMonthStartDay = useSettingsStore((state) => state.monthStartDay);
  const monthStartDay = monthStartDayOverride ?? configuredMonthStartDay ?? 1;

  const rawPeriodBounds = getPeriodBounds(currentDate, monthStartDay);
  const { startMs, endMs, monthStartDay: clampedMonthStartDay } = rawPeriodBounds;

  const periodBounds = useMemo(
    () => rawPeriodBounds,
    // Keep a stable object identity across renders/Date instances that fall in the same billing period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startMs, endMs, clampedMonthStartDay]
  );

  return useMemo(() => {
    let totalIncome = 0;
    let totalExpense = 0;
    const currentMonthData: typeof transactionsList = [];
    const currentMonthExpenses: typeof transactionsList = [];

    for (let i = 0; i < transactionsList.length; i += 1) {
      const tx = transactionsList[i];
      const ts = tx.date;
      if (typeof ts === 'number' && ts >= startMs && ts <= endMs) {
        currentMonthData.push(tx);
        // Transfers move money between the user's own accounts: neither income nor spending.
        const amount = tx.type === 'transfer' ? 0 : tx.totalAmount || 0;
        if (amount > 0) {
          totalIncome += amount;
        } else if (amount < 0) {
          currentMonthExpenses.push(tx);
          totalExpense += Math.abs(amount);
        }
      }
    }

    const balance = totalIncome - totalExpense;

    return {
      currentMonthData,
      currentMonthExpenses,
      totalIncome,
      totalExpense,
      balance,
      periodBounds,
    };
  }, [transactionsList, startMs, endMs, periodBounds]);
};