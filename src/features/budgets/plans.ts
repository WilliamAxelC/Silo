import type { BudgetKind, BudgetPlan, BudgetRollover, BudgetUnit } from './engine';
import { normalizeCurrencyCode } from '../currency/currencies';

interface Db {
  getAllSync<T>(sql: string, params: (string | number | null)[]): T[];
  runSync(sql: string, params: (string | number | null)[]): { lastInsertRowId: number; changes: number };
}

export type BudgetPlanInput = Omit<BudgetPlan, 'id' | 'archived'> & { archived?: boolean };

const UNITS = new Set<BudgetUnit>(['day', 'week', 'month', 'year']);

function parseList<T>(json: string | null, guard: (v: unknown) => v is T): T[] {
  try {
    const parsed = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}
const isString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function readBudgetPlans(db: Db): BudgetPlan[] {
  const rows = db.getAllSync<{
    id: number; name: string; amount: number; currency: string | null; kind: string; startDate: number;
    endDate: number | null; every: number; unit: string; rollover: string; carryOverspend: number;
    categories: string; walletIds: string; tags: string; archived: number;
  }>(
    `SELECT id, name, amount, currency, kind, start_date AS startDate, end_date AS endDate, every, unit, rollover,
            carry_overspend AS carryOverspend, categories, wallet_ids AS walletIds, tags, archived
     FROM budget_plans ORDER BY archived ASC, kind DESC, id ASC;`,
    []
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    amount: Number(row.amount) || 0,
    currency: normalizeCurrencyCode(row.currency),
    kind: (row.kind === 'once' ? 'once' : 'recurring') as BudgetKind,
    startDate: row.startDate,
    endDate: row.endDate ?? null,
    every: Math.max(1, Number(row.every) || 1),
    unit: UNITS.has(row.unit as BudgetUnit) ? (row.unit as BudgetUnit) : 'month',
    rollover: (row.rollover === 'carry' ? 'carry' : 'reset') as BudgetRollover,
    carryOverspend: row.carryOverspend === 1,
    categories: parseList(row.categories, isString),
    walletIds: parseList(row.walletIds, isId),
    tags: parseList(row.tags, isString),
    archived: row.archived === 1,
  }));
}

export function validateBudgetPlan(input: BudgetPlanInput): string | null {
  if (!input.name.trim()) return 'Give the budget a name.';
  if (!(input.amount > 0)) return 'Enter an amount above zero.';
  if (!Number.isFinite(input.startDate)) return 'Pick a start date.';
  if (input.kind === 'once' && (input.endDate == null || input.endDate < input.startDate)) {
    return 'Pick an end date on or after the start date.';
  }
  if (input.kind === 'recurring' && !(input.every >= 1)) return 'Repeat at least every 1 period.';
  return null;
}

/** Inserts (id null) or updates a budget plan; returns its id. */
export function saveBudgetPlan(db: Db, id: number | null, input: BudgetPlanInput): number {
  const error = validateBudgetPlan(input);
  if (error) throw new Error(error);
  const values = [
    input.name.trim(),
    input.amount,
    normalizeCurrencyCode(input.currency),
    input.kind,
    input.startDate,
    input.endDate ?? null,
    input.kind === 'once' ? 1 : Math.floor(input.every),
    input.unit,
    input.kind === 'once' ? 'reset' : input.rollover,
    input.kind === 'recurring' && input.rollover === 'carry' && input.carryOverspend ? 1 : 0,
    JSON.stringify(input.categories),
    JSON.stringify(input.walletIds),
    JSON.stringify(input.tags),
    input.archived ? 1 : 0,
  ];
  if (id == null) {
    const result = db.runSync(
      `INSERT INTO budget_plans (name, amount, currency, kind, start_date, end_date, every, unit, rollover, carry_overspend,
                                 categories, wallet_ids, tags, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [...values, Date.now()]
    );
    return Number(result.lastInsertRowId);
  }
  db.runSync(
    `UPDATE budget_plans SET name = ?, amount = ?, currency = ?, kind = ?, start_date = ?, end_date = ?, every = ?, unit = ?,
       rollover = ?, carry_overspend = ?, categories = ?, wallet_ids = ?, tags = ?, archived = ? WHERE id = ?;`,
    [...values, id]
  );
  return id;
}

export function deleteBudgetPlan(db: Db, id: number) {
  db.runSync('DELETE FROM budget_plans WHERE id = ?;', [id]);
}

/** Keeps plan filters in step when a category is renamed. */
export function renameCategoryInPlans(db: Db, from: string, to: string) {
  for (const plan of readBudgetPlans(db)) {
    if (!plan.categories.includes(from)) continue;
    const next = Array.from(new Set(plan.categories.map((c) => (c === from ? to : c))));
    db.runSync('UPDATE budget_plans SET categories = ? WHERE id = ?;', [JSON.stringify(next), plan.id]);
  }
}
