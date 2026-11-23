const mockNative = { normalize: jest.fn(), takeSharedImages: jest.fn() };
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({
    normalize: (...args: unknown[]) => mockNative.normalize(...args),
    takeSharedImages: () => mockNative.takeSharedImages(),
  }),
}));

import { consumeTrustedSharedImage, takeSharedImages } from '../normalizeImage';

// Security review 2026-11-23: silo://add?sharedImageUri=... could point Add Transaction at any file,
// including Silo's own database. Only photos handed out by the native share path may be scanned.
describe('shared image allowlist (regression)', () => {
  it('refuses a URI that did not come from the share sheet', () => {
    expect(consumeTrustedSharedImage('file:///data/user/0/com.LCSdev.silo/files/SQLite/silo.db')).toBe(false);
    expect(consumeTrustedSharedImage(undefined)).toBe(false);
  });

  it('accepts each shared photo exactly once', async () => {
    mockNative.takeSharedImages.mockResolvedValueOnce(['file:///cache/shared-receipt-1-0.jpg', '']);
    expect(await takeSharedImages()).toEqual(['file:///cache/shared-receipt-1-0.jpg']);
    expect(consumeTrustedSharedImage('file:///cache/shared-receipt-1-0.jpg')).toBe(true);
    expect(consumeTrustedSharedImage('file:///cache/shared-receipt-1-0.jpg')).toBe(false);
  });
});
