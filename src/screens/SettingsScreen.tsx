import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

// 🛑 THE FIX: Point exactly to the /legacy bundle for SDK 54+ compatibility
import { documentDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

import { NavigationProps } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAIStore } from '../store/useAIStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';

export const SettingsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  
  // 1. Pull UI preferences
  const { isDarkMode, setIsDarkMode } = useSettingsStore();
  
  // 2. Pull AI preferences
  const { apiKey, selectedModel, setApiKey } = useAIStore();

  // 3. Pull Transactions for Export
  const transactionsList = useTransactionStore(state => state.transactionsList);
  const [isExporting, setIsExporting] = useState(false);

  const handleClearApiKey = () => {
    Alert.alert(
      "Revoke AI Access",
      "Are you sure you want to remove your Gemini API Key?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Remove Key", 
          style: "destructive", 
          onPress: () => {
            setApiKey(''); 
            Alert.alert("Success", "API Key removed.");
          } 
        }
      ]
    );
  };

  const handleExportCSV = async () => {
    try {
      setIsExporting(true);
      
      if (!transactionsList || transactionsList.length === 0) {
        Alert.alert("No Data", "You don't have any transactions to export yet.");
        setIsExporting(false);
        return;
      }

      // 1. Generate CSV Headers
      const headers = ["Date", "Merchant Name", "Category", "Amount", "Type", "Description"];
      let csvString = headers.join(",") + "\n";

      // 2. Loop through transactions and format rows safely
      transactionsList.forEach((tx) => {
        const dateStr = new Date(tx.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        
        // Escape quotes to prevent CSV breaking
        const merchant = `"${(tx.merchantName || '').replace(/"/g, '""')}"`;
        const category = `"${(tx.category || '').replace(/"/g, '""')}"`;
        const description = `"${(tx.description || '').replace(/"/g, '""')}"`;
        
        const type = (tx.totalAmount || 0) > 0 ? "Income" : "Expense";
        
        csvString += `${dateStr},${merchant},${category},${tx.totalAmount},${type},${description}\n`;
      });

      // 3. Define the file path using the legacy API
      const fileName = `Silo_Export_${new Date().toISOString().split('T')[0]}.csv`;
      const fileUri = `${documentDirectory}${fileName}`;

      // 4. Write the string to the device
      await writeAsStringAsync(fileUri, csvString, { 
        encoding: EncodingType.UTF8 
      });

      // 5. Open the native Share sheet
      const isAvailable = await isAvailableAsync();
      if (isAvailable) {
        await shareAsync(fileUri, {
          mimeType: 'text/csv',
          dialogTitle: 'Export Silo Transactions',
          UTI: 'public.comma-separated-values-text'
        });
      } else {
        Alert.alert("Error", "Sharing is not supported on this device.");
      }
    } catch (error) {
      console.error("Export failed:", error);
      Alert.alert("Export Failed", "An error occurred while generating your CSV file.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={28} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Settings</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* PREFERENCES SECTION */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>Preferences</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="moon-outline" size={22} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }]}>Dark Mode</Text>
            </View>
            <Switch 
              value={isDarkMode} 
              onValueChange={setIsDarkMode} 
              trackColor={{ false: '#767577', true: theme.primary }}
            />
          </View>
        </View>

        {/* DATA MANAGEMENT SECTION */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>Data Management</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity style={styles.row} onPress={handleExportCSV} disabled={isExporting}>
            <View style={styles.rowLeft}>
              <Ionicons name="download-outline" size={22} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }]}>Export Data to CSV</Text>
            </View>
            {isExporting ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
            )}
          </TouchableOpacity>
        </View>

        {/* AI & INTEGRATION SECTION */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>AI Assistant</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="key-outline" size={22} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }]}>API Key Status</Text>
            </View>
            <Text style={[styles.statusText, { color: apiKey ? theme.primary : theme.textMuted }]}>
              {apiKey ? 'Active' : 'Not Set'}
            </Text>
          </View>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="hardware-chip-outline" size={22} color={theme.text} />
              <Text style={[styles.rowText, { color: theme.text }]}>Active Model</Text>
            </View>
            <Text style={[styles.subText, { color: theme.textMuted }]}>
              {selectedModel ? selectedModel.replace('models/', '') : 'None'}
            </Text>
          </View>
          
          {apiKey && (
            <>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <TouchableOpacity style={styles.row} onPress={handleClearApiKey}>
                <Text style={[styles.rowText, { color: theme.expense, marginLeft: 0 }]}>Revoke API Key</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* ABOUT SECTION */}
        <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>About Silo</Text>
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.row}>
            <Text style={[styles.rowText, { color: theme.text, marginLeft: 0 }]}>Version</Text>
            <Text style={[styles.subText, { color: theme.textMuted }]}>0.1.0 (Alpha)</Text>
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  backButton: { padding: 4 },
  content: { padding: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 'bold', textTransform: 'uppercase', marginBottom: 8, marginLeft: 12, marginTop: 16 },
  sectionCard: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  rowLeft: { flexDirection: 'row', alignItems: 'center' },
  rowText: { fontSize: 16, marginLeft: 12 },
  subText: { fontSize: 14 },
  statusText: { fontSize: 14, fontWeight: 'bold' },
  divider: { height: 1, marginLeft: 50 },
});