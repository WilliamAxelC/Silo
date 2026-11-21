import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';

import {
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import { getCategoryTypeForTransaction } from '../features/transactions/categories';
import { createTransactionInput, deriveEditableTransactionType, normalizeTransactionInput } from '../features/transactions/factories';
import { buildEditableTransactionInput } from '../features/transactions/mappers';
import type { Transaction, TransactionInput, TransactionType, TransactionUIInputMode } from '../features/transactions/types';
import { NavigationProps, AddTransactionScreenRouteProp } from '../navigation/types';
import { analyzeReceiptImage, type ParsedReceiptResult } from '../services/ai/agent';
import type { ReceiptConfidenceAssessment } from '../services/ocr/receiptConfidence';
import { useReceiptQueueStore } from '../store/useReceiptQueueStore';
import { ConfidenceNotice } from '../components/ConfidenceBadge';
import { scanReceiptDocuments } from '../services/ocr/documentScanner';
import { AccountPickerModal } from '../components/AccountPickerModal';
import { AmountCalculatorModal } from '../components/AmountCalculatorKeypad';
import { RECURRING_FREQUENCIES, createRecurringRule, type RecurringFrequency } from '../services/recurring';
import {
  createTransactionTemplate,
  deleteTransactionTemplate,
  listTransactionTemplates,
  type TransactionTemplate,
} from '../services/templates';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getErrorMessage } from '../services/ai/localInferenceTypes';
import { useAppTheme } from '../theme/useAppTheme';

import { ReceiptItemsEditor, ReceiptLineItemDraft } from '../components/ReceiptItemsEditor';
import { CategorySelectorModal } from '../components/CategorySelectorModal';
import { SourceSelectorModal } from '../components/SourceSelectorModal';

const createReceiptItemDraft = (overrides?: Partial<ReceiptLineItemDraft>): ReceiptLineItemDraft => ({
  id: overrides?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: overrides?.name ?? '',
  price: overrides?.price ?? '',
  note: overrides?.note ?? '',
});

const parseReceiptLineItemsText = (value: string): ReceiptLineItemDraft[] => {
  if (!value.trim()) {
    return [];
  }

  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(' | ').map((part) => part.trim());
      const [namePart = '', pricePart = '', notePart = ''] = parts;
      const fallbackMatch = parts.length === 1 ? line.match(/^(.*?)\s*-\s*([\d.,]+)$/) : null;

      return createReceiptItemDraft({
        id: `${index}-${line}`,
        name: fallbackMatch ? fallbackMatch[1].trim() : namePart,
        price: fallbackMatch ? fallbackMatch[2].trim() : pricePart,
        note: notePart,
      });
    });
};

const serializeReceiptLineItems = (items: ReceiptLineItemDraft[]): string => {
  return items
    .map((item) => {
      const name = item.name.trim();
      const price = item.price.trim();
      const note = item.note.trim();

      if (!name && !price && !note) {
        return '';
      }

      return [name, price, note].join(' | ').trim();
    })
    .filter(Boolean)
    .join('\n');
};

