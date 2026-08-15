import { IOcrEngine, OcrResult } from './types';
import { MlKitEngine } from './MlKitEngine';

export class PaddleOcrEngine implements IOcrEngine {
  private fallbackEngine = new MlKitEngine();

  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const { PaddleOCR } = require('ppu-paddle-ocr/mobile');
      const ocr = new PaddleOCR();
      await ocr.init();
      const result = await ocr.recognize(imageUri);
      if (result && result.text) {
        return { rawText: result.text || '', extractedTotal: null, extractedMerchant: null, success: true };
      }
      return this.fallbackEngine.processImage(imageUri);
    } catch (e: any) {
      console.warn('PaddleOCR native module unavailable, falling back to ML Kit:', e?.message || e);
      return this.fallbackEngine.processImage(imageUri);
    }
  }
}

