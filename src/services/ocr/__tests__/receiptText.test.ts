import { buildReceiptRows, extractAmounts, isGrounded, pickTotalFromRows } from '../receiptText';

describe('receiptText', () => {
  describe('buildReceiptRows', () => {
    it('groups boxes by vertical overlap (>=50% of smaller height) and sorts left-to-right', () => {
      const rows = buildReceiptRows([
        { text: '50.000', frame: { left: 220, top: 102, width: 60, height: 20 } },
        { text: 'Nasi Goreng', frame: { left: 10, top: 100, width: 120, height: 22 } },
        { text: 'WARUNG MAKAN', frame: { left: 40, top: 20, width: 150, height: 24 } },
        { text: '2', frame: { left: 150, top: 103, width: 15, height: 18 } },
        { text: 'TOTAL', frame: { left: 10, top: 150, width: 60, height: 20 } },
        { text: '50.000', frame: { left: 220, top: 152, width: 60, height: 20 } },
      ]);

      expect(rows).toEqual([
        'WARUNG MAKAN',
        'Nasi Goreng  2  50.000',
        'TOTAL  50.000',
      ]);
    });

    it('keeps lines on separate rows when vertical overlap is below 50%', () => {
      const rows = buildReceiptRows([
        { text: 'Item A', frame: { left: 10, top: 100, width: 80, height: 20 } },
        { text: 'Item B', frame: { left: 10, top: 112, width: 80, height: 20 } },
      ]);

      // overlap = 120 - 112 = 8, 8 / 20 = 0.4 < 0.5
      expect(rows).toEqual(['Item A', 'Item B']);
    });

    it('preserves input order for lines without frames and drops blank lines', () => {
      const rows = buildReceiptRows([
        { text: '  FIRST  ' },
        { text: '   ' },
        { text: 'SECOND' },
        { text: 'THIRD' },
      ]);

      expect(rows).toEqual(['FIRST', 'SECOND', 'THIRD']);
    });
  });

  describe('extractAmounts', () => {
    it('extracts Indonesian dot/comma formatted rupiah amounts and skips dates/times/phones/qtys', () => {
      const text = [
        'INDOMARET 12.03.2026 14:22:10',
        'TELP 08123456789',
        '2 Nasi Goreng Rp 25.000,-',
        'Total Disc. 2,000',
        'Total Belanja 48.000',
      ].join('\n');

      expect(extractAmounts(text)).toEqual([25000, 2000, 48000]);
    });

    it('handles multi-thousand separators and decimal cents', () => {
      expect(extractAmounts('GRAND TOTAL Rp 1.565.938,00')).toEqual([1565938]);
      expect(extractAmounts('TOTAL 60,000.00')).toEqual([60000]);
    });
  });

  describe('pickTotalFromRows', () => {
    it('picks Total Belanja from real Indonesian Lawson receipt rows', () => {
      const rows = [
        'Total Item  1  15,000',
        'Total Disc.  2,000',
        'Total Belanja  13,000',
        'QRIS CPM LAWSON  13,000',
      ];

      expect(pickTotalFromRows(rows)).toBe(13000);
    });

    it('falls back to a single Rupiah price on tickets without a TOTAL row', () => {
      expect(pickTotalFromRows(['TIKET MASUK', 'Rp.10.000,', 'PERHUTANI'])).toBe(10000);
      expect(pickTotalFromRows(['Rp 5.000', 'Rp 7.000'])).toBeNull();
    });

    it('picks TOTAL over SUBTOTAL, CASH, CHANGE in CORD-style rows', () => {
      const rows = [
        'Nasi Goreng  2  55.000',
        'SUBTOTAL  55.000',
        'PB1 10%  5.000',
        'TOTAL  60.000',
        'CASH  100.000',
        'CHANGE  40.000',
      ];

      expect(pickTotalFromRows(rows)).toBe(60000);
    });

    it('prefers GRAND TOTAL / TOTAL BAYAR / TOTAL BELANJA over plain TOTAL', () => {
      const rows = [
        'TOTAL  55.000',
        'GRAND TOTAL  60.500',
        'TOTAL NETTO  55.000',
      ];

      expect(pickTotalFromRows(rows)).toBe(60500);
    });

    it('takes the first amount on the next row when keyword row has no amount', () => {
      const rows = [
        'TOTAL BAYAR',
        '42.500  IDR',
        'TUNAI  50.000',
      ];

      expect(pickTotalFromRows(rows)).toBe(42500);
    });

    it('takes the last matching non-preferred row and falls back to null when none match', () => {
      expect(pickTotalFromRows(['JUMLAH  20.000', 'TAGIHAN  25.000'])).toBe(25000);
      expect(pickTotalFromRows(['SUBTOTAL  20.000', 'TUNAI  50.000', 'KEMBALI  30.000'])).toBeNull();
    });
  });

  describe('isGrounded', () => {
    it('returns true only when total appears among extracted OCR amounts', () => {
      const rows = ['Nasi Goreng  25.000', 'Total Belanja  25.000'];
      expect(isGrounded(25000, rows)).toBe(true);
      expect(isGrounded(26000, rows)).toBe(false);
      expect(isGrounded(0, rows)).toBe(false);
    });
  });
});
