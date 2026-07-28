import { scanReceiptNative } from './index';
import { IOcrEngine, OcrResult } from './types';

export class MlKitEngine implements IOcrEngine {
  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const rawText = await scanReceiptNative(imageUri);
      
      if (!rawText) {
        return { rawText: '', extractedTotal: null, extractedMerchant: null, success: false, error: 'Empty text returned' };
      }

      // MVP Regex: Looks for Rp or simple numbers to guess the total. 
      // This will need refinement in Alpha.
      const totalMatch = rawText.match(/(?:Rp|IDR|USD|\$)?\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/i);
      const extractedTotal = totalMatch ? parseFloat(totalMatch[1].replace(/[.,]/g, '')) : null;

      return {
        rawText,
        extractedTotal: isNaN(extractedTotal as number) ? null : extractedTotal,
        extractedMerchant: null, // Harder to regex, leave for later
        success: true,
      };
    } catch (error: any) {
      return { rawText: '', extractedTotal: null, extractedMerchant: null, success: false, error: error?.message || 'Unknown OCR Error' };
    }
  }
}

export const defaultOcrEngine = new MlKitEngine();