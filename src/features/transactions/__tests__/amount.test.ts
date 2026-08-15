import { formatAmountInput, parseSignedAmount, formatDisplayCurrency } from '../amount';

describe('amount utilities', () => {
  describe('formatAmountInput', () => {
    it('formats empty and whitespace string to empty', () => {
      expect(formatAmountInput('')).toBe('');
      expect(formatAmountInput('  ')).toBe('');
    });

    it('adds thousand separators correctly', () => {
      expect(formatAmountInput('1000')).toBe('1,000');
      expect(formatAmountInput('50000')).toBe('50,000');
      expect(formatAmountInput('1000000')).toBe('1,000,000');
    });

    it('strips non-numeric characters', () => {
      expect(formatAmountInput('Rp 50.000')).toBe('50,000');
      expect(formatAmountInput('$12,500.00')).toBe('1,250,000');
    });
  });

  describe('parseSignedAmount', () => {
    it('returns negative amount for expenses', () => {
      expect(parseSignedAmount('50,000', 'expense')).toBe(-50000);
      expect(parseSignedAmount('1500', 'expense')).toBe(-1500);
      expect(parseSignedAmount(25000, 'expense')).toBe(-25000);
    });

    it('returns positive amount for income', () => {
      expect(parseSignedAmount('5,000,000', 'income')).toBe(5000000);
      expect(parseSignedAmount('75000', 'income')).toBe(75000);
      expect(parseSignedAmount(100000, 'income')).toBe(100000);
    });

    it('handles null, undefined, and empty string safely', () => {
      expect(parseSignedAmount('', 'expense')).toBe(0);
      expect(parseSignedAmount(null, 'expense')).toBe(0);
      expect(parseSignedAmount(undefined, 'income')).toBe(0);
    });
  });

  describe('formatDisplayCurrency', () => {
    it('formats IDR without fractional decimals by default', () => {
      const result = formatDisplayCurrency(50000, 'IDR');
      expect(result).toContain('50.000');
    });

    it('handles negative numbers safely', () => {
      const result = formatDisplayCurrency(-75000, 'IDR');
      expect(result).toContain('75.000');
    });

    it('handles null or invalid amounts gracefully', () => {
      const result = formatDisplayCurrency(null, 'IDR');
      expect(result).toBeDefined();
    });
  });
});
