import { parseReceiptTextHeuristic } from '../MlKitEngine';

describe('parseReceiptTextHeuristic (Indonesian & International Receipts)', () => {
  it('correctly extracts total, merchant, and date from an Indomaret / Minimarket style receipt', () => {
    const rawText = `
INDOMARET HYBRID
JL. GAJAH MADA NO. 12
15-08-2024 14:32:10
1 INDOMILK 950ML 18.500
2 ROTI TAWAR SARI ROTI 15.000
TOTAL BELANJA 33.500
TUNAI 50.000
KEMBALIAN 16.500
TERIMA KASIH
    `.trim();

    const result = parseReceiptTextHeuristic(rawText);
    expect(result.extractedMerchant).toBe('INDOMARET HYBRID');
    expect(result.extractedTotal).toBe(33500);
    expect(result.extractedDate).toBe('2024-08-15');
  });

  it('correctly extracts total when receipt has Discount, Subtotal, PB1 Tax, Cash and Change', () => {
    const rawText = `
KOPI KENANGAN
MALL KELAPA GADING
2 ICE BLACK COFFEE 82,000
1 AVOCADO COFFEE 61,000
1 CHICKEN KATSU 51,000
SUB_TOTAL 194,000
DISCOUNT 19,400
PB1 (10%) 17,460
TOTAL 174,600
CASH 200,000
CHANGE 25,400
    `.trim();

    const result = parseReceiptTextHeuristic(rawText);
    expect(result.extractedMerchant).toBe('KOPI KENANGAN');
    expect(result.extractedTotal).toBe(174600);
  });

  it('correctly extracts unformatted total numbers (no dots or commas)', () => {
    const rawText = `
BAKMI GM
J.STB PROMO 17500
Y.B.BAT 46000
Y.BASO PROM 27500
TOTAL 91000
CASH 91000
    `.trim();

    const result = parseReceiptTextHeuristic(rawText);
    expect(result.extractedMerchant).toBe('BAKMI GM');
    expect(result.extractedTotal).toBe(91000);
  });

  it('correctly extracts AMOUNT DUE and DD/MM/YYYY dates', () => {
    const rawText = `
BURGER BAR
TANGGAL: 24/12/2024
AMBUSH DBL CHS 60000
AMBUSH CHS BUR 100000
NET SALES 160000
TAX 16000
AMOUNT DUE 176000
    `.trim();

    const result = parseReceiptTextHeuristic(rawText);
    expect(result.extractedMerchant).toBe('BURGER BAR');
    expect(result.extractedTotal).toBe(176000);
    expect(result.extractedDate).toBe('2024-12-24');
  });

  it('correctly falls back to Tunai/Cash payment if explicit TOTAL line is missing', () => {
    const rawText = `
WARUNG MAKAN SEDAP
1 NASI GORENG 25.000
1 ES TEH MANIS 5.000
TUNAI 30.000
KEMBALIAN 0
    `.trim();

    const result = parseReceiptTextHeuristic(rawText);
    expect(result.extractedMerchant).toBe('WARUNG MAKAN SEDAP');
    expect(result.extractedTotal).toBe(30000);
  });

  it('handles empty or blank text gracefully', () => {
    const result = parseReceiptTextHeuristic('');
    expect(result.extractedTotal).toBeNull();
    expect(result.extractedMerchant).toBeNull();
    expect(result.extractedDate).toBeNull();
  });
});
