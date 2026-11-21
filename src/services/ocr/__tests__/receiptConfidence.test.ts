import { assessReceiptConfidence } from '../receiptConfidence';

const ROWS = ['WARUNG NASI', 'Nasi Goreng  25.000', 'Es Teh  5.000', 'PB1 10%  3.000', 'TOTAL  33.000'];

describe('assessReceiptConfidence', () => {
  it('is high when the total is in the text and matches the TOTAL line', () => {
    expect(assessReceiptConfidence({ total: 33000, rows: ROWS, independentTotal: 33000, itemPrices: [] })).toEqual({
      level: 'high',
      reasons: [],
    });
  });

  it('is high when the items add up to the total within tax and discount range', () => {
    const result = assessReceiptConfidence({ total: 33000, rows: ROWS, independentTotal: null, itemPrices: [25000, 5000] });
    expect(result.level).toBe('high');
  });

  it('is medium when the total is in the text but nothing confirms it', () => {
    const result = assessReceiptConfidence({ total: 25000, rows: ROWS, independentTotal: 33000, itemPrices: [25000, 5000, 3000, 33000] });
    expect(result.level).toBe('medium');
    expect(result.reasons[0]).toMatch(/cross-checked/);
  });

  it('is low when the total is not in the text read from the photo', () => {
    const result = assessReceiptConfidence({ total: 99000, rows: ROWS, independentTotal: 33000, itemPrices: [99000] });
    expect(result.level).toBe('low');
    expect(result.reasons[0]).toMatch(/doesn't appear/);
  });

  it('is low with no total', () => {
    expect(assessReceiptConfidence({ total: undefined, rows: ROWS, independentTotal: null, itemPrices: [] }).level).toBe('low');
  });

  it('warns about unreadable photos even when the few rows contain the total', () => {
    const result = assessReceiptConfidence({ total: 33000, rows: ['TOTAL 33.000'], independentTotal: 33000, itemPrices: [33000] });
    expect(result.level).toBe('low');
    expect(result.reasons[0]).toMatch(/blurry, dark, or cropped/);
  });

  it('never returns high (Verified) when merchant looks like an item, promo, disclaimer, or total line (F-07)', () => {
    const badMerchants = [
      'J.STB PROMO 17500',
      '1 EG6 TART 13,000',
      'sudah termasuk asuransi',
      'TOTAL 33.000',
      'SUS T8TAL',
    ];
    for (const merchantName of badMerchants) {
      const result = assessReceiptConfidence({
        total: 33000,
        rows: ROWS,
        independentTotal: 33000,
        itemPrices: [25000, 5000],
        merchantName,
      });
      expect(result.level).toBe('medium');
      expect(result.reasons.join(' ')).toMatch(/Merchant name/i);
    }
  });

  it('downgrades from high to medium when extracted item prices do not reconcile with the total (F-07)', () => {
    // e.g. OCR duplicated totals/cash into items or missed half the receipt
    const result = assessReceiptConfidence({
      total: 33000,
      rows: ROWS,
      independentTotal: 33000,
      itemPrices: [25000, 5000, 33000, 50000],
      merchantName: 'WARUNG NASI',
    });
    expect(result.level).toBe('medium');
    expect(result.reasons.join(' ')).toMatch(/don't add up/i);
  });

  it('stays high when merchant is clean, total matches, and items reconcile within tax/discount range', () => {
    const result = assessReceiptConfidence({
      total: 33000,
      rows: ROWS,
      independentTotal: 33000,
      itemPrices: [25000, 5000],
      merchantName: 'WARUNG NASI',
    });
    expect(result).toEqual({ level: 'high', reasons: [] });
  });
});
