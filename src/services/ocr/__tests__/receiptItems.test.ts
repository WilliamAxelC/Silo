import { extractReceiptItems } from '../receiptItems';
import { parseReceiptLineItemsText } from '../../../features/transactions/lineItems';

// Layouts from real receipts as ML Kit grouped them into rows (store details, people and numbers replaced).
const read = (rows: string) =>
  parseReceiptLineItemsText(extractReceiptItems(rows.trim().split('\n')) ?? '').map((i) => [
    i.name,
    i.price,
    i.note,
  ]);

describe('extractReceiptItems: names and prices on different rows', () => {
  it('regression: coffee shop with option rows and the price row under them', () => {
    expect(
      read(`
COFFEE SHOP
Date:  19/Aug/2026 20:44
Channel:  SEL-POS
Order Number:  TO0000000000000000000
Breve Latte Iced Medium
+Master Milk
+No Topping  1
34,000  1  34,000
Caffe Latte Hot Medium
+Master Milk
+No Topping  1
28,000  1  28,000
SUBTOTAL:  56,364
Tax:  5,636
TOAL:
BNI QRIS Dynamic  62,000
`),
    ).toEqual([
      ['Breve Latte Iced Medium', '34000', 'Master Milk, No Topping'],
      ['Caffe Latte Hot Medium', '28000', 'Master Milk, No Topping'],
    ]);
  });

  it('regression: noodle shop with "4x 35.000  140.000" under each name and OCR slips for @', () => {
    expect(
      read(`
Noodle Shop
Sales No  : SX000000000000
Date  :07-11-2026 18:59
Table  :7
Bakmi
4x 35.000  140.000
Bakmi Jumbo
1x G43.000  43.000
Es Teh Tawar
2x 83.000  6.000
Es Teh Manis
1x  5.000  5.000
8 items
Subtotal :  194.000
`),
    ).toEqual([
      ['Bakmi', '140000', '4 × 35.000'],
      ['Bakmi Jumbo', '43000', ''],
      ['Es Teh Tawar', '6000', ''],
      ['Es Teh Manis', '5000', ''],
    ]);
  });

  it('regression: tea shop with "@38.000  38.000" and zero-priced options', () => {
    expect(
      read(`
TEA SHOP
No  : SB0000000000000
Date  : 08-09-2026 12:31
Purpose  : TAKEAWAY
Banana Latte
@38.000  38.000
NORMAL ICE
1x @0
LESS SUGAR
1x @0  0
1 item
rand Total : B0
EDC BCA :  38.000
`),
    ).toEqual([['Banana Latte', '38000', 'NORMAL ICE, LESS SUGAR']]);
  });

  it('regression: bakery with item codes, "Rp" price rows and a discount under each item', () => {
    expect(
      read(`
Bakery
Machine:  A07
Thate:  14 NOy 26 21:0Ü:09
in23-Chocochip & Walnut
Rp 40.000  Rp 40.000
Discount item3I%
-Rp 12.000  -Rp i2.000
2015-Sapporo Chizu Toast
Rp 55.000  Rp 55.D00
hiscount itea30%
-Rp l6.500  -Rp 16.500
1001-Choco Bun
Rp 33.000  Rp 33.000
Biscount item30%
-Rp 9.900  -Rp ?.900
Total Item:  3
Tntal.  Rp 89.600
`),
    ).toEqual([
      ['Chocochip & Walnut', '28000', '40.000 - 12.000 Discount item3I%'],
      ['Sapporo Chizu Toast', '38500', '55.000 - 16.500 hiscount itea30%'],
      ['Choco Bun', '23100', '33.000 - 9.900 Biscount item30%'],
    ]);
  });

  it('regression: names wrapped over two rows with the price on the second', () => {
    expect(
      read(`
coffee
Order Date:Apr 03 2026.11:57 AM
DI
1  Creamy Aren Latte, Ice, Large,
Kenangan Blend, Less Sugar  31,000
Normal Ice
1  Tiramisu Mocha Latte, Ice, Lar
ge, Kenangan Blend, Milk, Less  32,000
Sugar
`),
    ).toEqual([
      ['Creamy Aren Latte', '31000', 'Ice, Large, Kenangan Blend, Less Sugar'],
      ['Tiramisu Mocha Latte', '32000', 'Ice, Lar, ge, Kenangan Blend, Milk, Less'],
    ]);
  });

  it('regression: header dates, branch codes and order numbers are never items', () => {
    expect(
      read(`
Coffee
Branch
29/07/2026 15:09
Order No : PSwBL9u
Receipt No : R14Qto0
1 Palm Sugar Latte  35.000
1 Gula - Normal Sugar  +0
1 Seduh - Ice  + 0
Subtotal (Rp)  35.000
PB1 10% (Rp)  3.500
Total (Rp)  38.500
`),
    ).toEqual([['Palm Sugar Latte', '35000', 'Gula - Normal Sugar, Seduh - Ice']]);
    expect(
      read(`
12.08.26-14:23/4.4.2/TXXX-499/XXXXX/02
YCG SALTED BUTTERSC  1 14000  14.000
JoTAL BELANJA :  14,000
TUNAI:  20,000
`),
    ).toEqual([['YCG SALTED BUTTERSC', '14000', '']]);
  });

  it('regression: a price printed above its name goes to the next name, not to a header word', () => {
    expect(
      read(`
TBL: VIP1
STAFF
Pax: 2  OP:XXXX  POS: POS003
POS Title : Cashier 3  12/09/2026 18:09
1,450,000
2 Signature Selection
1,450,,000
SUBTOTAL  1,450,000
`),
    ).toEqual([['Signature Selection', '1450000', '']]);
  });

  it('regression: voucher in parentheses is folded into the item', () => {
    expect(
      read(`
21.08.26-10:33/4.4.2/TXXX-00000/XXXXX/G2
I/OCHA TEH MLATI 350 1 3700  3,700
VOUCHER:  (700)
TOTAL BELANJA :  3,000
`),
    ).toEqual([['I/OCHA TEH MLATI', '3000', '3.700 - 700 VOUCHER']]);
  });
});

