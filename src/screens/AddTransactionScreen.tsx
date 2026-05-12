import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Modal, ScrollView, Image, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';

import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NavigationProps, AddTransactionScreenRouteProp } from '../navigation/types';

import { analyzeReceiptImage } from '../services/ai/agent';
import { useAIStore } from '../store/useAIStore';

export const AddTransactionScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<AddTransactionScreenRouteProp>();
  const editingId = route.params?.transactionId;
  const theme = useAppTheme();

  const { addTransaction, updateTransaction, deleteTransaction, isSaving, categories, addCategory } = useTransactionStore();
  
  // FIX 2: Extract the API key and model from the store
  const { apiKey, selectedModel } = useAIStore();

  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');

  const [imageModalVisible, setImageModalVisible] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [customCategory, setCustomCategory] = useState('');

  // FIX 3: Add the missing scanning state
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    if (editingId) {
      const latestTransactions = useTransactionStore.getState().transactionsList;
      const tx = latestTransactions.find(t => t.id === editingId);
      
      if (tx) {
        setTitle(tx.merchantName);
        setAmount(Math.abs(tx.totalAmount).toString()); 
        setType(tx.totalAmount > 0 ? 'income' : 'expense');
        setCategory(tx.category || categories[0]);
        setSelectedDate(new Date(tx.date));
        setImageUri(tx.imageUri || null);
      }
    } else {
      setTitle(''); setAmount(''); setDescription(''); setImageUri(null); setType('expense'); setSelectedDate(new Date());
      setCategory(categories[0]);
    }
  }, [editingId, categories]); 

  const resetForm = () => {
    setTitle(''); 
    setAmount(''); 
    setDescription(''); 
    setImageUri(null); 
    setType('expense'); 
    setSelectedDate(new Date());
  };

  const openPicker = (mode: 'date' | 'time') => { setPickerMode(mode); setShowPicker(true); };
  const onDateChange = (event: any, date?: Date) => { setShowPicker(false); if (date) setSelectedDate(date); };

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    setAmount(numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  };

  const pickImage = async (source: 'gallery' | 'camera') => {
    let result = source === 'gallery' 
      ? await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 })
      : (await ImagePicker.requestCameraPermissionsAsync(), await ImagePicker.launchCameraAsync({ quality: 0.8 }));
    if (!result.canceled) setImageUri(result.assets[0].uri);
    setImageModalVisible(false);
  };

  const handleScanReceipt = async () => {
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert("Permission Required", "Camera access is needed to scan receipts.");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ 
      quality: 0.8, 
      base64: true 
    });
    
    if (result.canceled || !result.assets || !result.assets[0].uri) return;

    const uri = result.assets[0].uri;
    const base64String = result.assets[0].base64;
    
    setImageUri(uri); 
    setIsScanning(true);

    try {
      if (apiKey && selectedModel && base64String) {
        // Send the image directly to Gemini
        const parsedData = await analyzeReceiptImage(base64String, apiKey, selectedModel);
        
        if (parsedData) {
          if (parsedData.merchantName) setTitle(parsedData.merchantName);
          if (parsedData.totalAmount) setAmount(parsedData.totalAmount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));
          if (parsedData.category) {
            if (!categories.includes(parsedData.category)) addCategory(parsedData.category);
            setCategory(parsedData.category);
          }
          if (parsedData.date) {
             const parsedDate = new Date(parsedData.date);
             if (!isNaN(parsedDate.getTime())) setSelectedDate(parsedDate);
          }
        } else {
          Alert.alert("Scan Failed", "The AI could not read the receipt clearly. Please try again.");
        }
      } else {
        Alert.alert("Setup Required", "Please configure your AI API Key in Settings to enable receipt scanning.");
      }
    } finally {
      setIsScanning(false);
    }
  };

  const handleSave = async () => {
    if (!title || !amount) {
      alert("Please enter a title and amount");
      return;
    }
    
    const parsedAmount = parseFloat(amount.replace(/,/g, ''));
    const finalAmount = type === 'expense' ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);

    const data = {
      merchantName: title,
      totalAmount: finalAmount,
      type: type,
      category: category,
      date: selectedDate.getTime(),
      description: description,
      imageUri: imageUri || null,
    };

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
    Alert.alert("Delete Transaction", "Are you sure you want to delete this?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { await deleteTransaction(editingId); resetForm(); navigation.navigate('MainTabs', { screen: 'Cashflow' }); }}
    ]);
  };

  const handleAddCustomCategory = () => {
    if (customCategory.trim() !== '') {
      addCategory(customCategory);
      setCategory(customCategory);
      setCustomCategory('');
      setCategoryModalVisible(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
        
        <View style={styles.header}>
          <TouchableOpacity 
            onPress={() => {
              resetForm();
              if (navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('MainTabs', { screen: 'Cashflow' });
              }
            }}
          >
            <Ionicons name="chevron-back" size={28} color={theme.text} />
          </TouchableOpacity>
        </View>

        {/* FIX 4: Update the button UI to show the Activity Indicator while scanning */}
        <TouchableOpacity 
          style={[styles.ocrButton, { backgroundColor: theme.primary, opacity: isScanning ? 0.7 : 1 }]} 
          onPress={handleScanReceipt}
          disabled={isScanning}
        >
          {isScanning ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Ionicons name="scan-outline" size={20} color="#fff" />
              <Text style={styles.ocrButtonText}>Scan Receipt</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={styles.row}>
          <View style={styles.halfInput}>
            <Text style={[styles.label, { color: theme.text }]}>Date*</Text>
            <TouchableOpacity style={[styles.iconInputBoxAction, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => openPicker('date')}>
              <Text style={[styles.iconInputText, { color: theme.text }]}>{selectedDate.toLocaleDateString()}</Text>
              <Ionicons name="calendar-outline" size={20} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={styles.halfInput}>
            <Text style={[styles.label, { color: theme.text }]}>Time*</Text>
            <TouchableOpacity style={[styles.iconInputBoxAction, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => openPicker('time')}>
              <Text style={[styles.iconInputText, { color: theme.text }]}>{selectedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              <Ionicons name="time-outline" size={20} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={[styles.typeToggle, { borderColor: theme.border }]}>
          <TouchableOpacity style={[styles.toggleBtn, { backgroundColor: type === 'income' ? theme.income : theme.surface }]} onPress={() => setType('income')}>
            <Text style={[styles.toggleText, { color: type === 'income' ? '#fff' : theme.textMuted }]}>Income</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.toggleBtn, { backgroundColor: type === 'expense' ? theme.expense : theme.surface }]} onPress={() => setType('expense')}>
            <Text style={[styles.toggleText, { color: type === 'expense' ? '#fff' : theme.textMuted }]}>Expense</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: theme.text }]}>Title*</Text>
          <TextInput style={[styles.standardInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]} placeholderTextColor={theme.textMuted} value={title} onChangeText={setTitle} placeholder="e.g. Groceries" />
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: theme.text }]}>Amount*</Text>
          <View style={styles.amountInputContainer}>
            <View style={[styles.currencyBadge, { backgroundColor: theme.surface, borderColor: theme.border }]}><Text style={[styles.currencyText, { color: theme.textMuted }]}>Rp</Text></View>
            <TextInput style={[styles.amountInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]} placeholderTextColor={theme.textMuted} value={amount} onChangeText={handleAmountChange} keyboardType="numeric" placeholder="0" />
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: theme.text }]}>Category</Text>
          <TouchableOpacity 
            style={[styles.iconInputBoxAction, { backgroundColor: theme.surface, borderColor: theme.border }]} 
            onPress={() => setCategoryModalVisible(true)}
          >
            <Text style={[styles.iconInputText, { color: theme.text }]}>{category}</Text>
            <Ionicons name="chevron-down-outline" size={20} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: theme.text }]}>Description</Text>
          <TextInput 
            style={[styles.standardInput, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]} 
            value={description} 
            onChangeText={setDescription} 
            placeholder="Optional notes" 
            placeholderTextColor={theme.textMuted}
          />
        </View>

        <Text style={[styles.label, { color: theme.text }]}>Attachment</Text>
        <TouchableOpacity style={[styles.attachmentBox, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => !imageUri && setImageModalVisible(true)}>
          {imageUri ? (
            <>
              <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="cover" />
              <TouchableOpacity style={styles.removeImageBtn} onPress={() => setImageUri(null)}>
                <Ionicons name="close-circle" size={28} color={theme.expense} />
              </TouchableOpacity>
            </>
          ) : (
             <><Ionicons name="attach" size={24} color={theme.textMuted} /><Text style={[styles.attachmentText, { color: theme.textMuted }]}>Tap to add</Text></>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={[styles.saveButton, { backgroundColor: theme.primary }]} onPress={handleSave} disabled={isSaving}>
          {isSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>Save</Text>}
        </TouchableOpacity>
        
        <View style={{ height: 120 }} />
      </ScrollView>

      {showPicker && <DateTimePicker value={selectedDate} mode={pickerMode} display="default" onChange={onDateChange} />}

      <Modal visible={imageModalVisible} transparent animationType="slide">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setImageModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Select a Source</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }]} onPress={() => pickImage('gallery')}>
                <Ionicons name="images" size={40} color="#fff" />
                <Text style={styles.modalBtnText}>Gallery</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }]} onPress={() => pickImage('camera')}>
                <Ionicons name="camera" size={40} color="#fff" />
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
              {categories.map((cat, idx) => (
                <TouchableOpacity key={idx} style={[styles.categoryRow, { borderBottomColor: theme.border }]} onPress={() => { setCategory(cat); setCategoryModalVisible(false); }}>
                  <Text style={[styles.categoryText, { color: theme.text }]}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.customCategoryBox}>
              <TextInput style={[styles.customCategoryInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]} placeholderTextColor={theme.textMuted} placeholder="Add new category" value={customCategory} onChangeText={setCustomCategory} />
              <TouchableOpacity style={[styles.addCategoryBtn, { backgroundColor: theme.primary }]} onPress={handleAddCustomCategory}>
                <Ionicons name="add" size={20} color="#fff" />
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
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  ocrButton: { flexDirection: 'row', justifyContent: 'center', padding: 12, borderRadius: 8, marginBottom: 16 },
  ocrButtonText: { color: '#fff', fontWeight: 'bold', marginLeft: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  halfInput: { flex: 0.48 },
  iconInputBoxAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 14 },
  iconInputText: { fontSize: 14 },
  typeToggle: { flexDirection: 'row', borderRadius: 8, borderWidth: 1, marginBottom: 16, overflow: 'hidden' },
  toggleBtn: { flex: 1, padding: 12, alignItems: 'center' },
  toggleText: { fontWeight: '600' },
  inputGroup: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '500', marginBottom: 8 },
  standardInput: { padding: 12, borderWidth: 1, borderRadius: 8 },
  amountInputContainer: { flexDirection: 'row', alignItems: 'center' },
  currencyBadge: { padding: 12, borderWidth: 1, borderTopLeftRadius: 8, borderBottomLeftRadius: 8 },
  currencyText: { fontWeight: 'bold' },
  amountInput: { flex: 1, padding: 12, borderWidth: 1, borderLeftWidth: 0, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  attachmentBox: { borderWidth: 1, borderRadius: 8, borderStyle: 'dashed', height: 120, justifyContent: 'center', alignItems: 'center', marginBottom: 24, overflow: 'hidden' },
  attachmentText: { marginTop: 8 },
  previewImage: { width: '100%', height: '100%' },
  removeImageBtn: { position: 'absolute', top: 8, right: 8, backgroundColor: '#fff', borderRadius: 14 },
  saveButton: { padding: 16, borderRadius: 8, alignItems: 'center' },
  saveButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { padding: 24, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  modalTitle: { fontSize: 18, fontWeight: 'bold', textAlign: 'center', marginBottom: 16 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 24 },
  modalBtn: { width: 120, height: 120, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  modalBtnText: { color: '#fff', marginTop: 12, fontWeight: '600' },
  categoryRow: { paddingVertical: 12, borderBottomWidth: 1 },
  categoryText: { fontSize: 16 },
  customCategoryBox: { flexDirection: 'row', marginTop: 16, alignItems: 'center' },
  customCategoryInput: { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, marginRight: 8 },
  addCategoryBtn: { padding: 12, borderRadius: 8 },
  cancelBtn: { alignItems: 'center', paddingTop: 20 },
  cancelBtnText: { fontSize: 16, fontWeight: '600' }
});