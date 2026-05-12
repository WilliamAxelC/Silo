import { create } from 'zustand';
import { db } from '../db/index'; 
import { transactions, transactionItems, budgets } from '../db/schema';
import { desc, eq } from 'drizzle-orm';

export interface Transaction {
  id: number;
  merchantName: string;
  totalAmount: number;
  type: string;
  category: string;
  date: number; 
  imageUri?: string | null;
  description?: string;
}

const DEFAULT_CATEGORIES = ['Food & Dining', 'Transport', 'Groceries', 'Bills', 'Entertainment', 'Salary', 'Freelance'];

interface TransactionState {
  transactionsList: Transaction[];
  categories: string[];
  budgets: Record<string, number>;
  isSaving: boolean;
  
  initDB: () => Promise<void>;
  fetchTransactions: () => Promise<void>;
  fetchBudgets: () => Promise<void>;
  addTransaction: (tx: Omit<Transaction, 'id'>) => Promise<void>;
  updateTransaction: (id: number, tx: Partial<Transaction>) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addCategory: (category: string) => void;
  setBudget: (category: string, limitAmount: number) => Promise<void>;
  
  clearAllData: () => Promise<void>;
  injectDummyData: () => Promise<void>;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactionsList: [],
  categories: DEFAULT_CATEGORIES,
  budgets: {},
  isSaving: false,

  initDB: async () => {
    // DB is initialized synchronously via expoDb openDatabaseSync in src/db/index.ts
    await get().fetchTransactions();
    await get().fetchBudgets();
  },

  fetchTransactions: async () => {
    try {
      // FIX: Use Drizzle to JOIN the relational tables into the flat array the UI expects
      const rows = await db
        .select({
          id: transactions.id,
          merchantName: transactions.merchantName,
          totalAmount: transactions.totalAmount,
          type: transactions.type,
          date: transactions.date,
          imageUri: transactions.imageUri,
          category: transactionItems.category,
        })
        .from(transactions)
        .leftJoin(transactionItems, eq(transactions.id, transactionItems.transactionId))
        .orderBy(desc(transactions.date));

      const mapped: Transaction[] = rows.map(r => ({
        id: r.id,
        merchantName: r.merchantName,
        totalAmount: r.totalAmount,
        type: r.type,
        date: r.date,
        imageUri: r.imageUri,
        category: r.category || 'Uncategorized',
      }));

      set({ transactionsList: mapped });
    } catch (error) {
      console.error("Failed to fetch transactions:", error);
    }
  },

  fetchBudgets: async () => {
    try {
      const allRows = await db.select().from(budgets);
      const budgetMap: Record<string, number> = {};
      allRows.forEach(row => { budgetMap[row.category] = row.limitAmount; });
      set({ budgets: budgetMap });
    } catch (error) {
      console.error("Failed to fetch budgets:", error);
    }
  },

  addTransaction: async (tx) => {
    set({ isSaving: true });
    try {
      // 1. Insert core transaction to get the ID
      const [newTx] = await db.insert(transactions).values({
        walletId: 1, // Default wallet ID inserted via schema.ts
        merchantName: tx.merchantName,
        totalAmount: tx.totalAmount,
        type: tx.type,
        date: tx.date,
        imageUri: tx.imageUri,
      }).returning({ id: transactions.id });

      // 2. Insert category breakdown into child table
      if (newTx && newTx.id) {
        await db.insert(transactionItems).values({
          transactionId: newTx.id,
          category: tx.category,
          amount: Math.abs(tx.totalAmount),
        });
      }

      await get().fetchTransactions();
    } catch (error) {
      console.error("Failed to add transaction:", error);
    } finally {
      set({ isSaving: false }); 
    }
  },

  updateTransaction: async (id, tx) => {
    set({ isSaving: true });
    try {
      // Update core record
      if (tx.merchantName !== undefined || tx.totalAmount !== undefined || tx.date !== undefined || tx.type !== undefined) {
        await db.update(transactions)
          .set({
            merchantName: tx.merchantName,
            totalAmount: tx.totalAmount,
            type: tx.type,
            date: tx.date,
            imageUri: tx.imageUri,
          })
          .where(eq(transactions.id, id));
      }

      // Update child category
      if (tx.category !== undefined) {
        await db.update(transactionItems)
          .set({ category: tx.category, amount: tx.totalAmount ? Math.abs(tx.totalAmount) : undefined })
          .where(eq(transactionItems.transactionId, id));
      }

      await get().fetchTransactions();
    } catch (error) {
      console.error("Failed to update transaction:", error);
    } finally {
      set({ isSaving: false });
    }
  },

  deleteTransaction: async (id) => {
    try {
      // MUST delete foreign key dependencies first
      await db.delete(transactionItems).where(eq(transactionItems.transactionId, id));
      await db.delete(transactions).where(eq(transactions.id, id));
      await get().fetchTransactions();
    } catch (error) {
      console.error("Failed to delete transaction:", error);
    }
  },

