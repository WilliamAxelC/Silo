import TextRecognition from '@react-native-ml-kit/text-recognition';
import { IOcrEngine, OcrResult } from './types';

export class MlKitEngine implements IOcrEngine {
  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const result = await TextRecognition.recognize(imageUri);
      const rawText = result.text;
      
      // MVP Regex: Looks for Rp or simple numbers to guess the total. 
      // This will need refinement in Alpha.
      const totalMatch = rawText.match(/(?:Rp|IDR)?\s?(\d{1,3}(?:[.,]\d{3})*)/i);
      const extractedTotal = totalMatch ? parseFloat(totalMatch[1].replace(/[.,]/g, '')) : null;

      return {
        rawText,
        extractedTotal,
        extractedMerchant: null, // Harder to regex, leave for later
        success: true,
      };
    } catch (error: any) {
      return { rawText: '', extractedTotal: null, extractedMerchant: null, success: false, error: error.message };
    }
  }
}