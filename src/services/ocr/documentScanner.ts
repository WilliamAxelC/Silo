import DocumentScanner, { ResponseType, ScanDocumentResponseStatus } from 'react-native-document-scanner-plugin';

/**
 * Opens the system document scanner (Google ML Kit Document Scanner on Android, VisionKit on iOS):
 * edge detection, perspective correction and cleanup, several receipts per session.
 * Resolves [] when the user cancels; throws when the scanner is unavailable (e.g. no Google Play services),
 * so callers can fall back to the plain camera.
 */
export async function scanReceiptDocuments(maxReceipts = 20): Promise<string[]> {
  const response = await DocumentScanner.scanDocument({
    croppedImageQuality: 90,
    maxNumDocuments: maxReceipts,
    responseType: ResponseType.ImageFilePath,
  });
  if (response.status === ScanDocumentResponseStatus.Cancel) return [];
  return (response.scannedImages ?? []).map((path) => (path.includes('://') ? path : `file://${path}`));
}
