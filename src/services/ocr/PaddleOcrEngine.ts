import { IOcrEngine, OcrResult } from './types';
import { buildOcrResultFromLines, MlKitEngine } from './MlKitEngine';
import { OcrLine } from './receiptText';

interface PaddleLineItem {
  text?: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function extractLinesFromPaddleResult(result: { text?: string; lines?: unknown }): OcrLine[] {
  const lines: OcrLine[] = [];

  if (Array.isArray(result.lines)) {
    const flatEntries: unknown[] = [];
    for (const entry of result.lines) {
      if (Array.isArray(entry)) {
        flatEntries.push(...entry);
      } else {
        flatEntries.push(entry);
      }
    }

    for (const entry of flatEntries) {
      const item = entry as PaddleLineItem | null | undefined;
      if (!item?.text) continue;
      lines.push({
        text: item.text,
        frame: item.box
          ? {
              left: item.box.x,
              top: item.box.y,
              width: item.box.width,
              height: item.box.height,
            }
          : undefined,
      });
    }
  }

  if (lines.length === 0 && result.text) {
    for (const text of result.text.split('\n')) {
      if (text.trim()) {
        lines.push({ text });
      }
    }
  }

  return lines;
}

export class PaddleOcrEngine implements IOcrEngine {
  private fallbackEngine = new MlKitEngine();

  async processImage(imageUri: string): Promise<OcrResult> {
    try {
      const { PaddleOCR } = require('ppu-paddle-ocr/mobile');
      const ocr = new PaddleOCR();
      await ocr.init();
      const result = await ocr.recognize(imageUri);
      if (result && result.text) {
        const lines = extractLinesFromPaddleResult(result);
        return buildOcrResultFromLines(lines, result.text);
      }
      return this.fallbackEngine.processImage(imageUri);
    } catch (e: any) {
      console.warn('PaddleOCR native module unavailable, falling back to ML Kit:', e?.message || e);
      return this.fallbackEngine.processImage(imageUri);
    }
  }
}
