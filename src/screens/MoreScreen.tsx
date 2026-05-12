import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

import { useTransactionStore } from '../store/useTransactionStore'; 
import { useAppTheme } from '../theme/useAppTheme'; // NEW: Dynamic Theme

export const MoreScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const [dummyQuery, setDummyQuery] = useState('');
  const theme = useAppTheme();

  // Bring in our Dev Tools from the Zustand store
  const clearAllData = useTransactionStore((state) => (state as any).clearAllData); // Type assertion if method not exposed
  const injectDummyData = useTransactionStore((state) => (state as any).injectDummyData);

  const handleClear = () => {
    Alert.alert("Warning", "This will wipe the entire Silo database.", [
      { text: "Cancel", style: "cancel" },
      { text: "Wipe It", style: "destructive", onPress: clearAllData }
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>More</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        
        <View style={[styles.aiCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Ionicons name="sparkles" size={32} color={theme.primary} style={{ marginBottom: 12 }} />
          <Text style={[styles.aiTitle, { color: theme.text }]}>Silo AI Chatbot</Text>
          <Text style={[styles.aiDesc, { color: theme.textMuted }]}>Ask questions about your spending or analyze your budget.</Text>
          
          <TextInput
            style={[styles.input, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
            placeholderTextColor={theme.textMuted}
            placeholder="E.g., How much did I spend on food?"
            value={dummyQuery}
            onChangeText={setDummyQuery}
          />
          
          <TouchableOpacity style={[styles.chatButton, { backgroundColor: theme.primary }]} onPress={() => navigation.navigate('Chatbot', { initialMessage: dummyQuery })}>
            <Text style={styles.chatButtonText}>Start Chat</Text>
          </TouchableOpacity>
        </View>
        
        {/* DEV TOOLS SECTION - Only visible in local development */}
        {__DEV__ && (
          <>
            <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>Developer Tools</Text>
            <View style={[styles.devCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <TouchableOpacity style={styles.devButton} onPress={injectDummyData}>
                <Ionicons name="add-circle-outline" size={24} color={theme.primary} />
                <Text style={[styles.devButtonText, { color: theme.text }]}>Inject Dummy Data</Text>
              </TouchableOpacity>
              
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              
              <TouchableOpacity style={styles.devButton} onPress={handleClear}>
                <Ionicons name="trash-outline" size={24} color={theme.expense} />
                <Text style={[styles.devButtonText, { color: theme.expense }]}>Clear Database</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        <TouchableOpacity style={[styles.settingRow, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => navigation.navigate('Settings')}>
          <Ionicons name="settings-outline" size={24} color={theme.text} />
          <Text style={[styles.settingText, { color: theme.text }]}>App Settings</Text>
          <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
        </TouchableOpacity>
        
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingVertical: 16, alignItems: 'center', borderBottomWidth: 1 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  scrollContent: { padding: 16, paddingBottom: 120 }, 
  aiCard: { padding: 20, borderRadius: 12, borderWidth: 1, marginBottom: 24, alignItems: 'center' },
  aiTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  aiDesc: { textAlign: 'center', marginBottom: 16 },
  input: { width: '100%', borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 16 },
  chatButton: { width: '100%', padding: 14, borderRadius: 8, alignItems: 'center' },
  chatButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 'bold', textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
  devCard: { borderRadius: 12, borderWidth: 1, marginBottom: 24, overflow: 'hidden' },
  devButton: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  devButtonText: { fontSize: 16, fontWeight: '500', marginLeft: 12 },
  divider: { height: 1, marginLeft: 52 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 8, borderWidth: 1 },
  settingText: { flex: 1, marginLeft: 12, fontSize: 16 }
});