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
const mockGoBack = jest.fn();
let mockCanGoBack = false;
const mockRouteParams: {
  transactionId?: number;
  duplicateFromId?: number;
  receiptQueueId?: number;
  reviewBatchIndex?: number;
  reviewBatchTotal?: number;
  initialDate?: number;
  sharedImageUri?: string;
} = {};

let mockNavState: any = undefined;
const mockPopTo = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: mockReplace,
    getState: () => mockNavState,
    popTo: mockPopTo,
    canGoBack: () => mockCanGoBack,
    goBack: mockGoBack,
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

jest.mock('../../services/fx/rates', () => ({
  getCachedRate: jest.fn(() => ({ rate: 104.6, date: '2026-11-22' })),
  getDailyRate: jest.fn(async () => ({ rate: 104.6, date: '2026-11-22' })),
}));

jest.mock('../../services/ai/agent', () => ({
  analyzeReceiptImage: jest.fn(),
  RECEIPT_SCAN_CANCELLED: 'SCAN_CANCELLED',
}));

describe('AddTransactionScreen', () => {
  const mockAddTransaction = jest.fn();
  const mockUpdateTransaction = jest.fn();
  const mockDeleteTransaction = jest.fn();
  const mockAddCategory = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack = false;
    mockNavState = undefined;
    delete mockRouteParams.transactionId;
    delete mockRouteParams.duplicateFromId;
    delete mockRouteParams.receiptQueueId;
    delete mockRouteParams.reviewBatchIndex;
    delete mockRouteParams.reviewBatchTotal;
    delete mockRouteParams.initialDate;
    delete mockRouteParams.sharedImageUri;
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    ReactTestRenderer.act(() => {
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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Security review 2026-11-23: a silo:// link sets route params, so it could ask Add Transaction to
  // scan any file (e.g. Silo's own database). Only photos from the share sheet are scanned.
  it('regression: ignores a sharedImageUri that did not come from the share sheet', async () => {
    mockRouteParams.sharedImageUri = 'file:///data/user/0/com.LCSdev.silo/files/SQLite/silo.db';
    let renderer: any;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    expect(analyzeReceiptImage).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  // Regression (reported 2026-11-23): tapping Amount did nothing on Android unless Merchant was focused
  // first, and then the system number keyboard appeared instead of the calculator. The hidden TextInput
  // inside the "Edit amount" button took the touch because Android ignores pointerEvents on TextInput.
  it('regression: tapping Amount opens the calculator, and no text box inside a tappable control can take the touch', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    // Any TextInput nested in a pressable must be non-editable and sit under a View with
    // pointerEvents="none", or Android routes the tap to the input instead of the button.
    const pressables = renderer.root.findAll(
      (n: any) => typeof n.type !== 'string' && typeof n.props?.onPress === 'function'
    );
    const hasBlockingAncestor = (node: any, stop: any) => {
      for (let p = node.parent; p && p !== stop; p = p.parent) {
        if (p.props?.pointerEvents === 'none') return true;
      }
      return false;
    };
    let nestedInputs = 0;
    for (const pressable of pressables) {
      for (const input of pressable.findAllByType(TextInput)) {
        nestedInputs += 1;
        expect(input.props.editable).toBe(false);
        expect(input.props.pointerEvents).toBeUndefined();
        expect(hasBlockingAncestor(input, pressable)).toBe(true);
      }
    }
    expect(nestedInputs).toBeGreaterThan(0);

    // With nothing focused, one tap on Amount opens the calculator keypad.
    const calculator = () =>
      renderer.root.findAll((n: any) => n.props && 'initialValue' in n.props && 'onDone' in n.props)[0];
    expect(calculator().props.visible).toBe(false);
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Edit amount' }).props.onPress();
    });
    expect(calculator().props.visible).toBe(true);

    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());

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
    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());
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
    expect(enqueue).toHaveBeenCalledWith(['file:///a.jpg', 'file:///b.jpg'], { scan: true });
    expect(analyzeReceiptImage).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('ReceiptInbox');
    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());
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
    ReactTestRenderer.act(() => renderer.unmount());
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
    expect(mockAddTransaction).toHaveBeenCalledWith(expect.objectContaining({ walletId: 2 }), { source: 'template' });
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
      }),
      // Recorded in the activity log as coming from a template.
      { source: 'template' }
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
        // Photos outside app storage are copied in once so the OS can't clear them.
        imageUri: expect.stringContaining('/files/receipts/receipt-'),
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
    const mockQueueRemove = jest.fn((id: number, _transactionId?: number | null) => {
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
      markSaved: mockQueueRemove,
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

    // Saved receipts move to the "Recently saved" history, linked to their new transaction.
    expect(mockQueueRemove).toHaveBeenCalledWith(10, null);
    expect(mockReplace).toHaveBeenCalledWith('AddTransactionStack', {
      receiptQueueId: 11,
      reviewBatchIndex: 2,
      reviewBatchTotal: 2,
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('MainTabs', expect.anything());
    ReactTestRenderer.act(() => renderer.unmount());

    // Now open receipt 11 (last one) and save -> navigates back to ReceiptInbox (NOT Cashflow)
    mockNavState = { routes: [{ name: 'MainTabs' }, { name: 'ReceiptInbox' }, { name: 'AddTransactionStack' }] };
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

    expect(mockQueueRemove).toHaveBeenCalledWith(11, null);
    // Back to the inbox already in the stack, so Back from it can't reopen the saved receipt.
    expect(mockPopTo).toHaveBeenCalledWith('ReceiptInbox');
    expect(mockNavigate).not.toHaveBeenCalledWith('ReceiptInbox');
    expect(mockNavigate).not.toHaveBeenCalledWith('MainTabs', expect.anything());
    mockNavState = undefined;
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('applies bottom safe-area inset padding to the action stack and scales fonts with fontScale (F-06, F-12, NIT-03)', () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ fontScale: 1.2 });
    });

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

  it('validates empty Title inline without blocking Alert and keeps red error border off the currency badge (F-21)', async () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockAddTransaction).not.toHaveBeenCalled();

    const texts = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children ?? ''));
    expect(texts).toContain('Please enter a title');
    expect(texts).toContain('Amount must be greater than 0');

    // Editable amount box shows red border, read-only currency badge does NOT
    const currencyBadge = renderer.root.findByProps({ testID: 'amount-currency-badge' });
    const amountBox = renderer.root.findByProps({ testID: 'amount-input-box' });
    expect(StyleSheet.flatten(amountBox.props.style).borderColor).not.toBe(
      StyleSheet.flatten(currencyBadge.props.style).borderColor
    );

    // Typing a title clears the inline error
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Coffee');
    });
    const textsAfterType = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children ?? ''));
    expect(textsAfterType).not.toContain('Please enter a title');

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('stacks Details above Note|Items|Both, adapts Income/Transfer placeholders & Scan CTA, formats scanned item prices, and drops duplicate bottom SafeArea edge (F-15, F-31, NIT-01)', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///single-scan.jpg' }],
    });
    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({
      merchantName: 'Toast Cafe',
      totalAmount: 31000,
      lineItemsText: 'Trad Ky Toast | 28182',
      rawText: 'TOAST CAFE\nTOTAL 31.000',
    });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    // F-15: Details header stacks vertically so Note/Items/Both never clip off right edge
    const detailsHeader = renderer.root.findByProps({ testID: 'details-section-header' });
    expect(StyleSheet.flatten(detailsHeader.props.style).flexDirection).toBe('column');

    // Single scan formats line item price consistently (28182 -> 28.182) with Rp badge
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Scan receipt' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' }).props.onPress();
    });

    const inputValues = renderer.root
      .findAllByType(TextInput)
      .map((node: any) => node.props.value)
      .filter((v: any) => typeof v === 'string');
    expect(inputValues).toContain('31.000');
    expect(inputValues).toContain('28.182');
    const currencyBadgeTexts = renderer.root
      .findByProps({ testID: 'amount-currency-badge' })
      .findAllByType(Text)
      .map((t: any) => String(t.props.children));
    expect(currencyBadgeTexts).toContain('Rp');

    // F-31: Income adapts placeholder to Source, Transfer hides Scan and uses optional Description
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Set Income type' }).props.onPress();
    });
    expect(renderer.root.findByProps({ placeholder: 'Source (e.g. Salary, Client)' })).toBeTruthy();

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Set Transfer type' }).props.onPress();
    });
    expect(renderer.root.findByProps({ placeholder: 'Description (optional)' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Scan receipt' })).toHaveLength(0);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('saves the edited itemized list (not the scanned one) after a scan', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///scan-edit.jpg' }],
    });
    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({
      merchantName: 'Super Indo',
      totalAmount: 23695,
      lineItemsText: 'TELUR AYAM OMEGA 806 29, 400 | 23695\nBTKP | 23695\nELP BEBAS PULSA | 3210',
      rawText: 'SUPER INDO',
    });
    mockAddTransaction.mockResolvedValue(undefined);

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

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Remove item 3' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Remove item 2' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Item 1 name' }).props.onChangeText('Telur Ayam Omega');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Item 1 note' }).props.onChangeText('0.806 kg');
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockAddTransaction).toHaveBeenCalledTimes(1);
    const saved = mockAddTransaction.mock.calls[0][0];
    expect(saved.totalAmount).toBe(-23695);
    expect(saved.merchantName).toBe('Super Indo');
    expect(saved.lineItemsText).toBe('Telur Ayam Omega | 23.695 | 0.806 kg');
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('lets the user cancel a slow scan, ignoring its late result and restoring the form', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///slow-scan.jpg' }],
    });
    let finishScan: (value: unknown) => void = () => undefined;
    let scanSignal: AbortSignal | undefined;
    (analyzeReceiptImage as jest.Mock).mockImplementationOnce((_uri, _b64, _onStatus, options) => {
      scanSignal = options?.signal;
      return new Promise((resolve) => {
        finishScan = resolve;
      });
    });

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

    const cancelBtn = renderer.root.findByProps({ accessibilityLabel: 'Cancel scan' });
    ReactTestRenderer.act(() => {
      cancelBtn.props.onPress();
    });
    expect(scanSignal?.aborted).toBe(true);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Cancel scan' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Remove photo' })).toHaveLength(0);

    await ReactTestRenderer.act(async () => {
      finishScan({ merchantName: 'Late Merchant', totalAmount: 99000, rawText: 'LATE' });
    });
    const values = renderer.root
      .findAllByType(TextInput)
      .map((node: any) => node.props.value)
      .filter((v: any) => typeof v === 'string');
    expect(values).not.toContain('Late Merchant');
    expect(values).not.toContain('99.000');
    expect(Alert.alert).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('asks before saving an unrealistic date and saves only after "Save anyway"', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///superindo.jpg' }],
    });
    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({
      merchantName: 'Super Indo',
      totalAmount: 23695,
      date: '2097-07-07',
      rawText: 'SUPER INDO',
    });
    mockAddTransaction.mockResolvedValue(undefined);

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
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });

    expect(mockAddTransaction).not.toHaveBeenCalled();
    const call = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Check the date');
    expect(call).toBeDefined();
    expect(call[1]).toMatch(/2097.*years in the future\. Save it anyway\?/);
    const buttons = call[2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons.map((b) => b.text)).toEqual(['Change date', 'Save anyway']);

    await ReactTestRenderer.act(async () => {
      buttons[1].onPress?.();
    });
    expect(mockAddTransaction).toHaveBeenCalledTimes(1);
    expect(new Date(mockAddTransaction.mock.calls[0][0].date).getFullYear()).toBe(2097);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('saves tags picked from suggestions and typed in, separate from the category', async () => {
    mockAddTransaction.mockResolvedValue(undefined);
    let renderer: any;
    ReactTestRenderer.act(() => {
      useTransactionStore.setState({ tags: [{ id: 1, name: 'date', usage: 4 }, { id: 2, name: 'work', usage: 1 }] } as any);
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Sushi dinner');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findAllByType(TextInput).find((n: any) => n.props.showSoftInputOnFocus === false).props.onChangeText('450000');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Add tag date' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Add tag' }).props.onChangeText('#Anniversary');
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Add tag' }).props.onSubmitEditing();
    });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Remove tag Anniversary' })).toBeTruthy();

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });
    expect(mockAddTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Food & Dining', tags: ['date', 'Anniversary'] })
    );
    ReactTestRenderer.act(() => renderer.unmount());
  });

  describe('foreign-currency accounts', () => {
    const wallets = [
      { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 5_000_000, currency: null, averageRate: null },
      { id: 2, name: 'Japan Cash', type: 'cash', isActive: true, initialBalance: 0, balance: 20_000, currency: 'JPY', averageRate: 105 },
    ];
    const render = () => {
      let renderer: any;
      ReactTestRenderer.act(() => {
        useTransactionStore.setState({ wallets } as any);
        renderer = ReactTestRenderer.create(<AddTransactionScreen />);
      });
      return renderer;
    };
    const pickAccount = (renderer: any, name: string) => {
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Account: BCA' }).props.onPress();
      });
      ReactTestRenderer.act(() => {
        const modal = renderer.root.findAll((n: any) => typeof n.props.onSelect === 'function' && n.props.wallets)[0];
        modal.props.onSelect(wallets.find((w) => w.name === name)!.id);
      });
    };

    it('records yen spent from a yen account at today\'s rate, and can switch to the average cost', async () => {
      mockAddTransaction.mockResolvedValue(undefined);
      const renderer = render();
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ placeholder: 'Merchant or title' }).props.onChangeText('Ramen');
      });
      pickAccount(renderer, 'Japan Cash');
      await ReactTestRenderer.act(async () => {});
      ReactTestRenderer.act(() => {
        renderer.root.findAllByType(TextInput).find((n: any) => n.props.onChangeText && n.props.placeholder === '0' && n.props.showSoftInputOnFocus === false).props.onChangeText('3200');
      });

      expect(renderer.root.findByProps({ testID: 'currency-exchange-panel' })).toBeTruthy();
      const rateInput = renderer.root.findByProps({ accessibilityLabel: 'Exchange rate, IDR per JPY' });
      expect(rateInput.props.value).toBe('104,6');
      expect(renderer.root.findByProps({ testID: 'amount-currency-badge' }).findAllByType(Text).map((t: any) => t.props.children)).toContain('¥');

      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Use my average exchange cost' }).props.onPress();
      });
      await ReactTestRenderer.act(async () => {
        await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
      });

      expect(mockAddTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 2, totalAmount: -336000, originalAmount: -3200, originalCurrency: 'JPY', fxRate: 105 })
      );
      ReactTestRenderer.act(() => renderer.unmount());
    });

    it('records buying yen with rupiah as a transfer with the amount received', async () => {
      mockAddTransaction.mockResolvedValue(undefined);
      const renderer = render();
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Set Transfer type' }).props.onPress();
      });
      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Transfer to: Choose account' }).props.onPress();
      });
      ReactTestRenderer.act(() => {
        const modal = renderer.root.findAll((n: any) => typeof n.props.onSelect === 'function' && n.props.wallets)[0];
        modal.props.onSelect(2);
      });
      ReactTestRenderer.act(() => {
        renderer.root.findAllByType(TextInput).find((n: any) => n.props.showSoftInputOnFocus === false).props.onChangeText('1000000');
      });

      await ReactTestRenderer.act(async () => {
        await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
      });
      expect(mockAddTransaction).not.toHaveBeenCalled();
      expect(renderer.root.findAllByType(Text).some((t: any) => t.props.children === 'Enter how much JPY arrived.')).toBe(true);

      ReactTestRenderer.act(() => {
        renderer.root.findByProps({ accessibilityLabel: 'Amount received in JPY' }).props.onChangeText('9560');
      });
      expect(
        renderer.root.findAllByType(Text).some((t: any) => typeof t.props.children === 'string' && t.props.children.startsWith('Exchange rate: 1 JPY = Rp 104,6'))
      ).toBe(true);
      await ReactTestRenderer.act(async () => {
        await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
      });
      expect(mockAddTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'transfer', walletId: 1, toWalletId: 2, totalAmount: -1000000, toAmount: 9560, fxRate: 104.603 })
      );
      ReactTestRenderer.act(() => renderer.unmount());
    });
  });

  it('confirms a scanned receipt date far from today, with a one-tap "Use today"', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///r.jpg' }] });
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    const iso = `${lastYear.getFullYear()}-${String(lastYear.getMonth() + 1).padStart(2, '0')}-${String(lastYear.getDate()).padStart(2, '0')}`;
    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({ merchantName: 'Super Indo', totalAmount: 23695, date: iso, rawText: 'SUPER INDO' });
    mockAddTransaction.mockResolvedValue(7);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => renderer.root.findByProps({ accessibilityLabel: 'Scan receipt' }).props.onPress());
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' }).props.onPress();
    });
    expect(renderer.root.findByProps({ testID: 'scanned-date-notice' })).toBeTruthy();

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Save transaction' }).props.onPress();
    });
    expect(mockAddTransaction).not.toHaveBeenCalled();
    const call = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Check the receipt date');
    expect(call[1]).toMatch(/a year ago\. Is that right\?/);
    await ReactTestRenderer.act(async () => {
      call[2][0].onPress();
    });
    expect(mockAddTransaction).toHaveBeenCalledTimes(1);
    const saved = mockAddTransaction.mock.calls[0];
    expect(new Date(saved[0].date).toDateString()).toBe(new Date().toDateString());
    expect(saved[1]).toEqual({ source: 'scan' });
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('calls navigation.goBack() on delete and edit save when canGoBack() is true to preserve caller screen state (F-17)', async () => {
    mockCanGoBack = true;
    mockRouteParams.transactionId = 99;
    mockDeleteTransaction.mockResolvedValueOnce(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Delete transaction' }).props.onPress();
    });
    const deleteAlertCall = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Delete Transaction');
    const confirmButton = deleteAlertCall[2].find((b: any) => b.text === 'Delete');
    await ReactTestRenderer.act(async () => {
      await confirmButton.onPress();
    });

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalledWith('MainTabs', expect.anything());
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('surfaces duplicate feedback when multi-select gallery scan skips already-queued receipts (MIN-02)', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///dup1.jpg' }, { uri: 'file:///dup2.jpg' }],
    });
    const enqueueSpy = jest
      .spyOn(useReceiptQueueStore.getState(), 'enqueue')
      .mockResolvedValue({ added: 1, skippedDuplicates: 1 });

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

    expect(Alert.alert).toHaveBeenCalledWith(
      'Duplicate receipts skipped',
      expect.stringContaining('1 duplicate receipt was already in the inbox')
    );
    expect(mockNavigate).toHaveBeenCalledWith('ReceiptInbox');

    enqueueSpy.mockRestore();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('parses stored and scanned line item prices numerically for the active currency without multiplying decimals in IDR (MIN-R5-02)', async () => {
    // 1. Edit hydration with IDR: decimal price "12.50" -> "13" (never "1.250"), existing IDR "30.000" & "45000.00" preserved accurately
    const txDate = new Date(2026, 10, 12, 10, 0).getTime();
    useSettingsStore.setState({ currencyCode: 'IDR' });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 405,
          walletId: 1,
          merchantName: 'Import Cafe',
          totalAmount: -75013,
          type: 'expense' as const,
          category: 'Food & Dining',
          date: txDate,
          note: '',
          lineItemsText: 'Latte | 30.000\nPastry | 12.50\nMeal | 45000.00',
          imageUri: null,
        },
      ],
    } as any);

    mockRouteParams.transactionId = 405;
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    const editItemPrices = [
      renderer.root.findByProps({ accessibilityLabel: 'Item 1 price' }).props.value,
      renderer.root.findByProps({ accessibilityLabel: 'Item 2 price' }).props.value,
      renderer.root.findByProps({ accessibilityLabel: 'Item 3 price' }).props.value,
    ];
    expect(editItemPrices).toEqual(['30.000', '13', '45.000']);
    ReactTestRenderer.act(() => renderer.unmount());

    // 2. Scan hydration with IDR: "12.50" -> "13", raw integer "28182" -> "28.182"
    mockRouteParams.transactionId = undefined;
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///decimal-scan.jpg' }],
    });
    (analyzeReceiptImage as jest.Mock).mockResolvedValueOnce({
      merchantName: 'Corner Mart',
      totalAmount: 28195,
      lineItemsText: 'Mint | 12.50\nToast | 28182',
    });

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Scan receipt' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' }).props.onPress();
    });

    expect(renderer.root.findByProps({ accessibilityLabel: 'Item 1 price' }).props.value).toBe('13');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Item 2 price' }).props.value).toBe('28.182');
    ReactTestRenderer.act(() => renderer.unmount());

    // 3. Edit hydration with USD preserves fractional cents
    useSettingsStore.setState({ currencyCode: 'USD' });
    useTransactionStore.setState({
      transactionsList: [
        {
          id: 406,
          walletId: 1,
          merchantName: 'NYC Coffee',
          totalAmount: -1247.06,
          type: 'expense' as const,
          category: 'Food & Dining',
          date: txDate,
          note: '',
          lineItemsText: 'Espresso | 12.50\nCatering | 1,234.56',
          imageUri: null,
        },
      ],
    } as any);
    mockRouteParams.transactionId = 406;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<AddTransactionScreen />);
    });

    expect(renderer.root.findByProps({ accessibilityLabel: 'Item 1 price' }).props.value).toBe('12.5');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Item 2 price' }).props.value).toBe('1,234.56');
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
