import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';

import {
  formatAmountForInput,
  formatAmountInput,
  formatDisplayCurrency,
  formatStoredAmountForInput,
  getCurrencySymbol,
  isAmountWithinRange,
  parseSignedAmount,
} from '../features/transactions/amount';
import { getCategoryTypeForTransaction } from '../features/transactions/categories';
import { TRANSFER_CATEGORY_LABEL } from '../features/transactions/constants';
import { createTransactionInput, deriveEditableTransactionType, normalizeTransactionInput } from '../features/transactions/factories';
import {
  createReceiptItemDraft,
  parseReceiptLineItemsText,
  serializeReceiptLineItems,
  type ReceiptLineItemDraft,
} from '../features/transactions/lineItems';
import { buildEditableTransactionInput } from '../features/transactions/mappers';
import type { Transaction, TransactionInput, TransactionType, TransactionUIInputMode } from '../features/transactions/types';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { NavigationProps, AddTransactionScreenRouteProp } from '../navigation/types';
import { analyzeReceiptImage, RECEIPT_SCAN_CANCELLED, type ParsedReceiptResult } from '../services/ai/agent';
import { describeDateDistance, getUnrealisticDateWarning, isFarFromToday } from '../features/transactions/dateSanity';
import type { ActivitySource } from '../features/activity/activityLog';
import { walletCurrencyOf } from '../features/currency/currencies';
import {
  CurrencyConversionError,
  formatRate,
  parseRateText,
  resolveEntryAmounts,
  roundRate,
  resolveTransferAmounts,
  type CurrencyFields,
} from '../features/currency/conversion';
import { getCachedRate, getDailyRate } from '../services/fx/rates';
import type { ReceiptConfidenceAssessment } from '../services/ocr/receiptConfidence';
import { useReceiptQueueStore } from '../store/useReceiptQueueStore';
import { ConfidenceNotice } from '../components/ConfidenceBadge';
import { capturePhotoWithCamera, captureReceiptWithFallback } from '../services/ocr/documentScanner';
import { AccountPickerModal } from '../components/AccountPickerModal';
import { AmountCalculatorModal } from '../components/AmountCalculatorKeypad';
import { ReceiptPhotoModal } from '../components/ReceiptPhotoModal';
import { TagInput } from '../components/TagInput';
import { persistReceiptImage, scanGalleryImage } from '../services/receiptImages';
import {
  RECURRING_FREQUENCIES,
  createRecurringRule,
  deleteRecurringRule,
  findRecurringRuleForTransaction,
  updateRecurringRule,
  type RecurringFrequency,
} from '../services/recurring';
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
import { consumeTrustedSharedImage } from '../services/ocr/normalizeImage';

import { ReceiptItemsEditor } from '../components/ReceiptItemsEditor';
import { CategorySelectorModal } from '../components/CategorySelectorModal';
import { SourceSelectorModal } from '../components/SourceSelectorModal';
import { confirmRemoveSplit } from '../features/splits/confirmRemoveSplit';
import { useSplitsStore } from '../features/splits/store';

export { parseReceiptLineItemsText, serializeReceiptLineItems };

