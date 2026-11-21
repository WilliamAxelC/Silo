import { expoDb } from '../db/index';
import type { TransactionInput } from '../features/transactions/types';

/** Fields copied when tapping a template chip. Date and receipt photo are never stored on templates. */
export type TransactionTemplatePayload = Omit<TransactionInput, 'date' | 'imageUri'>;

export interface TransactionTemplate {
  id: number;
  name: string;
  template: TransactionTemplatePayload;
  createdAt: number;
}

interface TemplateRow {
  id: number;
  name: string;
  template_json: string;
  created_at: number;
}

export function listTransactionTemplates(sqliteDb: typeof expoDb = expoDb): TransactionTemplate[] {
  const rows = sqliteDb.getAllSync<TemplateRow>(
    'SELECT id, name, template_json, created_at FROM transaction_templates ORDER BY created_at DESC, id DESC;'
  );

  const templates: TransactionTemplate[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.template_json) as TransactionTemplatePayload;
      templates.push({
        id: row.id,
        name: row.name,
        template: parsed,
        createdAt: row.created_at,
      });
    } catch {
      // Skip malformed rows rather than breaking the add screen
    }
  }
  return templates;
}

export function createTransactionTemplate(
  name: string,
  template: TransactionTemplatePayload,
  sqliteDb: typeof expoDb = expoDb
): TransactionTemplate {
  const trimmedName =
    name.trim() ||
    template.merchantName.trim() ||
    (template.type === 'transfer' ? 'Transfer' : 'Template');

  const payload: TransactionTemplatePayload = {
    merchantName: template.merchantName.trim() || trimmedName,
    totalAmount: Number.isFinite(template.totalAmount) ? template.totalAmount : 0,
    type: template.type,
    category: template.category,
    note: template.note ?? '',
    lineItemsText: template.lineItemsText ?? '',
    walletId: template.walletId,
    toWalletId: template.type === 'transfer' ? template.toWalletId ?? null : null,
  };

  const createdAt = Date.now();
  const result = sqliteDb.runSync(
    'INSERT INTO transaction_templates (name, template_json, created_at) VALUES (?, ?, ?);',
    [trimmedName, JSON.stringify(payload), createdAt]
  );

  return {
    id: Number(result.lastInsertRowId),
    name: trimmedName,
    template: payload,
    createdAt,
  };
}

export function deleteTransactionTemplate(id: number, sqliteDb: typeof expoDb = expoDb): void {
  sqliteDb.runSync('DELETE FROM transaction_templates WHERE id = ?;', [id]);
}
