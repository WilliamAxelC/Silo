const mockProcessImage = jest.fn();
const mockNormalize = jest.fn();

jest.mock('../../ocr/index', () => ({
  getOcrEngine: jest.fn(() => ({ processImage: mockProcessImage })),
}));
jest.mock('../../ocr/normalizeImage', () => ({
  normalizeReceiptImage: (uri: string) => mockNormalize(uri),
}));
const mockRotate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (uri: string, actions: Array<{ rotate?: number }>) => mockRotate(uri, actions),
  SaveFormat: { JPEG: 'jpeg' },
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
    mockRotate.mockReset();
    mockRotate.mockImplementation(async (uri: string, actions: Array<{ rotate?: number }>) => ({
      uri: `${uri}#rot${actions[0]?.rotate}`,
    }));
  });

  const goodRead = read(['INDOMIE 3.500', 'AQUA 4.000', 'TOTAL 7.500'], 7500);

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
    mockProcessImage.mockResolvedValueOnce(goodRead);

    await recognizeReceiptText('file:///photo.jpg');

    expect(mockProcessImage).toHaveBeenCalledTimes(1);
    expect(mockProcessImage).toHaveBeenCalledWith('file:///photo.jpg');
  });

  it('turns a sideways receipt upright when that reads clearly better, and says how far it turned', async () => {
    mockNormalize.mockResolvedValue(null);
    mockProcessImage.mockImplementation(async (uri: string) =>
      uri.endsWith('#rot270') ? goodRead : read(['l1', 'i1I', 'TO'], null),
    );
    const result = await recognizeReceiptText('file:///sideways.jpg');
    expect(result.rotation).toBe(270);
    expect(result.uprightReadUri).toBe('file:///sideways.jpg#rot270');
    expect(result.extractedTotal).toBe(7500);
    expect(mockRotate.mock.calls.map((c) => c[1][0].rotate)).toEqual([90, 270]);
  });

  it('leaves upright receipts alone and keeps the original when no turn reads better', async () => {
    mockNormalize.mockResolvedValue(null);
    mockProcessImage.mockResolvedValueOnce(goodRead);
    expect((await recognizeReceiptText('file:///upright.jpg')).rotation).toBe(0);
    expect(mockRotate).not.toHaveBeenCalled();

    mockProcessImage.mockReset();
    mockProcessImage.mockResolvedValue(read(['blurry'], null));
    const blurry = await recognizeReceiptText('file:///blurry.jpg');
    expect(blurry.rotation).toBe(0);
    expect(mockRotate).toHaveBeenCalledTimes(3);
  });
});
