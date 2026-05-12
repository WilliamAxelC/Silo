import Constants from 'expo-constants';
import { Alert } from 'react-native';

// Auto-detects: true in Custom Dev Clients, false in Expo Go
export const IS_NATIVE_OCR_SUPPORTED = Constants.appOwnership !== 'expo'; 

// Manual override: switch to 'false' when you build your native client
export const FORCE_DISABLE_OCR = true; 

export const scanReceiptNative = async (imageUri: string): Promise<string | null> => {
  if (FORCE_DISABLE_OCR || !IS_NATIVE_OCR_SUPPORTED) {
    Alert.alert(
      "OCR Disabled", 
      "Native OCR is currently disabled to maintain Expo Go compatibility."
    );
    return null;
  }

  try {
    // 🛑 DYNAMIC REQUIRE: This prevents the app from crashing on startup in Expo Go.
    // It only attempts to load the native module if the checks above pass.
    const TextRecognition = require('@react-native-ml-kit/text-recognition').default;
    
    const result = await TextRecognition.recognize(imageUri);
    return result.text;
    
  } catch (error: any) {
    console.error("Native OCR Error:", error);
    Alert.alert("OCR Error", "Ensure you are running a custom dev client, not Expo Go.");
    return null;
  }
};