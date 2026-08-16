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

// Mock ppu-paddle-ocr/mobile
jest.mock('ppu-paddle-ocr/mobile', () => ({
  PaddleOCR: jest.fn().mockImplementation(() => ({
    init: jest.fn(async () => {}),
    recognize: jest.fn(async () => ({ text: 'TOTAL 50000' })),
  })),
}));

// Mock @expo/vector-icons
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  MaterialIcons: 'MaterialIcons',
  FontAwesome: 'FontAwesome',
  Feather: 'Feather',
}));

