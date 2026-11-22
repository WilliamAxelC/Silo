const mockProcessImage = jest.fn();
const mockNormalize = jest.fn();

jest.mock('../../ocr/index', () => ({
  getOcrEngine: jest.fn(() => ({ processImage: mockProcessImage })),
}));
jest.mock('../../ocr/normalizeImage', () => ({
  normalizeReceiptImage: (uri: string) => mockNormalize(uri),
}));

import { recognizeReceiptText } from '../agent';

const read = (rows: string[], extractedTotal: number | null) => ({
  success: true,
  rawText: rows.join('\n'),
  rows,
  extractedTotal,
  extractedMerchant: null,
});

describe('recognizeReceiptText (black-and-white normalization for gallery photos)', () => {
  beforeEach(() => {
    mockProcessImage.mockReset();
    mockNormalize.mockReset();
  });

  it('uses the normalized scan when it yields a total, without a second OCR pass', async () => {
    mockNormalize.mockResolvedValue('file:///cache/receipt-normalized.jpg');
    mockProcessImage.mockResolvedValueOnce(read(['KOPI 18.000', 'TOTAL 18.000'], 18000));

    const result = await recognizeReceiptText('content://gallery/1');

    expect(mockProcessImage).toHaveBeenCalledTimes(1);
    expect(mockProcessImage).toHaveBeenCalledWith('file:///cache/receipt-normalized.jpg');
    expect(result.extractedTotal).toBe(18000);
  });

  it('falls back to the original photo when the scan reads worse', async () => {
    mockNormalize.mockResolvedValue('file:///cache/receipt-normalized.jpg');
    mockProcessImage
      .mockResolvedValueOnce(read(['KOPI'], null))
      .mockResolvedValueOnce(read(['KOPI 18.000', 'TOTAL 18.000'], 18000));

    const result = await recognizeReceiptText('content://gallery/1');

    expect(mockProcessImage).toHaveBeenNthCalledWith(2, 'content://gallery/1');
    expect(result.extractedTotal).toBe(18000);
  });

  it('reads the original directly when the native normalizer is unavailable', async () => {
    mockNormalize.mockResolvedValue(null);
    mockProcessImage.mockResolvedValueOnce(read(['TOTAL 9.000'], 9000));

    await recognizeReceiptText('file:///photo.jpg');

    expect(mockProcessImage).toHaveBeenCalledTimes(1);
    expect(mockProcessImage).toHaveBeenCalledWith('file:///photo.jpg');
  });
});