  addCategory: (newCategory) => {
    const currentCategories = get().categories;
    if (!currentCategories.includes(newCategory)) {
      set({ categories: [...currentCategories, newCategory] });
    }
  },

  setBudget: async (category, limitAmount) => {
    try {
      await db.delete(budgets).where(eq(budgets.category, category));
      await db.insert(budgets).values({ category, limitAmount, walletId: 1 });
      await get().fetchBudgets();
    } catch (error) {
      console.error("Failed to set budget:", error);
    }
  },

  clearAllData: async () => {
    try {
      await db.delete(transactionItems);
      await db.delete(transactions);
      await db.delete(budgets);
      await get().fetchTransactions();
      await get().fetchBudgets();
    } catch (error) {
      console.error("Failed to clear data:", error);
    }
  },

injectDummyData: async () => {
    set({ isSaving: true });
    try {
      const dummyTransactions: Omit<Transaction, 'id'>[] = [];
      
      // Helper function to easily generate dates for 2026
      const getMs = (month: number, day: number, hour: number = 10) => 
        new Date(2026, month - 1, day, hour, 0, 0).getTime();

      // 1. Generate Recurring Months (January to April)
      for (let m = 1; m <= 4; m++) {
        // Income
        dummyTransactions.push({ merchantName: 'PT Corporate Salary', totalAmount: 18500000, type: 'income', category: 'Salary', date: getMs(m, 25) });
        
        // Fixed Bills
        dummyTransactions.push({ merchantName: 'Apartment Rent', totalAmount: -4000000, type: 'expense', category: 'Bills', date: getMs(m, 1) });
        dummyTransactions.push({ merchantName: 'IndiHome Internet', totalAmount: -450000, type: 'expense', category: 'Bills', date: getMs(m, 5) });
        dummyTransactions.push({ merchantName: 'PLN Token', totalAmount: -500000, type: 'expense', category: 'Bills', date: getMs(m, 8) });
        dummyTransactions.push({ merchantName: 'Netflix', totalAmount: -186000, type: 'expense', category: 'Entertainment', date: getMs(m, 28) });
        
        // Variable Expenses (Groceries & Transport)
        dummyTransactions.push({ merchantName: 'Superindo', totalAmount: -850000, type: 'expense', category: 'Groceries', date: getMs(m, 10) });
        dummyTransactions.push({ merchantName: 'Superindo', totalAmount: -600000, type: 'expense', category: 'Groceries', date: getMs(m, 22) });
        dummyTransactions.push({ merchantName: 'Gojek / Grab', totalAmount: -250000, type: 'expense', category: 'Transport', date: getMs(m, 12) });
        dummyTransactions.push({ merchantName: 'Commuter Line Topup', totalAmount: -150000, type: 'expense', category: 'Transport', date: getMs(m, 26) });
        
        // Lifestyle (Food & Dining)
        dummyTransactions.push({ merchantName: 'Kopi Kenangan', totalAmount: -45000, type: 'expense', category: 'Food & Dining', date: getMs(m, 3, 8) });
        dummyTransactions.push({ merchantName: 'Kopi Kenangan', totalAmount: -45000, type: 'expense', category: 'Food & Dining', date: getMs(m, 14, 8) });
        dummyTransactions.push({ merchantName: 'Nasi Padang', totalAmount: -55000, type: 'expense', category: 'Food & Dining', date: getMs(m, 18, 12) });
        dummyTransactions.push({ merchantName: 'Sushi Tei', totalAmount: -350000, type: 'expense', category: 'Food & Dining', date: getMs(m, 20, 19) });
      }

      // 2. Generate May (Up to current date: May 8th)
      dummyTransactions.push({ merchantName: 'Apartment Rent', totalAmount: -4000000, type: 'expense', category: 'Bills', date: getMs(5, 1) });
      dummyTransactions.push({ merchantName: 'IndiHome Internet', totalAmount: -450000, type: 'expense', category: 'Bills', date: getMs(5, 5) });
      dummyTransactions.push({ merchantName: 'Kopi Kenangan', totalAmount: -45000, type: 'expense', category: 'Food & Dining', date: getMs(5, 2, 8) });
      dummyTransactions.push({ merchantName: 'Gojek / Grab', totalAmount: -100000, type: 'expense', category: 'Transport', date: getMs(5, 4) });
      dummyTransactions.push({ merchantName: 'Nasi Padang', totalAmount: -60000, type: 'expense', category: 'Food & Dining', date: getMs(5, 7, 12) });
      
      // 3. Inject sequentially using the existing action so relational logic applies
      for (const tx of dummyTransactions) {
        await get().addTransaction(tx);
      }

    } catch (error) {
      console.error("Failed to inject dummy data:", error);
    } finally {
      set({ isSaving: false });
    }
  }
}));