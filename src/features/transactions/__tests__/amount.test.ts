import {
  MAX_TRANSACTION_AMOUNT,
  isAmountWithinRange,
  getCurrencyDecimals,
  currencyHasDecimals,
  formatAmountInput,
  formatAmountForInput,
  roundCurrency,
  parseSignedAmount,
  addAmounts,
  calculateTotal,
  splitAmount,
  calculatePercentage,
  formatDisplayCurrency,
  evaluateAmountExpression,
  formatCalculatorExpression,
  summarizeTransactions,
} from '../amount';

describe('amount utilities', () => {
  describe('formatAmountInput', () => {
    it('formats empty, null, undefined, or whitespace string to empty', () => {
      expect(formatAmountInput('')).toBe('');
      expect(formatAmountInput('   ')).toBe('');
      expect(formatAmountInput(null as any)).toBe('');
      expect(formatAmountInput(undefined as any)).toBe('');
    });

    it('adds thousand separators correctly for standard integers', () => {
      expect(formatAmountInput('0')).toBe('0');
      expect(formatAmountInput('9')).toBe('9');
      expect(formatAmountInput('100')).toBe('100');
      expect(formatAmountInput('1000')).toBe('1.000');
      expect(formatAmountInput('50000')).toBe('50.000');
      expect(formatAmountInput('1000000')).toBe('1.000.000');
      expect(formatAmountInput('1234567890')).toBe('1.234.567.890');
    });

    it('strips non-numeric characters and symbols', () => {
      expect(formatAmountInput('Rp 50.000')).toBe('50.000');
      expect(formatAmountInput('$12,500.00')).toBe('1.250.000');
      expect(formatAmountInput('abc 123 def 456')).toBe('123.456');
      expect(formatAmountInput('!@#$%^&*()_+')).toBe('');
    });

    it('strips leading zeros while keeping a single zero if followed by digits', () => {
      expect(formatAmountInput('00050')).toBe('50');
      expect(formatAmountInput('0123456')).toBe('123.456');
      expect(formatAmountInput('000')).toBe('0');
    });

    it('handles extreme integer and large numeric values correctly', () => {
      expect(formatAmountInput('9007199254740991')).toBe('9.007.199.254.740.991');
      expect(formatAmountInput('1000000000000000')).toBe('1.000.000.000.000.000');
      expect(formatAmountInput('99999999999999999999')).toBe('99.999.999.999.999.999.999');
    });

    it('handles mixed currency symbols and spaces', () => {
      expect(formatAmountInput('  Rp  1.250.000   ')).toBe('1.250.000');
      expect(formatAmountInput('€ 999 999')).toBe('999.999');
      expect(formatAmountInput('🍔 50.000 🍟')).toBe('50.000');
    });
  });

  describe('roundCurrency', () => {
    it('rounds to 2 decimal places by default', () => {
      expect(roundCurrency(12.3456)).toBe(12.35);
      expect(roundCurrency(12.344)).toBe(12.34);
      expect(roundCurrency(100)).toBe(100);
      expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
      expect(roundCurrency(1.005)).toBe(1.01);
    });

    it('supports custom decimal places', () => {
      expect(roundCurrency(12.3456, 0)).toBe(12);
      expect(roundCurrency(12.3456, 1)).toBe(12.3);
      expect(roundCurrency(12.3456, 3)).toBe(12.346);
      expect(roundCurrency(50000, 0)).toBe(50000);
    });

    it('handles negative numbers properly', () => {
      expect(roundCurrency(-12.3456)).toBe(-12.35);
      expect(roundCurrency(-12.344)).toBe(-12.34);
    });

    it('guards against NaN, Infinity, -Infinity, null, and non-numeric values', () => {
      expect(roundCurrency(NaN)).toBe(0);
      expect(roundCurrency(Infinity)).toBe(0);
      expect(roundCurrency(-Infinity)).toBe(0);
      expect(roundCurrency(null as any)).toBe(0);
      expect(roundCurrency(undefined as any)).toBe(0);
      expect(roundCurrency('123.45' as any)).toBe(0);
    });

    it('handles extreme integer bounds and very small decimal values', () => {
      expect(roundCurrency(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
      expect(roundCurrency(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
      expect(roundCurrency(999999999999998, 2)).toBe(999999999999998);
      expect(roundCurrency(-999999999999998, 2)).toBe(-999999999999998);
      expect(roundCurrency(99999999999999.5, 2)).toBe(99999999999999.5);
      expect(roundCurrency(0.00001, 2)).toBe(0);
      expect(roundCurrency(0.00001, 5)).toBe(0.00001);
      expect(roundCurrency(0.07 * 100)).toBe(7);
      expect(roundCurrency(1.0000000000000002)).toBe(1);
    });

    it('keeps every cent exact up to MAX_TRANSACTION_AMOUNT (1e13)', () => {
      expect(MAX_TRANSACTION_AMOUNT).toBe(1e13);
      expect(isAmountWithinRange(MAX_TRANSACTION_AMOUNT)).toBe(true);
      expect(isAmountWithinRange(-MAX_TRANSACTION_AMOUNT)).toBe(true);
      expect(isAmountWithinRange(MAX_TRANSACTION_AMOUNT + 1)).toBe(false);
      expect(isAmountWithinRange(999999999999998)).toBe(false);
      expect(isAmountWithinRange(NaN)).toBe(false);

      for (let cents = 0; cents < 100; cents++) {
        const expected = Number(`9999999999999.${String(cents).padStart(2, '0')}`);
        expect(roundCurrency(expected, 2)).toBe(expected);
      }
    });
  });

  describe('parseSignedAmount', () => {
    it('returns negative amounts for expense type', () => {
      expect(parseSignedAmount('50,000', 'expense')).toBe(-50000);
      expect(parseSignedAmount('1500.50', 'expense')).toBe(-1500.5);
      expect(parseSignedAmount(25000, 'expense')).toBe(-25000);
      expect(parseSignedAmount(-35000, 'expense')).toBe(-35000);
      expect(parseSignedAmount('Rp 150.000', 'expense')).toBe(-150000);
    });

    it('returns negative amounts for transfer type', () => {
      expect(parseSignedAmount('20,000', 'transfer')).toBe(-20000);
      expect(parseSignedAmount(50000, 'transfer')).toBe(-50000);
    });

    it('returns positive amounts for income type', () => {
      expect(parseSignedAmount('5,000,000', 'income')).toBe(5000000);
      expect(parseSignedAmount('75000.75', 'income')).toBe(75000.75);
      expect(parseSignedAmount(100000, 'income')).toBe(100000);
      expect(parseSignedAmount(-50000, 'income')).toBe(50000);
      expect(parseSignedAmount('$2,500.00', 'income')).toBe(2500);
    });

    it('handles zero values correctly (never returning -0)', () => {
      expect(parseSignedAmount(0, 'expense')).toBe(0);
      expect(parseSignedAmount('0', 'expense')).toBe(0);
      expect(parseSignedAmount(0, 'income')).toBe(0);
      expect(parseSignedAmount('0.00', 'income')).toBe(0);
      expect(Object.is(parseSignedAmount('0', 'expense'), -0)).toBe(false);
    });

    it('guards against null, undefined, empty string, and whitespace', () => {
      expect(parseSignedAmount('', 'expense')).toBe(0);
      expect(parseSignedAmount('   ', 'income')).toBe(0);
      expect(parseSignedAmount(null, 'expense')).toBe(0);
      expect(parseSignedAmount(undefined, 'income')).toBe(0);
    });

    it('guards against NaN, Infinity, -Infinity, and invalid string formats', () => {
      expect(parseSignedAmount(NaN, 'expense')).toBe(0);
      expect(parseSignedAmount(Infinity, 'income')).toBe(0);
      expect(parseSignedAmount(-Infinity, 'expense')).toBe(0);
      expect(parseSignedAmount('abc-def', 'expense')).toBe(0);
      expect(parseSignedAmount('$$$', 'income')).toBe(0);
    });

    describe('IDR Rupiah parsing table-driven rules (B3)', () => {
      const cases: Array<{ input: string; expected: number; description: string }> = [
        { input: '45.000', expected: 45000, description: 'standard rupiah with thousand dot' },
        { input: '1.500.000', expected: 1500000, description: 'million rupiah with multiple dots' },
        { input: '45,000', expected: 45000, description: 'rupiah with comma separator' },
        { input: '1.500,50', expected: 1500.5, description: 'dot thousand and comma decimal' },
        { input: 'Rp 45.000,-', expected: 45000, description: 'Rp prefix and trailing ,- sen notation' },
        { input: '-12.000', expected: -12000, description: 'negative rupiah amount' },
        { input: '12.5', expected: 12.5, description: 'single dot with 1-2 digits decimal' },
      ];

      test.each(cases)('$description: parseSignedAmount("$input") -> $expected', ({ input, expected }) => {
        expect(parseSignedAmount(input)).toBe(expected);
      });

      test.each(cases)(
        '$description: parseSignedAmount("$input", "expense") -> negative value',
        ({ input, expected }) => {
          expect(parseSignedAmount(input, 'expense')).toBe(-Math.abs(expected));
        }
      );

      test.each(cases)(
        '$description: parseSignedAmount("$input", "income") -> positive value',
        ({ input, expected }) => {
          expect(parseSignedAmount(input, 'income')).toBe(Math.abs(expected));
        }
      );
    });
  });

  describe('addAmounts', () => {
    it('safely sums numbers avoiding floating point imprecision', () => {
      expect(addAmounts(0.1, 0.2)).toBe(0.3);
      expect(addAmounts(100, 200, 300)).toBe(600);
      expect(addAmounts(-50, 100, -25)).toBe(25);
    });

    it('ignores null, undefined, NaN, and non-finite inputs', () => {
      expect(addAmounts(10, null, 20, undefined, 30)).toBe(60);
      expect(addAmounts(NaN, 100, Infinity, -Infinity)).toBe(100);
      expect(addAmounts()).toBe(0);
    });
  });

  describe('calculateTotal', () => {
    it('calculates the total from an array of items with amount property', () => {
      const items = [
        { name: 'Coffee', amount: 35000 },
        { name: 'Donut', amount: 15000 },
        { name: 'Tax', amount: 5000 },
      ];
      expect(calculateTotal(items)).toBe(55000);
    });

    it('handles missing, null, or undefined amounts inside items', () => {
      const items = [
        { name: 'Item 1', amount: 100 },
        { name: 'Item 2', amount: null },
        { name: 'Item 3' },
        { name: 'Item 4', amount: 200 },
      ];
      expect(calculateTotal(items)).toBe(300);
      expect(calculateTotal([])).toBe(0);
    });
  });

  describe('splitAmount', () => {
    it('returns empty array when parts <= 0 or total is non-finite', () => {
      expect(splitAmount(100, 0)).toEqual([]);
      expect(splitAmount(100, -2)).toEqual([]);
      expect(splitAmount(NaN, 3)).toEqual([]);
      expect(splitAmount(Infinity, 2)).toEqual([]);
    });

    it('returns single rounded item when parts === 1', () => {
      expect(splitAmount(100.555, 1)).toEqual([100.56]);
      expect(splitAmount(50, 1, 0)).toEqual([50]);
    });

    it('splits evenly divisible amounts exactly', () => {
      expect(splitAmount(100, 4)).toEqual([25, 25, 25, 25]);
      expect(splitAmount(60, 3)).toEqual([20, 20, 20]);
    });

    it('distributes remainder cents so that the sum of parts strictly equals total', () => {
      const parts3 = splitAmount(10, 3, 2);
      expect(parts3).toEqual([3.34, 3.33, 3.33]);
      const sum3 = parts3.reduce((a, b) => a + b, 0);
      expect(roundCurrency(sum3)).toBe(10);

      const parts7 = splitAmount(100, 7, 2);
      expect(parts7.length).toBe(7);
      const sum7 = parts7.reduce((a, b) => a + b, 0);
      expect(roundCurrency(sum7)).toBe(100);
    });

    it('handles negative total amounts correctly', () => {
      const negativeParts = splitAmount(-10, 3, 2);
      expect(negativeParts).toEqual([-3.34, -3.33, -3.33]);
      const sum = negativeParts.reduce((a, b) => a + b, 0);
      expect(roundCurrency(sum)).toBe(-10);
    });

    it('handles large participant count without cent loss', () => {
      const parts30 = splitAmount(100, 30, 2);
      expect(parts30.length).toBe(30);
      const sum30 = parts30.reduce((a, b) => a + b, 0);
      expect(roundCurrency(sum30)).toBe(100);
    });

    it('handles splitting 1 cent ($0.01) across multiple participants', () => {
      const parts4 = splitAmount(0.01, 4, 2);
      expect(parts4).toEqual([0.01, 0, 0, 0]);
      const sum4 = parts4.reduce((a, b) => a + b, 0);
      expect(roundCurrency(sum4)).toBe(0.01);
    });

    it('handles splitting extreme billion amounts', () => {
      const billionParts = splitAmount(1_000_000_000, 3, 2);
      expect(billionParts).toEqual([333333333.34, 333333333.33, 333333333.33]);
      const sumBillion = billionParts.reduce((a, b) => a + b, 0);
      expect(roundCurrency(sumBillion)).toBe(1_000_000_000);
    });
  });

  describe('calculatePercentage', () => {
    it('calculates percentage of part over total correctly', () => {
      expect(calculatePercentage(50, 200)).toBe(25);
      expect(calculatePercentage(1, 3)).toBe(33.33);
      expect(calculatePercentage(100, 100)).toBe(100);
      expect(calculatePercentage(250, 100)).toBe(250); // Over 100%
      expect(calculatePercentage(-50, 100)).toBe(-50); // Negative percentage
    });

    it('guards against division by zero', () => {
      expect(calculatePercentage(50, 0)).toBe(0);
    });

    it('guards against NaN, Infinity, -Infinity, and null/undefined values', () => {
      expect(calculatePercentage(NaN, 100)).toBe(0);
      expect(calculatePercentage(50, NaN)).toBe(0);
      expect(calculatePercentage(Infinity, 100)).toBe(0);
      expect(calculatePercentage(50, Infinity)).toBe(0);
      expect(calculatePercentage(null as any, 100)).toBe(0);
    });
  });

  describe('formatDisplayCurrency', () => {
    it('formats IDR without fractional decimals by default', () => {
      const result = formatDisplayCurrency(50000, 'IDR');
      expect(result).toMatch(/Rp\s*50\.000|IDR\s*50\.000/);
    });

    it('formats USD with standard decimals', () => {
      const result = formatDisplayCurrency(1234.56, 'USD');
      expect(result).toMatch(/\$|USD/);
      expect(result).toContain('1.234,56'); // id-ID locale uses dot for thousands and comma for decimals
    });

    it('formats EUR and other multi-currency codes', () => {
      const resultEur = formatDisplayCurrency(500, 'EUR');
      expect(resultEur).toMatch(/€|EUR/);

      const resultJpy = formatDisplayCurrency(1000, 'JPY');
      expect(resultJpy).toMatch(/¥|JPY/);
      expect(resultJpy).not.toContain(',00');
    });

    it('handles useThousands=false properly', () => {
      expect(formatDisplayCurrency(50000, 'IDR', false)).toBe('Rp 50000');
      expect(formatDisplayCurrency(1250.5, 'USD', false)).toBe('USD 1250.5');
    });

    it('handles negative amounts safely without showing negative zero', () => {
      const resultNeg = formatDisplayCurrency(-75000, 'IDR');
      expect(resultNeg).toContain('75.000');

      const resultNegZero = formatDisplayCurrency(-0, 'IDR', false);
      expect(resultNegZero).toBe('Rp 0');
    });

    it('formats extreme amounts in the trillions properly', () => {
      const trillion = formatDisplayCurrency(1_000_000_000_000, 'IDR');
      expect(trillion).toMatch(/1\.000\.000\.000\.000/);

      const smallFraction = formatDisplayCurrency(0.01, 'USD');
      expect(smallFraction).toContain('0,01');
    });

    it('falls back to string formatting when Intl.NumberFormat throws', () => {
      const originalIntl = Intl.NumberFormat;
      try {
        (Intl as any).NumberFormat = jest.fn().mockImplementation(() => {
          throw new Error('Intl unsupported');
        });
        const result = formatDisplayCurrency(50000, 'XYZ');
        expect(result).toBe('XYZ 50,000');

        const resultNeg = formatDisplayCurrency(-1000, 'XYZ');
        expect(resultNeg).toBe('XYZ -1,000');
      } finally {
        Intl.NumberFormat = originalIntl;
      }
    });
  });

  describe('currency decimals & decimal-aware input/parsing', () => {
    it('identifies zero-decimal vs minor-unit currencies accurately', () => {
      expect(getCurrencyDecimals('IDR')).toBe(0);
      expect(getCurrencyDecimals('JPY')).toBe(0);
      expect(currencyHasDecimals('IDR')).toBe(false);
      expect(currencyHasDecimals('JPY')).toBe(false);

      expect(getCurrencyDecimals('USD')).toBe(2);
      expect(getCurrencyDecimals('EUR')).toBe(2);
      expect(getCurrencyDecimals('GBP')).toBe(2);
      expect(getCurrencyDecimals('SGD')).toBe(2);
      expect(currencyHasDecimals('USD')).toBe(true);
      expect(currencyHasDecimals('eur')).toBe(true);
    });

    it('keeps decimals when formatting input for minor-unit currencies', () => {
      expect(formatAmountInput('12.5', 'USD')).toBe('12.5');
      expect(formatAmountInput('12.50', 'USD')).toBe('12.50');
      expect(formatAmountInput('12.567', 'USD')).toBe('12.56');
      expect(formatAmountInput('1234.56', 'USD')).toBe('1,234.56');
      expect(formatAmountInput('1234.', 'EUR')).toBe('1,234.');
      expect(formatAmountInput('.5', 'SGD')).toBe('0.5');
      expect(formatAmountInput('.', 'GBP')).toBe('0.');
      expect(formatAmountInput('12.3.4', 'USD')).toBe('12.34');
      expect(formatAmountInput('$12,500.50', 'USD')).toBe('12,500.50');
      // Backspacing "1,234" produces "1,23" -> must stay "123", not "1.23"
      expect(formatAmountInput('1,23', 'USD')).toBe('123');
    });

    it('strips decimals for IDR and JPY', () => {
      expect(formatAmountInput('50.000', 'IDR')).toBe('50.000');
      expect(formatAmountInput('12.50', 'JPY')).toBe('1.250');
    });

    it('formats stored numeric amounts for input without rounding away cents in USD', () => {
      expect(formatAmountForInput(-45000, 'IDR')).toBe('45.000');
      expect(formatAmountForInput(1200, 'JPY')).toBe('1.200');
      expect(formatAmountForInput(-12.5, 'USD')).toBe('12.5');
      expect(formatAmountForInput(1234.56, 'USD')).toBe('1,234.56');
      expect(formatAmountForInput(0.05, 'EUR')).toBe('0.05');
      expect(formatAmountForInput(NaN, 'USD')).toBe('');
    });

    it('parses decimal-currency inputs end-to-end and rounds zero-decimal currencies', () => {
      expect(parseSignedAmount('1,234.56', 'expense', 'USD')).toBe(-1234.56);
      expect(parseSignedAmount('12.5', 'income', 'USD')).toBe(12.5);
      expect(parseSignedAmount('0.05', 'expense', 'EUR')).toBe(-0.05);
      expect(parseSignedAmount('12.345', 'expense', 'USD')).toBe(-12.35);
      expect(parseSignedAmount('45.000', 'expense', 'IDR')).toBe(-45000);
      expect(parseSignedAmount(45000.6, 'expense', 'IDR')).toBe(-45001);
    });
  });

  describe('evaluateAmountExpression & formatCalculatorExpression', () => {
    it('evaluates arithmetic with standard precedence and left-associativity', () => {
      expect(evaluateAmountExpression('45000 + 18500', 0)).toEqual({ ok: true, value: 63500, isExpression: true });
      expect(evaluateAmountExpression('10 + 5 × 2', 2)).toEqual({ ok: true, value: 20, isExpression: true });
      expect(evaluateAmountExpression('100 - 20 ÷ 4', 2)).toEqual({ ok: true, value: 95, isExpression: true });
      expect(evaluateAmountExpression('100 ÷ 2 ÷ 5', 2)).toEqual({ ok: true, value: 10, isExpression: true });
      expect(evaluateAmountExpression('10 - 3 - 2', 2)).toEqual({ ok: true, value: 5, isExpression: true });
      expect(evaluateAmountExpression('12.50 + 3.25', 2)).toEqual({ ok: true, value: 15.75, isExpression: true });
      expect(evaluateAmountExpression('100 ÷ 3', 2)).toEqual({ ok: true, value: 33.33, isExpression: true });
      expect(evaluateAmountExpression('10000 ÷ 3', 0)).toEqual({ ok: true, value: 3333, isExpression: true });
      expect(evaluateAmountExpression('45000', 0)).toEqual({ ok: true, value: 45000, isExpression: false });
    });

    it('rejects division by zero without returning a numeric value', () => {
      expect(evaluateAmountExpression('100 ÷ 0', 0)).toEqual({ ok: false, error: 'division_by_zero' });
      expect(evaluateAmountExpression('100 / 0.00', 2)).toEqual({ ok: false, error: 'division_by_zero' });
      expect(evaluateAmountExpression('50 + 10 ÷ 0', 2)).toEqual({ ok: false, error: 'division_by_zero' });
      expect(evaluateAmountExpression('0 ÷ 0', 2)).toEqual({ ok: false, error: 'division_by_zero' });
    });

    it('rejects incomplete expressions so a wrong amount is never saved', () => {
      expect(evaluateAmountExpression('50 +', 0)).toEqual({ ok: false, error: 'incomplete' });
      expect(evaluateAmountExpression('50 -', 0)).toEqual({ ok: false, error: 'incomplete' });
      expect(evaluateAmountExpression('50 ×', 0)).toEqual({ ok: false, error: 'incomplete' });
      expect(evaluateAmountExpression('50 ÷', 0)).toEqual({ ok: false, error: 'incomplete' });
      expect(evaluateAmountExpression('12.', 2)).toEqual({ ok: false, error: 'incomplete' });
      expect(evaluateAmountExpression('.', 2)).toEqual({ ok: false, error: 'incomplete' });
      expect(evaluateAmountExpression('-', 2)).toEqual({ ok: false, error: 'incomplete' });
    });

    it('rejects empty, malformed, and overflowing inputs safely', () => {
      expect(evaluateAmountExpression('', 0)).toEqual({ ok: false, error: 'empty' });
      expect(evaluateAmountExpression('   ', 2)).toEqual({ ok: false, error: 'empty' });
      expect(evaluateAmountExpression('12..5', 2)).toEqual({ ok: false, error: 'invalid' });
      expect(evaluateAmountExpression('10 + × 5', 2)).toEqual({ ok: false, error: 'invalid' });
      expect(evaluateAmountExpression('process.exit()', 2)).toEqual({ ok: false, error: 'invalid' });
      expect(evaluateAmountExpression('999999999999999 × 999999', 0)).toEqual({ ok: false, error: 'overflow' });
      // Safe precision cap (1e13): accepts exact values up to 1e13 and rejects values above it
      expect(evaluateAmountExpression('9999999999999.99', 2)).toEqual({
        ok: true,
        value: 9999999999999.99,
        isExpression: false,
      });
      expect(evaluateAmountExpression('10000000000000', 0)).toEqual({
        ok: true,
        value: 10000000000000,
        isExpression: false,
      });
      expect(evaluateAmountExpression('10000000000001', 0)).toEqual({ ok: false, error: 'overflow' });
      expect(evaluateAmountExpression('10000000000000.01', 2)).toEqual({ ok: false, error: 'overflow' });
      expect(evaluateAmountExpression('999999999999998', 2)).toEqual({ ok: false, error: 'overflow' });
    });

    it('formats calculator expressions for IDR and USD display', () => {
      expect(formatCalculatorExpression('45000+18500', 'IDR')).toBe('45.000 + 18.500');
      expect(formatCalculatorExpression('1250.5*2', 'USD')).toBe('1,250.5 × 2');
      expect(formatCalculatorExpression('100/', 'IDR')).toBe('100 ÷ ');
    });
  });

  describe('summarizeTransactions', () => {
    it('computes count, totalIn, totalOut, and net while excluding transfers from in/out', () => {
      const summary = summarizeTransactions([
        { type: 'income', totalAmount: 5000000 },
        { type: 'expense', totalAmount: -1200000 },
        { type: 'expense', totalAmount: -300000 },
        { type: 'transfer', totalAmount: -2000000 },
      ]);

      expect(summary).toEqual({
        count: 4,
        totalIn: 5000000,
        totalOut: 1500000,
        net: 3500000,
      });
    });

    it('handles transfer-only lists and decimal amounts accurately', () => {
      expect(summarizeTransactions([{ type: 'transfer', totalAmount: -500 }])).toEqual({
        count: 1,
        totalIn: 0,
        totalOut: 0,
        net: 0,
      });

      expect(
        summarizeTransactions([
          { type: 'income', totalAmount: 10.1 },
          { type: 'income', totalAmount: 0.2 },
          { type: 'expense', totalAmount: -4.05 },
        ])
      ).toEqual({
        count: 3,
        totalIn: 10.3,
        totalOut: 4.05,
        net: 6.25,
      });
    });
  });
});
