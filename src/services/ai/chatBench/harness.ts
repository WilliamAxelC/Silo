/**
 * Builds the exact prompt Silo's chat screen would send for a benchmark case, against a seeded in-memory
 * database. Used by the retrieval test (no model) and the model benchmark (llama-server).
 */
import { DatabaseSync } from 'node:sqlite';
import { buildLocalMessagesForMode, buildRetrievedContext, type ExternalChatMessage, type GroundedSqliteDb } from '../agent';
import { runMigrations } from '../../../db/index';
import { BENCH_NOW, seedBenchDb } from './fixture';
import type { BenchCase } from './cases';

export function openBenchDb(): GroundedSqliteDb {
  const raw = new DatabaseSync(':memory:');
  const db = {
    execSync: (sql: string) => raw.exec(sql),
    getAllSync: <T = any>(sql: string, params: any[] = []): T[] => raw.prepare(sql).all(...params) as T[],
    getFirstSync: <T = any>(sql: string, params: any[] = []): T | null => (raw.prepare(sql).get(...params) as T) ?? null,
    runSync: (sql: string, params: any[] = []) => {
      const res = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(res.lastInsertRowid), changes: Number(res.changes) };
    },
    withTransactionSync: <T = void>(cb: () => T): T => {
      raw.exec('BEGIN TRANSACTION;');
      try {
        const res = cb();
        raw.exec('COMMIT;');
        return res;
      } catch (err) {
        raw.exec('ROLLBACK;');
        throw err;
      }
    },
  };
  runMigrations(db as any);
  seedBenchDb(db);
  return db;
}

/** `store` is the (mocked) useAIStore state; its chatHistory is replaced with the case's history. */
export function buildBenchMessages(db: GroundedSqliteDb, benchCase: BenchCase, store: any): ExternalChatMessage[] {
  const history = (benchCase.history ?? []).map((turn, idx) => ({
    id: `h${idx}`,
    role: turn.role === 'user' ? 'user' : 'ai',
    text: turn.text,
    status: 'complete',
  }));
  store.chatHistory = [...history, { id: 'current', role: 'user', text: benchCase.prompt, status: 'complete' }];
  const previousUserPrompts = history.filter((m) => m.role === 'user').map((m) => m.text);
  const retrieved = buildRetrievedContext(benchCase.prompt, {
    db,
    now: BENCH_NOW,
    monthStartDay: 1,
    previousUserPrompts,
  });
  return buildLocalMessagesForMode(benchCase.prompt, 'chat', store, retrieved);
}
