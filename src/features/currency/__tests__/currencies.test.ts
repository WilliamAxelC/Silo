import {
  COMMON_CURRENCIES,
  currencyName,
  quickCurrencyChoices,
  searchCurrencies,
  SUPPORTED_CURRENCIES,
} from '../currencies';
import {
  formatAmountInput,
  formatDisplayCurrency,
  getCurrencyDecimals,
  getCurrencySymbol,
  parseSignedAmount,
} from '../../transactions/amount';
import { CURRENCY_TO_CALLING_CODE } from '../../splits/messaging';

// Requested 2026-11-25: more currencies, TWD included. Settings and first launch only offered 6.
describe('supported currencies', () => {
  it('lists TWD and many more, each with a symbol, a WhatsApp calling code and no duplicates', () => {
    const codes = SUPPORTED_CURRENCIES.map((c) => c.code);
    expect(codes.length).toBeGreaterThanOrEqual(50);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ['TWD', 'CAD', 'MOP', 'KHR', 'BRL', 'MXN', 'ZAR', 'SEK', 'PLN', 'TRY']) {
      expect(codes).toContain(code);
    }
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(getCurrencySymbol(code)).toBeTruthy();
      // EUR spans many countries; phone numbers then fall back to the user's default country code.
      if (code !== 'EUR') expect(CURRENCY_TO_CALLING_CODE[code]).toMatch(/^\d{1,4}$/);
    }
    expect(currencyName('twd')).toBe('New Taiwan Dollar');
  });

  it('writes TWD without decimals like NT$ prices', () => {
    expect(getCurrencyDecimals('TWD')).toBe(0);
    expect(formatDisplayCurrency(1200, 'TWD')).toBe('NT$ 1.200');
    expect(formatAmountInput('1200', 'TWD')).toBe('1.200');
    expect(parseSignedAmount('NT$ 1.200', undefined, 'TWD')).toBe(1200);
    expect(getCurrencyDecimals('BRL')).toBe(2);
    expect(formatDisplayCurrency(12.5, 'BRL')).toBe('R$ 12,50');
  });

  it('finds currencies by code or name', () => {
    expect(searchCurrencies('twd')[0].code).toBe('TWD');
    expect(searchCurrencies('taiwan').map((c) => c.code)).toEqual(['TWD']);
    expect(searchCurrencies('  Peso ').map((c) => c.code)).toEqual(expect.arrayContaining(['PHP', 'MXN', 'ARS', 'CLP', 'COP']));
    expect(searchCurrencies('xx')).toEqual([]);
    expect(searchCurrencies('')).toHaveLength(SUPPORTED_CURRENCIES.length);
  });

  it('quick chips: preferred first, then common ones; a code picked from More takes the last chip', () => {
    expect(quickCurrencyChoices(['IDR'], 'IDR')).toEqual([...COMMON_CURRENCIES]);
    expect(quickCurrencyChoices(['IDR', 'JPY', null, 'KRW'], 'IDR')).toEqual(['IDR', 'JPY', 'KRW', 'USD', 'EUR', 'GBP', 'SGD', 'MYR']);
    // Tapping a chip does not move the chips.
    expect(quickCurrencyChoices(['IDR'], 'GBP')).toEqual(quickCurrencyChoices(['IDR'], 'IDR'));
    const withBrl = quickCurrencyChoices(['IDR'], 'BRL');
    expect(withBrl).toHaveLength(8);
    expect(withBrl[7]).toBe('BRL');
  });
});
