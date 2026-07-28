import { Alert } from 'react-native';
import { IOcrEngine, OcrResult } from './types';

export class ExternalOcrEngine implements IOcrEngine {
  async processImage(imageUri: string): Promise<OcrResult> {
    Alert.alert("External OCR", "External OCR not implemented yet. Fallback to ML Kit.");
    return { rawText: '', extractedTotal: null, extractedMerchant: null, success: false, error: 'Not implemented' };
  }
}
