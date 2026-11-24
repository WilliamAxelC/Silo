import { create } from 'zustand';

import { expoDb } from '../../db/index';
import { getCurrencyDecimals, roundCurrency } from '../transactions/amount';
import { DEFAULT_WALLET_ID } from '../transactions/constants';
import { walletCurrencyOf } from '../currency/currencies';
import { roundRate } from '../currency/conversion';
import { getCachedRate } from '../../services/fx/rates';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useTransactionStore } from '../../store/useTransactionStore';
import type { DeviceContactCandidate } from '../../services/contactsImport';
import type {
  BillSplitGroup,
  CurrencyTotal,
  PersonOwedGroup,
  SaveBillSplitEntryInput,
  SiloContact,
  SplitBreakdown,
  SplitEntry,
  SplitMode,
} from './types';

export const SPLIT_PAYMENT_DETAILS_KEY = 'splitPaymentDetails';
export const SPLIT_COUNTRY_CODE_KEY = 'splitDefaultCountryCode';

interface ContactSqlRow {
  id: number;
  name: string;
  phone: string | null;
  device_contact_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SplitSqlRow {
  id: number;
  transaction_id: number;
  contact_id: number | null;
  person_name: string;
  phone: string | null;
  amount_owed: number;
  currency: string | null;
  split_mode: string | null;
  breakdown_json: string | null;
  is_settled: number | null;
  settled_at: number | null;
  repayment_transaction_id: number | null;
  created_at: number | null;
  merchant_name: string;
  transaction_date: number;
  transaction_total: number;
  transaction_wallet_id: number;
  transaction_original_amount: number | null;
  transaction_original_currency: string | null;
  transaction_fx_rate: number | null;
  transaction_line_items_text: string | null;
}

function parseSplitMode(raw: string | null | undefined): SplitMode {
  if (raw === 'custom' || raw === 'items') return raw;
  return 'equal';
}

function parseBreakdown(raw: string | null | undefined): SplitBreakdown | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as SplitBreakdown;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function mapContactRow(row: ContactSqlRow): SiloContact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    deviceContactId: row.device_contact_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSplitRow(row: SplitSqlRow, fallbackCurrency: string): SplitEntry {
  const effectiveCurrency = row.currency ?? row.transaction_original_currency ?? fallbackCurrency;
  return {
    id: row.id,
    transactionId: row.transaction_id,
    contactId: row.contact_id ?? null,
    personName: row.person_name,
    phone: row.phone ?? null,
    amountOwed: Number(row.amount_owed ?? 0),
    currency: effectiveCurrency,
    splitMode: parseSplitMode(row.split_mode),
    breakdown: parseBreakdown(row.breakdown_json),
    isSettled: Boolean(row.is_settled),
    settledAt: row.settled_at ?? null,
    repaymentTransactionId: row.repayment_transaction_id ?? null,
    createdAt: row.created_at ?? null,
    merchantName: row.merchant_name,
    transactionDate: row.transaction_date,
    transactionTotal: Number(row.transaction_total ?? 0),
    transactionWalletId: Number(row.transaction_wallet_id ?? DEFAULT_WALLET_ID),
    transactionOriginalAmount: row.transaction_original_amount ?? null,
    transactionOriginalCurrency: row.transaction_original_currency ?? null,
    transactionFxRate: row.transaction_fx_rate ?? null,
    transactionLineItemsText: row.transaction_line_items_text ?? null,
  };
}

function readHomeCurrencySetting(db = expoDb): string {
  try {
    const row = db.getFirstSync<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'currencyCode' LIMIT 1;"
    );
    return row?.value?.trim() || useSettingsStore.getState().currencyCode || 'IDR';
  } catch {
    return useSettingsStore.getState().currencyCode || 'IDR';
  }
}

function readSettingValue(key: string, db = expoDb): string {
  try {
    const row = db.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ? LIMIT 1;', [key]);
    return row?.value ?? '';
  } catch {
    return '';
  }
}

function writeSettingValue(key: string, value: string, db = expoDb): void {
  db.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [key, value]);
}

export function readContacts(db = expoDb): SiloContact[] {
  try {
    return db
      .getAllSync<ContactSqlRow>('SELECT * FROM contacts ORDER BY LOWER(name) ASC, id ASC;')
      .map(mapContactRow);
  } catch {
    return [];
  }
}

