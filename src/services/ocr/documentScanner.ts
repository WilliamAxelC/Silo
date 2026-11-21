import { Alert, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
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

export interface CameraFallbackOptions {
  onImportFromGallery?: () => void | Promise<void>;
  quality?: number;
}

export interface CaptureReceiptOptions extends CameraFallbackOptions {
  maxReceipts?: number;
}

export type CaptureReceiptResult =
  | { status: 'captured'; uris: string[]; source: 'scanner' | 'camera' }
  | { status: 'cancelled' }
  | { status: 'permission-denied' }
  | { status: 'unavailable'; error?: unknown };

/**
 * Shows a consistent camera-permission denial dialog with Open settings and optional Import from gallery actions.
 */
export function showCameraPermissionDeniedAlert(onImportFromGallery?: () => void | Promise<void>) {
  const buttons: Array<{ text: string; style?: 'cancel' | 'default' | 'destructive'; onPress?: () => void }> = [
    { text: 'Cancel', style: 'cancel' },
  ];
  if (onImportFromGallery) {
    buttons.push({
      text: 'Import from gallery',
      onPress: () => {
        void onImportFromGallery();
      },
    });
  }
  buttons.push({
    text: 'Open settings',
    onPress: () => {
      void Linking.openSettings();
    },
  });

  Alert.alert(
    'Camera Permission Required',
    'Camera access is required to take photos of receipts.',
    buttons
  );
}

/**
 * Requests camera permission and launches the system camera, surfacing actionable dialogs
 * (Open settings + Import from gallery) if permission is denied or camera is unavailable.
 */
export async function capturePhotoWithCamera(options: CameraFallbackOptions = {}): Promise<CaptureReceiptResult> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      showCameraPermissionDeniedAlert(options.onImportFromGallery);
      return { status: 'permission-denied' };
    }

    const result = await ImagePicker.launchCameraAsync({ quality: options.quality ?? 0.8 });
    if (result.canceled || !result.assets?.[0]?.uri) {
      return { status: 'cancelled' };
    }
    return { status: 'captured', uris: [result.assets[0].uri], source: 'camera' };
  } catch (error) {
    const buttons: Array<{ text: string; style?: 'cancel' | 'default' | 'destructive'; onPress?: () => void }> = [
      { text: 'Cancel', style: 'cancel' },
    ];
    if (options.onImportFromGallery) {
      buttons.push({
        text: 'Import from gallery',
        onPress: () => {
          void options.onImportFromGallery?.();
        },
      });
    }
    Alert.alert(
      'Scanner unavailable',
      'The document scanner and camera could not be opened on this device. Import photos from your gallery instead.',
      buttons
    );
    return { status: 'unavailable', error };
  }
}

/**
 * Unified receipt scan flow shared by AddTransactionScreen and ReceiptInboxScreen:
 * 1. Tries the native document scanner (multi-page crop & deskew).
 * 2. When unavailable (e.g. missing Google Play services), falls back to the standard camera.
 * 3. Offers "Open settings" and "Import from gallery" on permission denial or camera failure.
 */
export async function captureReceiptWithFallback(options: CaptureReceiptOptions = {}): Promise<CaptureReceiptResult> {
  try {
    const scanned = await scanReceiptDocuments(options.maxReceipts);
    if (scanned.length === 0) {
      return { status: 'cancelled' };
    }
    return { status: 'captured', uris: scanned, source: 'scanner' };
  } catch (scannerError) {
    console.warn('Document scanner unavailable, falling back to camera:', scannerError);
    return capturePhotoWithCamera(options);
  }
}
