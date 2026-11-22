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

jest.mock('../../db/index', () => {
  const actual = jest.requireActual('../../db/index');
  return Object.defineProperty({ ...actual, __esModule: true }, 'expoDb', {
    get: () => (globalThis as any).__siloTestDb,
    enumerable: true,
  });
});

import { runMigrations } from '../../db/index';
import { useTransactionStore } from '../useTransactionStore';

let raw: DatabaseSync;
let db: ReturnType<typeof wrap>;
const insertTx = (walletId: number, amount: number, type: string, toWalletId: number | null = null) =>
  db.runSync(
    'INSERT INTO transactions (wallet_id, merchant_name, total_amount, type, date, to_wallet_id) VALUES (?, ?, ?, ?, 1, ?);',
    [walletId, type, amount, type, toWalletId],
  );
const balances = () => Object.fromEntries(useTransactionStore.getState().wallets.map((w) => [w.name, w.balance]));

describe('accounts', () => {
  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    db = wrap(raw);
    (globalThis as any).__siloTestDb = db;
    runMigrations(db as any);
    useTransactionStore.setState({ wallets: [] });
  });
  afterEach(() => raw.close());

  it('computes balances from opening balance, income, spending and transfers in both directions', () => {
    const { addWallet } = useTransactionStore.getState();
    const bank = addWallet({ name: 'BCA', type: 'bank', initialBalance: 1_000_000 });
    const gopay = addWallet({ name: 'GoPay', type: 'ewallet', initialBalance: 0 });

    insertTx(bank, 5_000_000, 'income');
    insertTx(bank, -200_000, 'transfer', gopay); // top up GoPay
    insertTx(gopay, -38_500, 'expense');
    insertTx(1, -20_000, 'expense'); // default cash account
    useTransactionStore.getState().fetchWallets();

    expect(balances()).toEqual({ 'Main Wallet': -20_000, BCA: 5_800_000, GoPay: 161_500 });
  });

  it('keeps foreign accounts in their own currency with an average exchange cost', () => {
    const { addWallet } = useTransactionStore.getState();
    const bca = addWallet({ name: 'BCA', type: 'bank', initialBalance: 5_000_000 });
    const yen = addWallet({ name: 'Japan Cash', type: 'cash', initialBalance: 0, currency: 'jpy' });
    const insert = (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      db.runSync(
        `INSERT INTO transactions (merchant_name, date, ${keys.join(', ')}) VALUES ('x', 1, ${keys.map(() => '?').join(', ')});`,
        Object.values(cols) as any[],
      );
    };

    // Two exchanges at different rates: Rp 1.000.000 -> ¥10.000, then Rp 1.100.000 -> ¥10.000.
    insert({ wallet_id: bca, to_wallet_id: yen, type: 'transfer', total_amount: -1_000_000, to_amount: 10_000, fx_rate: 100 });
    insert({ wallet_id: bca, to_wallet_id: yen, type: 'transfer', total_amount: -1_100_000, to_amount: 10_000, fx_rate: 110 });
    // Spend ¥3.200 (Rp 336.000 in reports) and sell ¥1.000 back for Rp 104.000.
    insert({ wallet_id: yen, type: 'expense', total_amount: -336_000, original_amount: -3_200, original_currency: 'JPY', fx_rate: 105 });
    insert({ wallet_id: yen, to_wallet_id: bca, type: 'transfer', total_amount: -104_000, original_amount: -1_000, original_currency: 'JPY', to_amount: 104_000, fx_rate: 104 });
    useTransactionStore.getState().fetchWallets();

    const wallets = useTransactionStore.getState().wallets;
    expect(wallets.find((w) => w.id === yen)).toMatchObject({ currency: 'JPY', balance: 15_800, averageRate: 105 });
    expect(wallets.find((w) => w.id === bca)).toMatchObject({ currency: null, balance: 3_004_000, averageRate: null });
  });

  it('only lets an account change currency while it has no transactions', () => {
    const { addWallet, updateWallet } = useTransactionStore.getState();
    const fresh = addWallet({ name: 'USD card', type: 'card', initialBalance: 0 });
    updateWallet(fresh, { currency: 'USD' });
    expect(useTransactionStore.getState().wallets.find((w) => w.id === fresh)?.currency).toBe('USD');

    insertTx(fresh, -10, 'expense');
    expect(() => updateWallet(fresh, { currency: 'SGD' })).toThrow("currency can't change");
  });

  it('archives accounts that have history or are the default, deletes unused ones, and keeps one active', () => {
    const { addWallet, removeWallet } = useTransactionStore.getState();
    const used = addWallet({ name: 'Old card', type: 'card', initialBalance: 0 });
    const unused = addWallet({ name: 'Typo', type: 'bank', initialBalance: 0 });
    insertTx(used, -1000, 'expense');
    useTransactionStore.getState().fetchWallets();

    expect(removeWallet(used)).toEqual({ ok: true, archived: true });
    expect(removeWallet(unused)).toEqual({ ok: true });
    expect(removeWallet(1)).toEqual({ ok: false, message: 'Keep at least one active account.' });

    const wallets = useTransactionStore.getState().wallets;
    expect(wallets.map((w) => [w.name, w.isActive])).toEqual([
      ['Main Wallet', true],
      ['Old card', false],
    ]);
  });
});
