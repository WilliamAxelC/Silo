import Constants from 'expo-constants';
import { Alert } from 'react-native';
import { IOcrEngine } from './types';
import { PaddleOcrEngine } from './PaddleOcrEngine';
import { ExternalOcrEngine } from './ExternalOcrEngine';
import { MlKitEngine } from './MlKitEngine';
import { OcrEngineId } from '../../features/transactions/types';

// Auto-detects: true in Custom Dev Clients, false in Expo Go
export const IS_NATIVE_OCR_SUPPORTED = Constants.appOwnership !== 'expo'; 

// Manual override: switch to 'false' when you build your native client
export const FORCE_DISABLE_OCR = false; 

export const scanReceiptNative = async (imageUri: string): Promise<string | null> => {
  if (FORCE_DISABLE_OCR || !IS_NATIVE_OCR_SUPPORTED) {
    Alert.alert(
      "OCR Disabled", 
      "Native OCR is currently disabled to maintain Expo Go compatibility."
    );
    return null;
  }

  try {
    const TextRecognition = require('@react-native-ml-kit/text-recognition').default;
    const result = await TextRecognition.recognize(imageUri);
    return result.text;
  } catch (error: any) {
    console.error("Native OCR Error:", error);
    Alert.alert("OCR Error", "Ensure you are running a custom dev client, not Expo Go.");
    return null;
  }
};

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