export const AddTransactionScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<AddTransactionScreenRouteProp>();
  const editingId = route.params?.transactionId;
  const duplicateFromId = route.params?.duplicateFromId;
  const receiptQueueId = route.params?.receiptQueueId;
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);

  const {
    addTransaction,
    updateTransaction,
    deleteTransaction,
    isSaving,
    categories,
    addCategory,
    getCategoriesByType,
    normalizeCategoryForType,
  } = useTransactionStore();

  const [type, setType] = useState<TransactionType>('expense');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [scanConfidence, setScanConfidence] = useState<ReceiptConfidenceAssessment | null>(null);
  const wallets = useTransactionStore((s) => s.wallets);
  const defaultWalletId = wallets.find((w) => w.isActive)?.id ?? null;
  const [walletId, setWalletId] = useState<number | null>(null);
  const [toWalletId, setToWalletId] = useState<number | null>(null);
  const [accountPicker, setAccountPicker] = useState<'from' | 'to' | null>(null);
  const [repeat, setRepeat] = useState<RecurringFrequency | null>(null);
  const isSelectableWallet = (id: number | null) => {
    if (id == null) return false;
    if (wallets.length === 0) return true;
    const match = wallets.find((w) => w.id === id);
    if (!match) return false;
    return Boolean(editingId) || match.isActive;
  };
  const effectiveWalletId = isSelectableWallet(walletId) ? walletId : defaultWalletId;
  const effectiveToWalletId =
    isSelectableWallet(toWalletId) && toWalletId !== effectiveWalletId ? toWalletId : null;
  const walletName = (id: number | null) => {
    const match = wallets.find((w) => w.id === id);
    if (!match) return 'Choose account';
    return match.isActive ? match.name : `${match.name} (archived)`;
  };
  const [category, setCategory] = useState('');
  const [pendingScannedCategory, setPendingScannedCategory] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [lineItems, setLineItems] = useState<ReceiptLineItemDraft[]>([]);
  const [detailsMode, setDetailsMode] = useState<TransactionUIInputMode>('note');

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [rawOcrText, setRawOcrText] = useState<string | null>(null);
  const [isRawTextExpanded, setIsRawTextExpanded] = useState<boolean>(false);
  const [sourceModalVisible, setSourceModalVisible] = useState(false);
  const [sourceModalTarget, setSourceModalTarget] = useState<'attachment' | 'scan' | null>(null);

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [customCategory, setCustomCategory] = useState('');

  const [isScanning, setIsScanning] = useState(false);
  const [scanStatusLabel, setScanStatusLabel] = useState<string | null>(null);
  const [calculatorVisible, setCalculatorVisible] = useState(false);
  const [templates, setTemplates] = useState<TransactionTemplate[]>([]);
  const [templateFeedback, setTemplateFeedback] = useState<string | null>(null);

  const refreshTemplates = useCallback(() => {
    try {
      setTemplates(listTransactionTemplates());
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    if (!editingId) {
      refreshTemplates();
    }
  }, [editingId, refreshTemplates]);

  const activeCategoryType = getCategoryTypeForTransaction(type);
  const availableCategories = useMemo(
    () => getCategoriesByType(activeCategoryType),
    [activeCategoryType, categories, getCategoriesByType]
  );
  const lineItemsText = useMemo(() => serializeReceiptLineItems(lineItems), [lineItems]);
  const compactDateLabel = selectedDate.toLocaleDateString(dateFormat || 'en-GB', { day: '2-digit', month: 'short' });
  const compactTimeLabel = selectedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const detailModeOptions = useMemo(
    () => [
      { key: 'note' as const, label: 'Note' },
      { key: 'receipt' as const, label: 'Items' },
      { key: 'both' as const, label: 'Both' },
    ],
    []
  );

  const resetForm = () => {
    const fallbackCategory = availableCategories[0]?.name ?? normalizeCategoryForType('', type);
    const nextForm = createTransactionInput({ category: fallbackCategory, type });
    setTitle(nextForm.merchantName);
    setAmount('');
    setAmountError(null);
    setScanConfidence(null);
    setCategory(nextForm.category);
    setPendingScannedCategory(null);
    setNote(nextForm.note ?? '');
    setLineItems(parseReceiptLineItemsText(nextForm.lineItemsText ?? ''));
    setDetailsMode('note');
    setImageUri(nextForm.imageUri ?? null);
    setType(nextForm.type);
    setSelectedDate(new Date());
    setScanStatusLabel(null);
    setRawOcrText(null);
    setIsRawTextExpanded(false);
    setWalletId(null);
    setToWalletId(null);
    setRepeat(null);
    setTemplateFeedback(null);
  };

  const prevTypeRef = React.useRef(type);

  const populateFormFromTransaction = (
    tx: Partial<Transaction>,
    options: { preserveDateAndPhoto: boolean }
  ) => {
    const editableTransaction = buildEditableTransactionInput(tx);
    const editableType = deriveEditableTransactionType(editableTransaction.totalAmount, editableTransaction.type);
    prevTypeRef.current = editableType;
    setTitle(editableTransaction.merchantName);
    setAmount(
      editableTransaction.totalAmount !== 0
        ? formatAmountForInput(editableTransaction.totalAmount, currencyCode)
        : ''
    );
    setAmountError(null);
    setScanConfidence(null);
    setType(editableType);
    setCategory(normalizeCategoryForType(editableTransaction.category, editableType));
    setPendingScannedCategory(null);
    setNote(editableTransaction.note || '');
    setLineItems(parseReceiptLineItemsText(editableTransaction.lineItemsText || ''));
    setDetailsMode(editableTransaction.lineItemsText ? (editableTransaction.note ? 'both' : 'receipt') : 'note');
    setSelectedDate(options.preserveDateAndPhoto ? new Date(editableTransaction.date) : new Date());
    setImageUri(options.preserveDateAndPhoto ? editableTransaction.imageUri || null : null);
    const knownWallets = useTransactionStore.getState().wallets;
    const activeDefaultWalletId = knownWallets.find((w) => w.isActive)?.id ?? null;
    const resolveWalletId = (id?: number | null) => {
      if (id == null) return null;
      if (knownWallets.length === 0) return id;
      return knownWallets.some((w) =>
        options.preserveDateAndPhoto ? w.id === id : w.id === id && w.isActive
      )
        ? id
        : null;
    };
    const resolvedFromId = resolveWalletId(editableTransaction.walletId);
    const effectiveFromId = resolvedFromId ?? activeDefaultWalletId;
    const rawToId = editableType === 'transfer' ? resolveWalletId(editableTransaction.toWalletId) : null;
    const resolvedToId =
      !options.preserveDateAndPhoto && rawToId != null && rawToId === effectiveFromId
        ? null
        : rawToId;
    setWalletId(resolvedFromId);
    setToWalletId(resolvedToId);
    setRepeat(null);
    setRawOcrText(null);
    setIsRawTextExpanded(false);
    setTemplateFeedback(null);
  };

  useEffect(() => {
    if (editingId) {
      const latestTransactions = useTransactionStore.getState().transactionsList;
      const tx = latestTransactions.find((transaction) => transaction.id === editingId);
      if (tx) {
        populateFormFromTransaction(tx, { preserveDateAndPhoto: true });
      }
    } else if (duplicateFromId) {
      const latestTransactions = useTransactionStore.getState().transactionsList;
      const tx = latestTransactions.find((transaction) => transaction.id === duplicateFromId);
      if (tx) {
        populateFormFromTransaction(tx, { preserveDateAndPhoto: false });
      } else {
        resetForm();
      }
    } else {
      resetForm();
      const queued = receiptQueueId
        ? useReceiptQueueStore.getState().items.find((item) => item.id === receiptQueueId)
        : undefined;
      if (queued?.result) {
        setImageUri(queued.imageUri);
        applyScanResult(queued.result);
      }
    }
  }, [editingId, duplicateFromId, receiptQueueId]);

  useEffect(() => {
    const typeChanged = prevTypeRef.current !== type;
    prevTypeRef.current = type;

    if (typeChanged) {
      setPendingScannedCategory(null);
      const nextCategory = availableCategories[0]?.name ?? normalizeCategoryForType('', type);
      setCategory(nextCategory);
      return;
    }

    if (pendingScannedCategory && category === pendingScannedCategory) {
      return;
    }

    if (availableCategories.length === 0) {
      const fallback = normalizeCategoryForType('', type);
      if (category !== fallback) {
        setCategory(fallback);
      }
      return;
    }
    if (!category || !availableCategories.some((item) => item.name === category)) {
      const nextCategory = availableCategories[0]?.name ?? normalizeCategoryForType('', type);
      if (category !== nextCategory) {
        setCategory(nextCategory);
      }
    }
  }, [availableCategories, category, normalizeCategoryForType, pendingScannedCategory, type]);

  const openPicker = (mode: 'date' | 'time') => {
    setPickerMode(mode);
    setShowPicker(true);
  };

  const onDateChange = (_event: unknown, date?: Date) => {
    setShowPicker(false);
    if (date) setSelectedDate(date);
  };

  const handleAmountChange = (text: string) => {
    setScanConfidence(null);
    const formatted = formatAmountInput(text, currencyCode);
    setAmount(formatted);
    if (text.trim().length > 0) {
      const parsed = Math.abs(parseSignedAmount(text, undefined, currencyCode));
      if (parsed === 0 || Number.isNaN(parsed)) {
        setAmountError('Amount must be greater than 0');
      } else if (!isAmountWithinRange(parsed)) {
        setAmountError('Amount is too large');
      } else {
        setAmountError(null);
      }
    } else {
      setAmountError(null);
    }
  };

  const setParsedLineItems = (value: string) => {
    const parsedItems = parseReceiptLineItemsText(value);
    setLineItems(parsedItems.length > 0 ? parsedItems : [createReceiptItemDraft()]);
  };

  const addReceiptItemRow = () => {
    setLineItems((current) => [...current, createReceiptItemDraft()]);
  };

  const removeReceiptItemRow = (id: string) => {
    setLineItems((current) => current.filter((item) => item.id !== id));
  };

  const updateReceiptItemRow = (id: string, field: keyof Omit<ReceiptLineItemDraft, 'id'>, value: string) => {
    setLineItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, [field]: field === 'price' ? formatAmountInput(value, currencyCode) : value } : item
      )
    );
  };

  const handleDetailsModeChange = (mode: TransactionUIInputMode) => {
    setDetailsMode(mode);

    if ((mode === 'receipt' || mode === 'both') && lineItems.length === 0) {
      setLineItems([createReceiptItemDraft()]);
    }
  };

  const pickImage = async (source: 'gallery' | 'camera') => {
    const target = sourceModalTarget;
    setSourceModalVisible(false);
    let result;
    try {
      if (source === 'gallery') {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.8,
          // Scanning accepts several receipts at once; they go to the Receipt Inbox and are read in the background.
          allowsMultipleSelection: target === 'scan',
          selectionLimit: target === 'scan' ? 0 : 1,
        });
      } else {
        if (target === 'scan') {
          let scanned: string[] | null = null;
          try {
            scanned = await scanReceiptDocuments();
          } catch (scannerError) {
            console.warn('Document scanner unavailable, falling back to camera:', scannerError);
          }
          if (scanned) {
            if (scanned.length > 1) {
              await useReceiptQueueStore.getState().enqueue(scanned);
              navigation.navigate('ReceiptInbox');
            } else if (scanned.length === 1) {
              processScanReceipt(scanned[0]);
            }
            return;
          }
        }
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('Camera Permission Required', 'Camera access is required to take photos of receipts.');
          return;
        }
        result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      }
    } catch (error) {
      Alert.alert('Image Error', getErrorMessage(error, 'Failed to pick an image. Please try again.'));
      return;
    }

    if (result.canceled || !result.assets || !result.assets[0]?.uri) return;

    if (target === 'scan' && result.assets.length > 1) {
      await useReceiptQueueStore.getState().enqueue(result.assets.map((asset) => asset.uri));
      navigation.navigate('ReceiptInbox');
      return;
    }

    if (target === 'scan') {
      processScanReceipt(result.assets[0].uri);
    } else {
      setImageUri(result.assets[0].uri);
    }
  };

  const applyScanResult = (parsedData: ParsedReceiptResult) => {
    setScanConfidence(
      parsedData.confidence ? { level: parsedData.confidence, reasons: parsedData.confidenceReasons ?? [] } : null
    );
    const rawText = (parsedData as { rawText?: string }).rawText;
    if (rawText) {
      setRawOcrText(rawText);
      setIsRawTextExpanded(false);
    }
    if (parsedData.merchantName) setTitle(parsedData.merchantName);
    if (parsedData.totalAmount) {
      setAmount(formatAmountForInput(parsedData.totalAmount, currencyCode));
      setAmountError(isAmountWithinRange(parsedData.totalAmount) ? null : 'Amount is too large');
    }
    if (parsedData.category) {
      const detectedCategory = parsedData.category.trim();
      const existingCategory = availableCategories.find(
        (item) => item.name.toLowerCase() === detectedCategory.toLowerCase()
      );
      if (existingCategory) {
        setCategory(existingCategory.name);
        setPendingScannedCategory(null);
      } else {
        // Keep in form state, do NOT call addCategory during scan
        setCategory(detectedCategory);
        setPendingScannedCategory(detectedCategory);
      }
    }
    if (parsedData.lineItemsText) {
      setParsedLineItems(parsedData.lineItemsText);
      setDetailsMode(note ? 'both' : 'receipt');
    }
    if (parsedData.date) {
      const parsedDate = new Date(parsedData.date);
      if (!isNaN(parsedDate.getTime())) setSelectedDate(parsedDate);
    }
  };

  const processScanReceipt = async (uri: string, base64String?: string) => {
    setImageUri(uri);
    setIsScanning(true);
    setScanStatusLabel('Reading text…');
    setRawOcrText(null);
    setIsRawTextExpanded(false);

    try {
      const parsedData = await analyzeReceiptImage(uri, base64String ?? undefined, (status: string) => {
        if (status === 'Reading receipt with AI vision…' || status.includes('vision')) {
          setScanStatusLabel(status);
        } else if (
          status.includes('Structuring') ||
          status.toLowerCase().includes('understanding') ||
          status.includes('AI')
        ) {
          setScanStatusLabel('Understanding receipt…');
        } else if (status.includes('OCR') || status.toLowerCase().includes('reading')) {
          setScanStatusLabel('Reading text…');
        } else {
          setScanStatusLabel(status);
        }
      });

      if (parsedData) {
        applyScanResult(parsedData);
        setScanStatusLabel(null);
      } else {
        Alert.alert('Scan Result', 'Extracted image details. Review and adjust fields if needed.');
        setScanStatusLabel(null);
      }
    } catch (error: any) {
      console.warn('OCR error:', error);
      setScanStatusLabel(null);
      if (error?.message === 'NO_TEXT_DETECTED') {
        Alert.alert(
          'No Text Detected',
          "We couldn't find any readable text in the image. Please make sure the receipt is clear and try again."
        );
      } else {
        Alert.alert('Scan Failed', 'Failed to scan the receipt automatically. Please enter details manually.');
      }
    } finally {
      setIsScanning(false);
    }
  };

  const openScanSourceModal = () => {
    setSourceModalTarget('scan');
    setSourceModalVisible(true);
  };

  const openAttachmentSourceModal = () => {
    setSourceModalTarget('attachment');
    setSourceModalVisible(true);
  };

  const buildTransactionPayload = (categoryOverride?: string): TransactionInput => {
    const signedType = type === 'transfer' ? 'expense' : type;

    return normalizeTransactionInput(
      createTransactionInput({
        merchantName: title.trim() || (type === 'transfer' ? 'Transfer' : title),
        totalAmount: parseSignedAmount(amount, signedType, currencyCode),
        type,
        category: (categoryOverride ?? category).trim() || normalizeCategoryForType('', type),
        date: selectedDate.getTime(),
        note,
        lineItemsText,
        imageUri: imageUri || null,
        walletId: effectiveWalletId ?? undefined,
        toWalletId: type === 'transfer' ? effectiveToWalletId : null,
      })
    );
  };

  const handleSave = async () => {
    if (type === 'transfer') {
      if (!effectiveToWalletId || effectiveToWalletId === effectiveWalletId) {
        Alert.alert('Choose accounts', 'Pick the account the money goes to (different from the one it leaves).');
        return;
      }
      if (!title.trim()) setTitle('Transfer');
    } else if (!title.trim()) {
      Alert.alert('Missing Required Fields', 'Please enter a title');
      return;
    }

    const parsedAmt = Math.abs(parseSignedAmount(amount, undefined, currencyCode));
    if (!amount || parsedAmt === 0 || Number.isNaN(parsedAmt)) {
      setAmountError('Amount must be greater than 0');
      return;
    }
    if (!isAmountWithinRange(parsedAmt)) {
      setAmountError('Amount is too large');
      return;
    }

    try {
      let resolvedCategory = category;
      if (category) {
        const categoryExists = availableCategories.some(
          (item) => item.name.toLowerCase() === category.toLowerCase()
        );
        if (!categoryExists) {
          try {
            resolvedCategory = await addCategory(category, activeCategoryType);
            setPendingScannedCategory(null);
          } catch (catErr) {
            console.warn('Failed to auto-create category on save:', catErr);
          }
        }
      }

      const data = buildTransactionPayload(resolvedCategory);

      if (editingId) {
        await updateTransaction(editingId, data);
      } else {
        await addTransaction(data);
        if (repeat) {
          createRecurringRule(data, repeat, data.date);
        }
        if (receiptQueueId) {
          // The transaction now owns the receipt photo, so keep the file.
          await useReceiptQueueStore.getState().remove(receiptQueueId, false);
        }
      }

      navigation.navigate('MainTabs', { screen: 'Cashflow' });
      setTimeout(() => resetForm(), 100);
    } catch (error: any) {
      Alert.alert('Save Failed', error?.message || 'Failed to save transaction. Please try again.');
    }
  };

  const handleDuplicate = () => {
    if (!editingId) return;
    navigation.navigate('AddTransactionStack', { duplicateFromId: editingId });
  };

  const handleSaveAsTemplate = () => {
    if (type === 'transfer') {
      if (!effectiveToWalletId || effectiveToWalletId === effectiveWalletId) {
        Alert.alert('Choose accounts', 'Pick the account the money goes to (different from the one it leaves).');
        return;
      }
    } else if (!title.trim()) {
      Alert.alert('Missing Title', 'Please enter a title before saving as a template.');
      return;
    }

    if (amount.trim().length > 0) {
      const parsedAmt = Math.abs(parseSignedAmount(amount, undefined, currencyCode));
      if (parsedAmt === 0 || Number.isNaN(parsedAmt)) {
        setAmountError('Amount must be greater than 0');
        return;
      }
      if (!isAmountWithinRange(parsedAmt)) {
        setAmountError('Amount is too large');
        return;
      }
    }

    try {
      const payload = buildTransactionPayload();
      const saved = createTransactionTemplate(payload.merchantName, {
        merchantName: payload.merchantName,
        totalAmount: payload.totalAmount,
        type: payload.type,
        category: payload.category,
        note: payload.note,
        lineItemsText: payload.lineItemsText,
        walletId: payload.walletId,
        toWalletId: payload.toWalletId,
      });
      refreshTemplates();
      setTemplateFeedback(`Saved "${saved.name}" as template`);
    } catch (error) {
      Alert.alert('Template Error', getErrorMessage(error, 'Could not save template.'));
    }
  };

  const handleApplyTemplate = (item: TransactionTemplate) => {
    populateFormFromTransaction(
      {
        ...item.template,
        date: Date.now(),
        imageUri: null,
      },
      { preserveDateAndPhoto: false }
    );
  };

  const confirmDeleteTemplate = (item: TransactionTemplate) => {
    Alert.alert('Delete Template', `Remove "${item.name}" from your templates?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteTransactionTemplate(item.id);
          refreshTemplates();
          setTemplateFeedback(null);
        },
      },
    ]);
  };

  const handleDelete = () => {
    if (!editingId) return;
    Alert.alert('Delete Transaction', 'Are you sure you want to delete this transaction?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteTransaction(editingId);
            resetForm();
            navigation.navigate('MainTabs', { screen: 'Cashflow' });
          } catch (error: any) {
            Alert.alert('Delete Failed', error?.message || 'Failed to delete transaction. Please try again.');
          }
        },
      },
    ]);
  };

  const handleAddCustomCategory = async (nameOverride?: string) => {
    const target = typeof nameOverride === 'string' ? nameOverride : customCategory;
    const trimmedCategory = target.trim();

    if (trimmedCategory !== '') {
      try {
        const createdCategory = await addCategory(trimmedCategory, activeCategoryType);
        setCategory(createdCategory);
        setPendingScannedCategory(null);
        setCustomCategory('');
        setCategoryModalVisible(false);
      } catch (error) {
        Alert.alert('Category Error', getErrorMessage(error, 'Failed to add category.'));
      }
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardShell}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Top Header */}
          <View style={styles.header}>
            <TouchableOpacity
              style={[styles.headerBackButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => {
                resetForm();
                if (navigation.canGoBack()) {
                  navigation.goBack();
                } else {
                  navigation.navigate('MainTabs', { screen: 'Cashflow' });
                }
              }}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="chevron-back" size={22} color={theme.text} />
            </TouchableOpacity>
            <Text style={[styles.headerScreenTitle, { color: theme.text }]}>
              {editingId ? 'Edit Transaction' : 'Add Transaction'}
            </Text>
            <View style={styles.headerSpacer} />
          </View>

          {/* Quick-entry Templates Strip */}
          {!editingId && templates.length > 0 ? (
            <View style={styles.templatesSection}>
              <View style={styles.templatesHeaderRow}>
                <Text style={[styles.label, styles.templatesLabel, { color: theme.text }]}>Templates</Text>
                <Text style={[styles.templatesHint, { color: theme.textMuted }]}>Tap to fill · hold to remove</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.templatesScroll}
                keyboardShouldPersistTaps="handled"
              >
                {templates.map((tpl) => {
                  const dotColor =
                    tpl.template.type === 'transfer'
                      ? theme.primary
                      : tpl.template.type === 'income'
                        ? theme.income
                        : theme.expense;
                  const amountPreview =
                    tpl.template.totalAmount !== 0
                      ? formatDisplayCurrency(Math.abs(tpl.template.totalAmount), currencyCode, useThousandsSeparator)
                      : null;
                  return (
                    <TouchableOpacity
                      key={tpl.id}
                      style={[
                        styles.templateChip,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                      ]}
                      onPress={() => handleApplyTemplate(tpl)}
                      onLongPress={() => confirmDeleteTemplate(tpl)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`Use template ${tpl.name}`}
                      accessibilityHint="Long press to delete template"
                    >
                      <View style={[styles.templateDot, { backgroundColor: dotColor }]} />
                      <Text style={[styles.templateChipName, { color: theme.text }]} numberOfLines={1}>
                        {tpl.name}
                      </Text>
                      {amountPreview ? (
                        <Text style={[styles.templateChipAmount, { color: theme.textMuted }]} numberOfLines={1}>
                          {amountPreview}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          {/* Real-time Scan Status Feedback Banner */}
          {isScanning && (
            <View style={[styles.scanStatusBar, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}>
              <ActivityIndicator color={theme.primary} size="small" style={styles.scanSpinner} />
              <View style={styles.scanStatusTextWrap}>
                <Text style={[styles.scanStatusTitle, { color: theme.primary }]}>Scanning Receipt</Text>
                <Text style={[styles.scanStatusSub, { color: theme.text }]}>
                  {scanStatusLabel || 'Extracting text and identifying line items...'}
                </Text>
              </View>
            </View>
          )}

          {/* Type Toggle + Scan Receipt Button */}
          <View style={styles.compactRow}>
            <View style={[styles.typeToggle, styles.compactTypeToggle, { borderColor: theme.border, backgroundColor: theme.surface }]}>
              <TouchableOpacity
                style={[
                  styles.toggleBtn,
                  styles.compactToggleBtn,
                  { backgroundColor: type === 'expense' ? theme.expense : 'transparent' },
                ]}
                onPress={() => setType('expense')}
                accessibilityRole="button"
                accessibilityLabel="Set Expense type"
              >
                <Text style={[styles.toggleText, { color: type === 'expense' ? '#fff' : theme.textMuted }]}>Expense</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleBtn,
                  styles.compactToggleBtn,
                  { backgroundColor: type === 'income' ? theme.income : 'transparent' },
                ]}
                onPress={() => setType('income')}
                accessibilityRole="button"
                accessibilityLabel="Set Income type"
              >
                <Text style={[styles.toggleText, { color: type === 'income' ? '#fff' : theme.textMuted }]}>Income</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleBtn,
                  styles.compactToggleBtn,
                  { backgroundColor: type === 'transfer' ? theme.primary : 'transparent' },
                ]}
                onPress={() => setType('transfer')}
                accessibilityRole="button"
                accessibilityLabel="Set Transfer type"
              >
                <Text style={[styles.toggleText, { color: type === 'transfer' ? '#fff' : theme.textMuted }]}>Transfer</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.scanButtonCompact, { backgroundColor: theme.primary, opacity: isScanning ? 0.7 : 1 }]}
              onPress={openScanSourceModal}
              disabled={isScanning}
              accessibilityRole="button"
              accessibilityLabel="Scan receipt"
            >
              {isScanning ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons name="scan-outline" size={18} color="#fff" />
              )}
              <Text style={styles.scanButtonTextCompact}>{isScanning ? 'Scanning…' : 'Scan'}</Text>
            </TouchableOpacity>
          </View>

          {/* Title & Amount Fields */}
          <View style={styles.compactRow}>
            <View style={[styles.fieldCard, styles.flexField]}>
              <Text style={[styles.label, { color: theme.text }]}>Title *</Text>
              <TextInput
                style={[styles.compactInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
                placeholderTextColor={theme.textMuted}
                value={title}
                onChangeText={setTitle}
                placeholder="Merchant or title"
              />
            </View>
            <View style={[styles.fieldCard, styles.amountField]}>
              <Text style={[styles.label, { color: theme.text }]}>Amount *</Text>
              <View style={styles.amountInputContainer}>
                <View
                  style={[
                    styles.currencyBadge,
                    styles.compactCurrencyBadge,
                    { backgroundColor: theme.surface, borderColor: amountError ? theme.expense : theme.border },
                  ]}
                >
                  <Text style={[styles.currencyText, { color: theme.textMuted }]}>{currencyCode}</Text>
                </View>
                <TouchableOpacity
                  style={[
                    styles.amountInput,
                    styles.amountPressable,
                    {
                      backgroundColor: theme.surface,
                      borderColor: amountError ? theme.expense : theme.border,
                    },
                  ]}
                  onPress={() => {
                    Keyboard.dismiss();
                    setCalculatorVisible(true);
                  }}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Edit amount"
                >
                  <TextInput
                    style={[styles.amountTextInput, styles.compactAmountInput, { color: theme.text }]}
                    placeholderTextColor={theme.textMuted}
                    value={amount}
                    onChangeText={handleAmountChange}
                    keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                    showSoftInputOnFocus={false}
                    pointerEvents="none"
                    placeholder="0"
                  />
                  <Ionicons name="calculator-outline" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
              {amountError ? (
                <Text style={[styles.inlineErrorText, { color: theme.expense }]}>{amountError}</Text>
              ) : scanConfidence ? (
                <ConfidenceNotice level={scanConfidence.level} reasons={scanConfidence.reasons} />
              ) : null}
            </View>
          </View>

          {/* Account(s) */}
          <View style={styles.compactRow}>
            <View style={[styles.fieldCard, styles.flexField]}>
              <Text style={[styles.label, { color: theme.text }]}>
                {type === 'transfer' ? 'From' : type === 'income' ? 'To account' : 'From account'}
              </Text>
              <TouchableOpacity
                style={[styles.compactPicker, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setAccountPicker('from')}
                accessibilityRole="button"
                accessibilityLabel={`Account: ${walletName(effectiveWalletId)}`}
              >
                <Text style={[styles.iconInputText, { color: theme.text }]} numberOfLines={1}>
                  {walletName(effectiveWalletId)}
                </Text>
                <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
            {type === 'transfer' ? (
              <>
                <Ionicons name="arrow-forward" size={18} color={theme.textMuted} style={styles.transferArrow} />
                <View style={[styles.fieldCard, styles.flexField]}>
                  <Text style={[styles.label, { color: theme.text }]}>To</Text>
                  <TouchableOpacity
                    style={[styles.compactPicker, { backgroundColor: theme.surface, borderColor: theme.border }]}
                    onPress={() => setAccountPicker('to')}
                    accessibilityRole="button"
                    accessibilityLabel={`Transfer to: ${walletName(effectiveToWalletId)}`}
                  >
                    <Text style={[styles.iconInputText, { color: effectiveToWalletId ? theme.text : theme.textMuted }]} numberOfLines={1}>
                      {walletName(effectiveToWalletId)}
                    </Text>
                    <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>

          {/* Category & Date Pickers */}
          <View style={styles.compactRow}>
            {type !== 'transfer' ? (
            <View style={[styles.fieldCard, styles.flexField]}>
              <Text style={[styles.label, { color: theme.text }]}>Category</Text>
              <TouchableOpacity
                style={[styles.compactPicker, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setCategoryModalVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Select category"
              >
                <Text style={[styles.iconInputText, { color: theme.text }]} numberOfLines={1}>
                  {category || 'Select category'}
                </Text>
                <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
            ) : null}

            <View style={[styles.fieldCard, type === 'transfer' ? styles.flexField : styles.dateGroup]}>
              <Text style={[styles.label, { color: theme.text }]}>Date & Time</Text>
              <View style={styles.inlineDateActions}>
                <TouchableOpacity
                  style={[styles.miniAction, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  onPress={() => openPicker('date')}
                  accessibilityRole="button"
                  accessibilityLabel="Pick date"
                >
                  <Ionicons name="calendar-outline" size={15} color={theme.textMuted} />
                  <Text style={[styles.miniActionText, { color: theme.text }]}>{compactDateLabel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.miniAction, { backgroundColor: theme.surface, borderColor: theme.border, marginLeft: 6 }]}
                  onPress={() => openPicker('time')}
                  accessibilityRole="button"
                  accessibilityLabel="Pick time"
                >
                  <Ionicons name="time-outline" size={15} color={theme.textMuted} />
                  <Text style={[styles.miniActionText, { color: theme.text }]}>{compactTimeLabel}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {!editingId ? (
            <View style={styles.inputGroupCompact}>
              <Text style={[styles.label, { color: theme.text }]}>Repeat</Text>
              <View style={styles.repeatRow}>
                {[{ key: null, label: 'Never' }, ...RECURRING_FREQUENCIES].map((option) => {
                  const selected = repeat === option.key;
                  return (
                    <TouchableOpacity
                      key={option.label}
                      style={[
                        styles.repeatChip,
                        { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primaryMuted : theme.surface },
                      ]}
                      onPress={() => setRepeat(option.key as RecurringFrequency | null)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Repeat ${option.label}`}
                    >
                      <Text style={[styles.repeatChipText, { color: selected ? theme.primary : theme.text }]}>{option.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Details Section (Note vs Items vs Both) */}
          <View style={styles.inputGroupCompact}>
            <View style={styles.inlineSectionHeader}>
              <Text style={[styles.sectionTitleCompact, { color: theme.text }]}>Details</Text>
              <View style={[styles.detailsModeToggle, styles.compactDetailsToggle, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                {detailModeOptions.map((option) => {
                  const isActive = detailsMode === option.key;
                  return (
                    <TouchableOpacity
                      key={option.key}
                      style={[
                        styles.detailsModeBtn,
                        styles.compactDetailsBtn,
                        { backgroundColor: isActive ? theme.primary : 'transparent' },
                      ]}
                      onPress={() => handleDetailsModeChange(option.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Show ${option.label} details`}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    >
                      <Text style={[styles.detailsModeText, { color: isActive ? '#fff' : theme.textMuted }]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {(detailsMode === 'note' || detailsMode === 'both') && (
              <TextInput
                style={[
                  styles.compactInput,
                  styles.noteInputCompact,
                  { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text },
                ]}
                value={note}
                onChangeText={setNote}
                placeholder="Description or notes"
                placeholderTextColor={theme.textMuted}
                multiline
                textAlignVertical="top"
              />
            )}

            {(detailsMode === 'receipt' || detailsMode === 'both') && (
              <ReceiptItemsEditor
                lineItems={lineItems}
                onAddRow={addReceiptItemRow}
                onRemoveRow={removeReceiptItemRow}
                onUpdateRow={updateReceiptItemRow}
              />
            )}
          </View>

          {/* Receipt / Invoice Photo Attachment */}
          <View style={styles.compactRow}>
            <View style={[styles.fieldCard, styles.flexField]}>
              <Text style={[styles.label, { color: theme.text }]}>Receipt Photo</Text>
              {imageUri ? (
                <View style={[styles.attachmentCompact, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <View style={styles.imagePreviewWrap}>
                    <Image source={{ uri: imageUri }} style={styles.previewImageCompact} resizeMode="cover" />
                    <TouchableOpacity
                      style={[styles.removeImageBtnCompact, { backgroundColor: theme.surface }]}
                      onPress={() => setImageUri(null)}
                      accessibilityRole="button"
                      accessibilityLabel="Remove photo"
                      hitSlop={{ top: 9, bottom: 9, left: 9, right: 9 }}
                    >
                      <Ionicons name="close-circle" size={26} color={theme.expense} />
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.attachmentCompact, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  onPress={openAttachmentSourceModal}
                  accessibilityRole="button"
                  accessibilityLabel="Add receipt photo"
                >
                  <View style={styles.attachmentCompactEmpty}>
                    <Ionicons name="camera-outline" size={22} color={theme.primary} />
                    <Text style={[styles.attachmentCompactText, { color: theme.textMuted }]}>Attach receipt image</Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Collapsible Raw OCR Text Section */}
          {rawOcrText ? (
            <View style={[styles.rawOcrCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <TouchableOpacity
                style={styles.rawOcrHeader}
                onPress={() => setIsRawTextExpanded((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={isRawTextExpanded ? 'Collapse raw OCR text' : 'Expand raw OCR text'}
                accessibilityState={{ expanded: isRawTextExpanded }}
              >
                <View style={styles.rawOcrHeaderLeft}>
                  <Ionicons name="document-text-outline" size={16} color={theme.primary} />
                  <Text style={[styles.rawOcrTitle, { color: theme.text }]}>Raw OCR text</Text>
                </View>
                <Ionicons
                  name={isRawTextExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={theme.textMuted}
                />
              </TouchableOpacity>
              {isRawTextExpanded && (
                <View style={[styles.rawOcrBody, { borderTopColor: theme.border }]}>
                  <Text selectable style={[styles.rawOcrContent, { color: theme.textMuted }]}>
                    {rawOcrText}
                  </Text>
                </View>
              )}
            </View>
          ) : null}

          {/* Save, Template, Duplicate & Delete Actions */}
          <View style={styles.actionStack}>
            <TouchableOpacity
              style={[styles.saveButton, styles.saveButtonCompact, { backgroundColor: theme.primary }]}
              onPress={handleSave}
              disabled={isSaving}
              accessibilityRole="button"
              accessibilityLabel="Save transaction"
            >
              {isSaving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.saveButtonText}>{editingId ? 'Update Transaction' : 'Save Transaction'}</Text>
              )}
            </TouchableOpacity>

            {editingId ? (
              <View style={styles.secondaryActionRow}>
                <TouchableOpacity
                  style={[styles.secondaryActionButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
                  onPress={handleDuplicate}
                  disabled={isSaving}
                  accessibilityRole="button"
                  accessibilityLabel="Duplicate transaction"
                >
                  <Ionicons name="copy-outline" size={18} color={theme.primary} style={{ marginRight: 6 }} />
                  <Text style={[styles.secondaryActionText, { color: theme.primary }]}>Duplicate</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryActionButton, { borderColor: theme.expense, backgroundColor: theme.surface }]}
                  onPress={handleDelete}
                  disabled={isSaving}
                  accessibilityRole="button"
                  accessibilityLabel="Delete transaction"
                >
                  <Ionicons name="trash-outline" size={18} color={theme.expense} style={{ marginRight: 6 }} />
                  <Text style={[styles.secondaryActionText, { color: theme.expense }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <TouchableOpacity
                  style={[styles.templateSaveButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
                  onPress={handleSaveAsTemplate}
                  disabled={isSaving}
                  accessibilityRole="button"
                  accessibilityLabel="Save as template"
                >
                  <Ionicons name="bookmark-outline" size={18} color={theme.primary} style={{ marginRight: 6 }} />
                  <Text style={[styles.secondaryActionText, { color: theme.primary }]}>Save as template</Text>
                </TouchableOpacity>
                {templateFeedback ? (
                  <Text style={[styles.templateFeedbackText, { color: theme.income }]} accessibilityRole="text">
                    {templateFeedback}
                  </Text>
                ) : null}
              </>
            )}
          </View>

          <View style={{ height: 80 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {showPicker && (
        <DateTimePicker value={selectedDate} mode={pickerMode} display="default" onChange={onDateChange} />
      )}

      <AmountCalculatorModal
        visible={calculatorVisible}
        initialValue={amount}
        currencyCode={currencyCode}
        onDone={(formatted) => handleAmountChange(formatted)}
        onClose={() => setCalculatorVisible(false)}
      />

      <AccountPickerModal
        visible={accountPicker !== null}
        title={accountPicker === 'to' ? 'Transfer to' : 'Account'}
        wallets={wallets}
        selectedId={accountPicker === 'to' ? effectiveToWalletId : effectiveWalletId}
        excludeId={accountPicker === 'to' ? effectiveWalletId : null}
        onSelect={(id) => {
          if (accountPicker === 'to') {
            setToWalletId(id);
          } else {
            setWalletId(id);
            if (id === effectiveToWalletId) setToWalletId(null);
          }
        }}
        onClose={() => setAccountPicker(null)}
        onManage={() => navigation.navigate('Accounts')}
      />

      <SourceSelectorModal
        visible={sourceModalVisible}
        onClose={() => setSourceModalVisible(false)}
        onPickImage={pickImage}
        scanMode={sourceModalTarget === 'scan'}
      />

      <CategorySelectorModal
        visible={categoryModalVisible}
        onClose={() => setCategoryModalVisible(false)}
        categories={availableCategories}
        selectedCategory={category}
        onSelectCategory={(name) => {
          setCategory(name);
          setPendingScannedCategory(null);
          setCategoryModalVisible(false);
        }}
        customCategory={customCategory}
        onChangeCustomCategory={setCustomCategory}
        onAddCustomCategory={handleAddCustomCategory}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardShell: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 32 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerBackButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerScreenTitle: { fontSize: 18, fontWeight: '700' },
  headerSpacer: { width: 44 },
  scanStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  scanSpinner: { marginRight: 10 },
  scanStatusTextWrap: { flex: 1 },
  scanStatusTitle: { fontSize: 13, fontWeight: '700' },
  scanStatusSub: { fontSize: 12, marginTop: 2 },
  compactRow: { flexDirection: 'row', marginBottom: 12 },
  typeToggle: { flexDirection: 'row', borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  compactTypeToggle: { flex: 1, marginRight: 10 },
  toggleBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  compactToggleBtn: { minHeight: 46 },
  toggleText: { fontSize: 14, fontWeight: '700' },
  scanButtonCompact: {
    minWidth: 100,
    minHeight: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 14,
  },
  scanButtonTextCompact: { color: '#fff', fontWeight: '700', fontSize: 13, marginLeft: 6 },
  fieldCard: { flex: 1 },
  flexField: { flex: 1 },
  amountField: { width: 160, marginLeft: 10 },
  dateGroup: { width: 180, marginLeft: 10 },
  repeatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  repeatChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 34, justifyContent: 'center' },
  repeatChipText: { fontSize: 13, fontWeight: '600' },
  transferArrow: { alignSelf: 'flex-end', marginHorizontal: 6, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  compactInput: { minHeight: 46, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, fontSize: 14 },
  amountInputContainer: { flexDirection: 'row', alignItems: 'center' },
  currencyBadge: { borderWidth: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  compactCurrencyBadge: { width: 50, height: 46, marginRight: 8 },
  currencyText: { fontSize: 12, fontWeight: '700' },
  amountInput: { flex: 1, minHeight: 46, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10 },
  amountPressable: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  amountTextInput: { flex: 1, minHeight: 44, paddingVertical: 0, marginRight: 4 },
  compactAmountInput: { fontSize: 14, fontWeight: '600' },
  inlineErrorText: { fontSize: 11, marginTop: 4, fontWeight: '600' },
  inlineWarningText: { fontSize: 11, marginTop: 4, fontWeight: '600' },
  compactPicker: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconInputText: { fontSize: 14, fontWeight: '500', flex: 1, marginRight: 8 },
  inlineDateActions: { flexDirection: 'row' },
  miniAction: {
    flex: 1,
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 4,
  },
  miniActionText: { marginLeft: 4, fontSize: 12, fontWeight: '600' },
  inputGroupCompact: { marginBottom: 12 },
  inlineSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitleCompact: { fontSize: 14, fontWeight: '700' },
  detailsModeToggle: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  compactDetailsToggle: { minHeight: 38 },
  detailsModeBtn: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', minWidth: 54 },
  compactDetailsBtn: { paddingHorizontal: 12 },
  detailsModeText: { fontSize: 12, fontWeight: '700' },
  noteInputCompact: { minHeight: 88, paddingTop: 12 },
  attachmentCompact: {
    minHeight: 90,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentCompactEmpty: { alignItems: 'center', justifyContent: 'center', padding: 12 },
  attachmentCompactText: { marginTop: 4, fontSize: 12 },
  imagePreviewWrap: { width: '100%', height: 140, position: 'relative' },
  previewImageCompact: { width: '100%', height: '100%' },
  removeImageBtnCompact: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rawOcrCard: {
    borderWidth: 1,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
  },
  rawOcrHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    minHeight: 44,
  },
  rawOcrHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rawOcrTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  rawOcrBody: {
    borderTopWidth: 1,
    padding: 12,
  },
  rawOcrContent: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  templatesSection: { marginBottom: 12 },
  templatesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  templatesLabel: { marginBottom: 0 },
  templatesHint: { fontSize: 11, fontWeight: '500' },
  templatesScroll: { gap: 8, paddingVertical: 2 },
  templateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    gap: 6,
    maxWidth: 220,
  },
  templateDot: { width: 8, height: 8, borderRadius: 4 },
  templateChipName: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  templateChipAmount: { fontSize: 12, fontWeight: '600' },
  actionStack: { marginTop: 8, gap: 10 },
  secondaryActionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  secondaryActionButton: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 14,
  },
  templateSaveButton: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 14,
  },
  secondaryActionText: { fontSize: 14, fontWeight: '700' },
  templateFeedbackText: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  saveButton: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  saveButtonCompact: { paddingHorizontal: 18 },
  saveButtonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
