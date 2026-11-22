import { resolveEntryAmounts, resolveTransferAmounts, roundRate } from '../conversion';

describe('resolveEntryAmounts', () => {
  it('keeps home-currency accounts unchanged', () => {
    expect(resolveEntryAmounts({ homeCurrency: 'IDR', walletCurrency: 'IDR', enteredCurrency: 'IDR', amount: 50000, sign: -1 })).toEqual({
      totalAmount: -50000, originalAmount: null, originalCurrency: null, fxRate: null, toAmount: null,
    });
  });

  it('stores yen spent from a yen wallet with its rupiah value', () => {
    expect(resolveEntryAmounts({ homeCurrency: 'IDR', walletCurrency: 'JPY', enteredCurrency: 'JPY', amount: 3200, sign: -1, rate: 104.6 })).toEqual({
      totalAmount: -334720, originalAmount: -3200, originalCurrency: 'JPY', fxRate: 104.6, toAmount: null,
    });
  });

  it('converts a rupiah entry on a yen wallet into yen for the wallet balance', () => {
    expect(resolveEntryAmounts({ homeCurrency: 'IDR', walletCurrency: 'JPY', enteredCurrency: 'IDR', amount: 100000, sign: -1, rate: 104.6 })).toEqual({
      totalAmount: -100000, originalAmount: -956, originalCurrency: 'JPY', fxRate: 104.6, toAmount: null,
    });
  });

  it('keeps cents for decimal currencies and requires a rate', () => {
    expect(resolveEntryAmounts({ homeCurrency: 'IDR', walletCurrency: 'USD', enteredCurrency: 'USD', amount: 12.5, sign: 1, rate: 16250 }).totalAmount).toBe(203125);
    expect(() => resolveEntryAmounts({ homeCurrency: 'IDR', walletCurrency: 'USD', enteredCurrency: 'USD', amount: 1, sign: -1 })).toThrow('exchange rate for USD');
  });
});

describe('resolveTransferAmounts', () => {
  it('records buying yen with rupiah as the exchange rate actually paid', () => {
    expect(resolveTransferAmounts({ homeCurrency: 'IDR', fromCurrency: 'IDR', toCurrency: 'JPY', sent: 1000000, received: 9560 })).toEqual({
      totalAmount: -1000000, originalAmount: null, originalCurrency: null, fxRate: 104.603, toAmount: 9560,
    });
  });

  it('values selling yen back by the rupiah received', () => {
    expect(resolveTransferAmounts({ homeCurrency: 'IDR', fromCurrency: 'JPY', toCurrency: 'IDR', sent: 2000, received: 21000 })).toEqual({
      totalAmount: -21000, originalAmount: -2000, originalCurrency: 'JPY', fxRate: 10.5, toAmount: 21000,
    });
  });

  it('moves yen between yen wallets and needs a rate only for its home value', () => {
    expect(resolveTransferAmounts({ homeCurrency: 'IDR', fromCurrency: 'JPY', toCurrency: 'JPY', sent: 5000, sourceRate: 104 })).toEqual({
      totalAmount: -520000, originalAmount: -5000, originalCurrency: 'JPY', fxRate: 104, toAmount: 5000,
    });
  });

  it('requires the received amount for a cross-currency transfer and leaves home transfers alone', () => {
    expect(() => resolveTransferAmounts({ homeCurrency: 'IDR', fromCurrency: 'IDR', toCurrency: 'JPY', sent: 1000 })).toThrow('how much JPY');
    expect(resolveTransferAmounts({ homeCurrency: 'IDR', fromCurrency: 'IDR', toCurrency: 'IDR', sent: 25000 }).toAmount).toBeNull();
  });

  it('rounds rates to 6 significant digits', () => {
    expect(roundRate(104.60251046)).toBe(104.603);
    expect(roundRate(0.0095602)).toBe(0.0095602);
  });
});

describe('rate text', () => {
  const { formatRate, parseRateText } = jest.requireActual('../conversion');
  it('formats with Indonesian separators and parses what people type', () => {
    expect(formatRate(16260.2)).toBe('16.260,2');
    expect(formatRate(115.345)).toBe('115,345');
    expect(parseRateText('16.250')).toBe(16250);
    expect(parseRateText('16.260,2')).toBe(16260.2);
    expect(parseRateText('115,345')).toBe(115.345);
    expect(parseRateText('104.6')).toBe(104.6);
    expect(parseRateText('0.0000615')).toBe(0.0000615);
    expect(parseRateText('abc')).toBeNull();
  });
});
