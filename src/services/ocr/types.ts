// Define the standard output format no matter which OCR engine is used
export interface OcrResult {
  rawText: string;
  rows?: string[];
  extractedTotal: number | null;
  extractedMerchant: string | null;
  extractedDate?: string | null;
  extractedCategory?: string | null;
  extractedLineItems?: string | null;
  success: boolean;
  error?: string;
  /** Clockwise degrees the image needs to read upright, from the text direction (undefined: unknown). */
  uprightRotation?: 0 | 90 | 180 | 270;
}

export interface IOcrEngine {
  processImage(imageUri: string): Promise<OcrResult>;
}