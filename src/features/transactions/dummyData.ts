import type { TransactionInput } from './types';
import { createTransactionInput } from './factories';

export function buildDummyTransactions(): TransactionInput[] {
  const dummyTransactions: TransactionInput[] = [];

  const getMs = (month: number, day: number, hour: number = 10) =>
    new Date(2026, month - 1, day, hour, 0, 0).getTime();

  for (let month = 1; month <= 4; month++) {
    dummyTransactions.push(createTransactionInput({ merchantName: 'PT Corporate Salary', totalAmount: 18500000, type: 'income', category: 'Salary', date: getMs(month, 25) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Apartment Rent', totalAmount: -4000000, type: 'expense', category: 'Bills', date: getMs(month, 1) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'IndiHome Internet', totalAmount: -450000, type: 'expense', category: 'Bills', date: getMs(month, 5) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'PLN Token', totalAmount: -500000, type: 'expense', category: 'Bills', date: getMs(month, 8) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Netflix', totalAmount: -186000, type: 'expense', category: 'Entertainment', date: getMs(month, 28) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Superindo', totalAmount: -850000, type: 'expense', category: 'Groceries', date: getMs(month, 10) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Superindo', totalAmount: -600000, type: 'expense', category: 'Groceries', date: getMs(month, 22) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Gojek / Grab', totalAmount: -250000, type: 'expense', category: 'Transport', date: getMs(month, 12) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Commuter Line Topup', totalAmount: -150000, type: 'expense', category: 'Transport', date: getMs(month, 26) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Kopi Kenangan', totalAmount: -45000, type: 'expense', category: 'Food & Dining', date: getMs(month, 3, 8) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Kopi Kenangan', totalAmount: -45000, type: 'expense', category: 'Food & Dining', date: getMs(month, 14, 8) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Nasi Padang', totalAmount: -55000, type: 'expense', category: 'Food & Dining', date: getMs(month, 18, 12) }));
    dummyTransactions.push(createTransactionInput({ merchantName: 'Sushi Tei', totalAmount: -350000, type: 'expense', category: 'Food & Dining', date: getMs(month, 20, 19) }));
  }

  dummyTransactions.push(createTransactionInput({ merchantName: 'Apartment Rent', totalAmount: -4000000, type: 'expense', category: 'Bills', date: getMs(5, 1) }));
  dummyTransactions.push(createTransactionInput({ merchantName: 'IndiHome Internet', totalAmount: -450000, type: 'expense', category: 'Bills', date: getMs(5, 5) }));
  dummyTransactions.push(createTransactionInput({ merchantName: 'Kopi Kenangan', totalAmount: -45000, type: 'expense', category: 'Food & Dining', date: getMs(5, 2, 8) }));
  dummyTransactions.push(createTransactionInput({ merchantName: 'Gojek / Grab', totalAmount: -100000, type: 'expense', category: 'Transport', date: getMs(5, 4) }));
  dummyTransactions.push(createTransactionInput({ merchantName: 'Nasi Padang', totalAmount: -60000, type: 'expense', category: 'Food & Dining', date: getMs(5, 7, 12) }));

  return dummyTransactions;
}
