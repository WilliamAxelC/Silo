import type { TransactionInput } from './types';
import { createTransactionInput } from './factories';

export function buildDummyTransactions(): TransactionInput[] {
  const dummyTransactions: TransactionInput[] = [];

  const getMs = (month: number, day: number, hour: number = 10) =>
    new Date(2026, month - 1, day, hour, 0, 0).getTime();

  for (let month = 1; month <= 4; month++) {
    dummyTransactions.push(createTransactionInput({
      merchantName: 'PT Corporate Salary',
      totalAmount: 18500000,
      type: 'income',
      category: 'Salary',
      date: getMs(month, 25),
      note: `Monthly corporate salary for month ${month}`,
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Apartment Rent',
      totalAmount: -4000000,
      type: 'expense',
      category: 'Bills',
      date: getMs(month, 1),
      note: 'Monthly rental fee',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'IndiHome Internet',
      totalAmount: -450000,
      type: 'expense',
      category: 'Bills',
      date: getMs(month, 5),
      note: 'Fiber optic internet subscription',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'PLN Token',
      totalAmount: -500000,
      type: 'expense',
      category: 'Bills',
      date: getMs(month, 8),
      note: 'Electricity token 500k',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Netflix',
      totalAmount: -186000,
      type: 'expense',
      category: 'Entertainment',
      date: getMs(month, 28),
      note: 'Premium 4K plan',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Superindo',
      totalAmount: -850000,
      type: 'expense',
      category: 'Groceries',
      date: getMs(month, 10),
      note: 'Bi-weekly grocery restock',
      lineItemsText: 'Fresh Milk | 35000\nEggs 1kg | 32000\nOrganic Rice 5kg | 95000\nChicken Breast | 65000',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Superindo',
      totalAmount: -600000,
      type: 'expense',
      category: 'Groceries',
      date: getMs(month, 22),
      note: 'Weekly grocery run',
      lineItemsText: 'Apples | 45000\nOlive Oil | 120000\nWhole Wheat Bread | 25000',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Gojek / Grab',
      totalAmount: -250000,
      type: 'expense',
      category: 'Transport',
      date: getMs(month, 12),
      note: 'Office ride hailing',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Commuter Line Topup',
      totalAmount: -150000,
      type: 'expense',
      category: 'Transport',
      date: getMs(month, 26),
      note: 'KMT card balance reload',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Kopi Kenangan',
      totalAmount: -45000,
      type: 'expense',
      category: 'Food & Dining',
      date: getMs(month, 3, 8),
      note: 'Morning iced coffee',
      lineItemsText: 'Kopi Kenangan Mantan Large | 24000\nToast | 21000',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Kopi Kenangan',
      totalAmount: -45000,
      type: 'expense',
      category: 'Food & Dining',
      date: getMs(month, 14, 8),
      note: 'Afternoon coffee break',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Nasi Padang',
      totalAmount: -55000,
      type: 'expense',
      category: 'Food & Dining',
      date: getMs(month, 18, 12),
      note: 'Lunch with beef rendang',
    }));
    dummyTransactions.push(createTransactionInput({
      merchantName: 'Sushi Tei',
      totalAmount: -350000,
      type: 'expense',
      category: 'Food & Dining',
      date: getMs(month, 20, 19),
      note: 'Dinner with friends',
      lineItemsText: 'Salmon Sashimi | 95000\nDragon Roll | 110000\nTuna Salad Crispy | 65000',
    }));
  }

  dummyTransactions.push(createTransactionInput({
    merchantName: 'Apartment Rent',
    totalAmount: -4000000,
    type: 'expense',
    category: 'Bills',
    date: getMs(5, 1),
    note: 'May apartment rental',
  }));
  dummyTransactions.push(createTransactionInput({
    merchantName: 'IndiHome Internet',
    totalAmount: -450000,
    type: 'expense',
    category: 'Bills',
    date: getMs(5, 5),
    note: 'May internet bill',
  }));
  dummyTransactions.push(createTransactionInput({
    merchantName: 'Kopi Kenangan',
    totalAmount: -45000,
    type: 'expense',
    category: 'Food & Dining',
    date: getMs(5, 2, 8),
    note: 'Iced latte',
  }));
  dummyTransactions.push(createTransactionInput({
    merchantName: 'Gojek / Grab',
    totalAmount: -100000,
    type: 'expense',
    category: 'Transport',
    date: getMs(5, 4),
    note: 'Trip to station',
  }));
  dummyTransactions.push(createTransactionInput({
    merchantName: 'Nasi Padang',
    totalAmount: -60000,
    type: 'expense',
    category: 'Food & Dining',
    date: getMs(5, 7, 12),
    note: 'Lunch ayam pop',
  }));

  return dummyTransactions;
}

