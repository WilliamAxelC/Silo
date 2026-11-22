import { expoDb } from '../../db/index';
import { normalizeCurrencyCode } from '../../features/currency/currencies';
import { roundRate } from '../../features/currency/conversion';

/**
 * Daily market exchange rates, fetched at most once per local day and cached in app_settings.
 * Source: the free, key-less fawazahmed0 currency-api (daily rates for ~200 currencies). Only the home
 * currency code is sent; nothing about the user's data leaves the device.
 */
const CACHE_KEY = 'fxRateCache';
const SOURCES = [
  (base: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.min.json`,
  (base: string) => `https://latest.currency-api.pages.dev/v1/currencies/${base}.min.json`,
];

export interface RateCache {
  base: string;
  /** Rate date reported by the source (YYYY-MM-DD). */
  date: string;
  fetchedAt: number;
  /** 1 base unit = rates[code] units of code (lower-case codes, as the source returns them). */
  rates: Record<string, number>;
}

export interface DailyRate {
  /** Home-currency units per 1 foreign unit. */
  rate: number;
  date: string;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function readCache(): RateCache | null {
  try {
    const row = expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [CACHE_KEY]);
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as RateCache;
    return parsed && typeof parsed.base === 'string' && parsed.rates ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: RateCache) {
  expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [CACHE_KEY, JSON.stringify(cache)]);
}

const sameLocalDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

let inFlight: Promise<RateCache | null> | null = null;

/** Fetches today's rates for the home currency unless they were already fetched today. Never throws. */
export async function refreshDailyRates(
  homeCurrency: string,
  options: { force?: boolean; now?: number; fetchImpl?: FetchLike } = {},
): Promise<RateCache | null> {
  const home = normalizeCurrencyCode(homeCurrency);
  if (!home) return null;
  const now = options.now ?? Date.now();
  const cached = readCache();
  if (!options.force && cached?.base === home.toLowerCase() && sameLocalDay(cached.fetchedAt, now)) {
    return cached;
  }
  if (inFlight) return inFlight;

  const fetchImpl: FetchLike = options.fetchImpl ?? ((url) => fetch(url));
  inFlight = (async () => {
    const base = home.toLowerCase();
    for (const source of SOURCES) {
      try {
        const response = await fetchImpl(source(base));
        if (!response.ok) continue;
        const body = (await response.json()) as Record<string, unknown>;
        const rates = body?.[base] as Record<string, number> | undefined;
        if (!rates || typeof rates !== 'object') continue;
        const cache: RateCache = { base, date: String(body.date ?? ''), fetchedAt: now, rates };
        writeCache(cache);
        return cache;
      } catch (error) {
        console.warn('Exchange-rate source failed:', error);
      }
    }
    return cached?.base === base ? cached : null;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Last cached market rate (home units per 1 foreign unit), without touching the network. */
export function getCachedRate(foreignCurrency: string, homeCurrency: string): DailyRate | null {
  const foreign = normalizeCurrencyCode(foreignCurrency);
  const home = normalizeCurrencyCode(homeCurrency);
  if (!foreign || !home) return null;
  if (foreign === home) return { rate: 1, date: '' };
  const cache = readCache();
  if (!cache || cache.base !== home.toLowerCase()) return null;
  const perHome = cache.rates[foreign.toLowerCase()];
  if (typeof perHome !== 'number' || !Number.isFinite(perHome) || perHome <= 0) return null;
  return { rate: roundRate(1 / perHome), date: cache.date };
}

/** Today's market rate, fetching once per day when online; falls back to the last cached rate. */
export async function getDailyRate(foreignCurrency: string, homeCurrency: string): Promise<DailyRate | null> {
  await refreshDailyRates(homeCurrency);
  return getCachedRate(foreignCurrency, homeCurrency);
}

/**
 * Rate used to value a foreign account in the home currency (net worth, defaults when spending from it):
 * the account's average exchange cost when known, otherwise the cached daily market rate.
 */
export function walletHomeRate(
  wallet: { currency: string | null; averageRate: number | null },
  homeCurrency: string,
): number | null {
  if (!wallet.currency || wallet.currency === normalizeCurrencyCode(homeCurrency)) return 1;
  return wallet.averageRate ?? getCachedRate(wallet.currency, homeCurrency)?.rate ?? null;
}
