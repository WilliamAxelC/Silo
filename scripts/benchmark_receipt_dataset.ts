import { parseReceiptTextHeuristic } from '../src/services/ocr/MlKitEngine';

export interface GroundTruthReceipt {
  id: string;
  scenario: string;
  merchantName: string;
  totalAmount: number;
  date: string;
  category: string;
  rawOcrText: string;
}

export const INDONESIAN_RECEIPT_DATASET: GroundTruthReceipt[] = [
  {
    id: 'indomaret_standard',
    scenario: 'Indomaret standard retail with member discount and cash change',
    merchantName: 'INDOMARET POINT',
    totalAmount: 42500,
    date: '2026-03-12',
    category: 'Groceries',
    rawOcrText: `INDOMARET POINT
PT INDOMARCO PRISMATAMA
JL. SUDIRMAN NO 45 JAKARTA
NPWP: 01.337.890.1-021.000
KASIR: ANDI / POS 01
12.03.2026 14:22:10
================================
ULTRA MILK COKLAT 1L    21.500
ROTI TAWAR SARI ROTI    16.000
INDOMIE AYAM BAWANG 5X  15.000
--------------------------------
SUBTOTAL                52.500
DISKON PROMO MEMBER    -10.000
TOTAL BAYAR             42.500
TUNAI                  100.000
KEMBALIAN               57.500
================================
TERIMA KASIH SELAMAT BELANJA KEMBALI
LAYANAN KONSUMEN SMS 0816-500-500`,
  },
  {
    id: 'indomaret_multicolumn_ocr',
    scenario: 'Indomaret OCR where MLKit split columns into two separate text blocks',
    merchantName: 'INDOMARET',
    totalAmount: 38000,
    date: '2026-04-05',
    category: 'Groceries',
    rawOcrText: `INDOMARET
JL. KEMANG RAYA NO. 10
05/04/2026 19:30

AQUA 600ML 2X
CHITATO SAPI PANGGANG
TEH BOTOL SOSRO 450ML
SUBTOTAL
DISKON
TOTAL BELANJA
QRIS BCA

7.000
23.000
8.000
38.000
0
38.000
38.000`,
  },
  {
    id: 'alfamart_mixed_discounts',
    scenario: 'Alfamart with PPN tax and GoPay payment',
    merchantName: 'ALFAMART',
    totalAmount: 89600,
    date: '2026-05-18',
    category: 'Groceries',
    rawOcrText: `ALFAMART
PT. SUMBER ALFARIA TRIJAYA TBK
TGL: 18-05-2026 10:15
================================
MINYAK GORENG TROPICAL 2L  38.500
BERAS SETRA RAMOS 5KG      64.000
POTONGAN VOUCHER          -15.000
--------------------------------
DPP: 78.919  PPN 11%: 8.681
GRAND TOTAL                89.600
GOPAY                      89.600
================================
PPN TERMASUK DALAM HARGA JUAL`,
  },
  {
    id: 'mie_gacoan_restaurant',
    scenario: 'Mie Gacoan restaurant with PB1 10% tax and table number',
    merchantName: 'MIE GACOAN TEBET',
    totalAmount: 64900,
    date: '2026-06-20',
    category: 'Food & Dining',
    rawOcrText: `MIE GACOAN TEBET
JL. TEBET RAYA NO 88
ORDER #MG-4029 / MEJA 14
20/06/2026 13:45:00
--------------------------------
2x MIE HOMPIMPA LV 2    24.000
1x DIMSUM UDANG KEJU    11.500
1x UDANG RAMBUTAN       11.500
2x ES GOBAK SODOR       12.000
--------------------------------
SUBTOTAL                59.000
PB1 (10%)                5.900
TOTAL TAGIHAN           64.900
DEBIT BCA               64.900`,
  },
  {
    id: 'kopi_kenangan_cafe',
    scenario: 'Kopi Kenangan cafe with add-on modifiers and rounded total',
    merchantName: 'KOPI KENANGAN',
    totalAmount: 52000,
    date: '2026-07-01',
    category: 'Food & Dining',
    rawOcrText: `KOPI KENANGAN
MALL GRAND INDONESIA LG
01-07-2026 09:12
--------------------------------
1x KOPI KENANGAN MANTAN (L)  24.000
   + LESS SUGAR
   + EXTRA SHOT               6.000
1x MATCHA LATTE (R)          22.000
--------------------------------
ITEMS TOTAL                  52.000
PEMBULATAN                        0
TOTAL                        52.000
SHOPEEPAY                    52.000`,
  },
  {
    id: 'starbucks_faded_thermal',
    scenario: 'Starbucks thermal receipt with service charge & currency symbol Rp',
    merchantName: 'STARBUCKS COFFEE',
    totalAmount: 147400,
    date: '2026-08-02',
    category: 'Food & Dining',
    rawOcrText: `STARBUCKS COFFEE
PLAZA SENAYAN GROUND FLOOR
DATE: 02/08/2026 16:30
--------------------------------
1 GR IC CARAMEL MACCH   Rp 67.000
1 GR IC LATTE           Rp 55.000
1 CROISSANT CHOCOLATE   Rp 25.400
--------------------------------
SUBTOTAL                Rp 147.400
DISCOUNT 0%             Rp       0
AMOUNT DUE              Rp 147.400
CREDIT CARD             Rp 147.400
APPROVAL CODE: 883921`,
  },
  {
    id: 'pertamina_spbu',
    scenario: 'SPBU Pertamina fuel receipt with liters and pump number',
    merchantName: 'SPBU PERTAMINA 31.129.02',
    totalAmount: 250000,
    date: '2026-08-10',
    category: 'Transport',
    rawOcrText: `SPBU PERTAMINA 31.129.02
JL. HR RASUNA SAID KAV 10
PULAU/POMPA: 04
10/08/2026 08:15:30
--------------------------------
PRODUK : PERTAMAX (RON 92)
HARGA/LITER : Rp 12.950
VOLUME (L)  : 19.305 L
--------------------------------
TOTAL HARGA : Rp 250.000
BAYAR (CASH): Rp 300.000
KEMBALIAN   : Rp  50.000
TERIMA KASIH`,
  },
  {
    id: 'padang_sederhana',
    scenario: 'Restoran Padang handwritten-style printed nota with multiple food dishes',
    merchantName: 'RM. SEDERHANA',
    totalAmount: 187000,
    date: '2026-08-14',
    category: 'Food & Dining',
    rawOcrText: `RM. SEDERHANA BINTARO
JL. BINTARO UTAMA SEKTOR 3
TANGGAL: 14-08-2026
--------------------------------
2 NASI PUTIH            24.000
2 RENDANG DAGING        54.000
1 AYAM POP              26.000
1 GULAI CUMI            38.000
2 ES TEH MANIS          20.000
1 SAMBAL IJO + DAUN     10.000
1 KERUPUK KULIT         15.000
--------------------------------
TOTAL BAYAR            187.000
TUNAI                  200.000
KEMBALI                 13.000`,
  },
  {
    id: 'superindo_faded_dots',
    scenario: 'Superindo with missing dots and dot-separated thousand amounts',
    merchantName: 'SUPERINDO',
    totalAmount: 243750,
    date: '2026-08-15',
    category: 'Groceries',
    rawOcrText: `SUPERINDO PANCORAN
PT. SINGA SUPERINDO
15/08/2026 18:22
APEL FUJI 1.25 KG       48.750
AYAM BROILER 1 EKOR     36.500
TELUR AYAM NEGERI 1KG   31.500
BERAS PANDAN WANGI 5KG  75.000
BIMOLI SPESIAL 2L       52.000
--------------------------------
SUB TOTAL              243.750
TOTAL BELANJA          243.750
CASH                   250.000
KEMBALI                  6.250`,
  },
  {
    id: 'apotek_kimia_farma',
    scenario: 'Kimia Farma pharmacy receipt with prescription and non-tax medical items',
    merchantName: 'APOTEK KIMIA FARMA',
    totalAmount: 115000,
    date: '2026-08-16',
    category: 'Bills',
    rawOcrText: `APOTEK KIMIA FARMA 124
JL. FATMAWATI NO 20 JAKARTA
NO RESEP: R-88391
TGL: 16-08-2026 11:30
--------------------------------
PANADOL EXTRA 10 TAB     18.000
AMOXICILLIN 500MG 10     22.000
VITAMIN C IPI 50 TAB     15.000
BIAYA EMBALASE & RACIK   60.000
--------------------------------
TOTAL AKHIR             115.000
QRIS DANA               115.000
SEMOGA LEKAS SEMBUH`,
  },
];

export function runBenchmark(): {
  heuristicResults: Array<{ id: string; success: boolean; expected: number; got: number | null; error?: string }>;
  accuracy: number;
} {
  const heuristicResults = INDONESIAN_RECEIPT_DATASET.map((sample) => {
    const parsed = parseReceiptTextHeuristic(sample.rawOcrText);
    const success = parsed.extractedTotal === sample.totalAmount && Boolean(parsed.extractedMerchant);
    return {
      id: sample.id,
      success,
      expected: sample.totalAmount,
      got: parsed.extractedTotal,
      merchantExpected: sample.merchantName,
      merchantGot: parsed.extractedMerchant,
      error: !success ? `Total mismatch: expected ${sample.totalAmount}, got ${parsed.extractedTotal}` : undefined,
    };
  });

  const passedCount = heuristicResults.filter((r) => r.success).length;
  const accuracy = (passedCount / INDONESIAN_RECEIPT_DATASET.length) * 100;

  return {
    heuristicResults,
    accuracy,
  };
}
