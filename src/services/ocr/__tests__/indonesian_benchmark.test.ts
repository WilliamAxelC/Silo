import { INDONESIAN_RECEIPT_DATASET } from '../../../../scripts/benchmark_receipt_dataset';
import { parseReceiptTextHeuristic } from '../MlKitEngine';

describe('Indonesian Realistic Receipt OCR & Extraction Benchmark', () => {
  INDONESIAN_RECEIPT_DATASET.forEach((sample) => {
    it(`correctly extracts ${sample.id} (${sample.scenario})`, () => {
      const parsed = parseReceiptTextHeuristic(sample.rawOcrText);

      // Verify total extraction
      expect(parsed.extractedTotal).toBe(sample.totalAmount);

      // Verify merchant is found
      expect(parsed.extractedMerchant).toBeTruthy();

      // Verify date is found
      expect(parsed.extractedDate).toBe(sample.date);
    });
  });
});
