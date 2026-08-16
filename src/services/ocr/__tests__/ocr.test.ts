import { parseReceiptTextHeuristic, MlKitEngine } from '../MlKitEngine';
import { PaddleOcrEngine } from '../PaddleOcrEngine';
import { ExternalOcrEngine } from '../ExternalOcrEngine';
import { getOcrEngine, scanReceiptNative } from '../index';

describe('OCR Service & Receipt Heuristics', () => {
  describe('parseReceiptTextHeuristic', () => {
    it('correctly extracts total, merchant, and date from an Indomaret minimarket receipt', () => {
      const rawText = `
INDOMARET POINT
JL. SUDIRMAN NO. 45 JAKARTA
NPWP: 01.234.567.8-901.000
14-06-2024 10:15:30
1 ULTRA MILK 1000ML 21.000
1 OREO COOKIE 9.500
TOTAL BELANJA 30.500
TUNAI 50.000
KEMBALIAN 19.500
TERIMA KASIH TELAH BERBELANJA
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('INDOMARET POINT');
      expect(result.extractedTotal).toBe(30500);
      expect(result.extractedDate).toBe('2024-06-14');
    });

    it('correctly extracts total, merchant, and date from an Alfamart minimarket receipt', () => {
      const rawText = `
ALFAMART MERDEKA
KASIR: SITI
TANGGAL: 2024-03-22 08:30
INDOMIE GORENG 3.500
POCARI SWEAT 500ML 8.000
TOTAL SALES 11.500
CASH 20.000
CHANGE 8.500
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('ALFAMART MERDEKA');
      expect(result.extractedTotal).toBe(11500);
      expect(result.extractedDate).toBe('2024-03-22');
    });

    it('correctly extracts total from a Cafe receipt with discounts, service charge, and PB1 tax', () => {
      const rawText = `
KOPI KENANGAN
MALL KELAPA GADING
ORDER #1042
2 ICE BLACK COFFEE 82,000
1 AVOCADO COFFEE 61,000
1 CHICKEN KATSU 51,000
SUB_TOTAL 194,000
DISCOUNT 19,400
SERVICE CHARGE 9,700
PB1 (10%) 17,460
TOTAL 174,600
CASH 200,000
CHANGE 25,400
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('KOPI KENANGAN');
      expect(result.extractedTotal).toBe(174600);
    });

    it('correctly extracts total and date from a Starbucks receipt with DD/MM/YYYY date format', () => {
      const rawText = `
STARBUCKS RESERVE
TABLE 14
05/11/2024 16:45
1 CAFFE LATTE GRANDE 55.000
1 CINNAMON ROLL 38.000
SUBTOTAL 93.000
TAX 9.300
GRAND TOTAL 102.300
QRIS 102.300
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('STARBUCKS RESERVE');
      expect(result.extractedTotal).toBe(102300);
      expect(result.extractedDate).toBe('2024-11-05');
    });

    it('correctly extracts AMOUNT DUE and 2-digit year dates from a Restaurant receipt', () => {
      const rawText = `
BAKMI GM PLAZA SENAYAN
TELP: 021-5725555
15/09/24 19:20
BAKMI SPESIAL GM 42000
PANGSIT GORENG 35000
ES TEH MANIS 12000
NET SALES 89000
PB-1 8900
AMOUNT DUE 97900
DEBIT BCA 97900
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('BAKMI GM PLAZA SENAYAN');
      expect(result.extractedTotal).toBe(97900);
      expect(result.extractedDate).toBe('2024-09-15');
    });

    it('handles TAGIHAN keyword used in modern Indonesian POS systems', () => {
      const rawText = `
WARUNG KOPI LOKAL
1 KOPI SUSU GULA AREN 18000
TOTAL TAGIHAN 18000
TUNAI 20000
KEMBALI 2000
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('WARUNG KOPI LOKAL');
      expect(result.extractedTotal).toBe(18000);
    });

    it('correctly falls back to Tunai/Cash payment when explicit TOTAL line is missing', () => {
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

    it('correctly falls back to QRIS/Debit payment when explicit TOTAL line is missing', () => {
      const rawText = `
BAKSO SOLO SAMRAT
1 BAKSO KELAPA 65000
1 ES JERUK 15000
QRIS 80000
STATUS: BERHASIL
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('BAKSO SOLO SAMRAT');
      expect(result.extractedTotal).toBe(80000);
    });

    it('ignores header noise like addresses, telephone numbers, and receipt codes when picking merchant', () => {
      const rawText = `
JL. KEMANG RAYA NO. 10
TELP. 08123456789
RECEIPT #99281
THE BUTCHERS BURGER
1 SMOKEY BACON BURGER 85000
TOTAL 85000
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedMerchant).toBe('THE BUTCHERS BURGER');
      expect(result.extractedTotal).toBe(85000);
    });

    it('handles unformatted plain integer amounts without dots or commas', () => {
      const rawText = `
TOKO ELEKTRONIK
KABEL TYPE C 50000
CHARGER ADAPTER 120000
TOTAL 170000
CASH 170000
      `.trim();

      const result = parseReceiptTextHeuristic(rawText);
      expect(result.extractedTotal).toBe(170000);
    });

    it('handles empty or whitespace-only receipt text gracefully', () => {
      expect(parseReceiptTextHeuristic('')).toEqual({
        extractedTotal: null,
        extractedMerchant: null,
        extractedDate: null,
        extractedCategory: null,
        extractedLineItems: null,
      });

      expect(parseReceiptTextHeuristic('   \n  \n  ')).toEqual({
        extractedTotal: null,
        extractedMerchant: null,
        extractedDate: null,
        extractedCategory: null,
        extractedLineItems: null,
      });
    });
  });

  describe('MlKitEngine', () => {
    it('processes image and returns parsed OCR result successfully', async () => {
      const engine = new MlKitEngine();
      const result = await engine.processImage('file:///mock/image.jpg');

      expect(result.success).toBe(true);
      expect(result.rawText).toContain('TOTAL 50000');
      expect(result.extractedTotal).toBe(50000);
    });

    it('handles empty text return from scanner gracefully', async () => {
      const TextRecognition = require('@react-native-ml-kit/text-recognition').default;
      TextRecognition.recognize.mockResolvedValueOnce({ text: '' });

      const engine = new MlKitEngine();
      const result = await engine.processImage('file:///mock/empty.jpg');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty text returned');
      expect(result.rawText).toBe('');
    });

    it('handles scanner exceptions gracefully', async () => {
      const TextRecognition = require('@react-native-ml-kit/text-recognition').default;
      TextRecognition.recognize.mockRejectedValueOnce(new Error('Scanner hardware failure'));

      const engine = new MlKitEngine();
      const result = await engine.processImage('file:///mock/error.jpg');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('PaddleOcrEngine & ExternalOcrEngine', () => {
    it('instantiates PaddleOcrEngine and handles errors safely', async () => {
      const engine = new PaddleOcrEngine();
      const result = await engine.processImage('file:///mock/paddle.jpg');
      // In jest environment without native module, it catches error and returns success: false
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('falls back to ML Kit engine for ExternalOcrEngine', async () => {
      const engine = new ExternalOcrEngine();
      const result = await engine.processImage('file:///mock/ext.jpg');

      expect(result.success).toBe(true);
      expect(result.rawText).toBeDefined();
    });
  });

  describe('getOcrEngine factory', () => {
    it('returns appropriate engine according to OcrEngineId', () => {
      expect(getOcrEngine('mlkit')).toBeInstanceOf(MlKitEngine);
      expect(getOcrEngine('paddleocr')).toBeInstanceOf(PaddleOcrEngine);
      expect(getOcrEngine('external')).toBeInstanceOf(ExternalOcrEngine);
      expect(getOcrEngine('unknown' as any)).toBeInstanceOf(MlKitEngine);
    });
  });

  describe('scanReceiptNative', () => {
    it('recognizes text using native text recognition mock', async () => {
      const text = await scanReceiptNative('file:///mock/test.jpg');
      expect(text).toContain('TOTAL 50000');
    });
  });
});