export const AddTransactionScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<AddTransactionScreenRouteProp>();
  const editingId = route.params?.transactionId;
  const duplicateFromId = route.params?.duplicateFromId;
  const receiptQueueId = route.params?.receiptQueueId;
  const reviewBatchIndexParam = route.params?.reviewBatchIndex;
  const reviewBatchTotalParam = route.params?.reviewBatchTotal;
  const initialDate = route.params?.initialDate;
  const sharedImageUri = route.params?.sharedImageUri;
  const openSplitAfterSave = route.params?.openSplitAfterSave;
  const handledSharedImageRef = useRef<string | null>(null);
  const splits = useSplitsStore((s) => s.splits);
  const ensureSplitsLoaded = useSplitsStore((s) => s.ensureLoaded);
  useEffect(() => {
    if (editingId) {
      ensureSplitsLoaded();
    }
  }, [editingId, ensureSplitsLoaded]);
  const editingSplitCount = useMemo(
    () => (editingId ? splits.filter((s) => s.transactionId === editingId).length : 0),
    [editingId, splits]
  );
  const deleteBillSplits = useSplitsStore((s) => s.deleteBillSplits);
  const handleRemoveSplit = () => {
    if (!editingId) return;
    confirmRemoveSplit(
      title.trim() || 'this expense',
      splits.filter((s) => s.transactionId === editingId),
      (options) => void deleteBillSplits(editingId, options)
    );
  };
  const editingSplitUnpaid = useMemo(
    () => (editingId ? splits.filter((s) => s.transactionId === editingId && !s.isSettled).length : 0),
    [editingId, splits]
  );
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const queueItems = useReceiptQueueStore((s) => s.items);

  const addTransaction = useTransactionStore((s) => s.addTransaction);
  const updateTransaction = useTransactionStore((s) => s.updateTransaction);
  const deleteTransaction = useTransactionStore((s) => s.deleteTransaction);
  const isSaving = useTransactionStore((s) => s.isSaving);
  const categories = useTransactionStore((s) => s.categories);
  const addCategory = useTransactionStore((s) => s.addCategory);
  const getCategoriesByType = useTransactionStore((s) => s.getCategoriesByType);
  const normalizeCategoryForType = useTransactionStore((s) => s.normalizeCategoryForType);

  const [type, setType] = useState<TransactionType>('expense');
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [toAccountError, setToAccountError] = useState<string | null>(null);
  const [scanConfidence, setScanConfidence] = useState<ReceiptConfidenceAssessment | null>(null);
  const wallets = useTransactionStore((s) => s.wallets);
  const defaultWalletId = wallets.find((w) => w.isActive)?.id ?? null;
  const [walletId, setWalletId] = useState<number | null>(null);
  const [toWalletId, setToWalletId] = useState<number | null>(null);
  const [accountPicker, setAccountPicker] = useState<'from' | 'to' | null>(null);
  const [repeat, setRepeat] = useState<RecurringFrequency | null>(null);
  const linkedRecurringRuleIdRef = useRef<number | null>(null);
  const initialRepeatRef = useRef<RecurringFrequency | null>(null);
  const originalEditedTxRef = useRef<Transaction | null>(null);

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

  // ---- Foreign-currency accounts -------------------------------------------------------------
  // Amounts on a foreign account can be typed in its currency or the home currency; a rate converts
  // between them. Transfers between currencies record what arrived. See features/currency/conversion.ts.
  const fromWallet = wallets.find((w) => w.id === effectiveWalletId) ?? null;
  const toWallet = wallets.find((w) => w.id === effectiveToWalletId) ?? null;
  const fromCurrency = walletCurrencyOf(fromWallet, currencyCode);
  const toCurrency = walletCurrencyOf(toWallet, currencyCode);
  const [entryCurrency, setEntryCurrency] = useState<string | null>(null);
  // Where this entry came from, for the activity log ('scan', 'template'); Receipt Inbox entries are 'receipt'.
  const entrySourceRef = useRef<ActivitySource | undefined>(undefined);
  // The date read from a scanned receipt, until the user picks another date.
  const [scannedDateMs, setScannedDateMs] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const knownTags = useTransactionStore((s) => s.tags);
  const tagSuggestions = useMemo(() => (knownTags ?? []).map((t) => t.name), [knownTags]);
  const amountCurrency =
    type === 'transfer'
      ? fromCurrency
      : entryCurrency && (entryCurrency === fromCurrency || entryCurrency === currencyCode)
        ? entryCurrency
        : fromCurrency;
  const isCrossCurrencyTransfer = type === 'transfer' && Boolean(effectiveToWalletId) && fromCurrency !== toCurrency;
  // A typed rate is needed when the home value can't be derived from a home-currency side.
  const rateCurrency =
    fromCurrency === currencyCode
      ? null
      : type !== 'transfer' || (toCurrency !== currencyCode && Boolean(effectiveToWalletId))
        ? fromCurrency
        : null;
  const involvesForeignCurrency = fromCurrency !== currencyCode || (type === 'transfer' && toCurrency !== currencyCode);
  const [rateText, setRateText] = useState('');
  const [rateSource, setRateSource] = useState<string | null>(null);
  const rateEditedRef = useRef(false);
  const [receivedText, setReceivedText] = useState('');
  const [currencyError, setCurrencyError] = useState<string | null>(null);
  const prevAmountCurrencyRef = useRef(amountCurrency);
  const prevRateCurrencyRef = useRef<string | null>(rateCurrency);

  // Keep the typed number when the amount's currency changes (e.g. switching to a ¥ account).
  useEffect(() => {
    const previous = prevAmountCurrencyRef.current;
    prevAmountCurrencyRef.current = amountCurrency;
    if (previous === amountCurrency) return;
    setAmount((current) =>
      current ? formatAmountForInput(Math.abs(parseSignedAmount(current, undefined, previous)), amountCurrency) : current
    );
  }, [amountCurrency]);

  // Default rate: today's market rate (fetched once a day), else the account's average exchange cost.
  useEffect(() => {
    if (prevRateCurrencyRef.current !== rateCurrency && prevRateCurrencyRef.current !== null) {
      rateEditedRef.current = false;
    }
    prevRateCurrencyRef.current = rateCurrency;
    if (!rateCurrency) return;
    let alive = true;
    const apply = (rate: number, source: string) => {
      if (!alive || rateEditedRef.current) return;
      setRateText(formatRate(rate));
      setRateSource(source);
    };
    const describeDaily = (date: string) => `Today's market rate${date ? ` (${date})` : ''}`;
    const cached = getCachedRate(rateCurrency, currencyCode);
    if (cached) apply(cached.rate, describeDaily(cached.date));
    else if (fromWallet?.averageRate) apply(roundRate(fromWallet.averageRate), 'Your average exchange cost');
    void getDailyRate(rateCurrency, currencyCode).then((daily) => {
      if (daily) apply(daily.rate, describeDaily(daily.date));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateCurrency, currencyCode]);

  // Recurring rules don't carry foreign amounts yet, so Repeat is off for foreign-currency entries.
  useEffect(() => {
    if (involvesForeignCurrency) setRepeat(null);
  }, [involvesForeignCurrency]);
  const [category, setCategory] = useState('');
  const [pendingScannedCategory, setPendingScannedCategory] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [lineItems, setLineItems] = useState<ReceiptLineItemDraft[]>([]);
  const [detailsMode, setDetailsMode] = useState<TransactionUIInputMode>('note');

  const [selectedDate, setSelectedDate] = useState(() =>
    typeof initialDate === 'number' && Number.isFinite(initialDate) ? new Date(initialDate) : new Date()
  );
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [photoViewerVisible, setPhotoViewerVisible] = useState(false);
  const [rawOcrText, setRawOcrText] = useState<string | null>(null);
  const [isRawTextExpanded, setIsRawTextExpanded] = useState<boolean>(false);
  const [sourceModalVisible, setSourceModalVisible] = useState(false);
  const [sourceModalTarget, setSourceModalTarget] = useState<'attachment' | 'scan' | null>(null);

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [customCategory, setCustomCategory] = useState('');

  const [isScanning, setIsScanning] = useState(false);
  const [scanStatusLabel, setScanStatusLabel] = useState<string | null>(null);
  // Lets the user abandon a slow scan; the photo that was attached before the scan is restored.
  const scanAbortRef = useRef<AbortController | null>(null);
  const imageBeforeScanRef = useRef<string | null>(null);
  const [calculatorVisible, setCalculatorVisible] = useState(false);
  const [templates, setTemplates] = useState<TransactionTemplate[]>([]);
  const [templateFeedback, setTemplateFeedback] = useState<string | null>(null);

  // Prevents the category validation effect from overwriting freshly hydrated form state during the same commit.
  const skipNextCategorySyncRef = useRef(false);

  const readyQueueItems = useMemo(() => queueItems.filter((item) => item.status === 'done'), [queueItems]);
  const reviewProgress = useMemo(() => {
    if (!receiptQueueId) return null;
    const derivedIndex = readyQueueItems.findIndex((item) => item.id === receiptQueueId);
    const total = Math.max(reviewBatchTotalParam ?? readyQueueItems.length, 1);
    const index = Math.min(
      Math.max(reviewBatchIndexParam ?? (derivedIndex >= 0 ? derivedIndex + 1 : 1), 1),
      total
    );
    return { index, total };
  }, [receiptQueueId, readyQueueItems, reviewBatchIndexParam, reviewBatchTotalParam]);

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

  const resetForm = (dateOverride?: number) => {
    const expenseCats = getCategoriesByType('expense');
    const fallbackCategory = expenseCats[0]?.name ?? normalizeCategoryForType('', 'expense');
    const nextForm = createTransactionInput({ category: fallbackCategory, type: 'expense' });
    skipNextCategorySyncRef.current = true;
    setTitle(nextForm.merchantName);
    setTitleError(null);
    setAmount('');
    setAmountError(null);
    setToAccountError(null);
    setScanConfidence(null);
    setCategory(nextForm.category);
    setPendingScannedCategory(null);
    setNote(nextForm.note ?? '');
    setLineItems(parseReceiptLineItemsText(nextForm.lineItemsText ?? ''));
    setDetailsMode('note');
    setImageUri(nextForm.imageUri ?? null);
    setPhotoViewerVisible(false);
    setType(nextForm.type);
    setSelectedDate(
      typeof dateOverride === 'number' && Number.isFinite(dateOverride) ? new Date(dateOverride) : new Date()
    );
    setScanStatusLabel(null);
    setRawOcrText(null);
    setIsRawTextExpanded(false);
    setWalletId(null);
    setToWalletId(null);
    setEntryCurrency(null);
    entrySourceRef.current = undefined;
    setScannedDateMs(null);
    setTags([]);
    setRateText('');
    setRateSource(null);
    rateEditedRef.current = false;
    setReceivedText('');
    setCurrencyError(null);
    setRepeat(null);
    linkedRecurringRuleIdRef.current = null;
    initialRepeatRef.current = null;
    originalEditedTxRef.current = null;
    setTemplateFeedback(null);
  };

  const populateFormFromTransaction = (
    tx: Partial<Transaction>,
    options: { preserveDateAndPhoto: boolean; dateOverride?: Date; loadRecurring?: boolean }
  ) => {
    const editableTransaction = buildEditableTransactionInput(tx);
    const editableType = deriveEditableTransactionType(editableTransaction.totalAmount, editableTransaction.type);
    const knownCategories = useTransactionStore.getState().categories;
    const resolvedCategory =
      editableType === 'transfer'
        ? editableTransaction.category || TRANSFER_CATEGORY_LABEL
        : knownCategories.length > 0
          ? normalizeCategoryForType(editableTransaction.category, editableType)
          : editableTransaction.category || normalizeCategoryForType('', editableType);

    skipNextCategorySyncRef.current = true;
    setTitle(editableTransaction.merchantName);
    setTitleError(null);
    // Foreign amounts reopen in the currency they were recorded in, with the rate they used.
    const recordedCurrency = editableTransaction.originalCurrency ?? currencyCode;
    const recordedAmount =
      editableTransaction.originalCurrency && editableTransaction.originalAmount != null
        ? editableTransaction.originalAmount
        : editableTransaction.totalAmount;
    prevAmountCurrencyRef.current = recordedCurrency;
    setEntryCurrency(recordedCurrency);
    setTags(editableTransaction.tags ?? []);
    setAmount(recordedAmount !== 0 ? formatAmountForInput(recordedAmount, recordedCurrency) : '');
    setRateText(editableTransaction.fxRate ? formatRate(editableTransaction.fxRate) : '');
    rateEditedRef.current = Boolean(editableTransaction.fxRate);
    setRateSource(editableTransaction.fxRate ? 'Rate saved with this transaction' : null);
    setReceivedText('');
    setCurrencyError(null);
    setAmountError(null);
    setToAccountError(null);
    setScanConfidence(null);
    setType(editableType);
    setCategory(resolvedCategory);
    setPendingScannedCategory(null);
    setNote(editableTransaction.note || '');
    setLineItems(
      parseReceiptLineItemsText(editableTransaction.lineItemsText || '').map((item) => ({
        ...item,
        price: formatStoredAmountForInput(item.price, currencyCode),
      }))
    );
    setDetailsMode(editableTransaction.lineItemsText ? (editableTransaction.note ? 'both' : 'receipt') : 'note');
    setSelectedDate(
      options.dateOverride
        ? new Date(options.dateOverride.getTime())
        : options.preserveDateAndPhoto
          ? new Date(editableTransaction.date)
          : new Date()
    );
    setImageUri(options.preserveDateAndPhoto ? editableTransaction.imageUri || null : null);
    setPhotoViewerVisible(false);
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
    if (editableType === 'transfer' && editableTransaction.toAmount != null) {
      const receivingWallet = knownWallets.find((w) => w.id === resolvedToId) ?? null;
      setReceivedText(
        formatAmountForInput(Math.abs(editableTransaction.toAmount), walletCurrencyOf(receivingWallet, currencyCode))
      );
    }

    if (options.loadRecurring) {
      const matchedRule = findRecurringRuleForTransaction({
        merchantName: editableTransaction.merchantName,
        totalAmount: editableTransaction.totalAmount,
        type: editableType,
        category: resolvedCategory,
        date: editableTransaction.date,
        walletId: resolvedFromId ?? undefined,
        toWalletId: resolvedToId,
      });
      linkedRecurringRuleIdRef.current = matchedRule?.id ?? null;
      const loadedFrequency = matchedRule?.isActive ? matchedRule.frequency : null;
      initialRepeatRef.current = loadedFrequency;
      setRepeat(loadedFrequency);
    } else {
      linkedRecurringRuleIdRef.current = null;
      initialRepeatRef.current = null;
      setRepeat(null);
    }

    setRawOcrText(null);
    setIsRawTextExpanded(false);
    setTemplateFeedback(null);
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
    if (parsedData.merchantName) {
      setTitle(parsedData.merchantName);
      setTitleError(null);
    }
    if (parsedData.totalAmount) {
      setAmount(formatAmountForInput(parsedData.totalAmount, amountCurrency));
      setAmountError(isAmountWithinRange(parsedData.totalAmount) ? null : 'Amount is too large');
    }
    if (parsedData.category) {
      const detectedCategory = parsedData.category.trim();
      const currentAvailable = getCategoriesByType(getCategoryTypeForTransaction(type));
      const existingCategory = currentAvailable.find(
        (item) => item.name.toLowerCase() === detectedCategory.toLowerCase()
      );
      skipNextCategorySyncRef.current = true;
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
    entrySourceRef.current = 'scan';
    if (parsedData.date) {
      const parsedDate = new Date(parsedData.date);
      if (!isNaN(parsedDate.getTime())) {
        setSelectedDate(parsedDate);
        setScannedDateMs(parsedDate.getTime());
      }
    }
  };

  useEffect(() => {
    if (editingId) {
      const latestTransactions = useTransactionStore.getState().transactionsList;
      const tx = latestTransactions.find((transaction) => transaction.id === editingId);
      if (tx) {
        originalEditedTxRef.current = tx;
        populateFormFromTransaction(tx, { preserveDateAndPhoto: true, loadRecurring: true });
      }
    } else if (duplicateFromId) {
      originalEditedTxRef.current = null;
      const latestTransactions = useTransactionStore.getState().transactionsList;
      const tx = latestTransactions.find((transaction) => transaction.id === duplicateFromId);
      if (tx) {
        populateFormFromTransaction(tx, { preserveDateAndPhoto: false });
      } else {
        resetForm();
      }
    } else {
      originalEditedTxRef.current = null;
      resetForm(initialDate);
      const queued = receiptQueueId
        ? useReceiptQueueStore.getState().items.find((item) => item.id === receiptQueueId)
        : undefined;
      if (queued?.result) {
        setImageUri(queued.imageUri);
        applyScanResult(queued.result);
      }
    }
  }, [editingId, duplicateFromId, receiptQueueId, initialDate]);

  useEffect(() => {
    if (skipNextCategorySyncRef.current) {
      skipNextCategorySyncRef.current = false;
      return;
    }

    if (type === 'transfer') {
      return;
    }

    if (pendingScannedCategory && category === pendingScannedCategory) {
      return;
    }

    if (availableCategories.length === 0) {
      if (!category) {
        setCategory(normalizeCategoryForType('', type));
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

  const handleTypeChange = (nextType: TransactionType) => {
    if (nextType === type) return;
    setType(nextType);
    setTitleError(null);
    setToAccountError(null);
    setPendingScannedCategory(null);
    if (nextType !== 'transfer') {
      const nextCats = getCategoriesByType(getCategoryTypeForTransaction(nextType));
      skipNextCategorySyncRef.current = true;
      setCategory(nextCats[0]?.name ?? normalizeCategoryForType('', nextType));
    }
  };

  const openPicker = (mode: 'date' | 'time') => {
    setPickerMode(mode);
    setShowPicker(true);
  };

  const onDateChange = (_event: unknown, date?: Date) => {
    setShowPicker(false);
    if (date) {
      setSelectedDate(date);
      setScannedDateMs(null);
    }
  };

  const handleAmountChange = (text: string) => {
    setScanConfidence(null);
    const formatted = formatAmountInput(text, amountCurrency);
    setAmount(formatted);
    if (text.trim().length > 0) {
      const parsed = Math.abs(parseSignedAmount(text, undefined, amountCurrency));
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
    const parsedItems = parseReceiptLineItemsText(value).map((item) => ({
      ...item,
      price: formatStoredAmountForInput(item.price, currencyCode),
    }));
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

  const notifySkippedDuplicates = (skippedDuplicates?: number) => {
    if (!skippedDuplicates || skippedDuplicates <= 0) return;
    const noun = skippedDuplicates === 1 ? 'duplicate receipt was' : 'duplicate receipts were';
    Alert.alert(
      'Duplicate receipts skipped',
      `${skippedDuplicates} ${noun} already in the inbox and skipped.`
    );
  };

  const launchGalleryPicker = async (target: 'attachment' | 'scan' | null) => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        // Scanning accepts several receipts at once; they go to the Receipt Inbox and are read in the background.
        allowsMultipleSelection: target === 'scan',
        selectionLimit: target === 'scan' ? 0 : 1,
      });

      if (result.canceled || !result.assets || !result.assets[0]?.uri) return;

      if (target === 'scan' && result.assets.length > 1) {
        const queued = await useReceiptQueueStore
          .getState()
          .enqueue(result.assets.map((asset) => asset.uri), { scan: true });
        notifySkippedDuplicates(queued?.skippedDuplicates);
        navigation.navigate('ReceiptInbox');
        return;
      }

      if (target === 'scan') {
        void processScanReceipt(result.assets[0].uri, undefined, { fromGallery: true });
      } else {
        setImageUri(result.assets[0].uri);
      }
    } catch (error) {
      Alert.alert('Image Error', getErrorMessage(error, 'Failed to pick an image. Please try again.'));
    }
  };

  const pickImage = async (source: 'gallery' | 'camera') => {
    const target = sourceModalTarget;
    setSourceModalVisible(false);

    if (source === 'gallery') {
      await launchGalleryPicker(target);
      return;
    }

    if (target === 'scan') {
      const captured = await captureReceiptWithFallback({
        onImportFromGallery: () => launchGalleryPicker('scan'),
      });
      if (captured.status !== 'captured') return;
      if (captured.uris.length > 1) {
        const queued = await useReceiptQueueStore
          .getState()
          .enqueue(captured.uris, { scan: captured.source === 'camera' });
        notifySkippedDuplicates(queued?.skippedDuplicates);
        navigation.navigate('ReceiptInbox');
      } else if (captured.uris.length === 1) {
        // A plain camera photo (no document scanner on this phone) gets the same scan treatment as gallery picks.
        void processScanReceipt(captured.uris[0], undefined, { fromGallery: captured.source === 'camera' });
      }
      return;
    }

    const captured = await capturePhotoWithCamera({
      onImportFromGallery: () => launchGalleryPicker('attachment'),
    });
    if (captured.status === 'captured' && captured.uris[0]) {
      setImageUri(captured.uris[0]);
    }
  };

  const processScanReceipt = async (uri: string, base64String?: string, source: { fromGallery?: boolean } = {}) => {
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    imageBeforeScanRef.current = imageUri;
    setImageUri(uri);
    setIsScanning(true);
    setScanStatusLabel('Reading text…');
    setRawOcrText(null);
    setIsRawTextExpanded(false);

    try {
      // Gallery photos become a document-style scan first, like the camera's scanner: cropped,
      // straightened and black and white. That scan is the photo kept with the transaction.
      let scanUri = uri;
      let alreadyScanned = false;
      if (source.fromGallery) {
        setScanStatusLabel('Straightening the photo…');
        const scanned = await scanGalleryImage(uri);
        if (controller.signal.aborted) return;
        scanUri = scanned.uri;
        alreadyScanned = scanned.scanned;
        if (scanned.scanned) setImageUri(scanned.uri);
      }
      const parsedData = await analyzeReceiptImage(
        scanUri,
        base64String ?? undefined,
        (status: string) => {
          if (controller.signal.aborted) return;
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
        },
        { signal: controller.signal, alreadyScanned }
      );
      if (controller.signal.aborted) return;

      if (parsedData) {
        // A sideways/upside-down receipt comes back turned upright; keep that version as the photo.
        if (parsedData.imageUri) setImageUri(parsedData.imageUri);
        applyScanResult(parsedData);
        setScanStatusLabel(null);
      } else {
        Alert.alert('Scan Result', 'Extracted image details. Review and adjust fields if needed.');
        setScanStatusLabel(null);
      }
    } catch (error: any) {
      if (controller.signal.aborted || error?.message === RECEIPT_SCAN_CANCELLED) return;
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
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
    }
  };

  const cancelScan = () => {
    const controller = scanAbortRef.current;
    if (!controller) return;
    scanAbortRef.current = null;
    controller.abort();
    setIsScanning(false);
    setScanStatusLabel(null);
    setImageUri(imageBeforeScanRef.current);
  };

  useEffect(() => () => scanAbortRef.current?.abort(), []);

  // A receipt photo shared from another app: treat it like a gallery pick (scan, then read).
  useEffect(() => {
    if (!sharedImageUri || handledSharedImageRef.current === sharedImageUri) return;
    handledSharedImageRef.current = sharedImageUri;
    // Only photos from the share sheet; a silo:// link cannot make Silo read an arbitrary file.
    if (!consumeTrustedSharedImage(sharedImageUri)) return;
    void processScanReceipt(sharedImageUri, undefined, { fromGallery: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedImageUri]);

  const openScanSourceModal = () => {
    setSourceModalTarget('scan');
    setSourceModalVisible(true);
  };

  const openAttachmentSourceModal = () => {
    setSourceModalTarget('attachment');
    setSourceModalVisible(true);
  };

  const parseRate = (text: string): number | null => parseRateText(text);

  /** Home amount plus the foreign side for this entry; throws CurrencyConversionError when a rate/amount is missing. */
  const computeCurrencyFields = (): CurrencyFields => {
    const typed = Math.abs(parseSignedAmount(amount, undefined, amountCurrency));
    if (type === 'transfer') {
      return resolveTransferAmounts({
        homeCurrency: currencyCode,
        fromCurrency,
        toCurrency: effectiveToWalletId ? toCurrency : fromCurrency,
        sent: typed,
        received: receivedText ? Math.abs(parseSignedAmount(receivedText, undefined, toCurrency)) : null,
        sourceRate: parseRate(rateText),
      });
    }
    return resolveEntryAmounts({
      homeCurrency: currencyCode,
      walletCurrency: fromCurrency,
      enteredCurrency: amountCurrency,
      amount: typed,
      sign: type === 'income' ? 1 : -1,
      rate: parseRate(rateText),
    });
  };

  const buildTransactionPayload = (categoryOverride?: string, imageOverride?: string | null): TransactionInput => {
    const signedType = type === 'transfer' ? 'expense' : type;
    let currencyFields: CurrencyFields | null = null;
    try {
      currencyFields = computeCurrencyFields();
    } catch {
      currencyFields = null;
    }

    return normalizeTransactionInput(
      createTransactionInput({
        ...(currencyFields ?? {}),
        merchantName: title.trim() || (type === 'transfer' ? 'Transfer' : title),
        totalAmount: currencyFields ? currencyFields.totalAmount : parseSignedAmount(amount, signedType, currencyCode),
        type,
        category:
          type === 'transfer'
            ? TRANSFER_CATEGORY_LABEL
            : (categoryOverride ?? category).trim() || normalizeCategoryForType('', type),
        date: selectedDate.getTime(),
        note,
        lineItemsText,
        imageUri: (imageOverride !== undefined ? imageOverride : imageUri) || null,
        walletId: effectiveWalletId ?? undefined,
        toWalletId: type === 'transfer' ? effectiveToWalletId : null,
        tags,
      })
    );
  };

  /**
   * Back to the Receipt Inbox already under this screen (pop), instead of pushing another inbox on top,
   * so Back from the inbox never reopens a receipt that was just reviewed and saved.
   */
  const returnToReceiptInbox = () => {
    const navAny = navigation as unknown as {
      getState?: () => { routes?: Array<{ name: string }> } | undefined;
      popTo?: (name: string) => void;
    };
    const inStack = navAny.getState?.()?.routes?.some((route) => route.name === 'ReceiptInbox');
    if (inStack && typeof navAny.popTo === 'function') {
      navAny.popTo('ReceiptInbox');
    } else {
      navigation.navigate('ReceiptInbox');
    }
  };

  const returnToPreviousScreen = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('MainTabs', { screen: 'Cashflow' });
    }
  };

  const handleSave = () => saveTransaction();

  const saveTransaction = async (skipDateCheck = false, dateOverride?: Date) => {
    let hasValidationError = false;

    if (type === 'transfer') {
      if (!effectiveToWalletId || effectiveToWalletId === effectiveWalletId) {
        setToAccountError('Choose a different destination account');
        Alert.alert('Choose accounts', 'Pick the account the money goes to (different from the one it leaves).');
        return;
      }
      setToAccountError(null);
      setTitleError(null);
      if (!title.trim()) setTitle('Transfer');
    } else if (!title.trim()) {
      setTitleError(type === 'income' ? 'Please enter a source' : 'Please enter a title');
      hasValidationError = true;
    } else {
      setTitleError(null);
    }

    const parsedAmt = Math.abs(parseSignedAmount(amount, undefined, amountCurrency));
    if (!amount || parsedAmt === 0 || Number.isNaN(parsedAmt)) {
      setAmountError('Amount must be greater than 0');
      hasValidationError = true;
    } else if (!isAmountWithinRange(parsedAmt)) {
      setAmountError('Amount is too large');
      hasValidationError = true;
    } else {
      setAmountError(null);
    }

    if (!hasValidationError && involvesForeignCurrency) {
      try {
        computeCurrencyFields();
        setCurrencyError(null);
      } catch (error) {
        setCurrencyError(error instanceof CurrencyConversionError ? error.message : 'Check the exchange details.');
        hasValidationError = true;
      }
    }

    if (hasValidationError) {
      return;
    }

    // Warn before saving an implausible date (e.g. a scanned 07-07-97 tax date read as 2097),
    // unless an edited transaction keeps the date it already had.
    const effectiveDate = dateOverride ?? selectedDate;
    const keepsOriginalDate = Boolean(editingId && originalEditedTxRef.current?.date === effectiveDate.getTime());
    const dateWarning = skipDateCheck || keepsOriginalDate ? null : getUnrealisticDateWarning(effectiveDate);
    if (dateWarning) {
      const dateLabel = selectedDate.toLocaleDateString(dateFormat || 'en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      Alert.alert('Check the date', `This transaction is dated ${dateLabel}. ${dateWarning} Save it anyway?`, [
        { text: 'Change date', style: 'cancel', onPress: () => openPicker('date') },
        {
          text: 'Save anyway',
          onPress: () => {
            void saveTransaction(true);
          },
        },
      ]);
      return;
    }

    // A receipt date far from today is usually a misread year or day ("2025" for "2026"): confirm it once.
    const scannedDateFar =
      !skipDateCheck && scannedDateMs != null && effectiveDate.getTime() === scannedDateMs && isFarFromToday(effectiveDate);
    if (scannedDateFar) {
      const dateLabel = effectiveDate.toLocaleDateString(dateFormat || 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      Alert.alert('Check the receipt date', `The receipt was read as ${dateLabel}, ${describeDateDistance(effectiveDate)}. Is that right?`, [
        {
          text: 'Use today',
          onPress: () => {
            const today = new Date();
            setSelectedDate(today);
            setScannedDateMs(null);
            void saveTransaction(true, today);
          },
        },
        {
          text: `Keep ${dateLabel}`,
          onPress: () => {
            void saveTransaction(true);
          },
        },
      ]);
      return;
    }

    try {
      let resolvedCategory = category;
      if (type !== 'transfer' && category) {
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

      // Picked/scanned photos live in cache folders Android may clear; keep a permanent copy.
      const storedImage = await persistReceiptImage(imageUri);
      if (storedImage !== imageUri) setImageUri(storedImage);
      const data = { ...buildTransactionPayload(resolvedCategory, storedImage), date: effectiveDate.getTime() };

      if (editingId) {
        await updateTransaction(editingId, data);

        const linkedId = linkedRecurringRuleIdRef.current;
        const repeatChanged = repeat !== initialRepeatRef.current;
        const original = originalEditedTxRef.current;
        const txFieldsChanged = Boolean(
          original &&
            (original.merchantName !== data.merchantName ||
              original.totalAmount !== data.totalAmount ||
              original.type !== data.type ||
              original.category !== data.category ||
              (original.note ?? '') !== (data.note ?? '') ||
              (original.lineItemsText ?? '') !== (data.lineItemsText ?? '') ||
              original.walletId !== data.walletId ||
              (original.toWalletId ?? null) !== (data.toWalletId ?? null))
        );

        if (linkedId !== null) {
          if (repeat === null && repeatChanged) {
            deleteRecurringRule(linkedId);
          } else if (repeat !== null && (repeatChanged || txFieldsChanged)) {
            updateRecurringRule(linkedId, data, repeat);
          }
        } else if (repeat !== null) {
          createRecurringRule(data, repeat, data.date);
        }
      } else {
        const source = receiptQueueId ? 'receipt' : entrySourceRef.current;
        const newTransactionId = source ? await addTransaction(data, { source }) : await addTransaction(data);
        if (repeat) {
          createRecurringRule(data, repeat, data.date);
        }
        if (receiptQueueId) {
          // The transaction now owns the receipt photo; keep the receipt in "Recently saved" to fix later.
          useReceiptQueueStore.getState().markSaved(receiptQueueId, typeof newTransactionId === 'number' ? newTransactionId : null);

          const remainingReady = useReceiptQueueStore
            .getState()
            .items.filter((item) => item.status === 'done');
          const nextReady = remainingReady[0];
          if (nextReady) {
            const nextBatchTotal = Math.max(reviewProgress?.total ?? remainingReady.length + 1, remainingReady.length + 1);
            const nextBatchIndex = Math.min((reviewProgress?.index ?? 1) + 1, nextBatchTotal);
            const nextParams = {
              receiptQueueId: nextReady.id,
              reviewBatchIndex: nextBatchIndex,
              reviewBatchTotal: nextBatchTotal,
            };
            const navAny = navigation as unknown as {
              replace?: (screen: string, params: Record<string, unknown>) => void;
            };
            if (typeof navAny.replace === 'function') {
              navAny.replace('AddTransactionStack', nextParams);
            } else {
              navigation.navigate('AddTransactionStack', nextParams);
            }
          } else {
            returnToReceiptInbox();
          }
          return;
        }
        if (openSplitAfterSave && data.type === 'expense' && typeof newTransactionId === 'number') {
          const navAny = navigation as unknown as {
            replace?: (screen: string, params: Record<string, unknown>) => void;
          };
          if (typeof navAny.replace === 'function') {
            navAny.replace('SplitBillEditor', { transactionId: newTransactionId });
          } else {
            navigation.navigate('SplitBillEditor', { transactionId: newTransactionId });
          }
          setTimeout(() => resetForm(), 100);
          return;
        }
      }

      returnToPreviousScreen();
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
        setToAccountError('Choose a different destination account');
        Alert.alert('Choose accounts', 'Pick the account the money goes to (different from the one it leaves).');
        return;
      }
      setToAccountError(null);
    } else if (!title.trim()) {
      setTitleError(type === 'income' ? 'Please enter a source' : 'Please enter a title');
      return;
    } else {
      setTitleError(null);
    }

    if (amount.trim().length > 0) {
      const parsedAmt = Math.abs(parseSignedAmount(amount, undefined, amountCurrency));
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
    const preservedDate = Number.isFinite(selectedDate.getTime())
      ? selectedDate
      : typeof initialDate === 'number' && Number.isFinite(initialDate)
        ? new Date(initialDate)
        : new Date();
    entrySourceRef.current = 'template';
    populateFormFromTransaction(
      {
        ...item.template,
        date: preservedDate.getTime(),
        imageUri: null,
      },
      { preserveDateAndPhoto: false, dateOverride: preservedDate }
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
            returnToPreviousScreen();
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
        skipNextCategorySyncRef.current = true;
        setCategory(createdCategory);
        setPendingScannedCategory(null);
        setCustomCategory('');
        setCategoryModalVisible(false);
      } catch (error) {
        Alert.alert('Category Error', getErrorMessage(error, 'Failed to add category.'));
      }
    }
  };

  const currencySymbol = getCurrencySymbol(amountCurrency);

  const fxSummary = (() => {
    if (!involvesForeignCurrency) return null;
    const typed = amount ? Math.abs(parseSignedAmount(amount, undefined, amountCurrency)) : 0;
    const rate = parseRate(rateText);
    const rateLabel = (value: number, code: string) =>
      `${getCurrencySymbol(code)} ${value.toLocaleString('id-ID', { maximumFractionDigits: 4 })}`;
    const sourceNote = rateSource ? ` · ${rateSource}` : '';
    if (type !== 'transfer') {
      if (!typed || !rate) return rateSource;
      return amountCurrency === currencyCode
        ? `≈ ${formatDisplayCurrency(typed / rate, fromCurrency, useThousandsSeparator)} from this account${sourceNote}`
        : `≈ ${formatDisplayCurrency(typed * rate, currencyCode, useThousandsSeparator)}${sourceNote}`;
    }
    const received = receivedText ? Math.abs(parseSignedAmount(receivedText, undefined, toCurrency)) : 0;
    if (isCrossCurrencyTransfer && typed && received) {
      if (fromCurrency === currencyCode) return `Exchange rate: 1 ${toCurrency} = ${rateLabel(typed / received, currencyCode)}`;
      if (toCurrency === currencyCode) return `Exchange rate: 1 ${fromCurrency} = ${rateLabel(received / typed, currencyCode)}`;
      return `Exchange rate: 1 ${fromCurrency} = ${rateLabel(received / typed, toCurrency)}`;
    }
    if (rateCurrency && typed && rate) {
      return `≈ ${formatDisplayCurrency(typed * rate, currencyCode, useThousandsSeparator)}${sourceNote}`;
    }
    return null;
  })();
  const titleLabel = type === 'transfer' ? 'Description' : type === 'income' ? 'Source *' : 'Title *';
  const titlePlaceholder =
    type === 'transfer'
      ? 'Description (optional)'
      : type === 'income'
        ? 'Source (e.g. Salary, Client)'
        : 'Merchant or title';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      {/* Pinned Top Header */}
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={styles.headerBackButton}
          onPress={() => {
            resetForm();
            if (receiptQueueId) {
              returnToReceiptInbox();
            } else if (navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('MainTabs', { screen: 'Cashflow' });
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerScreenTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]}>
            {editingId ? 'Edit Transaction' : receiptQueueId ? 'Review Receipt' : 'Add Transaction'}
          </Text>
          {reviewProgress ? (
            <Text
              style={[styles.reviewProgressText, { color: theme.primary, fontSize: theme.scaleFont(12) }]}
              accessibilityLabel={`Receipt ${reviewProgress.index} of ${reviewProgress.total}`}
            >
              {reviewProgress.index} of {reviewProgress.total}
            </Text>
          ) : null}
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardShell}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >

          {/* Quick-entry Templates Strip */}
          {!editingId && templates.length > 0 ? (
            <View style={styles.templatesSection}>
              <View style={styles.templatesHeaderRow}>
                <Text style={[styles.label, styles.templatesLabel, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  Templates
                </Text>
                <Text style={[styles.templatesHint, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Tap to fill · hold to remove
                </Text>
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
                      <Text
                        style={[styles.templateChipName, { color: theme.text, fontSize: theme.scaleFont(13) }]}
                        numberOfLines={1}
                      >
                        {tpl.name}
                      </Text>
                      {amountPreview ? (
                        <Text
                          style={[styles.templateChipAmount, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}
                          numberOfLines={1}
                        >
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
                <Text style={[styles.scanStatusTitle, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>
                  Scanning Receipt
                </Text>
                <Text style={[styles.scanStatusSub, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  {scanStatusLabel || 'Extracting text and identifying line items...'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={cancelScan}
                style={[styles.scanCancelButton, { borderColor: theme.primary }]}
                accessibilityRole="button"
                accessibilityLabel="Cancel scan"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.scanCancelText, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Type Toggle + Scan Receipt Button */}
          <View style={styles.compactRow}>
            <View
              style={[
                styles.typeToggle,
                type !== 'transfer' ? styles.compactTypeToggle : styles.flexField,
                { borderColor: theme.border, backgroundColor: theme.surface },
              ]}
            >
              <TouchableOpacity
                style={[
                  styles.toggleBtn,
                  styles.compactToggleBtn,
                  { backgroundColor: type === 'expense' ? theme.expense : 'transparent' },
                ]}
                onPress={() => handleTypeChange('expense')}
                accessibilityRole="button"
                accessibilityLabel="Set Expense type"
              >
                <Text
                  style={[
                    styles.toggleText,
                    { color: type === 'expense' ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(14) },
                  ]}
                >
                  Expense
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleBtn,
                  styles.compactToggleBtn,
                  { backgroundColor: type === 'income' ? theme.income : 'transparent' },
                ]}
                onPress={() => handleTypeChange('income')}
                accessibilityRole="button"
                accessibilityLabel="Set Income type"
              >
                <Text
                  style={[
                    styles.toggleText,
                    { color: type === 'income' ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(14) },
                  ]}
                >
                  Income
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toggleBtn,
                  styles.compactToggleBtn,
                  { backgroundColor: type === 'transfer' ? theme.primary : 'transparent' },
                ]}
                onPress={() => handleTypeChange('transfer')}
                accessibilityRole="button"
                accessibilityLabel="Set Transfer type"
              >
                <Text
                  style={[
                    styles.toggleText,
                    { color: type === 'transfer' ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(14) },
                  ]}
                >
                  Transfer
                </Text>
              </TouchableOpacity>
            </View>

            {type !== 'transfer' ? (
              <TouchableOpacity
                style={[
                  styles.scanButtonCompact,
                  type === 'income'
                    ? { backgroundColor: theme.surface, borderColor: theme.primary, borderWidth: 1, opacity: isScanning ? 0.7 : 1 }
                    : { backgroundColor: theme.primary, opacity: isScanning ? 0.7 : 1 },
                ]}
                onPress={openScanSourceModal}
                disabled={isScanning}
                accessibilityRole="button"
                accessibilityLabel="Scan receipt"
              >
                {isScanning ? (
                  <ActivityIndicator color={type === 'income' ? theme.primary : theme.onPrimary} size="small" />
                ) : (
                  <Ionicons name="scan-outline" size={18} color={type === 'income' ? theme.primary : theme.onPrimary} />
                )}
                <Text
                  style={[
                    styles.scanButtonTextCompact,
                    { color: type === 'income' ? theme.primary : theme.onPrimary, fontSize: theme.scaleFont(13) },
                  ]}
                >
                  {isScanning ? 'Scanning…' : 'Scan'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Title & Amount Fields */}
          <View style={styles.compactRow}>
            <View style={[styles.fieldCard, styles.flexField]}>
              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>{titleLabel}</Text>
              <TextInput
                style={[
                  styles.compactInput,
                  {
                    backgroundColor: theme.surface,
                    borderColor: titleError ? theme.expense : theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
                ]}
                placeholderTextColor={theme.textMuted}
                value={title}
                onChangeText={(nextTitle) => {
                  setTitle(nextTitle);
                  if (titleError && nextTitle.trim()) {
                    setTitleError(null);
                  }
                }}
                placeholder={titlePlaceholder}
                accessibilityLabel={titleLabel.replace(' *', '')}
              />
              {titleError ? (
                <Text
                  accessibilityRole="alert"
                  style={[styles.inlineErrorText, { color: theme.expense, fontSize: theme.scaleFont(11) }]}
                >
                  {titleError}
                </Text>
              ) : null}
            </View>
            <View style={[styles.fieldCard, styles.amountField]}>
              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Amount *</Text>
              <View style={styles.amountInputContainer}>
                <View
                  testID="amount-currency-badge"
                  style={[
                    styles.currencyBadge,
                    styles.compactCurrencyBadge,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                >
                  <Text style={[styles.currencyText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                    {currencySymbol}
                  </Text>
                </View>
                <TouchableOpacity
                  testID="amount-input-box"
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
                  {/*
                    Display only: the calculator keypad edits the amount. On Android a TextInput ignores
                    its own pointerEvents prop, so the wrapper View blocks touches and editable={false}
                    keeps it from taking focus. Otherwise the tap focused the hidden input and never
                    reached onPress (bug: tapping Amount did nothing unless Merchant was focused first).
                  */}
                  <View testID="amount-display" pointerEvents="none" style={styles.amountDisplayWrap}>
                    <TextInput
                      style={[
                        styles.amountTextInput,
                        styles.compactAmountInput,
                        { color: theme.text, fontSize: theme.scaleFont(14) },
                      ]}
                      placeholderTextColor={theme.textMuted}
                      value={amount}
                      onChangeText={handleAmountChange}
                      editable={false}
                      focusable={false}
                      showSoftInputOnFocus={false}
                      placeholder="0"
                    />
                  </View>
                  <Ionicons name="calculator-outline" size={16} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
              {amountError ? (
                <Text
                  accessibilityRole="alert"
                  style={[styles.inlineErrorText, { color: theme.expense, fontSize: theme.scaleFont(11) }]}
                >
                  {amountError}
                </Text>
              ) : null}
            </View>
          </View>

          {!amountError && scanConfidence ? (
            <View style={styles.confidenceWrap}>
              <ConfidenceNotice level={scanConfidence.level} reasons={scanConfidence.reasons} />
            </View>
          ) : null}

          {/* Account(s) */}
          <View style={styles.compactRow}>
            <View style={[styles.fieldCard, styles.flexField]}>
              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                {type === 'transfer' ? 'From' : type === 'income' ? 'To account' : 'From account'}
              </Text>
              <TouchableOpacity
                style={[styles.compactPicker, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setAccountPicker('from')}
                accessibilityRole="button"
                accessibilityLabel={`Account: ${walletName(effectiveWalletId)}`}
              >
                <Text style={[styles.iconInputText, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
                  {walletName(effectiveWalletId)}
                </Text>
                <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
              </TouchableOpacity>
            </View>
            {type === 'transfer' ? (
              <>
                <Ionicons name="arrow-forward" size={18} color={theme.textMuted} style={styles.transferArrow} />
                <View style={[styles.fieldCard, styles.flexField]}>
                  <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>To</Text>
                  <TouchableOpacity
                    style={[
                      styles.compactPicker,
                      { backgroundColor: theme.surface, borderColor: toAccountError ? theme.expense : theme.border },
                    ]}
                    onPress={() => setAccountPicker('to')}
                    accessibilityRole="button"
                    accessibilityLabel={`Transfer to: ${walletName(effectiveToWalletId)}`}
                  >
                    <Text
                      style={[
                        styles.iconInputText,
                        { color: effectiveToWalletId ? theme.text : theme.textMuted, fontSize: theme.scaleFont(14) },
                      ]}
                      numberOfLines={1}
                    >
                      {walletName(effectiveToWalletId)}
                    </Text>
                    <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
                  </TouchableOpacity>
                  {toAccountError ? (
                    <Text
                      accessibilityRole="alert"
                      style={[styles.inlineErrorText, { color: theme.expense, fontSize: theme.scaleFont(11) }]}
                    >
                      {toAccountError}
                    </Text>
                  ) : null}
                </View>
              </>
            ) : null}
          </View>

          {involvesForeignCurrency ? (
            <View
              testID="currency-exchange-panel"
              style={[styles.fieldCard, styles.fxPanel, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              {type !== 'transfer' && fromCurrency !== currencyCode ? (
                <View style={styles.fxRow}>
                  <Text style={[styles.label, styles.fxRowLabel, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                    Amount in
                  </Text>
                  {[fromCurrency, currencyCode].map((code) => {
                    const selected = amountCurrency === code;
                    return (
                      <TouchableOpacity
                        key={code}
                        onPress={() => setEntryCurrency(code)}
                        style={[
                          styles.fxChip,
                          {
                            borderColor: selected ? theme.primary : theme.border,
                            backgroundColor: selected ? theme.primaryMuted : 'transparent',
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`Enter amount in ${code}`}
                        accessibilityState={{ selected }}
                      >
                        <Text style={{ color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13), fontWeight: '700' }}>
                          {code}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : null}

              {isCrossCurrencyTransfer ? (
                <View style={styles.fxRow}>
                  <Text style={[styles.label, styles.fxRowLabel, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                    Received ({getCurrencySymbol(toCurrency)})
                  </Text>
                  <TextInput
                    style={[styles.fxInput, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(14) }]}
                    value={receivedText}
                    onChangeText={(text) => {
                      setReceivedText(formatAmountInput(text, toCurrency));
                      setCurrencyError(null);
                    }}
                    keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                    placeholder="0"
                    placeholderTextColor={theme.textMuted}
                    accessibilityLabel={`Amount received in ${toCurrency}`}
                  />
                </View>
              ) : null}

              {rateCurrency ? (
                <View style={styles.fxRow}>
                  <Text style={[styles.label, styles.fxRowLabel, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                    1 {rateCurrency} = {getCurrencySymbol(currencyCode)}
                  </Text>
                  <TextInput
                    style={[styles.fxInput, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(14) }]}
                    value={rateText}
                    onChangeText={(text) => {
                      rateEditedRef.current = true;
                      setRateText(text.replace(/[^0-9.,]/g, ''));
                      setRateSource('Entered by you');
                      setCurrencyError(null);
                    }}
                    keyboardType="decimal-pad"
                    placeholder="Exchange rate"
                    placeholderTextColor={theme.textMuted}
                    accessibilityLabel={`Exchange rate, ${currencyCode} per ${rateCurrency}`}
                  />
                </View>
              ) : null}
              {rateCurrency && fromWallet?.averageRate && parseRate(rateText) !== roundRate(fromWallet.averageRate) ? (
                <TouchableOpacity
                  onPress={() => {
                    rateEditedRef.current = true;
                    setRateText(formatRate(fromWallet.averageRate ?? 0));
                    setRateSource('Your average exchange cost');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Use my average exchange cost"
                >
                  <Text style={{ color: theme.primary, fontSize: theme.scaleFont(12), fontWeight: '600' }}>
                    Use my exchange cost ({getCurrencySymbol(currencyCode)} {formatRate(fromWallet.averageRate)})
                  </Text>
                </TouchableOpacity>
              ) : null}

              {fxSummary ? (
                <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>{fxSummary}</Text>
              ) : null}
              {currencyError ? (
                <Text
                  accessibilityRole="alert"
                  style={[styles.inlineErrorText, { color: theme.expense, fontSize: theme.scaleFont(11) }]}
                >
                  {currencyError}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Category & Date Pickers */}
          <View style={styles.compactRow}>
            {type !== 'transfer' ? (
              <View style={[styles.fieldCard, styles.flexField]}>
                <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Category</Text>
                <TouchableOpacity
                  style={[styles.compactPicker, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  onPress={() => setCategoryModalVisible(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Select category"
                >
                  <Text style={[styles.iconInputText, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
                    {category || 'Select category'}
                  </Text>
                  <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
                </TouchableOpacity>
              </View>
            ) : null}

            <View style={[styles.fieldCard, type === 'transfer' ? styles.flexField : styles.dateGroup]}>
              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Date & Time</Text>
              <View style={styles.inlineDateActions}>
                <TouchableOpacity
                  style={[styles.miniAction, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  onPress={() => openPicker('date')}
                  accessibilityRole="button"
                  accessibilityLabel="Pick date"
                >
                  <Ionicons name="calendar-outline" size={15} color={theme.textMuted} />
                  <Text style={[styles.miniActionText, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                    {compactDateLabel}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.miniAction, { backgroundColor: theme.surface, borderColor: theme.border, marginLeft: 6 }]}
                  onPress={() => openPicker('time')}
                  accessibilityRole="button"
                  accessibilityLabel="Pick time"
                >
                  <Ionicons name="time-outline" size={15} color={theme.textMuted} />
                  <Text style={[styles.miniActionText, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                    {compactTimeLabel}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {scannedDateMs != null && selectedDate.getTime() === scannedDateMs && isFarFromToday(selectedDate) ? (
            <View
              testID="scanned-date-notice"
              style={[styles.scannedDateNotice, { backgroundColor: theme.primaryMuted, borderColor: theme.warning }]}
            >
              <Ionicons name="alert-circle-outline" size={16} color={theme.warning} />
              <Text style={{ flex: 1, color: theme.text, fontSize: theme.scaleFont(12) }}>
                Date from the receipt: {selectedDate.toLocaleDateString(dateFormat || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} (
                {describeDateDistance(selectedDate)})
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setSelectedDate(new Date());
                  setScannedDateMs(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Use today's date"
              >
                <Text style={{ color: theme.primary, fontSize: theme.scaleFont(12), fontWeight: '700' }}>Use today</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={styles.inputGroupCompact}>
            <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Tags</Text>
            <TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} />
          </View>

          {/* Repeat Schedule (visible in both Add and Edit modes) */}
          <View style={styles.inputGroupCompact}>
            <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Repeat</Text>
            <View style={styles.repeatRow}>
              {involvesForeignCurrency ? (
                <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>
                  Repeat isn&apos;t available for foreign-currency accounts yet.
                </Text>
              ) : null}
              {(involvesForeignCurrency ? [] : [{ key: null, label: 'Never' }, ...RECURRING_FREQUENCIES]).map((option) => {
                const selected = repeat === option.key;
                return (
                  <TouchableOpacity
                    key={option.label}
                    style={[
                      styles.repeatChip,
                      {
                        borderColor: selected ? theme.primary : theme.border,
                        backgroundColor: selected ? theme.primaryMuted : theme.surface,
                      },
                    ]}
                    onPress={() => setRepeat(option.key as RecurringFrequency | null)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Repeat ${option.label}`}
                  >
                    <Text
                      style={[
                        styles.repeatChipText,
                        { color: selected ? theme.primary : theme.text, fontSize: theme.scaleFont(13) },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Details Section (Note vs Items vs Both) */}
          <View style={styles.inputGroupCompact}>
            <View testID="details-section-header" style={styles.detailsSectionHeader}>
              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                Details
              </Text>
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
                      accessibilityState={{ selected: isActive }}
                    >
                      <Text
                        style={[
                          styles.detailsModeText,
                          { color: isActive ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(13) },
                        ]}
                      >
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
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
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
              <Text style={[styles.label, { color: theme.text, fontSize: theme.scaleFont(12) }]}>Receipt Photo</Text>
              {imageUri ? (
                <View style={[styles.attachmentCompact, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <View style={styles.imagePreviewWrap}>
                    <TouchableOpacity
                      style={styles.imageZoomTouch}
                      onPress={() => setPhotoViewerVisible(true)}
                      activeOpacity={0.9}
                      accessibilityRole="button"
                      accessibilityLabel="Zoom receipt photo"
                    >
                      <Image source={{ uri: imageUri }} style={styles.previewImageCompact} resizeMode="cover" />
                      <View style={styles.zoomHintPill}>
                        <Ionicons name="expand-outline" size={14} color="#fff" />
                        <Text style={[styles.zoomHintText, { fontSize: theme.scaleFont(11) }]}>Tap to zoom</Text>
                      </View>
                    </TouchableOpacity>
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
                    <Text style={[styles.attachmentCompactText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                      Attach receipt image
                    </Text>
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
                  <Text style={[styles.rawOcrTitle, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
                    Raw OCR text
                  </Text>
                </View>
                <Ionicons
                  name={isRawTextExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={theme.textMuted}
                />
              </TouchableOpacity>
              {isRawTextExpanded && (
                <View style={[styles.rawOcrBody, { borderTopColor: theme.border }]}>
                  <Text selectable style={[styles.rawOcrContent, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                    {rawOcrText}
                  </Text>
                </View>
              )}
            </View>
          ) : null}

          {/* Secondary Actions (Split Bill, Template / Duplicate & Delete) */}
          <View style={styles.secondaryStack}>
            {editingId && type === 'expense' ? (
              <View style={styles.secondaryActionRow}>
              <TouchableOpacity
                style={[styles.templateSaveButton, { flex: 1, borderColor: theme.primary, backgroundColor: theme.primaryMuted }]}
                onPress={() => navigation.navigate('SplitBillEditor', { transactionId: editingId })}
                disabled={isSaving}
                accessibilityRole="button"
                accessibilityLabel={
                  editingSplitCount === 0
                    ? 'Split this bill'
                    : editingSplitUnpaid > 0
                      ? `Open split, ${editingSplitUnpaid} unpaid`
                      : 'Open split, everyone paid'
                }
              >
                <Ionicons
                  name={editingSplitCount === 0 ? 'people-outline' : editingSplitUnpaid > 0 ? 'people' : 'checkmark-done-circle'}
                  size={18}
                  color={editingSplitCount > 0 && editingSplitUnpaid === 0 ? theme.income : editingSplitCount > 0 ? theme.warning : theme.primary}
                  style={{ marginRight: 6 }}
                />
                <Text style={[styles.secondaryActionText, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
                  {editingSplitCount === 0
                    ? 'Split bill'
                    : editingSplitUnpaid > 0
                      ? `Split · ${editingSplitUnpaid} of ${editingSplitCount} unpaid`
                      : 'Split · everyone paid'}
                </Text>
              </TouchableOpacity>
              {editingSplitCount > 0 ? (
                <TouchableOpacity
                  style={[styles.templateSaveButton, { width: 48, paddingHorizontal: 0, borderColor: theme.expense, backgroundColor: theme.surface }]}
                  onPress={handleRemoveSplit}
                  disabled={isSaving}
                  accessibilityRole="button"
                  accessibilityLabel="Remove split"
                  testID="expense-remove-split"
                >
                  <Ionicons name="trash-outline" size={18} color={theme.expense} />
                </TouchableOpacity>
              ) : null}
              </View>
            ) : null}
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
                  <Text style={[styles.secondaryActionText, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
                    Duplicate
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryActionButton, { borderColor: theme.expense, backgroundColor: theme.surface }]}
                  onPress={handleDelete}
                  disabled={isSaving}
                  accessibilityRole="button"
                  accessibilityLabel="Delete transaction"
                >
                  <Ionicons name="trash-outline" size={18} color={theme.expense} style={{ marginRight: 6 }} />
                  <Text style={[styles.secondaryActionText, { color: theme.expense, fontSize: theme.scaleFont(14) }]}>
                    Delete
                  </Text>
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
                  <Text style={[styles.secondaryActionText, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
                    Save as template
                  </Text>
                </TouchableOpacity>
                {templateFeedback ? (
                  <Text
                    style={[styles.templateFeedbackText, { color: theme.income, fontSize: theme.scaleFont(12) }]}
                    accessibilityRole="text"
                  >
                    {templateFeedback}
                  </Text>
                ) : null}
              </>
            )}
          </View>
        </ScrollView>

        {/* Pinned Primary Save CTA */}
        <View
          testID="add-transaction-actions"
          style={[
            styles.pinnedFooter,
            {
              backgroundColor: theme.surface,
              borderTopColor: theme.border,
              paddingBottom: getBottomInsetPadding(insets.bottom, 12),
            },
          ]}
        >
          <TouchableOpacity
            style={[styles.saveButton, styles.saveButtonCompact, { backgroundColor: theme.primary }]}
            onPress={handleSave}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel="Save transaction"
          >
            {isSaving ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Text style={[styles.saveButtonText, { fontSize: theme.scaleFont(15), color: theme.onPrimary }]}>
                {editingId ? 'Update Transaction' : 'Save Transaction'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {showPicker && (
        <DateTimePicker
          value={selectedDate}
          mode={pickerMode}
          display="default"
          accentColor={theme.primary}
          onChange={onDateChange}
        />
      )}

      <AmountCalculatorModal
        visible={calculatorVisible}
        initialValue={amount}
        currencyCode={amountCurrency}
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
            setToAccountError(null);
          } else {
            setWalletId(id);
            setEntryCurrency(null);
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
          skipNextCategorySyncRef.current = true;
          setCategory(name);
          setPendingScannedCategory(null);
          setCategoryModalVisible(false);
        }}
        customCategory={customCategory}
        onChangeCustomCategory={setCustomCategory}
        onAddCustomCategory={handleAddCustomCategory}
      />

      <ReceiptPhotoModal
        visible={photoViewerVisible}
        imageUri={imageUri}
        transactionId={editingId}
        onClose={() => setPhotoViewerVisible(false)}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardShell: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 56,
  },
  headerBackButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    marginLeft: 4,
  },
  headerScreenTitle: { fontSize: 18, fontWeight: '700' },
  reviewProgressText: { fontSize: 12, fontWeight: '700', marginTop: 2 },
  scanStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  scanSpinner: { marginRight: 10 },
  scanCancelButton: { marginLeft: 8, paddingHorizontal: 12, minHeight: 36, borderWidth: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  scanCancelText: { fontWeight: '700' },
  scanStatusTextWrap: { flex: 1 },
  scanStatusTitle: { fontSize: 13, fontWeight: '700' },
  scanStatusSub: { fontSize: 12, marginTop: 2 },
  compactRow: { flexDirection: 'row', marginBottom: 12 },
  confidenceWrap: { marginTop: -6, marginBottom: 12 },
  typeToggle: { flexDirection: 'row', borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  compactTypeToggle: { flex: 1, marginRight: 10 },
  toggleBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  compactToggleBtn: { minHeight: 48 },
  toggleText: { fontSize: 14, fontWeight: '700' },
  scanButtonCompact: {
    minWidth: 100,
    minHeight: 48,
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
  repeatChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, minHeight: 48, justifyContent: 'center' },
  repeatChipText: { fontSize: 13, fontWeight: '600' },
  transferArrow: { alignSelf: 'flex-end', marginHorizontal: 6, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  compactInput: { minHeight: 48, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, fontSize: 14 },
  amountInputContainer: { flexDirection: 'row', alignItems: 'center' },
  currencyBadge: { borderWidth: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  compactCurrencyBadge: { width: 50, height: 48, marginRight: 8 },
  currencyText: { fontSize: 12, fontWeight: '700' },
  amountInput: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10 },
  amountPressable: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  amountDisplayWrap: { flex: 1 },
  amountTextInput: { minHeight: 48, paddingVertical: 0, marginRight: 4 },
  compactAmountInput: { fontSize: 14, fontWeight: '600' },
  inlineErrorText: { fontSize: 11, marginTop: 4, fontWeight: '600' },
  scannedDateNotice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 12 },
  fxPanel: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8, marginBottom: 12 },
  fxRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fxRowLabel: { marginBottom: 0, minWidth: 96 },
  fxChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  fxInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 48 },
  inlineWarningText: { fontSize: 11, marginTop: 4, fontWeight: '600' },
  compactPicker: {
    minHeight: 48,
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
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 4,
  },
  miniActionText: { marginLeft: 4, fontSize: 12, fontWeight: '600' },
  inputGroupCompact: { marginBottom: 12 },
  detailsSectionHeader: {
    flexDirection: 'column',
    marginBottom: 8,
  },
  detailsModeToggle: { flexDirection: 'row', width: '100%', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  compactDetailsToggle: { minHeight: 48 },
  detailsModeBtn: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  compactDetailsBtn: { paddingHorizontal: 10 },
  detailsModeText: { fontSize: 13, fontWeight: '700' },
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
  imageZoomTouch: { width: '100%', height: '100%' },
  previewImageCompact: { width: '100%', height: '100%' },
  zoomHintPill: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  zoomHintText: { color: '#fff', fontWeight: '700' },
  removeImageBtnCompact: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
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
    minHeight: 48,
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
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    gap: 6,
    maxWidth: 220,
  },
  templateDot: { width: 8, height: 8, borderRadius: 4 },
  templateChipName: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  templateChipAmount: { fontSize: 12, fontWeight: '600' },
  secondaryStack: { marginTop: 4, gap: 10 },
  pinnedFooter: {
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
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
