import {
  buildReceiptRows,
  extractAmounts,
  isGrounded,
  isNonItemLine,
  isSuspiciousMerchantName,
  pickMerchantFromRows,
  pickTotalFromRows,
} from '../receiptText';

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

  describe('isNonItemLine (F-07)', () => {
    it('filters subtotal, tax, cash, change, Indonesian tenders, and OCR-garbled total lines', () => {
      const nonItems = [
        'SUBTOTAL',
        'Sub Total',
        'SUS T8TAL',
        'S8BTOTAL',
        'TAX 10%',
        'PB1 10%',
        'PPN 11%',
        'TOTAL',
        'GRAND TOTAL',
        'TOTAL BELANJA',
        'CASH',
        'CAS8',
        'CHANGE',
        'CHNGE',
        'TUNAI',
        'KEMBALIAN',
        'KEMBALI',
        'QRIS',
        'ROUNDING',
        'DISCOUNT',
        'HARGA JUAL',
        'TOTAL ITEM 3',
      ];
      for (const line of nonItems) {
        expect(isNonItemLine(line)).toBe(true);
      }
    });

    it('keeps legitimate receipt items including foods with similar substrings', () => {
      const realItems = [
        'Tuna Sandwich',
        'Nasi Goreng Kampung',
        'Ayam Bakar Madu',
        'Es Kopi Susu',
        'Iced Americano',
        'Toast Kaya Butter',
        'Item 1',
      ];
      for (const line of realItems) {
        expect(isNonItemLine(line)).toBe(false);
      }
    });

    it('never drops real Indonesian and English item names containing summary/payment keywords or close edit-distance food words (R3A-01)', () => {
      const realItemsWithKeywords = [
        'Cash Back Burger  45.000',
        'Cash Back Burger',
        'Potongan Ayam  22.000',
        'Potongan Ayam',
        'Paket Hemat  35.000',
        'Paket Hemat Keluarga  95.000',
        'Tip Top Cake  25.000',
        'Tip Top Cake',
        'Kopi Tunas  18.000',
        'Kopi Tunas',
        'Nasi Bajak  30.000',
        'Nasi Bajak',
        'Total Care Toothpaste  24.000',
        'Master Cheese Pizza  85.000',
        'Table Water 600ml  8.000',
        'Menu Promo Ayam Geprek  28.000',
        'Change Purse Leather  120.000',
        'Dana White Tea  22.000',
        'Voucher Game Steam  50.000',
        '1x Paket Hemat  35.000',
      ];
      for (const line of realItemsWithKeywords) {
        expect(isNonItemLine(line)).toBe(false);
      }

      // True summary / discount / payment / tax / metadata lines are still dropped
      const trueSummaryLines = [
        'SUBTOTAL  55.000',
        'PB1 (10%)  17,460',
        'PB-1  8900',
        'DISKON MEMBER  5.000',
        'POTONGAN HARGA  5.000',
        'POTONGAN  -5.000',
        'ANDA HEMAT  3.000',
        'HEMAT  2.000',
        'QRIS CPM LAWSON  13,000',
        'DEBIT BCA  97900',
        'TUN4I  50.000',
        'P4J4K  5.000',
        'TABLE 14',
        'ORDER #1042',
      ];
      for (const line of trueSummaryLines) {
        expect(isNonItemLine(line)).toBe(true);
      }
    });
  });

  describe('isSuspiciousMerchantName & pickMerchantFromRows (F-07)', () => {
    it('rejects promo lines, quantity+item+price lines, totals, and disclaimers as merchant names', () => {
      expect(isSuspiciousMerchantName('J.STB PROMO 17500')).toBe(true);
      expect(isSuspiciousMerchantName('1 EG6 TART 13,000')).toBe(true);
      expect(isSuspiciousMerchantName('TRAD KY TOAST CARTE  28.182')).toBe(true);
      expect(isSuspiciousMerchantName('sudah termasuk asuransi')).toBe(true);
      expect(isSuspiciousMerchantName('Sponsored by HARI KE-6')).toBe(true);
      expect(isSuspiciousMerchantName('TOTAL 230,000')).toBe(true);
      expect(isSuspiciousMerchantName('SUBTOTAL 45.000')).toBe(true);
      expect(isSuspiciousMerchantName('SUS T8TAL 45.000')).toBe(true);
      expect(isSuspiciousMerchantName('TERIMA KASIH')).toBe(true);
    });

    it('accepts realistic Indonesian merchant titles including 4-digit branch IDs and brand names containing Total (R3A-01)', () => {
      expect(isSuspiciousMerchantName('INDOMARET POINT')).toBe(false);
      expect(isSuspiciousMerchantName('ALFAMART 1024')).toBe(false);
      expect(isSuspiciousMerchantName('INDOMARET 0412')).toBe(false);
      expect(isSuspiciousMerchantName('TOTAL BUAH SEGAR')).toBe(false);
      expect(isSuspiciousMerchantName('SPBU PERTAMINA 31.129.02')).toBe(false);
      expect(isSuspiciousMerchantName('APOTEK KIMIA FARMA 124')).toBe(false);
      expect(isSuspiciousMerchantName('KOPI KENANGAN')).toBe(false);
      expect(isSuspiciousMerchantName('TOAST BOX')).toBe(false);

      expect(pickMerchantFromRows(['ALFAMART 1024', 'JL. MERDEKA NO. 1', 'Paket Hemat  35.000', 'TOTAL  35.000'])).toBe(
        'ALFAMART 1024'
      );
      expect(pickMerchantFromRows(['TOTAL BUAH SEGAR', 'Mangga Harum Manis  40.000', 'TOTAL  40.000'])).toBe(
        'TOTAL BUAH SEGAR'
      );
    });

    it('skips top promo/disclaimer/item lines and picks the real merchant header', () => {
      const rows = [
        'Sponsored by HARI KE-6',
        'sudah termasuk asuransi',
        'KOPI KENANGAN',
        'Jl. Jend. Sudirman No. 10',
        '1x Kopi Kenangan Mantan  24.000',
        'SUS T8TAL  24.000',
        'TOTAL  24.000',
        'TUNAI  50.000',
        'KEMBALIAN  26.000',
      ];
      expect(pickMerchantFromRows(rows)).toBe('KOPI KENANGAN');
    });

    it('returns null instead of a garbled item or total line when no clean merchant exists', () => {
      const rows = [
        '1 EG6 TART 13,000',
        'J.STB PROMO 17500',
        'SUS T8TAL 30,500',
        'TOTAL 30,500',
      ];
      expect(pickMerchantFromRows(rows)).toBeNull();
    });
  });
});