export function readSplits(db = expoDb): SplitEntry[] {
  try {
    const homeCurrency = readHomeCurrencySetting(db);
    const rows = db.getAllSync<SplitSqlRow>(
      `SELECT
        s.id,
        s.transaction_id,
        s.contact_id,
        s.person_name,
        s.phone,
        s.amount_owed,
        s.currency,
        s.split_mode,
        s.breakdown_json,
        s.is_settled,
        s.settled_at,
        s.repayment_transaction_id,
        s.created_at,
        t.merchant_name,
        t.date AS transaction_date,
        t.total_amount AS transaction_total,
        t.wallet_id AS transaction_wallet_id,
        t.original_amount AS transaction_original_amount,
        t.original_currency AS transaction_original_currency,
        t.fx_rate AS transaction_fx_rate,
        t.line_items_text AS transaction_line_items_text
      FROM shared_splits s
      JOIN transactions t ON t.id = s.transaction_id
      ORDER BY t.date DESC, s.id ASC;`
    );
    return rows.map((row) => mapSplitRow(row, homeCurrency));
  } catch {
    return [];
  }
}

function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

function personKey(entry: Pick<SplitEntry, 'contactId' | 'personName'>): string {
  if (entry.contactId != null) return `contact:${entry.contactId}`;
  return `name:${entry.personName.trim().toLowerCase()}`;
}

export function groupSplitsByBill(splits: ReadonlyArray<SplitEntry>): BillSplitGroup[] {
  const byTx = new Map<number, SplitEntry[]>();
  for (const split of splits) {
    const bucket = byTx.get(split.transactionId);
    if (bucket) {
      bucket.push(split);
    } else {
      byTx.set(split.transactionId, [split]);
    }
  }

  const groups: BillSplitGroup[] = [];
  for (const [transactionId, entries] of byTx.entries()) {
    const first = entries[0];
    const currency = first.currency;
    const decimals = getCurrencyDecimals(currency);
    const billTotal = Math.abs(
      first.transactionOriginalCurrency && first.transactionOriginalAmount != null
        ? first.transactionOriginalAmount
        : first.transactionTotal
    );
    const unpaidEntries = entries.filter((e) => !e.isSettled);
    const unpaidTotal = roundCurrency(
      unpaidEntries.reduce((sum, e) => sum + e.amountOwed, 0),
      decimals
    );
    groups.push({
      transactionId,
      merchantName: first.merchantName,
      date: first.transactionDate,
      billTotal: roundCurrency(billTotal, decimals),
      currency,
      walletId: first.transactionWalletId,
      fxRate: first.transactionFxRate,
      splitMode: first.splitMode,
      entries,
      unpaidCount: unpaidEntries.length,
      unpaidTotal,
      allSettled: unpaidEntries.length === 0,
    });
  }

  groups.sort((a, b) => b.date - a.date || b.transactionId - a.transactionId);
  return groups;
}

export function groupUnpaidByPerson(splits: ReadonlyArray<SplitEntry>): PersonOwedGroup[] {
  const byPerson = new Map<string, PersonOwedGroup>();
  for (const split of splits) {
    if (split.isSettled) continue;
    const key = personKey(split);
    let group = byPerson.get(key);
    if (!group) {
      group = {
        key,
        contactId: split.contactId,
        personName: split.personName,
        phone: split.phone,
        entries: [],
        totalsByCurrency: [],
      };
      byPerson.set(key, group);
    }
    if (!group.phone && split.phone) {
      group.phone = split.phone;
    }
    group.entries.push(split);
  }

  for (const group of byPerson.values()) {
    const byCurrency = new Map<string, number>();
    for (const entry of group.entries) {
      const decimals = getCurrencyDecimals(entry.currency);
      const next = roundCurrency((byCurrency.get(entry.currency) ?? 0) + entry.amountOwed, decimals);
      byCurrency.set(entry.currency, next);
    }
    group.totalsByCurrency = Array.from(byCurrency.entries()).map(([currency, amount]) => ({
      currency,
      amount,
    }));
  }

  return Array.from(byPerson.values()).sort((a, b) => a.personName.localeCompare(b.personName));
}

