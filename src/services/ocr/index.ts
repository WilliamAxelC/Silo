import { IOcrEngine } from './types';
import { PaddleOcrEngine } from './PaddleOcrEngine';
import { ExternalOcrEngine } from './ExternalOcrEngine';
import { MlKitEngine, IS_NATIVE_OCR_SUPPORTED, FORCE_DISABLE_OCR, scanReceiptNative } from './MlKitEngine';
import { OcrEngineId } from '../../features/transactions/types';

export { IS_NATIVE_OCR_SUPPORTED, FORCE_DISABLE_OCR, scanReceiptNative };


export const getOcrEngine = (engineId: OcrEngineId): IOcrEngine => {
  switch (engineId) {
    case 'paddleocr':
      return new PaddleOcrEngine();
    case 'external':
      return new ExternalOcrEngine();
    case 'mlkit':
    default:
      return new MlKitEngine();
  }
};
