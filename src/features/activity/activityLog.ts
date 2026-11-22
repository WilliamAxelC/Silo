/**
 * Activity log: one row per thing the user did (added / edited / deleted a transaction, budget, account
 * or tag), with before/after snapshots so the change can be shown and undone. Kept for 90 days, at most
 * 2,000 rows (a few hundred bytes each).
 */
export type ActivityAction = 'create' | 'update' | 'delete';
export type ActivityEntity = 'transaction' | 'budget' | 'account' | 'tag';
/** Where a change came from, when it wasn't typed in by hand. */
export type ActivitySource = 'receipt' | 'scan' | 'recurring' | 'template' | 'undo';

export interface ActivityEntry {
  id: number;
  at: number;
  action: ActivityAction;
  entity: ActivityEntity;
  entityId: number | null;
  source: ActivitySource | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  undone: boolean;
}

export const ACTIVITY_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
export const ACTIVITY_MAX_ROWS = 2000;

interface Db {
  getAllSync<T>(sql: string, params: (string | number | null)[]): T[];
  runSync(sql: string, params: (string | number | null)[]): unknown;
}

const parse = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function logActivity(
  db: Db,
  entry: {
    action: ActivityAction;
    entity: ActivityEntity;
    entityId: number | null;
    source?: ActivitySource | null;
    before?: unknown;
    after?: unknown;
    at?: number;
  }
): void {
  try {
    db.runSync(
      `INSERT INTO activity_log (at, action, entity, entity_id, source, before_json, after_json, undone)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0);`,
      [
        entry.at ?? Date.now(),
        entry.action,
        entry.entity,
        entry.entityId,
        entry.source ?? null,
        entry.before == null ? null : JSON.stringify(entry.before),
        entry.after == null ? null : JSON.stringify(entry.after),
      ]
    );
  } catch (error) {
    // Logging must never break the change itself.
    console.warn('Could not record activity:', error);
  }
}

export function readActivity(db: Db, limit = 300): ActivityEntry[] {
  try {
    return db
      .getAllSync<{
        id: number;
        at: number;
        action: ActivityAction;
        entity: ActivityEntity;
        entityId: number | null;
        source: ActivitySource | null;
        before: string | null;
        after: string | null;
        undone: number;
      }>(
        `SELECT id, at, action, entity, entity_id AS entityId, source, before_json AS before, after_json AS after, undone
         FROM activity_log ORDER BY at DESC, id DESC LIMIT ?;`,
        [limit]
      )
      .map((row) => ({ ...row, before: parse(row.before), after: parse(row.after), undone: row.undone === 1 }));
  } catch {
    return [];
  }
}

export function markActivityUndone(db: Db, id: number): void {
  db.runSync('UPDATE activity_log SET undone = 1 WHERE id = ?;', [id]);
}

export function pruneActivity(db: Db, now: number = Date.now()): void {
  try {
    db.runSync('DELETE FROM activity_log WHERE at < ?;', [now - ACTIVITY_KEEP_MS]);
    db.runSync(
      `DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY at DESC, id DESC LIMIT ?);`,
      [ACTIVITY_MAX_ROWS]
    );
  } catch (error) {
    console.warn('Could not prune activity:', error);
  }
}
