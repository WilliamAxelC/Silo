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
