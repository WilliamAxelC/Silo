import { eq } from 'drizzle-orm';
import { sqliteTable, sqliteView, text, integer, real } from 'drizzle-orm/sqlite-core';

export const wallets = sqliteTable('wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  initialBalance: real('initial_balance').notNull().default(0),
});

export const budgets = sqliteTable('budgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull(),
  limitAmount: real('limit_amount').notNull(),
  period: text('period').default('monthly'),
  walletId: integer('wallet_id').references(() => wallets.id, { onDelete: 'cascade' }),
});

export const transactions = sqliteTable('transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  walletId: integer('wallet_id').references(() => wallets.id, { onDelete: 'cascade' }).notNull(),
  merchantName: text('merchant_name').notNull(),
  totalAmount: real('total_amount').notNull(),
  type: text('type').notNull(),
  date: integer('date').notNull(),
  imageUri: text('image_uri'),
  note: text('note'),
  lineItemsText: text('line_items_text'),
  // Transfers only: the account receiving the money. The amount is stored negative on wallet_id (the source).
  toWalletId: integer('to_wallet_id').references(() => wallets.id),
});

export const transactionItems = sqliteTable('transaction_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }).notNull(),
  category: text('category').notNull(),
  amount: real('amount').notNull(),
});

export const aiTransactionsView = sqliteView('ai_transactions_view').as((qb) =>
  qb.select({
    transactionId: transactions.id,
    merchantName: transactions.merchantName,
    totalAmount: transactions.totalAmount,
    type: transactions.type,
    date: transactions.date,
    note: transactions.note,
    lineItemsText: transactions.lineItemsText,
    category: transactionItems.category,
  })
    .from(transactions)
    .leftJoin(transactionItems, eq(transactions.id, transactionItems.transactionId))
);

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  isSystem: integer('is_system', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sharedSplits = sqliteTable('shared_splits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }).notNull(),
  personName: text('person_name').notNull(),
  amountOwed: real('amount_owed').notNull(),
  isSettled: integer('is_settled', { mode: 'boolean' }).default(false),
});
