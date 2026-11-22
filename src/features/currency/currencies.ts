/** Currencies offered for accounts (wallets). Amount formatting rules live in features/transactions/amount.ts. */
export const SUPPORTED_CURRENCIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'IDR', name: 'Indonesian Rupiah' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'THB', name: 'Thai Baht' },
  { code: 'KRW', name: 'South Korean Won' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'TWD', name: 'New Taiwan Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'PHP', name: 'Philippine Peso' },
  { code: 'VND', name: 'Vietnamese Dong' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'SAR', name: 'Saudi Riyal' },
  { code: 'AED', name: 'UAE Dirham' },
];

export function normalizeCurrencyCode(code: string | null | undefined): string | null {
  const trimmed = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}

/** A wallet's effective currency: its own code, or the home currency when unset. */
export function walletCurrencyOf(wallet: { currency?: string | null } | null | undefined, homeCurrency: string): string {
  return normalizeCurrencyCode(wallet?.currency) ?? normalizeCurrencyCode(homeCurrency) ?? 'IDR';
}
