import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const wallets = sqliteTable('wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'bank', 'ewallet', 'cash'
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
});

export const budgets = sqliteTable('budgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull(),
  limitAmount: real('limit_amount').notNull(),
  period: text('period').default('monthly'),
  walletId: integer('wallet_id').references(() => wallets.id),
});

export const transactions = sqliteTable('transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  walletId: integer('wallet_id').references(() => wallets.id).notNull(),
  merchantName: text('merchant_name').notNull(),
  totalAmount: real('total_amount').notNull(),
  type: text('type').notNull(), // 'expense', 'income', 'transfer'
  date: integer('date').notNull(), // Unix timestamp
  imageUri: text('image_uri'),
});

export const transactionItems = sqliteTable('transaction_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transactionId: integer('transaction_id').references(() => transactions.id).notNull(),
  category: text('category').notNull(),
  amount: real('amount').notNull(),
});

export const sharedSplits = sqliteTable('shared_splits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transactionId: integer('transaction_id').references(() => transactions.id).notNull(),
  personName: text('person_name').notNull(),
  amountOwed: real('amount_owed').notNull(),
  isSettled: integer('is_settled', { mode: 'boolean' }).default(false),
});