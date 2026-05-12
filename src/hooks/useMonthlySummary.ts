import { useMemo } from 'react';
import { isSameMonth } from 'date-fns';
import { useTransactionStore } from '../store/useTransactionStore';

export const useMonthlySummary = (currentDate: Date) => {
  const transactionsList = useTransactionStore((state) => state.transactionsList);

  return useMemo(() => {
    // 1. Safe Date Filtering (Ignores corrupted dates)
    const currentMonthData = transactionsList.filter(tx => 
      tx.date && isSameMonth(new Date(tx.date), currentDate)
    );

    // 2. Centralized Math with Fallbacks (|| 0)
    const totalIncome = currentMonthData
      .filter(tx => (tx.totalAmount || 0) > 0)
      .reduce((acc, curr) => acc + (curr.totalAmount || 0), 0);
      
    const currentMonthExpenses = currentMonthData.filter(tx => (tx.totalAmount || 0) < 0);
    
    const totalExpense = currentMonthExpenses
      .reduce((acc, curr) => acc + Math.abs(curr.totalAmount || 0), 0);
      
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