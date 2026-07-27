import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Modal, ScrollView, Image, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';

import { formatAmountInput, parseSignedAmount } from '../features/transactions/amount';
import { getCategoryTypeForTransaction } from '../features/transactions/categories';
import { createTransactionInput, deriveEditableTransactionType, normalizeTransactionInput } from '../features/transactions/factories';
import { buildEditableTransactionInput } from '../features/transactions/mappers';
import type { CategoryRecord, TransactionInput, TransactionType, TransactionUIInputMode } from '../features/transactions/types';
import { NavigationProps, AddTransactionScreenRouteProp } from '../navigation/types';
import { analyzeReceiptImage } from '../services/ai/agent';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAIStore } from '../store/useAIStore';
import { getErrorMessage } from '../services/ai/localInferenceTypes';
import { useAppTheme } from '../theme/useAppTheme';

type ReceiptLineItemDraft = {
  id: string;
  name: string;
  price: string;
  note: string;
};

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
  const theme = useAppTheme();

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
  const { provisioning, runtimeReady, warmupPending } = useAIStore();

  const [type, setType] = useState<TransactionType>('expense');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [lineItems, setLineItems] = useState<ReceiptLineItemDraft[]>([]);
  const [detailsMode, setDetailsMode] = useState<TransactionUIInputMode>('note');

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');

  const [imageModalVisible, setImageModalVisible] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [customCategory, setCustomCategory] = useState('');

  const [isScanning, setIsScanning] = useState(false);

  const activeCategoryType = getCategoryTypeForTransaction(type);
  const availableCategories = useMemo(() => getCategoriesByType(activeCategoryType), [activeCategoryType, categories, getCategoriesByType]);
  const lineItemsText = useMemo(() => serializeReceiptLineItems(lineItems), [lineItems]);
  const compactDateLabel = selectedDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
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
    setCategory(nextForm.category);
    setNote(nextForm.note ?? '');
    setLineItems(parseReceiptLineItemsText(nextForm.lineItemsText ?? ''));
    setDetailsMode('note');
    setImageUri(nextForm.imageUri ?? null);
    setType(nextForm.type);
    setSelectedDate(new Date());
  };

  useEffect(() => {
    if (editingId) {
      const latestTransactions = useTransactionStore.getState().transactionsList;
      const tx = latestTransactions.find((transaction) => transaction.id === editingId);

      if (tx) {
        const editableTransaction = buildEditableTransactionInput(tx);
        const editableType = deriveEditableTransactionType(editableTransaction.totalAmount, editableTransaction.type);
        setTitle(editableTransaction.merchantName);
        setAmount(formatAmountInput(Math.abs(editableTransaction.totalAmount).toString()));
        setType(editableType);
        setCategory(normalizeCategoryForType(editableTransaction.category, editableType));
        setNote(editableTransaction.note || '');
        setLineItems(parseReceiptLineItemsText(editableTransaction.lineItemsText || ''));
        setDetailsMode(editableTransaction.lineItemsText ? (editableTransaction.note ? 'both' : 'receipt') : 'note');
        setSelectedDate(new Date(editableTransaction.date));
        setImageUri(editableTransaction.imageUri || null);
      }
    } else {
      resetForm();
    }
  }, [editingId, categories]);

  useEffect(() => {
    if (!category || !availableCategories.some((item) => item.name === category)) {
      setCategory(availableCategories[0]?.name ?? normalizeCategoryForType('', type));
    }
  }, [availableCategories, category, normalizeCategoryForType, type]);

  const openPicker = (mode: 'date' | 'time') => {
    setPickerMode(mode);
    setShowPicker(true);
  };

  const onDateChange = (_event: unknown, date?: Date) => {
    setShowPicker(false);
    if (date) setSelectedDate(date);
  };

  const handleAmountChange = (text: string) => {
    setAmount(formatAmountInput(text));
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
      current.map((item) => (item.id === id ? { ...item, [field]: field === 'price' ? formatAmountInput(value) : value } : item))
    );
  };

  const handleDetailsModeChange = (mode: TransactionUIInputMode) => {
    setDetailsMode(mode);

    if ((mode === 'receipt' || mode === 'both') && lineItems.length === 0) {
      setLineItems([createReceiptItemDraft()]);
    }
  };

  const pickImage = async (source: 'gallery' | 'camera') => {
    const result = source === 'gallery'
      ? await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 })
      : (await ImagePicker.requestCameraPermissionsAsync(), await ImagePicker.launchCameraAsync({ quality: 0.8 }));

    if (!result.canceled) setImageUri(result.assets[0].uri);
    setImageModalVisible(false);
  };

  const handleScanReceipt = async () => {
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert('Permission Required', 'Camera access is needed to scan receipts.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      base64: true,
    });

    if (result.canceled || !result.assets || !result.assets[0].uri) return;

    const uri = result.assets[0].uri;
    const base64String = result.assets[0].base64;

    setImageUri(uri);
    setIsScanning(true);

    try {
      const isLocalAiReady = provisioning.status === 'ready' && runtimeReady && !warmupPending;
      if (!isLocalAiReady || !base64String) {
        Alert.alert('Setup Required', 'Offline AI is still preparing on this device. Finish local model setup in Settings before scanning receipts.');
        return;
      }

      const parsedData = await analyzeReceiptImage();

      if (parsedData) {
        if (parsedData.merchantName) setTitle(parsedData.merchantName);
        if (parsedData.totalAmount) setAmount(formatAmountInput(parsedData.totalAmount.toString()));
        if (parsedData.category) {
          const detectedCategory = parsedData.category.trim();
          const inferredType = getCategoryTypeForTransaction(type);
          const normalizedDetectedCategory = normalizeCategoryForType(detectedCategory, type);
          if (!availableCategories.some((item) => item.name.toLowerCase() === detectedCategory.toLowerCase())) {
            try {
              await addCategory(detectedCategory, inferredType);
              setCategory(detectedCategory);
            } catch {
              setCategory(normalizedDetectedCategory);
            }
          } else {
            setCategory(normalizedDetectedCategory);
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
      } else {
        Alert.alert('Scan Failed', 'Receipt scanning is not wired to the local runtime in this build yet. Capture the image and enter the details manually.');
      }
    } finally {
      setIsScanning(false);
    }
  };

  const buildTransactionPayload = (): TransactionInput => {
    const signedType = type === 'transfer' ? 'expense' : type;

    return normalizeTransactionInput(
      createTransactionInput({
        merchantName: title,
        totalAmount: parseSignedAmount(amount, signedType),
        type,
        category: normalizeCategoryForType(category, type),
        date: selectedDate.getTime(),
        note,
        lineItemsText,
        imageUri: imageUri || null,
      })
    );
  };

  const handleSave = async () => {
    if (!title.trim() || !amount) {
      Alert.alert('Missing Required Fields', 'Please enter a title and amount');
      return;
    }

    const data = buildTransactionPayload();

    if (editingId) {
      await updateTransaction(editingId, data);
    } else {
      await addTransaction(data);
    }

    navigation.navigate('MainTabs', { screen: 'Cashflow' });
    setTimeout(() => resetForm(), 100);
  };

  const handleDelete = () => {
    if (!editingId) return;
    Alert.alert('Delete Transaction', 'Are you sure you want to delete this?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteTransaction(editingId);
          resetForm();
          navigation.navigate('MainTabs', { screen: 'Cashflow' });
        },
      },
    ]);
  };

  const handleAddCustomCategory = async () => {
    const trimmedCategory = customCategory.trim();

    if (trimmedCategory !== '') {
      try {
        const createdCategory = await addCategory(trimmedCategory, activeCategoryType);
        setCategory(createdCategory);
        setCustomCategory('');
        setCategoryModalVisible(false);
      } catch (error) {
        Alert.alert('Category Error', getErrorMessage(error, 'Failed to add category.'));
      }
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerBackButton}
            onPress={() => {
              resetForm();
              if (navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('MainTabs', { screen: 'Cashflow' });
              }
            }}
          >
            <Ionicons name="chevron-back" size={24} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.headerScreenTitle, { color: theme.text }]}>{editingId ? 'Edit Transaction' : 'Add Transaction'}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.compactRow}>
          <View style={[styles.typeToggle, styles.compactTypeToggle, { borderColor: theme.border, backgroundColor: theme.surface }] }>
            <TouchableOpacity style={[styles.toggleBtn, styles.compactToggleBtn, { backgroundColor: type === 'income' ? theme.income : 'transparent' }]} onPress={() => setType('income')}>
              <Text style={[styles.toggleText, { color: type === 'income' ? '#fff' : theme.textMuted }]}>Income</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.toggleBtn, styles.compactToggleBtn, { backgroundColor: type === 'expense' ? theme.expense : 'transparent' }]} onPress={() => setType('expense')}>
              <Text style={[styles.toggleText, { color: type === 'expense' ? '#fff' : theme.textMuted }]}>Expense</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.scanButtonCompact, { backgroundColor: theme.primary, opacity: isScanning ? 0.7 : 1 }]}
            onPress={handleScanReceipt}
            disabled={isScanning}
          >
            {isScanning ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="scan-outline" size={18} color="#fff" />}
            <Text style={styles.scanButtonTextCompact}>{isScanning ? 'Scanning' : 'Scan'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.compactRow}>
          <View style={[styles.fieldCard, styles.flexField]}>
            <Text style={[styles.label, { color: theme.text }]}>Title*</Text>
            <TextInput
              style={[styles.compactInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
              placeholderTextColor={theme.textMuted}
              value={title}
              onChangeText={setTitle}
              placeholder="Store or transaction"
            />
          </View>
          <View style={[styles.fieldCard, styles.amountField]}>
            <Text style={[styles.label, { color: theme.text }]}>Amount*</Text>
            <View style={styles.amountInputContainer}>
              <View style={[styles.currencyBadge, styles.compactCurrencyBadge, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                <Text style={[styles.currencyText, { color: theme.textMuted }]}>Rp</Text>
              </View>
              <TextInput
                style={[styles.amountInput, styles.compactAmountInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
                placeholderTextColor={theme.textMuted}
                value={amount}
                onChangeText={handleAmountChange}
                keyboardType="numeric"
                placeholder="0"
              />
            </View>
          </View>
        </View>

        <View style={styles.compactRow}>
          <View style={[styles.fieldCard, styles.flexField]}>
            <Text style={[styles.label, { color: theme.text }]}>Category</Text>
            <TouchableOpacity
              style={[styles.compactPicker, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => setCategoryModalVisible(true)}
            >
              <Text style={[styles.iconInputText, { color: theme.text }]} numberOfLines={1}>{category}</Text>
              <Ionicons name="chevron-down-outline" size={18} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={[styles.fieldCard, styles.dateGroup]}>
            <Text style={[styles.label, { color: theme.text }]}>When</Text>
            <View style={styles.inlineDateActions}>
              <TouchableOpacity style={[styles.miniAction, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => openPicker('date')}>
                <Ionicons name="calendar-outline" size={15} color={theme.textMuted} />
                <Text style={[styles.miniActionText, { color: theme.text }]}>{compactDateLabel}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.miniAction, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => openPicker('time')}>
                <Ionicons name="time-outline" size={15} color={theme.textMuted} />
                <Text style={[styles.miniActionText, { color: theme.text }]}>{compactTimeLabel}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.inputGroupCompact}>
          <View style={styles.inlineSectionHeader}>
            <Text style={[styles.sectionTitleCompact, { color: theme.text }]}>Details</Text>
            <View style={[styles.detailsModeToggle, styles.compactDetailsToggle, { borderColor: theme.border, backgroundColor: theme.surface }] }>
              {detailModeOptions.map((option) => {
                const isActive = detailsMode === option.key;
                return (
                  <TouchableOpacity
                    key={option.key}
                    style={[styles.detailsModeBtn, styles.compactDetailsBtn, { backgroundColor: isActive ? theme.primary : 'transparent' }]}
                    onPress={() => handleDetailsModeChange(option.key)}
                  >
                    <Text style={[styles.detailsModeText, { color: isActive ? '#fff' : theme.textMuted }]}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {(detailsMode === 'note' || detailsMode === 'both') ? (
            <TextInput
              style={[styles.compactInput, styles.noteInputCompact, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
              value={note}
              onChangeText={setNote}
              placeholder="Description or note"
              placeholderTextColor={theme.textMuted}
              multiline
              textAlignVertical="top"
            />
          ) : null}

          {(detailsMode === 'receipt' || detailsMode === 'both') ? (
            <View style={styles.receiptEditorBlock}>
              <View style={styles.receiptHeaderRow}>
                <Text style={[styles.receiptHeaderTitle, { color: theme.text }]}>Receipt Items</Text>
                <TouchableOpacity style={[styles.inlineAddButton, { borderColor: theme.primary }]} onPress={addReceiptItemRow}>
                  <Ionicons name="add" size={15} color={theme.primary} />
                  <Text style={[styles.inlineAddButtonText, { color: theme.primary }]}>Add</Text>
                </TouchableOpacity>
              </View>

              {lineItems.length === 0 ? (
                <TouchableOpacity style={[styles.emptyReceiptState, { borderColor: theme.border, backgroundColor: theme.surface }]} onPress={addReceiptItemRow}>
                  <Ionicons name="receipt-outline" size={16} color={theme.textMuted} />
                  <Text style={[styles.emptyReceiptText, { color: theme.textMuted }]}>Add itemized lines</Text>
                </TouchableOpacity>
              ) : (
                lineItems.map((item) => (
                  <View key={item.id} style={[styles.receiptRowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                    <View style={styles.receiptRowTop}>
                      <TextInput
                        style={[styles.receiptNameInput, { color: theme.text }]}
                        value={item.name}
                        onChangeText={(value) => updateReceiptItemRow(item.id, 'name', value)}
                        placeholder="Item"
                        placeholderTextColor={theme.textMuted}
                      />
                      <View style={[styles.receiptPriceBox, { borderColor: theme.border, backgroundColor: theme.background }]}>
                        <Text style={[styles.receiptPricePrefix, { color: theme.textMuted }]}>Rp</Text>
                        <TextInput
                          style={[styles.receiptPriceInput, { color: theme.text }]}
                          value={item.price}
                          onChangeText={(value) => updateReceiptItemRow(item.id, 'price', value)}
                          placeholder="0"
                          placeholderTextColor={theme.textMuted}
                          keyboardType="numeric"
                        />
                      </View>
                      <TouchableOpacity style={styles.receiptRemoveBtn} onPress={() => removeReceiptItemRow(item.id)}>
                        <Ionicons name="close-circle" size={20} color={theme.expense} />
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      style={[styles.receiptNoteInput, { color: theme.textMuted, borderTopColor: theme.border }]}
                      value={item.note}
                      onChangeText={(value) => updateReceiptItemRow(item.id, 'note', value)}
                      placeholder="Notes"
                      placeholderTextColor={theme.textMuted}
                    />
                  </View>
                ))
              )}
            </View>
          ) : null}
        </View>

        <View style={styles.compactRow}>
          <View style={[styles.fieldCard, styles.flexField]}>
            <Text style={[styles.label, { color: theme.text }]}>Attachment</Text>
            <TouchableOpacity style={[styles.attachmentCompact, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => !imageUri && setImageModalVisible(true)}>
              {imageUri ? (
                <>
                  <Image source={{ uri: imageUri }} style={styles.previewImageCompact} resizeMode="cover" />
                  <TouchableOpacity style={styles.removeImageBtnCompact} onPress={() => setImageUri(null)}>
                    <Ionicons name="close-circle" size={24} color={theme.expense} />
                  </TouchableOpacity>
                </>
              ) : (
                <View style={styles.attachmentCompactEmpty}>
                  <Ionicons name="attach" size={16} color={theme.textMuted} />
                  <Text style={[styles.attachmentCompactText, { color: theme.textMuted }]}>Add photo</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.actionRow}>
          {editingId ? (
            <TouchableOpacity style={[styles.deleteButtonCompact, { borderColor: theme.expense }]} onPress={handleDelete} disabled={isSaving}>
              <Text style={[styles.deleteButtonTextCompact, { color: theme.expense }]}>Delete</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={[styles.saveButton, styles.saveButtonCompact, { backgroundColor: theme.primary }]} onPress={handleSave} disabled={isSaving}>
            {isSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>Save</Text>}
          </TouchableOpacity>
        </View>

        <View style={{ height: 72 }} />
      </ScrollView>

      {showPicker && <DateTimePicker value={selectedDate} mode={pickerMode} display="default" onChange={onDateChange} />}

      <Modal visible={imageModalVisible} transparent animationType="slide">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setImageModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Select a Source</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }]} onPress={() => pickImage('gallery')}>
                <Ionicons name="images" size={34} color="#fff" />
                <Text style={styles.modalBtnText}>Gallery</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }]} onPress={() => pickImage('camera')}>
                <Ionicons name="camera" size={34} color="#fff" />
                <Text style={styles.modalBtnText}>Camera</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setImageModalVisible(false)}>
              <Text style={[styles.cancelBtnText, { color: theme.expense }]}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={categoryModalVisible} transparent animationType="slide">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setCategoryModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Select Category</Text>
            <ScrollView style={{ maxHeight: 250 }}>
              {availableCategories.map((cat: CategoryRecord) => (
                <TouchableOpacity key={cat.id} style={[styles.categoryRow, { borderBottomColor: theme.border }]} onPress={() => { setCategory(cat.name); setCategoryModalVisible(false); }}>
                  <Text style={[styles.categoryText, { color: theme.text }]}>{cat.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.customCategoryBox}>
              <TextInput
                style={[styles.customCategoryInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                placeholderTextColor={theme.textMuted}
                placeholder="Add new category"
                value={customCategory}
                onChangeText={setCustomCategory}
              />
              <TouchableOpacity style={[styles.addCategoryBtn, { backgroundColor: theme.primary }]} onPress={handleAddCustomCategory}>
                <Ionicons name="add" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setCategoryModalVisible(false)}>
              <Text style={[styles.cancelBtnText, { color: theme.expense }]}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 28 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  headerBackButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerScreenTitle: { fontSize: 18, fontWeight: '700' },
  headerSpacer: { width: 36 },
  compactRow: { flexDirection: 'row', marginBottom: 10 },
  typeToggle: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  compactTypeToggle: { flex: 1, marginRight: 10 },
  toggleBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  compactToggleBtn: { minHeight: 42 },
  toggleText: { fontSize: 13, fontWeight: '700' },
  scanButtonCompact: { minWidth: 92, minHeight: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', paddingHorizontal: 12 },
  scanButtonTextCompact: { color: '#fff', fontWeight: '700', fontSize: 13, marginLeft: 6 },
  fieldCard: { flex: 1 },
  flexField: { flex: 1 },
  amountField: { width: 150, marginLeft: 10 },
  dateGroup: { width: 170, marginLeft: 10 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  compactInput: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 },
  amountInputContainer: { flexDirection: 'row', alignItems: 'center' },
  currencyBadge: { borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  compactCurrencyBadge: { width: 46, height: 44, marginRight: 8 },
  currencyText: { fontSize: 13, fontWeight: '700' },
  amountInput: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12 },
  compactAmountInput: { fontSize: 14 },
  compactPicker: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconInputText: { fontSize: 14, flex: 1, marginRight: 8 },
  inlineDateActions: { flexDirection: 'row' },
  miniAction: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  miniActionText: { marginLeft: 6, fontSize: 12, fontWeight: '600' },
  inputGroupCompact: { marginBottom: 10 },
  inlineSectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sectionTitleCompact: { fontSize: 14, fontWeight: '700' },
  detailsModeToggle: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  compactDetailsToggle: { minHeight: 36 },
  detailsModeBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  compactDetailsBtn: { paddingHorizontal: 12 },
  detailsModeText: { fontSize: 12, fontWeight: '700' },
  noteInputCompact: { minHeight: 92, paddingTop: 12 },
  receiptEditorBlock: { marginTop: 2 },
  receiptHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  receiptHeaderTitle: { fontSize: 14, fontWeight: '700' },
  inlineAddButton: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  inlineAddButtonText: { fontSize: 12, fontWeight: '700', marginLeft: 4 },
  emptyReceiptState: { minHeight: 44, borderWidth: 1, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  emptyReceiptText: { marginLeft: 6, fontSize: 13 },
  receiptRowCard: { borderWidth: 1, borderRadius: 14, marginBottom: 8, overflow: 'hidden' },
  receiptRowTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  receiptNameInput: { flex: 1, fontSize: 14, marginRight: 8 },
  receiptPriceBox: { minWidth: 98, borderWidth: 1, borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, marginRight: 6 },
  receiptPricePrefix: { fontSize: 12, fontWeight: '700', marginRight: 4 },
  receiptPriceInput: { flex: 1, minHeight: 34, fontSize: 13 },
  receiptRemoveBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  receiptNoteInput: { minHeight: 38, borderTopWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12 },
  attachmentCompact: { minHeight: 86, borderWidth: 1, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  attachmentCompactEmpty: { alignItems: 'center', justifyContent: 'center' },
  attachmentCompactText: { marginTop: 4, fontSize: 12 },
  previewImageCompact: { width: '100%', height: 120 },
  removeImageBtnCompact: { position: 'absolute', top: 8, right: 8 },
  actionRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  deleteButtonCompact: { minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginRight: 10 },
  deleteButtonTextCompact: { fontSize: 13, fontWeight: '700' },
  saveButton: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  saveButtonCompact: { paddingHorizontal: 18 },
  saveButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 20 },
  modalContent: { borderRadius: 18, padding: 18 },
  modalTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 14 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between' },
  modalBtn: { flex: 1, minHeight: 108, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  modalBtnText: { marginTop: 8, color: '#fff', fontWeight: '700' },
  cancelBtn: { marginTop: 14, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  cancelBtnText: { fontSize: 14, fontWeight: '700' },
  categoryRow: { minHeight: 46, justifyContent: 'center', borderBottomWidth: 1, paddingHorizontal: 4 },
  categoryText: { fontSize: 14, fontWeight: '500' },
  customCategoryBox: { flexDirection: 'row', marginTop: 12 },
  customCategoryInput: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 14, marginRight: 10 },
  addCategoryBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