describe('extractReceiptItems: one-row layouts', () => {
  it('reads bare prices only on receipts whose total is printed bare', () => {
    expect(read('J.STB PROMO  17500\nY.B.BAT  46000\nTOTAL  91000')).toEqual([
      ['J.STB PROMO', '17500', ''],
      ['Y.B.BAT', '46000', ''],
    ]);
    expect(read('OUTLET 2116\nNASI GORENG  25,000\nTOTAL  25,000')).toEqual([
      ['NASI GORENG', '25000', ''],
    ]);
  });

  it('drops zero cents and skips category subtotals', () => {
    expect(read('Chicken Maryland  47619.00\nCafe Latte  30303.00\nSubtotal  77922.00')).toEqual([
      ['Chicken Maryland', '47619', ''],
      ['Cafe Latte', '30303', ''],
    ]);
    expect(
      read(
        '1 BLACKCURRANT  32,000\n1 SPRITE  32,000\n** BEVERAGE  64,000\n1 GRILLED CALAMARI  85,000\nSUBTTL  149,000',
      ),
    ).toEqual([
      ['BLACKCURRANT', '32000', ''],
      ['SPRITE', '32000', ''],
      ['GRILLED CALAMARI', '85000', ''],
    ]);
  });

  it('treats "-Tidak Pedas" and "=*LARGE==" rows as options, and "ITEMS:1" as the end', () => {
    expect(
      read('1  BBQ Chicken  41,000\n-Tidak Pedas\n41,000\nITEMS:1  41,000\nPay Cash 50,000'),
    ).toEqual([['BBQ Chicken', '41000', 'Tidak Pedas']]);
    expect(read('1  SAPO TH SEAFOOD  172,000\n=*LARGE==\nSUBTOTAL  172,000')).toEqual([
      ['SAPO TH SEAFOOD', '172000', 'LARGE'],
    ]);
  });
});
