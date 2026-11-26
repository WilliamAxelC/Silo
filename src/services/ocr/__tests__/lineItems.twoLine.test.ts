import { parseReceiptTextHeuristic } from '../MlKitEngine';
import { extractReceiptItems } from '../receiptItems';
import { isNonItemLine } from '../receiptText';
import { parseReceiptLineItemsText } from '../../../features/transactions/lineItems';

// Minimarket layout (FamilyMart, Lawson): the item name on one line, "unit X qty   line total" on the next,
// discounts as their own name line followed by a negative amount. Rows as ML Kit grouped them; cashier name,
// receipt/QRIS numbers and tax ID removed.
const FAMILYMART_ROWS = `
FamilyMart
STORE : BRANCH
26/11/2026 08:08 POS ID : 002
RCT NO : 0000000000000000
CASHIER : Cashier Name
*SALES RECEIPT*
Onigiri Tuna Mayo Pcs
13,000 X 1  13,000
Onigiri Disc 2rb (20.00 - 00.00)
-2,000
Onigiri Salmon Mayo
13,000 X 1  13,000
TOTAL  Rp 24,000
BCA GRIS  24,000
0000000000000000000
TOTAL PAID  Rp 24,000
CHANGES  0
# ITEM SOLD  2
ANDA HEMAT :  2,000
DPP Nilai Lain : 19,820
DPP : 21,622  PPN : 2,378
PB1 : 0
Harga sudah termasuk pajak
`.trim();

// A skewed photo of the same layout: line totals land on the name row or before the next item's name.
const FAMILYMART_SKEWED_ROWS = `
FamilyMart
STORE :BRANCH  19/11/2026 13:38 P0S ID :002
CASHIER :Cashier Name  *SALES RECEIPTX
IcekSkLargeLessSugar  20,000
20,000 X 1
ICE KSK LARGE  20,000
20,000 X 1  ICE CARAMEL MACCHIATO L
20,000 X 1  20,000
Cranbery Americano L  60,000
20,000 X 3
2KopiL 32K  -24,000
3,000 X 1  Topping Jelly Coffee  3,000
TOTAL  Rp 99,000
BCA QRIS  99,000
TOTAL PAID  Rp 99,000
CHANGES  0
#ITEM SOLD  7
ANDA HEMAT:  24,000
DPP Nilai Lain:O
DPP:89,998  PPN : 0
PB1:9,002
`.trim();

const rows = (text: string) => text.split('\n');
const sum = (items: Array<{ price: string }>) => items.reduce((s, i) => s + Number(i.price), 0);

describe('two-line minimarket receipts', () => {
  it('regression: FamilyMart items are the onigiri, not BCA QRIS / TOTAL PAID / DPP Nilai Lain', () => {
    const items = parseReceiptLineItemsText(parseReceiptTextHeuristic(FAMILYMART_ROWS).extractedLineItems ?? '');
    expect(items).toEqual([
      expect.objectContaining({ name: 'Onigiri Tuna Mayo Pcs', price: '11000', note: '13.000 - 2.000 Onigiri Disc 2rb' }),
      expect.objectContaining({ name: 'Onigiri Salmon Mayo', price: '13000', note: '' }),
    ]);
    expect(sum(items)).toBe(24000);
  });

  it('pairs names with their qty and totals when the photo is skewed', () => {
    const items = parseReceiptLineItemsText(extractReceiptItems(rows(FAMILYMART_SKEWED_ROWS)) ?? '');
    expect(items.map((i) => [i.name, i.price])).toEqual([
      ['IcekSkLargeLessSugar', '20000'],
      ['ICE KSK LARGE', '20000'],
      ['ICE CARAMEL MACCHIATO L', '20000'],
      ['Cranbery Americano L', '36000'],
      ['Topping Jelly Coffee', '3000'],
    ]);
    expect(items[3].note).toBe('3 × 20.000 - 24.000 2KopiL 32K');
    expect(sum(items)).toBe(99000);
  });

  it('still reads one-line items', () => {
    expect(extractReceiptItems(['NASI GORENG  25,000', 'ES TEH  5,000', 'TOTAL  30,000'])).toBe(
      'NASI GORENG | 25000\nES TEH | 5000',
    );
  });

  it.each(['TOTAL PAID  Rp 24,000', 'BCA GRIS  24,000', 'DPP Nilai Lain : 19,820', 'CHANGES  0', '# ITEM SOLD  2'])(
    'regression: "%s" is not an item',
    (row) => {
      expect(isNonItemLine(row)).toBe(true);
    },
  );
});
