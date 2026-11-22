import { extractLineItemsHeuristic, parseReceiptTextHeuristic } from '../MlKitEngine';
import { extractReceiptDate, isPlausibleReceiptDate } from '../receiptText';
import { parseReceiptLineItemsText } from '../../../features/transactions/lineItems';

// Row text as ML Kit reconstructed a Super Indo receipt (member name replaced with a placeholder).
const SUPERINDO_ROWS = `
PT LION SUPER INDO
NPWP : 0017813726046000
Tanggal Pengukuhan : 07-07-97
JL. TANJUNG DUREN RAYA KAV 5-9
KEL TANJUNG DUREN SELATAN
JAKARTA BARAT, DKI JAKARTA
22-11-26 (16:12:45) 713 02 No:00014
DESKRIPSI QTY HARGA TOTAL
TELUR AYAM OMEGA 806 29, 400 23,695
Sub Total (Termasuk PPN) : 23,695
Pembayaran-BRI QRIS : 23,695
RefNum : 002e786e9da0
BTKP : 23,695
Total Item : 1
Member Name : Test Member
** Terima Kasih **
SARAN ANDA KEPUASAN ANDA
ELP BEBAS PULSA: 0800 140 3210
WHATSAPP: 0812 1313 7035 (CALL ONLY)
SENIN-JUMAT 08:00-17:00 WIB
email: customerservice@superindo.co.id
www.superindo.co.id
`.trim();

describe('Super Indo receipt line items', () => {
  it('keeps the single item, moves qty x unit price into the note, and drops BTKP and footer phone numbers', () => {
    const items = parseReceiptLineItemsText(extractLineItemsHeuristic(SUPERINDO_ROWS, 'PT LION SUPER INDO') ?? '');
    expect(items).toEqual([
      expect.objectContaining({ name: 'TELUR AYAM OMEGA', price: '23695', note: '806 g × 29.400/kg' }),
    ]);
  });

  it('reads the total, not the qty under the "DESKRIPSI QTY HARGA TOTAL" column header', () => {
    expect(parseReceiptTextHeuristic(SUPERINDO_ROWS).extractedTotal).toBe(23695);
  });

  it('dates the purchase from the timestamped row, not the 07-07-97 tax registration date', () => {
    const now = new Date(2026, 10, 22, 16, 20);
    expect(extractReceiptDate(SUPERINDO_ROWS, now)).toBe('2026-11-22');
  });

  it('rejects implausible receipt dates', () => {
    const now = new Date(2026, 10, 22);
    expect(isPlausibleReceiptDate('2097-07-07', now)).toBe(false);
    expect(isPlausibleReceiptDate('2026-02-30', now)).toBe(false);
    expect(isPlausibleReceiptDate('2019-01-01', now)).toBe(false);
    expect(isPlausibleReceiptDate('2026-11-23', now)).toBe(true);
    expect(isPlausibleReceiptDate('2025-06-14', now)).toBe(true);
    expect(extractReceiptDate('EXP 12/28\nBERLAKU S/D 01-01-2027\n14-06-2025 10:15', now)).toBe('2025-06-14');
  });

  it('drops phone-number rows even before any total row', () => {
    const items = parseReceiptLineItemsText(
      extractLineItemsHeuristic('KOPI SUSU 18.000\nHUBUNGI KAMI 0812 1313 7035\nCALL CENTER 1500 123 4567', null) ?? '',
    );
    expect(items.map((i) => i.name)).toEqual(['KOPI SUSU']);
  });

  it('strips qty and unit-price columns when qty x price matches the line total', () => {
    const items = parseReceiptLineItemsText(extractLineItemsHeuristic('INDOMIE GORENG 3 3,500 10,500\nAQUA 600ML 1 4,000 4,000', null) ?? '');
    expect(items).toEqual([
      expect.objectContaining({ name: 'INDOMIE GORENG', price: '10500', note: '3 × 3.500' }),
      expect.objectContaining({ name: 'AQUA 600ML', price: '4000', note: '' }),
    ]);
  });
});

describe('receipt id and cashier rows', () => {
  it('are never items, and long ID numbers are not amounts', () => {
    const { extractAmounts, isNonItemLine } = jest.requireActual('../receiptText');
    expect(isNonItemLine('Bon 6A5Q-555-020928K8 Kasir : AHMAD NI')).toBe(true);
    expect(isNonItemLine('Kasir: SITI 12.000')).toBe(true);
    expect(isNonItemLine('LW S CARB TRFLE 1 15,000 15,000')).toBe(false);
    expect(extractAmounts('NPWP: 845037704416000 total 13,000')).toEqual([13000]);
  });
});

describe('OCR-split thousands', () => {
  it('reads "13, 000" as 13000 and finds the Lawson total', () => {
    const { extractAmounts, pickTotalFromRows } = jest.requireActual('../receiptText');
    expect(extractAmounts('Total Bel anja  13, 000')).toEqual([13000]);
    expect(
      pickTotalFromRows(['LH S CARB TRFLE  1 15,000  15, 000', 'Total Item  1  15,000', 'Total Disc.  2, 000', 'Total Bel anja  13, 000', 'QRIS CPH LAWSON  13, 000', 'Kembal ian  0']),
    ).toBe(13000);
  });
});
