import { addDays, addMonths, addWeeks, addYears } from 'date-fns';

import { expoDb } from '../db/index';
import type { TransactionInput } from '../features/transactions/types';

export type RecurringFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const RECURRING_FREQUENCIES: Array<{ key: RecurringFrequency; label: string }> = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
];

/** What each occurrence copies. The receipt photo is not repeated. */
export type RecurringTemplate = Omit<TransactionInput, 'date' | 'imageUri'>;

export interface RecurringRule {
  id: number;
  template: RecurringTemplate;
  frequency: RecurringFrequency;
  startDate: number;
  occurrences: number;
  isActive: boolean;
  /** Date of the next transaction this rule will create. */
  nextDate: number;
}

// Safety cap when catching up after a long time away (e.g. a daily rule and a year without opening Silo).
const MAX_CATCH_UP = 400;

export function occurrenceDate(
  startDate: number,
  frequency: RecurringFrequency,
  n: number,
): number {
  const start = new Date(startDate);
  switch (frequency) {
    case 'daily':
      return addDays(start, n).getTime();
    case 'weekly':
      return addWeeks(start, n).getTime();
    case 'yearly':
      return addYears(start, n).getTime();
    default:
      // Anchored on the start date: Jan 31 -> Feb 28 -> Mar 31, never drifting to the 28th.
      return addMonths(start, n).getTime();
  }
}

interface RuleRow {
  id: number;
  template_json: string;
  frequency: string;
  start_date: number;
  occurrences: number;
  is_active: number;
}

export function listRecurringRules(): RecurringRule[] {
  return expoDb
    .getAllSync<RuleRow>('SELECT * FROM recurring_rules ORDER BY is_active DESC, id ASC;')
    .map((row) => {
      const frequency = (RECURRING_FREQUENCIES.find((f) => f.key === row.frequency)?.key ??
        'monthly') as RecurringFrequency;
      return {
        id: row.id,
        template: JSON.parse(row.template_json) as RecurringTemplate,
        frequency,
        startDate: row.start_date,
        occurrences: row.occurrences,
        isActive: row.is_active !== 0,
        nextDate: occurrenceDate(row.start_date, frequency, row.occurrences),
      };
    });
}

/** Call after saving the first occurrence (dated startDate); the rule creates the following ones. */
export function createRecurringRule(
  template: RecurringTemplate,
  frequency: RecurringFrequency,
  startDate: number,
): number {
  const { merchantName, totalAmount, type, category, note, lineItemsText, walletId, toWalletId } =
    template;
  const result = expoDb.runSync(
    'INSERT INTO recurring_rules (template_json, frequency, start_date, occurrences, is_active, created_at) VALUES (?, ?, ?, 1, 1, ?);',
    [
      JSON.stringify({
        merchantName,
        totalAmount,
        type,
        category,
        note,
        lineItemsText,
        walletId,
        toWalletId,
      }),
      frequency,
      startDate,
      Date.now(),
    ],
  );
  return Number(result.lastInsertRowId);
}

export function setRecurringRuleActive(id: number, active: boolean) {
  expoDb.runSync('UPDATE recurring_rules SET is_active = ? WHERE id = ?;', [active ? 1 : 0, id]);
}

/** Stops future occurrences; transactions already created stay. */
export function deleteRecurringRule(id: number) {
  expoDb.runSync('DELETE FROM recurring_rules WHERE id = ?;', [id]);
}

let running: Promise<number> | null = null;

/**
 * Creates every occurrence that has come due up to `now`. The counter is saved after each transaction, so an
 * interruption never creates duplicates. Returns how many transactions were created.
 */
export function materializeDueRecurring(
  addTransaction: (tx: TransactionInput, options?: { skipRefresh?: boolean }) => Promise<void>,
  now = Date.now(),
): Promise<number> {
  if (running) return running;
  const run = (async () => {
    let created = 0;
    for (const rule of listRecurringRules()) {
      if (!rule.isActive) continue;
      let n = rule.occurrences;
      let date = occurrenceDate(rule.startDate, rule.frequency, n);
      try {
        while (date <= now && created < MAX_CATCH_UP) {
          await addTransaction({ ...rule.template, date, imageUri: null }, { skipRefresh: true });
          n += 1;
          created += 1;
          expoDb.runSync('UPDATE recurring_rules SET occurrences = ? WHERE id = ?;', [n, rule.id]);
          date = occurrenceDate(rule.startDate, rule.frequency, n);
        }
      } catch (error) {
        // e.g. its account was removed: skip this rule, keep the others going.
        console.warn(`Recurring rule ${rule.id} could not create a transaction:`, error);
      }
    }
    return created;
  })();
  // Cleared only after `running` is assigned: with nothing due the body finishes synchronously.
  running = run.finally(() => {
    running = null;
  });
  return running;
}
