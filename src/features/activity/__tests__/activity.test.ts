import { DatabaseSync } from 'node:sqlite';

function wrap(raw: DatabaseSync) {
  return {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: (sql: string, params: any[] = []) => raw.prepare(sql).all(...params),
    getFirstSync: (sql: string, params: any[] = []) => raw.prepare(sql).get(...params) ?? null,
    runSync: (sql: string, params: any[] = []) => {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    withTransactionSync: (cb: () => void) => cb(),
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
import { useTransactionStore } from '../../../store/useTransactionStore';
import { ACTIVITY_KEEP_MS, logActivity, pruneActivity, readActivity } from '../activityLog';
import { describeActivity } from '../describeActivity';

const ctx = { homeCurrency: 'IDR', useThousands: true, dateLocale: 'en-GB', walletName: (id: any) => ({ 1: 'Cash', 2: 'BCA' } as any)[id] };

describe('activity log', () => {
  let raw: DatabaseSync;
  let db: ReturnType<typeof wrap>;
  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    db = wrap(raw);
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
    useTransactionStore.setState({ wallets: [], tags: [], budgetPlans: [], activity: [] } as any);
  });
  afterEach(() => raw.close());

  it('describes changes in plain words, including what an edit changed', () => {
    const before = { merchantName: 'Super Indo', totalAmount: -23695, date: new Date(2025, 10, 22).getTime(), category: 'Groceries', walletId: 1, tags: [] };
    const after = { ...before, date: new Date(2026, 10, 22).getTime(), walletId: 2, tags: ['date'] };
    const added = describeActivity({ id: 1, at: 1, action: 'create', entity: 'transaction', entityId: 5, source: 'scan', before: null, after: before, undone: false }, ctx);
    expect(added.title).toBe('Added Super Indo');
    expect(added.detail).toBe('Rp 23.695 · dated 22 Nov 2025 · scanned receipt');
    const edited = describeActivity({ id: 2, at: 2, action: 'update', entity: 'transaction', entityId: 5, source: null, before, after, undone: false }, ctx);
    expect(edited.detail).toBe('Date 22 Nov 2025 → 22 Nov 2026 · Account Cash → BCA · Tags none → date');
    const yen = describeActivity(
      { id: 3, at: 3, action: 'delete', entity: 'transaction', entityId: 6, source: null, before: { merchantName: 'Ramen', totalAmount: -336000, originalAmount: -3200, originalCurrency: 'JPY', date: 0 }, after: null, undone: false },
      ctx,
    );
    expect(yen.title).toBe('Deleted Ramen');
    expect(yen.detail.startsWith('¥ 3.200')).toBe(true);
  });

  it('prunes entries older than 90 days', () => {
    logActivity(db as any, { action: 'create', entity: 'budget', entityId: 1, after: { name: 'old' }, at: Date.now() - ACTIVITY_KEEP_MS - 1 });
    logActivity(db as any, { action: 'create', entity: 'budget', entityId: 2, after: { name: 'new' } });
    pruneActivity(db as any);
    expect(readActivity(db as any).map((e) => (e.after as any).name)).toEqual(['new']);
  });

  it('logs account, budget and tag changes and undoes them', async () => {
    const store = useTransactionStore.getState();
    const id = store.addWallet({ name: 'Jago', type: 'bank', initialBalance: 0 });
    store.updateWallet(id, { name: 'Bank Jago' });
    const planId = store.saveBudgetPlan(null, {
      name: 'Food', amount: 1_000_000, currency: null, kind: 'recurring', startDate: Date.now(), endDate: null, every: 1, unit: 'month',
      rollover: 'reset', carryOverspend: false, categories: [], walletIds: [], tags: [],
    });
    store.deleteBudgetPlan(planId);
    store.fetchActivity();
    expect(useTransactionStore.getState().activity.map((e) => `${e.action} ${e.entity}`)).toEqual([
      'delete budget', 'create budget', 'update account', 'create account',
    ]);

    const [deleteBudget, , renameAccount] = useTransactionStore.getState().activity;
    expect(await store.undoActivity(deleteBudget.id)).toEqual({ ok: true });
    expect(useTransactionStore.getState().budgetPlans.map((p) => p.name)).toEqual(['Food']);
    expect(await store.undoActivity(renameAccount.id)).toEqual({ ok: true });
    expect(useTransactionStore.getState().wallets.find((w) => w.id === id)?.name).toBe('Jago');
    expect(await store.undoActivity(renameAccount.id)).toEqual({ ok: false, message: 'Already undone.' });
    // Undoing doesn't add its own entries.
    expect(useTransactionStore.getState().activity).toHaveLength(4);
  });

  it('undoes transaction adds, edits and deletes through the store', async () => {
    const del = jest.spyOn(useTransactionStore.getState(), 'deleteTransaction').mockResolvedValue();
    const add = jest.spyOn(useTransactionStore.getState(), 'addTransaction').mockResolvedValue(9);
    const upd = jest.spyOn(useTransactionStore.getState(), 'updateTransaction').mockResolvedValue();
    db.runSync(`INSERT INTO transactions (id, wallet_id, merchant_name, total_amount, type, date) VALUES (5, 1, 'Super Indo', -23695, 'expense', 1);`);
    const snap = { id: 5, merchantName: 'Super Indo', totalAmount: -23695, type: 'expense', date: 1, category: 'Groceries', walletId: 1, tags: ['date'] };
    logActivity(db as any, { action: 'create', entity: 'transaction', entityId: 5, after: snap });
    logActivity(db as any, { action: 'update', entity: 'transaction', entityId: 5, before: snap, after: { ...snap, date: 2 } });
    logActivity(db as any, { action: 'delete', entity: 'transaction', entityId: 4, before: { ...snap, id: 4 } });
    const [deleted, edited, created] = readActivity(db as any);
    const store = useTransactionStore.getState();

    await store.undoActivity(deleted.id);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ merchantName: 'Super Indo', tags: ['date'] }), { skipLog: true });
    expect(add.mock.calls[0][0]).not.toHaveProperty('id');
    await store.undoActivity(edited.id);
    expect(upd).toHaveBeenCalledWith(5, expect.objectContaining({ date: 1 }), { skipLog: true });
    await store.undoActivity(created.id);
    expect(del).toHaveBeenCalledWith(5, { skipLog: true });
    jest.restoreAllMocks();
  });
});
