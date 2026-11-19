const { Platform } = require('react-native');
Platform.OS = 'android';

// Mock react-native-device-info
jest.mock('react-native-device-info', () => require('react-native-device-info/jest/react-native-device-info-mock'));

// Mock expo-sqlite
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn(() => null),
    runSync: jest.fn(() => ({ lastInsertRowId: 1, changes: 1 })),
    withTransactionSync: jest.fn((cb) => cb()),
  })),
}));

// Mock expo-file-system
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///mock/data/user/0/com.LCSdev.silo/files/',
  cacheDirectory: 'file:///mock/data/user/0/com.LCSdev.silo/cache/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  makeDirectoryAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  copyAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  readAsStringAsync: jest.fn(async () => '{}'),
  writeAsStringAsync: jest.fn(async () => {}),
}));

// Mock @react-native-ml-kit/text-recognition
jest.mock('@react-native-ml-kit/text-recognition', () => ({
  default: {
    recognize: jest.fn(async () => ({ text: 'TOTAL 50000\nCASH 50000' })),
  },
}));

// Mock llama.rn
jest.mock('llama.rn', () => ({
  initLlama: jest.fn(async () => ({
    completion: jest.fn(async () => ({ text: 'OK' })),
    stopCompletion: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
  })),
}));

// Mock @expo/vector-icons
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  MaterialIcons: 'MaterialIcons',
  FontAwesome: 'FontAwesome',
  Feather: 'Feather',
}));

// Mock expo-secure-store
const mockSecureStoreMap = new Map();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key) => (mockSecureStoreMap.has(key) ? mockSecureStoreMap.get(key) : null)),
  setItemAsync: jest.fn(async (key, value) => {
    mockSecureStoreMap.set(key, String(value));
  }),
  deleteItemAsync: jest.fn(async (key) => {
    mockSecureStoreMap.delete(key);
  }),
  isAvailableAsync: jest.fn(async () => true),
}));

// Mock expo-image-manipulator
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: {
    JPEG: 'jpeg',
    PNG: 'png',
    WEBP: 'webp',
  },
  manipulateAsync: jest.fn(async (uri, actions = [], _saveOptions = {}) => ({
    uri: uri.includes('resized') ? uri : `${uri}-resized.jpg`,
    width: 768,
    height: 768,
  })),
}));

const { Image } = require('react-native');
if (Image) {
  Image.getSize = jest.fn((_uri, success) => success(1024, 768));
}




jest.mock('react-native-document-scanner-plugin', () => ({
  __esModule: true,
  default: { scanDocument: jest.fn(() => Promise.resolve({ status: 'cancel', scannedImages: [] })) },
  ResponseType: { Base64: 'base64', ImageFilePath: 'imageFilePath' },
  ScanDocumentResponseStatus: { Success: 'success', Cancel: 'cancel' },
}));

jest.mock('expo-local-authentication', () => ({
  authenticateAsync: jest.fn(() => Promise.resolve({ success: true })),
  getEnrolledLevelAsync: jest.fn(() => Promise.resolve(2)),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
}));
