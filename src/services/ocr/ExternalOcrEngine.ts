import { IOcrEngine, OcrResult } from './types';
import { MlKitEngine } from './MlKitEngine';

export class ExternalOcrEngine implements IOcrEngine {
  private fallbackEngine = new MlKitEngine();

  async processImage(imageUri: string): Promise<OcrResult> {
    console.warn('External OCR not configured, falling back to on-device ML Kit OCR.');
    return this.fallbackEngine.processImage(imageUri);
  }
}