export function summarizePendingByCurrency(splits: ReadonlyArray<SplitEntry>): CurrencyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const split of splits) {
    if (split.isSettled) continue;
    const decimals = getCurrencyDecimals(split.currency);
    const next = roundCurrency((byCurrency.get(split.currency) ?? 0) + split.amountOwed, decimals);
    byCurrency.set(split.currency, next);
  }
  return Array.from(byCurrency.entries()).map(([currency, amount]) => ({ currency, amount }));
}

export function getTransactionSplitCounts(
  splits: ReadonlyArray<SplitEntry>
): Record<number, { total: number; unpaid: number }> {
  const map: Record<number, { total: number; unpaid: number }> = {};
  for (const split of splits) {
    const current = map[split.transactionId] ?? { total: 0, unpaid: 0 };
    current.total += 1;
    if (!split.isSettled) {
      current.unpaid += 1;
    }
    map[split.transactionId] = current;
  }
  return map;
}

function buildRepaymentTransactionPayload(
  split: SplitEntry,
  targetWalletId: number
): {
  merchantName: string;
  totalAmount: number;
  type: 'income';
  category: string;
  date: number;
  note: string;
  walletId: number;
  originalAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
} {
  const settingsHome = useSettingsStore.getState().currencyCode || 'IDR';
  const wallet = useTransactionStore.getState().wallets.find((w) => w.id === targetWalletId) ?? null;
  const walletCurrency = walletCurrencyOf(wallet, settingsHome);
  const splitCurrency = split.currency || settingsHome;
  const homeDecimals = getCurrencyDecimals(settingsHome);

  const splitToHomeRate =
    splitCurrency === settingsHome
      ? 1
      : split.transactionOriginalCurrency === splitCurrency && split.transactionFxRate && split.transactionFxRate > 0
        ? split.transactionFxRate
        : getCachedRate(splitCurrency, settingsHome)?.rate ?? 1;

  const homeAmount = roundCurrency(split.amountOwed * splitToHomeRate, homeDecimals);

  let originalAmount: number | null = null;
  let originalCurrency: string | null = null;
  let fxRate: number | null = null;

  if (walletCurrency !== settingsHome) {
    if (walletCurrency === splitCurrency) {
      originalAmount = roundCurrency(split.amountOwed, getCurrencyDecimals(walletCurrency));
      originalCurrency = walletCurrency;
      fxRate = roundRate(splitToHomeRate);
    } else {
      const walletToHomeRate = getCachedRate(walletCurrency, settingsHome)?.rate ?? 1;
      originalAmount = roundCurrency(homeAmount / walletToHomeRate, getCurrencyDecimals(walletCurrency));
      originalCurrency = walletCurrency;
      fxRate = roundRate(walletToHomeRate);
    }
  }

  return {
    merchantName: `Repayment from ${split.personName}`,
    totalAmount: homeAmount,
    type: 'income',
    category: 'Reimbursement',
    date: Date.now(),
    note: `Split bill: ${split.merchantName}`,
    walletId: targetWalletId,
    originalAmount,
    originalCurrency,
    fxRate,
  };
}

async function ensureReimbursementCategory(): Promise<void> {
  const txStore = useTransactionStore.getState();
  const hasCategory = txStore.categories.some(
    (c) => c.type === 'income' && c.name.trim().toLowerCase() === 'reimbursement'
  );
  if (!hasCategory) {
    try {
      await txStore.addCategory('Reimbursement', 'income');
    } catch {
      // Fallback: addTransaction normalizes category if DB already has it or creation fails.
    }
  }
}

interface SplitsState {
  contacts: SiloContact[];
  splits: SplitEntry[];
  paymentDetails: string;
  defaultCountryCode: string;
  loaded: boolean;

  load: () => void;
  ensureLoaded: () => void;
  setPaymentDetails: (details: string) => void;
  setDefaultCountryCode: (code: string) => void;

  addContact: (input: { name: string; phone?: string | null; deviceContactId?: string | null }) => SiloContact | null;
  updateContact: (id: number, input: { name: string; phone?: string | null }) => void;
  deleteContact: (id: number) => void;
  importDeviceContacts: (candidates: ReadonlyArray<DeviceContactCandidate>) => { added: number; skipped: number };

  saveBillSplits: (
    transactionId: number,
    payload: {
      mode: SplitMode;
      currency: string;
      entries: ReadonlyArray<SaveBillSplitEntryInput>;
    }
  ) => void;
  deleteBillSplits: (transactionId: number) => void;
  pruneTransaction: (transactionId: number) => void;

