export type SplitMode = 'equal' | 'custom' | 'items';

export interface SiloContact {
  id: number;
  name: string;
  phone: string | null;
  deviceContactId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SplitItemShare {
  name: string;
  fullPrice: number;
  shareAmount: number;
  sharedWithCount: number;
}

export interface SplitBreakdown {
  items?: SplitItemShare[];
  adjustmentAmount?: number;
  adjustmentLabel?: string;
  includeSelf?: boolean;
  totalParticipants?: number;
}

export interface SplitEntry {
  id: number;
  transactionId: number;
  contactId: number | null;
  personName: string;
  phone: string | null;
  amountOwed: number;
  currency: string;
  splitMode: SplitMode;
  breakdown: SplitBreakdown | null;
  isSettled: boolean;
  settledAt: number | null;
  repaymentTransactionId: number | null;
  createdAt: number | null;
  // Joined from parent transaction
  merchantName: string;
  transactionDate: number;
  transactionTotal: number;
  transactionWalletId: number;
  transactionOriginalAmount: number | null;
  transactionOriginalCurrency: string | null;
  transactionFxRate: number | null;
  transactionLineItemsText: string | null;
}

export interface BillSplitGroup {
  transactionId: number;
  merchantName: string;
  date: number;
  billTotal: number;
  currency: string;
  walletId: number;
  fxRate: number | null;
  splitMode: SplitMode;
  entries: SplitEntry[];
  unpaidCount: number;
  unpaidTotal: number;
  allSettled: boolean;
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface PersonOwedGroup {
  key: string;
  contactId: number | null;
  personName: string;
  phone: string | null;
  entries: SplitEntry[];
  totalsByCurrency: CurrencyTotal[];
}

export interface SaveBillSplitEntryInput {
  contactId: number | null;
  personName: string;
  phone: string | null;
  amountOwed: number;
  breakdown: SplitBreakdown | null;
}
