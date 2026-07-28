import { Alert } from 'react-native';
import { IOcrEngine, OcrResult } from './types';

export class PaddleOcrEngine implements IOcrEngine {
  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const { PaddleOCR } = require('ppu-paddle-ocr/mobile');
      const ocr = new PaddleOCR();
      await ocr.init(); // Assuming default init handles model downloading/loading
      const result = await ocr.recognize(imageUri);
      return { rawText: result.text || '', extractedTotal: null, extractedMerchant: null, success: true };
    } catch (e: any) {
      console.error(e);
      Alert.alert("PaddleOCR Error", e.message || "Failed to run PaddleOCR on-device.");
      return { rawText: '', extractedTotal: null, extractedMerchant: null, success: false, error: e.message || 'Unknown Error' };
    }
  }
}