  markSplitSettled: (splitId: number, options: { logRepayment: boolean; walletId?: number }) => Promise<void>;
  markSplitUnsettled: (splitId: number, options?: { deleteRepayment?: boolean }) => Promise<void>;
  markAllForPersonSettled: (
    entries: ReadonlyArray<SplitEntry>,
    options: { logRepayment: boolean; walletId?: number }
  ) => Promise<void>;
}

export const useSplitsStore = create<SplitsState>((set, get) => ({
  contacts: [],
  splits: [],
  paymentDetails: '',
  defaultCountryCode: '',
  loaded: false,

  load: () => {
    set({
      contacts: readContacts(),
      splits: readSplits(),
      paymentDetails: readSettingValue(SPLIT_PAYMENT_DETAILS_KEY),
      defaultCountryCode: readSettingValue(SPLIT_COUNTRY_CODE_KEY),
      loaded: true,
    });
  },

  ensureLoaded: () => {
    if (!get().loaded) {
      get().load();
    }
  },

  setPaymentDetails: (details) => {
    const trimmed = details.trim();
    writeSettingValue(SPLIT_PAYMENT_DETAILS_KEY, trimmed);
    set({ paymentDetails: trimmed });
  },

  setDefaultCountryCode: (code) => {
    const cleaned = code.replace(/\D/g, '').slice(0, 4);
    writeSettingValue(SPLIT_COUNTRY_CODE_KEY, cleaned);
    set({ defaultCountryCode: cleaned });
  },

  addContact: ({ name, phone, deviceContactId }) => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    const trimmedPhone = phone?.trim() || null;
    const now = Date.now();
    const res = expoDb.runSync(
      `INSERT INTO contacts (name, phone, device_contact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?);`,
      [trimmedName, trimmedPhone, deviceContactId ?? null, now, now]
    );
    const id = Number(res.lastInsertRowId);
    const contacts = readContacts();
    set({ contacts });
    return contacts.find((c) => c.id === id) ?? null;
  },

  updateContact: (id, { name, phone }) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const trimmedPhone = phone?.trim() || null;
    const now = Date.now();
    expoDb.withTransactionSync(() => {
      expoDb.runSync(`UPDATE contacts SET name = ?, phone = ?, updated_at = ? WHERE id = ?;`, [
        trimmedName,
        trimmedPhone,
        now,
        id,
      ]);
      expoDb.runSync(
        `UPDATE shared_splits SET person_name = ?, phone = ? WHERE contact_id = ? AND is_settled = 0;`,
        [trimmedName, trimmedPhone, id]
      );
    });
    set({ contacts: readContacts(), splits: readSplits() });
  },

  deleteContact: (id) => {
    expoDb.runSync('DELETE FROM contacts WHERE id = ?;', [id]);
    set({ contacts: readContacts(), splits: readSplits() });
  },

  importDeviceContacts: (candidates) => {
    const existing = readContacts();
    const knownDeviceIds = new Set(
      existing.map((c) => c.deviceContactId).filter((v): v is string => Boolean(v))
    );
    const knownNamePhones = new Set(
      existing.map((c) => `${c.name.trim().toLowerCase()}|${normalizePhoneDigits(c.phone)}`)
    );

    let added = 0;
    let skipped = 0;
    const now = Date.now();

    expoDb.withTransactionSync(() => {
      for (const candidate of candidates) {
        const name = candidate.name.trim();
        if (!name) {
          skipped += 1;
          continue;
        }
        const phone = candidate.phone.trim() || null;
        const namePhoneKey = `${name.toLowerCase()}|${normalizePhoneDigits(phone)}`;
        if (
          (candidate.deviceContactId && knownDeviceIds.has(candidate.deviceContactId)) ||
          knownNamePhones.has(namePhoneKey)
        ) {
          skipped += 1;
          continue;
        }

        expoDb.runSync(
          `INSERT INTO contacts (name, phone, device_contact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?);`,
          [name, phone, candidate.deviceContactId || null, now + added, now + added]
        );
        if (candidate.deviceContactId) knownDeviceIds.add(candidate.deviceContactId);
        knownNamePhones.add(namePhoneKey);
        added += 1;
      }
    });

    set({ contacts: readContacts() });
    return { added, skipped };
  },

  saveBillSplits: (transactionId, { mode, currency, entries }) => {
    const now = Date.now();
    expoDb.withTransactionSync(() => {
      const previous = expoDb.getAllSync<{
        contact_id: number | null;
        person_name: string;
        is_settled: number | null;
        settled_at: number | null;
        repayment_transaction_id: number | null;
      }>(
        `SELECT contact_id, person_name, is_settled, settled_at, repayment_transaction_id
         FROM shared_splits WHERE transaction_id = ?;`,
        [transactionId]
      );

      const previousByContactId = new Map<number, (typeof previous)[number]>();
      const previousByName = new Map<string, (typeof previous)[number]>();
      for (const row of previous) {
        if (row.contact_id != null) previousByContactId.set(row.contact_id, row);
        previousByName.set(row.person_name.trim().toLowerCase(), row);
      }

      expoDb.runSync('DELETE FROM shared_splits WHERE transaction_id = ?;', [transactionId]);

      for (const entry of entries) {
        const match =
          (entry.contactId != null ? previousByContactId.get(entry.contactId) : undefined) ??
          previousByName.get(entry.personName.trim().toLowerCase());
        const isSettled = match?.is_settled ? 1 : 0;
        const settledAt = isSettled ? match?.settled_at ?? null : null;
        const repaymentTransactionId = isSettled ? match?.repayment_transaction_id ?? null : null;

        expoDb.runSync(
          `INSERT INTO shared_splits (
            transaction_id, contact_id, person_name, phone, amount_owed, currency,
            split_mode, breakdown_json, is_settled, settled_at, repayment_transaction_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            transactionId,
            entry.contactId,
            entry.personName.trim(),
            entry.phone?.trim() || null,
            entry.amountOwed,
            currency,
            mode,
            entry.breakdown ? JSON.stringify(entry.breakdown) : null,
            isSettled,
            settledAt,
            repaymentTransactionId,
            now,
          ]
        );
      }
    });

    set({ splits: readSplits() });
  },

  deleteBillSplits: (transactionId) => {
    expoDb.runSync('DELETE FROM shared_splits WHERE transaction_id = ?;', [transactionId]);
    set({ splits: readSplits() });
  },

  pruneTransaction: (transactionId) => {
    set((state) => {
      if (!state.loaded) return state;
      const changed = state.splits.some(
        (s) => s.transactionId === transactionId || s.repaymentTransactionId === transactionId
      );
      if (!changed) return state;
      return {
        splits: state.splits
          .filter((s) => s.transactionId !== transactionId)
          .map((s) =>
            s.repaymentTransactionId === transactionId ? { ...s, repaymentTransactionId: null } : s
          ),
      };
    });
  },

  markSplitSettled: async (splitId, { logRepayment, walletId }) => {
    const current = get().splits.find((s) => s.id === splitId) ?? readSplits().find((s) => s.id === splitId);
    if (!current || current.isSettled) return;

    let repaymentTransactionId: number | null = null;
    if (logRepayment) {
      await ensureReimbursementCategory();
      const targetWalletId = walletId ?? current.transactionWalletId ?? DEFAULT_WALLET_ID;
      const payload = buildRepaymentTransactionPayload(current, targetWalletId);
      repaymentTransactionId = await useTransactionStore.getState().addTransaction(payload);
    }

    expoDb.runSync(
      `UPDATE shared_splits SET is_settled = 1, settled_at = ?, repayment_transaction_id = ? WHERE id = ?;`,
      [Date.now(), repaymentTransactionId, splitId]
    );
    set({ splits: readSplits() });
  },

  markSplitUnsettled: async (splitId, options) => {
    const current = get().splits.find((s) => s.id === splitId) ?? readSplits().find((s) => s.id === splitId);
    if (!current) return;

    const repaymentId = current.repaymentTransactionId;
    expoDb.runSync(
      `UPDATE shared_splits SET is_settled = 0, settled_at = NULL, repayment_transaction_id = NULL WHERE id = ?;`,
      [splitId]
    );
    if (options?.deleteRepayment && repaymentId != null) {
      await useTransactionStore.getState().deleteTransaction(repaymentId);
    }
    set({ splits: readSplits() });
  },

  markAllForPersonSettled: async (entries, options) => {
    for (const entry of entries) {
      if (!entry.isSettled) {
        await get().markSplitSettled(entry.id, options);
      }
    }
  },
}));
