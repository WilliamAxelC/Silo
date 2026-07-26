import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';

export const MoreScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const [dummyQuery, setDummyQuery] = useState('');
  const theme = useAppTheme();

  const clearAllData = useTransactionStore((state) => state.clearAllData);
  const injectDummyData = useTransactionStore((state) => state.injectDummyData);

  const handleClear = () => {
    Alert.alert('Warning', 'This will wipe the entire Silo database.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Wipe It', style: 'destructive', onPress: clearAllData },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>More</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={[styles.aiCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.aiHeaderRow}>
            <View style={[styles.aiIconWrap, { backgroundColor: theme.background }]}>
              <Ionicons name="sparkles" size={20} color={theme.primary} />
            </View>
            <View style={styles.aiHeaderText}>
              <Text style={[styles.aiTitle, { color: theme.text }]}>Silo AI Chatbot</Text>
              <Text style={[styles.aiDesc, { color: theme.textMuted }]}>Ask about spending or budgets.</Text>
            </View>
          </View>

          <View style={styles.aiInputRow}>
            <TextInput
              style={[styles.input, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
              placeholderTextColor={theme.textMuted}
              placeholder="Ask a finance question"
              value={dummyQuery}
              onChangeText={setDummyQuery}
            />
            <TouchableOpacity style={[styles.chatButton, { backgroundColor: theme.primary }]} onPress={() => navigation.navigate('Chatbot', { initialMessage: dummyQuery })}>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {__DEV__ ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>Developer Tools</Text>
            <View style={[styles.devCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <TouchableOpacity style={styles.devButton} onPress={injectDummyData}>
                <Ionicons name="add-circle-outline" size={20} color={theme.primary} />
                <Text style={[styles.devButtonText, { color: theme.text }]}>Inject Dummy Data</Text>
              </TouchableOpacity>

              <View style={[styles.divider, { backgroundColor: theme.border }]} />

              <TouchableOpacity style={styles.devButton} onPress={handleClear}>
                <Ionicons name="trash-outline" size={20} color={theme.expense} />
                <Text style={[styles.devButtonText, { color: theme.expense }]}>Clear Database</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}

        <TouchableOpacity style={[styles.settingRow, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => navigation.navigate('SystemLogs')}>
          <View style={styles.settingRowLeft}>
            <Ionicons name="receipt-outline" size={20} color={theme.text} />
            <Text style={[styles.settingText, { color: theme.text }]}>System Logs</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity style={[styles.settingRow, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => navigation.navigate('Settings')}>
          <View style={styles.settingRowLeft}>
            <Ionicons name="settings-outline" size={20} color={theme.text} />
            <Text style={[styles.settingText, { color: theme.text }]}>App Settings</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingVertical: 10, alignItems: 'center', borderBottomWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  scrollContent: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 124 },
  aiCard: { padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 14 },
  aiHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  aiIconWrap: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  aiHeaderText: { flex: 1 },
  aiTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  aiDesc: { fontSize: 12 },
  aiInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, minHeight: 42, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 14 },
  chatButton: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6, marginLeft: 4 },
  devCard: { borderRadius: 12, borderWidth: 1, marginBottom: 14, overflow: 'hidden' },
  devButton: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingHorizontal: 14, paddingVertical: 10 },
  devButtonText: { fontSize: 14, fontWeight: '500', marginLeft: 10 },
  divider: { height: 1, marginLeft: 44 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1 },
  settingRowLeft: { flexDirection: 'row', alignItems: 'center' },
  settingText: { marginLeft: 10, fontSize: 14, fontWeight: '500' },
});
