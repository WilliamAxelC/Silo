import { DatabaseSync } from 'node:sqlite';

function wrap(raw: DatabaseSync) {
  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: <T = any>(sql: string, params: any[] = []): T[] => raw.prepare(sql).all(...params) as T[],
    getFirstSync: <T = any>(sql: string, params: any[] = []): T | null =>
      (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    runSync: (sql: string, params: any[] = []) => {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    withTransactionSync: (cb: () => void) => {
      raw.exec('BEGIN;');
      try {
        cb();
        raw.exec('COMMIT;');
      } catch (e) {
        raw.exec('ROLLBACK;');
        throw e;
      }
    },
  };
}

jest.mock('../../../db/index', () => {
  const actual = jest.requireActual('../../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations } from '../../../db/index';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useTransactionStore } from '../../../store/useTransactionStore';
import {
  getTransactionSplitCounts,
  groupSplitsByBill,
  groupUnpaidByPerson,
  useSplitsStore,
} from '../store';

describe('useSplitsStore', () => {
  let raw: DatabaseSync;
  let db: ReturnType<typeof wrap>;
  let nextTxId: number;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    db = wrap(raw);
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
    db.runSync(
      `INSERT INTO wallets (id, name, type, is_active, initial_balance, currency) VALUES (2, 'JPY Cash', 'cash', 1, 0, 'JPY');`
    );
    nextTxId = 500;

    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true });
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: null, averageRate: null },
        { id: 2, name: 'JPY Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 0, currency: 'JPY', averageRate: 100 },
      ],
      categories: [{ id: 1, name: 'Salary', type: 'income', isSystem: true, createdAt: 1 }],
      addCategory: jest.fn(async (name: string) => name),
      addTransaction: jest.fn(async (tx: any) => {
        const id = nextTxId++;
        db.runSync(
          `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, note, original_amount, original_currency, fx_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            id,
            tx.walletId ?? 1,
            tx.merchantName,
            tx.totalAmount,
            tx.type,
            tx.date,
            tx.note ?? '',
            tx.originalAmount ?? null,
            tx.originalCurrency ?? null,
            tx.fxRate ?? null,
          ]
        );
        return id;
      }),
      deleteTransaction: jest.fn(async (id: number) => {
        db.runSync('DELETE FROM transactions WHERE id = ?;', [id]);
      }),
    } as any);

    useSplitsStore.setState({
      contacts: [],
      splits: [],
      paymentDetails: '',
      defaultCountryCode: '',
      loaded: false,
    });
  });

  afterEach(() => {
    raw.close();
  });

  it('creates, updates, deduplicates imported contacts, and syncs unpaid split names/phones', () => {
    const store = useSplitsStore.getState();
    const budi = store.addContact({ name: 'Budi', phone: '0812345' });
    expect(budi?.name).toBe('Budi');

    const importRes = store.importDeviceContacts([
      { deviceContactId: 'os-1', name: 'Budi', phone: '0812-345', allPhones: ['0812-345'] },
      { deviceContactId: 'os-2', name: 'Sari', phone: '0898765', allPhones: ['0898765'] },
    ]);
    expect(importRes).toEqual({ added: 1, skipped: 1 });
    expect(useSplitsStore.getState().contacts.map((c) => c.name)).toEqual(['Budi', 'Sari']);

    db.runSync(
      `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (10, 1, 'Dinner', -100000, 'expense', 1000);`
    );
    useSplitsStore.getState().saveBillSplits(10, {
      mode: 'equal',
      currency: 'IDR',
      entries: [{ contactId: budi!.id, personName: 'Budi', phone: '0812345', amountOwed: 50000, breakdown: null }],
    });

    useSplitsStore.getState().updateContact(budi!.id, { name: 'Budi Santoso', phone: '+62812345' });
    const updatedSplit = useSplitsStore.getState().splits[0];
    expect(updatedSplit.personName).toBe('Budi Santoso');
    expect(updatedSplit.phone).toBe('+62812345');
  });

  it('preserves settled state on bill edit and logs/deletes repayment income transaction cleanly', async () => {
    const budi = useSplitsStore.getState().addContact({ name: 'Budi', phone: '0812' })!;
    const sari = useSplitsStore.getState().addContact({ name: 'Sari', phone: '0899' })!;

    db.runSync(
      `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date, original_amount, original_currency, fx_rate)
       VALUES (20, 2, 'Tokyo Ramen', -300000, 'expense', 2000, -3000, 'JPY', 100);`
    );

    useSplitsStore.getState().saveBillSplits(20, {
      mode: 'equal',
      currency: 'JPY',
      entries: [
        { contactId: budi.id, personName: 'Budi', phone: '0812', amountOwed: 1000, breakdown: { includeSelf: true, totalParticipants: 3 } },
        { contactId: sari.id, personName: 'Sari', phone: '0899', amountOwed: 1000, breakdown: { includeSelf: true, totalParticipants: 3 } },
      ],
    });

    const firstSplit = useSplitsStore.getState().splits[0];
    await useSplitsStore.getState().markSplitSettled(firstSplit.id, { logRepayment: true, walletId: 2 });

    const afterSettle = useSplitsStore.getState().splits;
    const settledBudi = afterSettle.find((s) => s.contactId === budi.id)!;
    expect(settledBudi.isSettled).toBe(true);
    expect(settledBudi.repaymentTransactionId).toBe(500);

    const repaymentTx = db.getFirstSync<{
      total_amount: number;
      original_amount: number;
      original_currency: string;
      fx_rate: number;
      type: string;
    }>('SELECT total_amount, original_amount, original_currency, fx_rate, type FROM transactions WHERE id = 500;');
    expect(repaymentTx).toEqual({
      total_amount: 100_000,
      original_amount: 1000,
      original_currency: 'JPY',
      fx_rate: 100,
      type: 'income',
    });

    // Editing the bill keeps Budi's settled state
    useSplitsStore.getState().saveBillSplits(20, {
      mode: 'custom',
      currency: 'JPY',
      entries: [
        { contactId: budi.id, personName: 'Budi', phone: '0812', amountOwed: 1000, breakdown: null },
        { contactId: sari.id, personName: 'Sari', phone: '0899', amountOwed: 1200, breakdown: null },
      ],
    });
    const afterEdit = useSplitsStore.getState().splits;
    expect(afterEdit.find((s) => s.contactId === budi.id)?.isSettled).toBe(true);
    expect(afterEdit.find((s) => s.contactId === sari.id)?.isSettled).toBe(false);

    // Unmarking with deleteRepayment removes the linked income transaction
    await useSplitsStore.getState().markSplitUnsettled(
      afterEdit.find((s) => s.contactId === budi.id)!.id,
      { deleteRepayment: true }
    );
    expect(db.getFirstSync('SELECT id FROM transactions WHERE id = 500;')).toBeNull();
    expect(useSplitsStore.getState().splits.every((s) => !s.isSettled)).toBe(true);
  });

  it('groups splits by bill and by unpaid person across bills', async () => {
    const budi = useSplitsStore.getState().addContact({ name: 'Budi', phone: '0812' })!;
    db.runSync(
      `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (1, 1, 'Coffee', -60000, 'expense', 1000);`
    );
    db.runSync(
      `INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (2, 1, 'Dinner', -100000, 'expense', 2000);`
    );

    useSplitsStore.getState().saveBillSplits(1, {
      mode: 'equal',
      currency: 'IDR',
      entries: [{ contactId: budi.id, personName: 'Budi', phone: '0812', amountOwed: 30000, breakdown: null }],
    });
    useSplitsStore.getState().saveBillSplits(2, {
      mode: 'equal',
      currency: 'IDR',
      entries: [{ contactId: budi.id, personName: 'Budi', phone: '0812', amountOwed: 50000, breakdown: null }],
    });

    const splits = useSplitsStore.getState().splits;
    expect(groupSplitsByBill(splits)).toHaveLength(2);
    const people = groupUnpaidByPerson(splits);
    expect(people).toHaveLength(1);
    expect(people[0].totalsByCurrency).toEqual([{ currency: 'IDR', amount: 80_000 }]);
    expect(getTransactionSplitCounts(splits)).toEqual({
      1: { total: 1, unpaid: 1 },
      2: { total: 1, unpaid: 1 },
    });

    await useSplitsStore.getState().markAllForPersonSettled(people[0].entries, { logRepayment: false });
    expect(groupUnpaidByPerson(useSplitsStore.getState().splits)).toEqual([]);
  });
});
