import { buildDummyTransactions } from '../dummyData';

describe('dummyData', () => {
  it('generates consistent and valid dummy transactions', () => {
    const data = buildDummyTransactions();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    data.forEach((tx) => {
      expect(tx.merchantName).toBeTruthy();
      expect(typeof tx.totalAmount).toBe('number');
      expect(Number.isFinite(tx.totalAmount)).toBe(true);
      expect(tx.totalAmount).not.toBe(0);
      expect(['income', 'expense', 'transfer']).toContain(tx.type);
      expect(typeof tx.date).toBe('number');
      expect(tx.date).toBeGreaterThan(0);
      expect(tx.category).toBeTruthy();

      // Income must be positive, expense must be negative
      if (tx.type === 'income') {
        expect(tx.totalAmount).toBeGreaterThan(0);
      } else if (tx.type === 'expense') {
        expect(tx.totalAmount).toBeLessThan(0);
      }
    });
  });
});
