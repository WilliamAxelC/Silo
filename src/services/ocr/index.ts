import { IOcrEngine } from './types';
import { MlKitEngine, IS_NATIVE_OCR_SUPPORTED, FORCE_DISABLE_OCR, scanReceiptNative } from './MlKitEngine';

export { IS_NATIVE_OCR_SUPPORTED, FORCE_DISABLE_OCR, scanReceiptNative };

// ML Kit only: PaddleOCR (ppu-paddle-ocr + onnxruntime + Skia) added 50 MB to the arm64 APK and scored
// no better on the receipt benchmark (bench/results/REPORT.md, "OCR engines").
export const getOcrEngine = (): IOcrEngine => new MlKitEngine();
