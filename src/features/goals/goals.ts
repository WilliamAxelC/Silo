import { create } from 'zustand';

import { expoDb } from '../../db/index';
import type { Wallet } from '../transactions/types';
import { walletHomeRate } from '../../services/fx/rates';

export type GoalSource = 'manual' | 'account';

export interface Goal {
  id: number;
  name: string;
  /** Home currency. */
  targetAmount: number;
  targetDate: number | null;
  source: GoalSource;
  walletId: number | null;
  /** Manual goals: what has been put aside so far (home currency). */
  savedAmount: number;
  archived: boolean;
  createdAt: number;
}

export type GoalInput = Omit<Goal, 'id' | 'createdAt' | 'archived'> & { archived?: boolean };

export interface GoalProgress {
  current: number;
  remaining: number;
  /** 0..1 */
  fraction: number;
  done: boolean;
  /** Months left until the target date (at least 1), when there is one and it is not reached. */
  monthsLeft: number | null;
  /** Amount to put aside each month to make the date. */
  perMonth: number | null;
  overdue: boolean;
}

/** Whole calendar months from `now` to `date`, counting the current month, never below 1. */
export function monthsUntil(date: number, now: number): number {
  const a = new Date(now);
  const b = new Date(date);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  return Math.max(1, months);
}

/**
 * Account goals follow the account's balance (foreign accounts converted at their average cost, or today's
 * rate); manual goals use the saved amount.
 */
export function goalProgress(goal: Goal, wallets: Wallet[], homeCurrency: string, now = Date.now()): GoalProgress {
  let current = goal.savedAmount;
  if (goal.source === 'account') {
    const wallet = wallets.find((w) => w.id === goal.walletId);
    if (!wallet) current = 0;
    else if (!wallet.currency || wallet.currency === homeCurrency) current = wallet.balance;
    else {
      const rate = walletHomeRate(wallet, homeCurrency);
      current = rate ? wallet.balance * rate : 0;
    }
  }
  current = Math.max(0, current);
  const target = Math.max(0, goal.targetAmount);
  const remaining = Math.max(0, target - current);
  const done = target > 0 && current >= target;
  const fraction = target > 0 ? Math.min(1, current / target) : 0;
  let monthsLeft: number | null = null;
  let perMonth: number | null = null;
  const overdue = Boolean(goal.targetDate && goal.targetDate < now && !done);
  if (goal.targetDate && !done && !overdue) {
    monthsLeft = monthsUntil(goal.targetDate, now);
    perMonth = Math.ceil(remaining / monthsLeft);
  }
  return { current, remaining, fraction, done, monthsLeft, perMonth, overdue };
}

export function validateGoal(input: Partial<GoalInput>): string | null {
  if (!input.name || !input.name.trim()) return 'Give the goal a name.';
  if (!input.targetAmount || !(input.targetAmount > 0)) return 'Set a target amount above 0.';
  if (input.source === 'account' && input.walletId == null) return 'Pick the account that holds the savings.';
  return null;
}

type Row = {
  id: number;
  name: string;
  target_amount: number;
  target_date: number | null;
  source: string;
  wallet_id: number | null;
  saved_amount: number;
  archived: number;
  created_at: number;
};

const fromRow = (r: Row): Goal => ({
  id: r.id,
  name: r.name,
  targetAmount: r.target_amount,
  targetDate: r.target_date ?? null,
  source: r.source === 'account' ? 'account' : 'manual',
  walletId: r.wallet_id ?? null,
  savedAmount: r.saved_amount ?? 0,
  archived: Boolean(r.archived),
  createdAt: r.created_at,
});

export function readGoals(db = expoDb): Goal[] {
  try {
    return db.getAllSync<Row>('SELECT * FROM goals ORDER BY archived, created_at;').map(fromRow);
  } catch {
    return [];
  }
}

interface GoalsState {
  goals: Goal[];
  loaded: boolean;
  /** Reads goals from the database (after a restore or erase, or on first use). */
  load: () => void;
  /** Loads once; later reads come from the store, which every change below keeps current. */
  ensureLoaded: () => void;
  save: (input: GoalInput, id?: number) => { ok: boolean; message?: string };
  addSaved: (id: number, amount: number) => void;
  setArchived: (id: number, archived: boolean) => void;
  remove: (id: number) => void;
}

export const useGoalsStore = create<GoalsState>((set, get) => ({
  goals: [],
  loaded: false,
  load: () => set({ goals: readGoals(), loaded: true }),
  ensureLoaded: () => {
    if (!get().loaded) get().load();
  },
  save: (input, id) => {
    const problem = validateGoal(input);
    if (problem) return { ok: false, message: problem };
    const params = [
      input.name.trim().slice(0, 60),
      input.targetAmount,
      input.targetDate ?? null,
      input.source,
      input.source === 'account' ? input.walletId : null,
      input.source === 'manual' ? Math.max(0, input.savedAmount || 0) : 0,
    ];
    if (id) {
      expoDb.runSync(
        'UPDATE goals SET name = ?, target_amount = ?, target_date = ?, source = ?, wallet_id = ?, saved_amount = ? WHERE id = ?;',
        [...params, id],
      );
    } else {
      expoDb.runSync(
        'INSERT INTO goals (name, target_amount, target_date, source, wallet_id, saved_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
        [...params, Date.now()],
      );
    }
    set({ goals: readGoals() });
    return { ok: true };
  },
  addSaved: (id, amount) => {
    expoDb.runSync('UPDATE goals SET saved_amount = MAX(0, saved_amount + ?) WHERE id = ?;', [amount, id]);
    set({ goals: readGoals() });
  },
  setArchived: (id, archived) => {
    expoDb.runSync('UPDATE goals SET archived = ? WHERE id = ?;', [archived ? 1 : 0, id]);
    set({ goals: readGoals() });
  },
  remove: (id) => {
    expoDb.runSync('DELETE FROM goals WHERE id = ?;', [id]);
    set({ goals: readGoals() });
  },
}));
