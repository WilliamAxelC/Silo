import {
  formatAmountInput,
  roundCurrency,
  parseSignedAmount,
  addAmounts,
  calculateTotal,
  splitAmount,
  calculatePercentage,
  formatDisplayCurrency,
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
      expect(formatAmountInput('1000')).toBe('1,000');
      expect(formatAmountInput('50000')).toBe('50,000');
      expect(formatAmountInput('1000000')).toBe('1,000,000');
      expect(formatAmountInput('1234567890')).toBe('1,234,567,890');
    });

    it('strips non-numeric characters and symbols', () => {
      expect(formatAmountInput('Rp 50.000')).toBe('50,000');
      expect(formatAmountInput('$12,500.00')).toBe('1,250,000');
      expect(formatAmountInput('abc 123 def 456')).toBe('123,456');
      expect(formatAmountInput('!@#$%^&*()_+')).toBe('');
    });

    it('strips leading zeros while keeping a single zero if followed by digits', () => {
      expect(formatAmountInput('00050')).toBe('50');
      expect(formatAmountInput('0123456')).toBe('123,456');
      expect(formatAmountInput('000')).toBe('0');
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
  });

  describe('calculatePercentage', () => {
    it('calculates percentage of part over total correctly', () => {
      expect(calculatePercentage(50, 200)).toBe(25);
      expect(calculatePercentage(1, 3)).toBe(33.33);
      expect(calculatePercentage(100, 100)).toBe(100);
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

    it('falls back to string formatting when Intl.NumberFormat throws', () => {
      const originalIntl = Intl.NumberFormat;
      try {
        (Intl as any).NumberFormat = jest.fn().mockImplementation(() => {
          throw new Error('Intl unsupported');
        });
        const result = formatDisplayCurrency(50000, 'XYZ');
        expect(result).toBe('XYZ 50,000');
      } finally {
        Intl.NumberFormat = originalIntl;
      }
    });
  });
});
