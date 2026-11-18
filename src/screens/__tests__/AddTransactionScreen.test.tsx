import React from 'react';
import { Alert, Text, TextInput, TouchableOpacity } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { AddTransactionScreen } from '../AddTransactionScreen';
import { analyzeReceiptImage } from '../../services/ai/agent';
import { useTransactionStore } from '../../store/useTransactionStore';

const ReactTestRenderer = require('react-test-renderer');

const mockNavigate = jest.fn();
const mockRouteParams: { transactionId?: number } = {};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    canGoBack: () => false,
    goBack: jest.fn(),
  }),
  useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

jest.mock('../../services/ai/agent', () => ({
  analyzeReceiptImage: jest.fn(),
}));

describe('AddTransactionScreen', () => {
  const mockAddTransaction = jest.fn();
  const mockUpdateTransaction = jest.fn();
  const mockDeleteTransaction = jest.fn();
  const mockAddCategory = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    delete mockRouteParams.transactionId;
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    useTransactionStore.setState({
      transactionsList: [
        {
          id: 99,
          walletId: 1,
          merchantName: 'Existing Cafe',
          totalAmount: -45000,
          type: 'expense',
          category: 'Food & Dining',
          date: Date.now(),
          note: '',
          lineItemsText: '',
          imageUri: 'file:///existing.jpg',
        },
      ],
      categories: [
        { id: 1, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      ],
      isSaving: false,
      addTransaction: mockAddTransaction,
      updateTransaction: mockUpdateTransaction,
      deleteTransaction: mockDeleteTransaction,
      addCategory: mockAddCategory,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects zero and non-numeric amounts with an inline error message', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const titleInput = renderer.root.findByProps({ placeholder: 'Merchant or title' });
    const amountInput = renderer.root.findByProps({ placeholder: '0' });

    ReactTestRenderer.act(() => {
      titleInput.props.onChangeText('Coffee');
      amountInput.props.onChangeText('0');
    });

    const textsAfterZero = renderer.root.findAllByType(Text);
    expect(textsAfterZero.some((t: any) => t.props.children === 'Amount must be greater than 0')).toBe(true);

    const saveBtn = renderer.root.findByProps({ accessibilityLabel: 'Save transaction' });
    await ReactTestRenderer.act(async () => {
      await saveBtn.props.onPress();
    });
    expect(mockAddTransaction).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => {
      amountInput.props.onChangeText('abc');
    });
    expect(
      renderer.root.findAllByType(Text).some((t: any) => t.props.children === 'Amount must be greater than 0')
    ).toBe(true);
  });

  it('alerts and returns when camera permission is denied, and uses mediaTypes: ["images"] for gallery', async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: true });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    // Camera denied
    const addPhotoBtn = renderer.root.findByProps({ accessibilityLabel: 'Add receipt photo' });
    ReactTestRenderer.act(() => {
      addPhotoBtn.props.onPress();
    });

    const cameraBtn = renderer.root.findByProps({ accessibilityLabel: 'Take photo with camera' });
    await ReactTestRenderer.act(async () => {
      await cameraBtn.props.onPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Camera Permission Required',
      'Camera access is required to take photos of receipts.'
    );
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();

    // Gallery uses mediaTypes: ['images']
    ReactTestRenderer.act(() => {
      addPhotoBtn.props.onPress();
    });
    const galleryBtn = renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' });
    await ReactTestRenderer.act(async () => {
      await galleryBtn.props.onPress();
    });
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 0.8,
    });
  });

  it('defers scanned new category creation until handleSave and renders collapsible Raw OCR text', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///receipt.jpg' }],
    });

    const statusHistory: string[] = [];
    (analyzeReceiptImage as jest.Mock).mockImplementation(async (_uri, _b64, onStatus) => {
      onStatus('Running MLKit OCR on image...');
      statusHistory.push('ocr');
      onStatus('Structuring receipt with AI...');
      statusHistory.push('ai');
      return {
        merchantName: 'Kopi Kenangan',
        totalAmount: 45000,
        category: 'Specialty Coffee',
        rawText: 'KOPI KENANGAN\nTOTAL 45.000',
      };
    });
    mockAddCategory.mockResolvedValue('Specialty Coffee');
    mockAddTransaction.mockResolvedValue(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const scanBtn = renderer.root.findByProps({ accessibilityLabel: 'Scan receipt' });
    ReactTestRenderer.act(() => {
      scanBtn.props.onPress();
    });
    const galleryBtn = renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' });
    await ReactTestRenderer.act(async () => {
      await galleryBtn.props.onPress();
    });

    // Never calls addCategory during scan
    expect(mockAddCategory).not.toHaveBeenCalled();

    // Remove-photo button is a sibling overlay, not nested inside another TouchableOpacity
    const removePhotoBtn = renderer.root.findByProps({ accessibilityLabel: 'Remove photo' });
    let parent = removePhotoBtn.parent;
    while (parent) {
      expect(parent.type).not.toBe(TouchableOpacity);
      parent = parent.parent;
    }

    // Raw OCR text collapsed by default, selectable when expanded
    expect(renderer.root.findAllByType(Text).some((t: any) => t.props.children === 'KOPI KENANGAN\nTOTAL 45.000')).toBe(
      false
    );
    const expandRawBtn = renderer.root.findByProps({ accessibilityLabel: 'Expand raw OCR text' });
    ReactTestRenderer.act(() => {
      expandRawBtn.props.onPress();
    });
    const rawTextNode = renderer.root
      .findAllByType(Text)
      .find((t: any) => t.props.children === 'KOPI KENANGAN\nTOTAL 45.000');
    expect(rawTextNode).toBeDefined();
    expect(rawTextNode.props.selectable).toBe(true);

    // Creates scanned category on Save
    const saveBtn = renderer.root.findByProps({ accessibilityLabel: 'Save transaction' });
    await ReactTestRenderer.act(async () => {
      await saveBtn.props.onPress();
    });

    expect(mockAddCategory).toHaveBeenCalledWith('Specialty Coffee', 'expense');
    expect(mockAddTransaction).toHaveBeenCalledTimes(1);
  });

  it('shows Alert on add/update/delete failures', async () => {
    mockAddTransaction.mockRejectedValueOnce(new Error('DB write failed'));

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const titleInput = renderer.root.findByProps({ placeholder: 'Merchant or title' });
    const amountInput = renderer.root.findByProps({ placeholder: '0' });
    ReactTestRenderer.act(() => {
      titleInput.props.onChangeText('Lunch');
      amountInput.props.onChangeText('45000');
    });

    const saveBtn = renderer.root.findByProps({ accessibilityLabel: 'Save transaction' });
    await ReactTestRenderer.act(async () => {
      await saveBtn.props.onPress();
    });
    expect(Alert.alert).toHaveBeenCalledWith('Save Failed', 'DB write failed');

    // Edit mode delete failure
    mockRouteParams.transactionId = 99;
    mockDeleteTransaction.mockRejectedValueOnce(new Error('Delete boom'));
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const deleteBtn = renderer.root.findByProps({ accessibilityLabel: 'Delete transaction' });
    ReactTestRenderer.act(() => {
      deleteBtn.props.onPress();
    });

    const deleteAlertCall = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Delete Transaction');
    expect(deleteAlertCall).toBeDefined();
    const confirmButton = deleteAlertCall[2].find((b: any) => b.text === 'Delete');
    await ReactTestRenderer.act(async () => {
      await confirmButton.onPress();
    });
    expect(Alert.alert).toHaveBeenCalledWith('Delete Failed', 'Delete boom');
  });

  it('shows warning hint when scan result has totalNeedsReview and clears on amount edit', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///receipt.jpg' }],
    });

    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({
      merchantName: 'Warung Vision',
      totalAmount: 85000,
      totalNeedsReview: true,
      rawText: 'WARUNG VISION\nTOTAL BAYAR 85.000',
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const scanBtn = renderer.root.findByProps({ accessibilityLabel: 'Scan receipt' });
    ReactTestRenderer.act(() => {
      scanBtn.props.onPress();
    });
    const galleryBtn = renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' });
    await ReactTestRenderer.act(async () => {
      await galleryBtn.props.onPress();
    });

    const warningHint = renderer.root
      .findAllByType(Text)
      .find((t: any) => t.props.children === "Double-check the total — it wasn't found in the scanned text.");
    expect(warningHint).toBeDefined();
    expect(warningHint.props.accessibilityRole).toBe('alert');

    // Clears when user edits the amount
    const amountInput = renderer.root.findByProps({ placeholder: '0' });
    ReactTestRenderer.act(() => {
      amountInput.props.onChangeText('90000');
    });

    const warningHintAfterEdit = renderer.root
      .findAllByType(Text)
      .find((t: any) => t.props.children === "Double-check the total — it wasn't found in the scanned text.");
    expect(warningHintAfterEdit).toBeUndefined();
  });
});
