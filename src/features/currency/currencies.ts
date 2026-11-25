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
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'MOP', name: 'Macanese Pataca' },
  { code: 'BND', name: 'Brunei Dollar' },
  { code: 'KHR', name: 'Cambodian Riel' },
  { code: 'LAK', name: 'Lao Kip' },
  { code: 'MMK', name: 'Myanmar Kyat' },
  { code: 'BDT', name: 'Bangladeshi Taka' },
  { code: 'PKR', name: 'Pakistani Rupee' },
  { code: 'LKR', name: 'Sri Lankan Rupee' },
  { code: 'NPR', name: 'Nepalese Rupee' },
  { code: 'MVR', name: 'Maldivian Rufiyaa' },
  { code: 'MNT', name: 'Mongolian Tugrik' },
  { code: 'QAR', name: 'Qatari Riyal' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'ILS', name: 'Israeli New Shekel' },
  { code: 'EGP', name: 'Egyptian Pound' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'NGN', name: 'Nigerian Naira' },
  { code: 'KES', name: 'Kenyan Shilling' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'ARS', name: 'Argentine Peso' },
  { code: 'CLP', name: 'Chilean Peso' },
  { code: 'COP', name: 'Colombian Peso' },
  { code: 'PEN', name: 'Peruvian Sol' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'ISK', name: 'Icelandic Krona' },
  { code: 'PLN', name: 'Polish Zloty' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'HUF', name: 'Hungarian Forint' },
  { code: 'RON', name: 'Romanian Leu' },
  { code: 'RUB', name: 'Russian Ruble' },
  { code: 'UAH', name: 'Ukrainian Hryvnia' },
  { code: 'KZT', name: 'Kazakhstani Tenge' },
  { code: 'FJD', name: 'Fijian Dollar' },
];

export function normalizeCurrencyCode(code: string | null | undefined): string | null {
  const trimmed = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}

/** A wallet's effective currency: its own code, or the home currency when unset. */
export function walletCurrencyOf(wallet: { currency?: string | null } | null | undefined, homeCurrency: string): string {
  return normalizeCurrencyCode(wallet?.currency) ?? normalizeCurrencyCode(homeCurrency) ?? 'IDR';
}

/** Full name for a currency code, or the code itself when Silo does not list it. */
export function currencyName(code: string): string {
  const normalized = normalizeCurrencyCode(code);
  return SUPPORTED_CURRENCIES.find((c) => c.code === normalized)?.name ?? code;
}

/** Shown as chips before "More": the currencies most Silo users pick. */
export const COMMON_CURRENCIES = ['IDR', 'USD', 'EUR', 'GBP', 'SGD', 'JPY', 'MYR', 'TWD'] as const;

/**
 * The quick chips for a currency choice: the preferred codes (home, accounts), then common ones, deduplicated,
 * at most `limit`. A selected code picked from "More" takes the last chip so the choice stays visible; the
 * chips do not move when one of them is tapped. Everything else is under "More".
 */
export function quickCurrencyChoices(preferred: ReadonlyArray<string | null | undefined>, selected: string | null | undefined, limit = 8): string[] {
  const out: string[] = [];
  for (const raw of [...preferred, ...COMMON_CURRENCIES]) {
    const code = normalizeCurrencyCode(raw);
    if (code && !out.includes(code)) out.push(code);
  }
  // Keep the selected code visible even when it falls past the limit.
  const head = out.slice(0, limit);
  const sel = normalizeCurrencyCode(selected);
  if (sel && !head.includes(sel)) head[head.length - 1] = sel;
  return head;
}

/** Search the supported list by code or name ("twd", "taiwan", "dollar"). */
export function searchCurrencies(query: string, list = SUPPORTED_CURRENCIES): Array<{ code: string; name: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const byCode = list.filter((c) => c.code.toLowerCase().startsWith(q));
  const byName = list.filter((c) => !byCode.includes(c) && (c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)));
  return [...byCode, ...byName];
}
