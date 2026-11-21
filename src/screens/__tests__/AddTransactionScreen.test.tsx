import React from 'react';
import { Alert, Linking, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { AddTransactionScreen } from '../AddTransactionScreen';
import { analyzeReceiptImage } from '../../services/ai/agent';
import { useTransactionStore } from '../../store/useTransactionStore';
import { useReceiptQueueStore } from '../../store/useReceiptQueueStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import * as templateService from '../../services/templates';
import * as recurringService from '../../services/recurring';

const ReactTestRenderer = require('react-test-renderer');

const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockRouteParams: {
  transactionId?: number;
  duplicateFromId?: number;
  receiptQueueId?: number;
  reviewBatchIndex?: number;
  reviewBatchTotal?: number;
  initialDate?: number;
} = {};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: mockReplace,
    canGoBack: () => false,
    goBack: jest.fn(),
  }),
  useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 32, left: 0, right: 0 }),
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
    delete mockRouteParams.duplicateFromId;
    delete mockRouteParams.receiptQueueId;
    delete mockRouteParams.reviewBatchIndex;
    delete mockRouteParams.reviewBatchTotal;
    delete mockRouteParams.initialDate;
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, fontScale: 1 });

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
      'Camera access is required to take photos of receipts.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Import from gallery' }),
        expect.objectContaining({ text: 'Open settings' }),
      ])
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
      allowsMultipleSelection: false,
      selectionLimit: 1,
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

  it('shows the low-confidence notice from a scan and clears it on amount edit', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///receipt.jpg' }],
    });

    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({
      merchantName: 'Warung Vision',
      totalAmount: 85000,
      confidence: 'low',
      confidenceReasons: ["This total doesn't appear in the text read from the photo."],
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

    const findNotice = () =>
      renderer.root.findAllByType(Text).find((t: any) => t.props.children === 'Compare the total with the receipt');
    expect(findNotice()).toBeDefined();
    expect(
      renderer.root.findAllByType(Text).some((t: any) => t.props.children === "This total doesn't appear in the text read from the photo.")
    ).toBe(true);
    expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' }).length).toBeGreaterThan(0);

    // Clears when user edits the amount
    const amountInput = renderer.root.findByProps({ placeholder: '0' });
    ReactTestRenderer.act(() => {
      amountInput.props.onChangeText('90000');
    });

    expect(findNotice()).toBeUndefined();
  });

  it('sends several gallery picks from Scan to the Receipt Inbox instead of scanning one', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///a.jpg' }, { uri: 'file:///b.jpg' }],
    });
    const enqueue = jest
      .spyOn(useReceiptQueueStore.getState(), 'enqueue')
      .mockResolvedValue({ added: 2, skippedDuplicates: 0 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Scan receipt' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' }).props.onPress();
    });

    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 0 })
    );
    expect(enqueue).toHaveBeenCalledWith(['file:///a.jpg', 'file:///b.jpg']);
    expect(analyzeReceiptImage).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('ReceiptInbox');
  });

  it('requires a different destination account before saving a transfer', async () => {
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 0 },
        { id: 2, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
      ],
    } as any);
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Set Transfer type' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: '0' }).props.onChangeText('200000');
    });
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Select category' })).toHaveLength(0);

    const saveBtn = renderer.root.findAll((n: any) => n.props.accessibilityLabel === 'Save transaction')[0];
    await ReactTestRenderer.act(async () => {
      await saveBtn.props.onPress();
    });
    expect(Alert.alert).toHaveBeenCalledWith('Choose accounts', expect.any(String));
  });

  it('saves a repeat rule along with a new transaction when Repeat is set', async () => {
    const recurring = require('../../services/recurring');
    const createRule = jest.spyOn(recurring, 'createRecurringRule').mockReturnValue(1);
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Netflix');
      renderer.root.findByProps({ placeholder: '0' }).props.onChangeText('186000');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Repeat Monthly' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findAll((n: any) => n.props.accessibilityLabel === 'Save transaction')[0].props.onPress();
    });
    expect(createRule).toHaveBeenCalledWith(expect.objectContaining({ merchantName: 'Netflix', totalAmount: -186000 }), 'monthly', expect.any(Number));
    createRule.mockRestore();
  });

  it('opens calculator keypad on amount tap and preserves USD decimals end-to-end', async () => {
    useSettingsStore.setState({ currencyCode: 'USD', useThousandsSeparator: true });
    mockAddTransaction.mockResolvedValue(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Brunch');
    });

    // Open calculator by tapping the amount field
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Edit amount' }).props.onPress();
    });

    // Compute 12.5 + 3.25 = 15.75
    for (const label of ['1', '2', 'Decimal point', '5', 'Add', '3', 'Decimal point', '2', '5', 'Done']) {
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
      });
    }

    expect(renderer.root.findByProps({ placeholder: '0' }).props.value).toBe('15.75');

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockAddTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Brunch',
        totalAmount: -15.75,
        type: 'expense',
      })
    );

    ReactTestRenderer.act(() => renderer.unmount());

    // Reloading an existing USD transaction with decimals keeps cents (no Math.round truncation)
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 101,
          walletId: 1,
          merchantName: 'Brunch',
          totalAmount: -15.75,
          type: 'expense',
          category: 'Food & Dining',
          date: Date.now(),
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
      ],
    } as any);
    mockRouteParams.transactionId = 101;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    expect(renderer.root.findByProps({ placeholder: '0' }).props.value).toBe('15.75');
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('duplicates an edited transaction as a new entry dated today without copying the photo', async () => {
    const oldDate = new Date(2025, 0, 10, 9, 0).getTime();
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 99,
          walletId: 1,
          merchantName: 'Existing Cafe',
          totalAmount: -45000,
          type: 'expense',
          category: 'Food & Dining',
          date: oldDate,
          note: 'Oat latte',
          lineItemsText: '',
          imageUri: 'file:///existing.jpg',
        },
      ],
    } as any);

    mockRouteParams.transactionId = 99;
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Duplicate transaction' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('AddTransactionStack', { duplicateFromId: 99 });
    ReactTestRenderer.act(() => renderer.unmount());

    // Open duplicated entry screen
    delete mockRouteParams.transactionId;
    mockRouteParams.duplicateFromId = 99;
    const beforeMount = Date.now();
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    expect(renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.value).toBe('Existing Cafe');
    expect(renderer.root.findByProps({ placeholder: '0' }).props.value).toBe('45.000');
    // Photo must NOT be copied
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Remove photo' })).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Add receipt photo' })).toBeDefined();

    mockAddTransaction.mockResolvedValueOnce(undefined);
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockUpdateTransaction).not.toHaveBeenCalled();
    expect(mockAddTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Existing Cafe',
        totalAmount: -45000,
        note: 'Oat latte',
        imageUri: null,
      })
    );
    const savedDate = mockAddTransaction.mock.calls[0][0].date;
    expect(savedDate).toBeGreaterThanOrEqual(beforeMount - 1000);
    expect(savedDate).not.toBe(oldDate);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('saves, prefills, and deletes quick-entry templates on the add screen', () => {
    const stored: templateService.TransactionTemplate[] = [];
    const listSpy = jest.spyOn(templateService, 'listTransactionTemplates').mockImplementation(() => [...stored]);
    const createSpy = jest.spyOn(templateService, 'createTransactionTemplate').mockImplementation((name, payload) => {
      const created: templateService.TransactionTemplate = {
        id: stored.length + 1,
        name,
        template: payload,
        createdAt: Date.now(),
      };
      stored.unshift(created);
      return created;
    });
    const deleteSpy = jest.spyOn(templateService, 'deleteTransactionTemplate').mockImplementation((id) => {
      const idx = stored.findIndex((t) => t.id === id);
      if (idx >= 0) stored.splice(idx, 1);
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    // Fill fields and save as template
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Morning Coffee');
      renderer.root.findByProps({ placeholder: '0' }).props.onChangeText('28000');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Save as template' }).props.onPress();
    });

    expect(createSpy).toHaveBeenCalledWith(
      'Morning Coffee',
      expect.objectContaining({ merchantName: 'Morning Coffee', totalAmount: -28000, type: 'expense' })
    );

    // Clear fields, then tap the template chip to prefill
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('');
      renderer.root.findByProps({ placeholder: '0' }).props.onChangeText('');
    });
    const chip = renderer.root.findByProps({ accessibilityLabel: 'Use template Morning Coffee' });
    ReactTestRenderer.act(() => {
      chip.props.onPress();
    });

    expect(renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.value).toBe('Morning Coffee');
    expect(renderer.root.findByProps({ placeholder: '0' }).props.value).toBe('28.000');

    // Long press template chip -> confirm delete
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Use template Morning Coffee' }).props.onLongPress();
    });
    const alertCall = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Delete Template');
    expect(alertCall).toBeDefined();
    const deleteBtn = alertCall[2].find((b: any) => b.text === 'Delete');
    ReactTestRenderer.act(() => {
      deleteBtn.onPress();
    });

    expect(deleteSpy).toHaveBeenCalledWith(1);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Use template Morning Coffee' })).toHaveLength(0);

    ReactTestRenderer.act(() => renderer.unmount());

    listSpy.mockRestore();
    createSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it('never preselects archived accounts from templates or duplicates, while labeling them in edit mode (R-04)', async () => {
    useTransactionStore.setState({
      wallets: [
        { id: 1, name: 'Old Card', type: 'card', isActive: false, initialBalance: 0, balance: 0 },
        { id: 2, name: 'Main Bank', type: 'bank', isActive: true, initialBalance: 0, balance: 0 },
        { id: 3, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
      ],
      transactionsList: [
        {
          id: 201,
          walletId: 1,
          toWalletId: 2,
          merchantName: 'Old Transfer',
          totalAmount: -100000,
          type: 'transfer',
          category: 'Transfer',
          date: new Date(2025, 2, 1).getTime(),
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
        {
          id: 202,
          walletId: 2,
          toWalletId: 1,
          merchantName: 'To Archived',
          totalAmount: -75000,
          type: 'transfer',
          category: 'Transfer',
          date: new Date(2025, 2, 2).getTime(),
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
      ],
    } as any);

    const listSpy = jest.spyOn(templateService, 'listTransactionTemplates').mockReturnValue([
      {
        id: 7,
        name: 'Archived Expense',
        template: {
          merchantName: 'Archived Expense',
          totalAmount: -35000,
          type: 'expense',
          category: 'Food & Dining',
          note: '',
          lineItemsText: '',
          walletId: 1,
          toWalletId: null,
        },
        createdAt: Date.now(),
      },
    ]);

    // 1. Applying a template with archived walletId=1 falls back to active Main Bank (id=2)
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Use template Archived Expense' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Account: Main Bank' })).toBeDefined();

    mockAddTransaction.mockResolvedValueOnce(undefined);
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });
    expect(mockAddTransaction).toHaveBeenCalledWith(expect.objectContaining({ walletId: 2 }));
    ReactTestRenderer.act(() => renderer.unmount());

    // 2. Duplicating transfer from archived wallet 1 -> active wallet 2:
    //    walletId falls back to Main Bank (2), and colliding toWalletId resets to Choose account (null)
    mockRouteParams.duplicateFromId = 201;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Account: Main Bank' })).toBeDefined();
    expect(renderer.root.findByProps({ accessibilityLabel: 'Transfer to: Choose account' })).toBeDefined();
    ReactTestRenderer.act(() => renderer.unmount());

    // 3. Duplicating transfer to archived wallet 1 resets toWalletId to Choose account (null)
    mockRouteParams.duplicateFromId = 202;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Account: Main Bank' })).toBeDefined();
    expect(renderer.root.findByProps({ accessibilityLabel: 'Transfer to: Choose account' })).toBeDefined();
    ReactTestRenderer.act(() => renderer.unmount());

    // 4. Editing historical transaction keeps archived account visible with "(archived)" suffix
    delete mockRouteParams.duplicateFromId;
    mockRouteParams.transactionId = 201;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Account: Old Card (archived)' })).toBeDefined();
    ReactTestRenderer.act(() => renderer.unmount());

    listSpy.mockRestore();
  });

  it('rejects amounts exceeding the safe precision cap with an inline error (R-05)', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Huge Entry');
      renderer.root.findByProps({ placeholder: '0' }).props.onChangeText('999999999999998');
    });

    expect(
      renderer.root.findAllByType(Text).some((t: any) => t.props.children === 'Amount is too large')
    ).toBe(true);

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });
    expect(mockAddTransaction).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('prefills transaction date from route initialDate param and saves with that date', async () => {
    const prefilled = new Date(2026, 9, 12, 14, 15, 0, 0).getTime();
    mockRouteParams.initialDate = prefilled;
    mockAddTransaction.mockResolvedValueOnce(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Calendar Entry');
      renderer.root.findByProps({ placeholder: '0' }).props.onChangeText('35000');
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockAddTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Calendar Entry',
        date: prefilled,
      })
    );

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('preserves initialDate (selectedDate) when applying a quick-entry template (R2B-5)', async () => {
    const prefilled = new Date(2026, 10, 5, 14, 15, 0, 0).getTime();
    mockRouteParams.initialDate = prefilled;
    mockAddTransaction.mockResolvedValueOnce(undefined);

    const listSpy = jest.spyOn(templateService, 'listTransactionTemplates').mockReturnValue([
      {
        id: 12,
        name: 'Morning Coffee',
        template: {
          merchantName: 'Morning Coffee',
          totalAmount: -28000,
          type: 'expense',
          category: 'Food & Dining',
          note: 'Oat latte',
          lineItemsText: '',
          walletId: 1,
          toWalletId: null,
        },
        createdAt: Date.now(),
      },
    ]);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Use template Morning Coffee' }).props.onPress();
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockAddTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Morning Coffee',
        totalAmount: -28000,
        date: prefilled,
      })
    );

    ReactTestRenderer.act(() => renderer.unmount());
    listSpy.mockRestore();
  });

  it('editing an existing transaction and saving unchanged preserves category, line items without trailing pipe, and repeat schedule (F-01)', async () => {
    const txDate = new Date(2026, 10, 10, 12, 30).getTime();
    const existingTx = {
      id: 301,
      walletId: 1,
      merchantName: 'Sate Khas Dinner',
      totalAmount: -45000,
      type: 'expense' as const,
      category: 'Food & Dining',
      date: txDate,
      note: 'Dinner with team',
      lineItemsText: 'Latte | 30.000\nCroissant | 15.000',
      imageUri: 'file:///sate.jpg',
    };

    useTransactionStore.setState({
      transactionsList: [existingTx],
      categories: [
        { id: 1, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Entertainment', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 3, name: 'Food & Dining', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 4, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      ],
      wallets: [{ id: 1, name: 'Main Wallet', type: 'cash', isActive: true, initialBalance: 0, balance: 0 }],
    } as any);

    const findRuleSpy = jest.spyOn(recurringService, 'findRecurringRuleForTransaction').mockReturnValue({
      id: 77,
      template: {
        merchantName: existingTx.merchantName,
        totalAmount: existingTx.totalAmount,
        type: existingTx.type,
        category: existingTx.category,
        note: existingTx.note,
        lineItemsText: existingTx.lineItemsText,
        walletId: 1,
        toWalletId: null,
      },
      frequency: 'monthly',
      startDate: txDate,
      occurrences: 1,
      isActive: true,
      nextDate: txDate + 30 * 86400000,
    });
    const updateRuleSpy = jest.spyOn(recurringService, 'updateRecurringRule').mockImplementation(() => {});
    const createRuleSpy = jest.spyOn(recurringService, 'createRecurringRule').mockReturnValue(99);
    mockUpdateTransaction.mockResolvedValueOnce(undefined);

    mockRouteParams.transactionId = 301;
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    // Category must remain 'Food & Dining' (NOT reset to alphabetically-first 'Bills')
    const catPicker = renderer.root.findByProps({ accessibilityLabel: 'Select category' });
    const catTexts = catPicker.findAllByType(Text).map((t: any) => t.props.children);
    expect(catTexts).toContain('Food & Dining');
    expect(catTexts).not.toContain('Bills');

    // Repeat row must be visible in edit mode and reflect 'Monthly'
    const monthlyChip = renderer.root.findByProps({ accessibilityLabel: 'Repeat Monthly' });
    expect(monthlyChip.props.accessibilityState).toEqual({ selected: true });

    // Item price inputs must NOT contain trailing ' |'
    const priceInputs = renderer.root
      .findAllByType(TextInput)
      .map((i: any) => i.props.value)
      .filter((v: any) => typeof v === 'string');
    expect(priceInputs).toContain('30.000');
    expect(priceInputs).toContain('15.000');
    expect(priceInputs.some((v: string) => v.includes('|'))).toBe(false);

    // Tap Update Transaction unchanged -> stored row payload must match original exactly
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockUpdateTransaction).toHaveBeenCalledWith(
      301,
      expect.objectContaining({
        merchantName: 'Sate Khas Dinner',
        totalAmount: -45000,
        type: 'expense',
        category: 'Food & Dining',
        date: txDate,
        note: 'Dinner with team',
        lineItemsText: 'Latte | 30.000\nCroissant | 15.000',
        imageUri: 'file:///sate.jpg',
        walletId: 1,
      })
    );
    expect(createRuleSpy).not.toHaveBeenCalled();
    expect(updateRuleSpy).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => renderer.unmount());
    findRuleSpy.mockRestore();
    updateRuleSpy.mockRestore();
    createRuleSpy.mockRestore();
  });

  it('preserves income category when editing a saved income transaction (F-01)', async () => {
    const txDate = new Date(2026, 10, 1, 9, 0).getTime();
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 302,
          walletId: 1,
          merchantName: 'Monthly Payroll',
          totalAmount: 8500000,
          type: 'income',
          category: 'Salary',
          date: txDate,
          note: '',
          lineItemsText: '',
          imageUri: null,
        },
      ],
      categories: [
        { id: 1, name: 'Bills', type: 'expense', isSystem: true, createdAt: 1000 },
        { id: 2, name: 'Freelance', type: 'income', isSystem: true, createdAt: 1000 },
        { id: 3, name: 'Salary', type: 'income', isSystem: true, createdAt: 1000 },
      ],
    } as any);
    mockUpdateTransaction.mockResolvedValueOnce(undefined);

    mockRouteParams.transactionId = 302;
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const catPicker = renderer.root.findByProps({ accessibilityLabel: 'Select category' });
    expect(catPicker.findAllByType(Text).map((t: any) => t.props.children)).toContain('Salary');

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });
    expect(mockUpdateTransaction).toHaveBeenCalledWith(302, expect.objectContaining({ type: 'income', category: 'Salary' }));

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('advances to the next pending receipt (2 of N) after saving a queued receipt and returns to ReceiptInbox after the last one (F-08)', async () => {
    const mockQueueRemove = jest.fn(async (id: number) => {
      useReceiptQueueStore.setState((state) => ({
        items: state.items.filter((item) => item.id !== id),
      }));
    });

    useReceiptQueueStore.setState({
      items: [
        {
          id: 10,
          imageUri: 'file:///docs/receipts/r1.jpg',
          imageHash: 'md5:1',
          status: 'done',
          result: { merchantName: 'Cafe One', totalAmount: 32000, confidence: 'high' },
          error: null,
          createdAt: 1000,
        },
        {
          id: 11,
          imageUri: 'file:///docs/receipts/r2.jpg',
          imageHash: 'md5:2',
          status: 'done',
          result: { merchantName: 'Cafe Two', totalAmount: 55000, confidence: 'high' },
          error: null,
          createdAt: 2000,
        },
      ],
      remove: mockQueueRemove,
    } as any);

    mockRouteParams.receiptQueueId = 10;
    mockRouteParams.reviewBatchIndex = 1;
    mockRouteParams.reviewBatchTotal = 2;
    mockAddTransaction.mockResolvedValue(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    // Shows "1 of 2" progress indicator
    expect(renderer.root.findByProps({ accessibilityLabel: 'Receipt 1 of 2' })).toBeDefined();

    // Tap photo to zoom opens ReceiptPhotoModal
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Zoom receipt photo' }).props.onPress();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Close photo viewer' })).toBeDefined();
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Close photo viewer' }).props.onPress();
    });

    // Save first receipt -> advances directly to receipt 11 as "2 of 2", NOT Cashflow
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockQueueRemove).toHaveBeenCalledWith(10, false);
    expect(mockReplace).toHaveBeenCalledWith('AddTransactionStack', {
      receiptQueueId: 11,
      reviewBatchIndex: 2,
      reviewBatchTotal: 2,
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('MainTabs', expect.anything());
    ReactTestRenderer.act(() => renderer.unmount());

    // Now open receipt 11 (last one) and save -> navigates back to ReceiptInbox (NOT Cashflow)
    mockNavigate.mockClear();
    mockReplace.mockClear();
    mockRouteParams.receiptQueueId = 11;
    mockRouteParams.reviewBatchIndex = 2;
    mockRouteParams.reviewBatchTotal = 2;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Receipt 2 of 2' })).toBeDefined();

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockQueueRemove).toHaveBeenCalledWith(11, false);
    expect(mockNavigate).toHaveBeenCalledWith('ReceiptInbox');
    expect(mockNavigate).not.toHaveBeenCalledWith('MainTabs', expect.anything());
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('applies bottom safe-area inset padding to the action stack and scales fonts with fontScale (F-06, F-12)', () => {
    useSettingsStore.setState({ fontScale: 1.2 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const actions = renderer.root.findByProps({ testID: 'add-transaction-actions' });
    expect(StyleSheet.flatten(actions.props.style).paddingBottom).toBeGreaterThanOrEqual(44);

    const headerTitle = renderer.root
      .findAllByType(Text)
      .find((t: any) => t.props.children === 'Add Transaction');
    expect(StyleSheet.flatten(headerTitle.props.style).fontSize).toBeCloseTo(21.6, 1);

    const saveText = renderer.root
      .findAllByType(Text)
      .find((t: any) => t.props.children === 'Save Transaction');
    expect(StyleSheet.flatten(saveText.props.style).fontSize).toBeCloseTo(18, 1);

    ReactTestRenderer.act(() => renderer.unmount());
  });
});
