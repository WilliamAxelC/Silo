import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';

export const MoreScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const [quickQuery, setQuickQuery] = useState('');
  const theme = useAppTheme();

  const clearAllData = useTransactionStore((state) => state.clearAllData);
  const injectDummyData = useTransactionStore((state) => state.injectDummyData);

  const handleClear = () => {
    Alert.alert('Warning', 'This will wipe the entire Silo database.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Wipe It', style: 'destructive', onPress: clearAllData },
    ]);
  };

  const handleOpenChat = () => {
    const trimmed = quickQuery.trim();
    setQuickQuery('');
    if (trimmed) {
      navigation.navigate('Chatbot', { initialMessage: trimmed, autoSend: true });
    } else {
      navigation.navigate('Chatbot', {});
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]}>More</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={[styles.aiCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.aiHeaderRow}>
            <View style={[styles.aiIconWrap, { backgroundColor: theme.background }]}>
              <Ionicons name="sparkles" size={20} color={theme.primary} />
            </View>
            <View style={styles.aiHeaderText}>
              <Text style={[styles.aiTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>Silo AI Chatbot</Text>
              <Text style={[styles.aiDesc, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                Ask about spending or budgets.
              </Text>
            </View>
          </View>

          <View style={styles.aiInputRow}>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: theme.background, borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(14) },
              ]}
              placeholderTextColor={theme.textMuted}
              placeholder="Ask a finance question"
              accessibilityLabel="Ask a finance question"
              value={quickQuery}
              onChangeText={setQuickQuery}
              returnKeyType="send"
              onSubmitEditing={handleOpenChat}
            />
            <TouchableOpacity
              style={[styles.chatButton, { backgroundColor: theme.primary }]}
              onPress={handleOpenChat}
              accessibilityRole="button"
              accessibilityLabel={quickQuery.trim() ? 'Ask Silo AI' : 'Open chatbot'}
            >
              <Ionicons name="arrow-forward" size={18} color={theme.onPrimary} />
            </TouchableOpacity>
          </View>
        </View>

        {__DEV__ ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              Developer Tools
            </Text>
            <View style={[styles.devCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <TouchableOpacity
                style={styles.devButton}
                onPress={injectDummyData}
                accessibilityRole="button"
                accessibilityLabel="Inject Dummy Data"
              >
                <Ionicons name="add-circle-outline" size={20} color={theme.primary} />
                <Text style={[styles.devButtonText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>
                  Inject Dummy Data
                </Text>
              </TouchableOpacity>

              <View style={[styles.divider, { backgroundColor: theme.border }]} />

              <TouchableOpacity
                style={styles.devButton}
                onPress={handleClear}
                accessibilityRole="button"
                accessibilityLabel="Clear Database"
              >
                <Ionicons name="trash-outline" size={20} color={theme.expense} />
                <Text style={[styles.devButtonText, { color: theme.expense, fontSize: theme.scaleFont(14) }]}>
                  Clear Database
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}

        <View style={[styles.menuCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => navigation.navigate('Accounts')}
            accessibilityRole="button"
            accessibilityLabel="Accounts"
          >
            <View style={styles.settingRowLeft}>
              <Ionicons name="wallet-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Accounts</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => navigation.navigate('Recurring')}
            accessibilityRole="button"
            accessibilityLabel="Recurring"
          >
            <View style={styles.settingRowLeft}>
              <Ionicons name="repeat-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Recurring</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => navigation.navigate('ReceiptInbox')}
            accessibilityRole="button"
            accessibilityLabel="Receipt Inbox"
          >
            <View style={styles.settingRowLeft}>
              <Ionicons name="receipt-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Receipt Inbox</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => navigation.navigate('Activity')}
            accessibilityRole="button"
            accessibilityLabel="Activity"
          >
            <View style={styles.settingRowLeft}>
              <Ionicons name="time-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Activity</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => navigation.navigate('Settings')}
            accessibilityRole="button"
            accessibilityLabel="App Settings"
          >
            <View style={styles.settingRowLeft}>
              <Ionicons name="settings-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>App Settings</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.footerWrap}>
          <Text style={[styles.footerText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>Silo · by CDev</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 56,
    justifyContent: 'center',
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  scrollContent: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 28 },
  aiCard: { padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 14 },
  aiHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  aiIconWrap: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  aiHeaderText: { flex: 1 },
  aiTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  aiDesc: { fontSize: 12 },
  aiInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 14 },
  chatButton: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6, marginLeft: 4 },
  devCard: { borderRadius: 12, borderWidth: 1, marginBottom: 14, overflow: 'hidden' },
  devButton: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingHorizontal: 14, paddingVertical: 10 },
  devButtonText: { fontSize: 14, fontWeight: '500', marginLeft: 10 },
  divider: { height: 1, marginLeft: 44 },
  menuCard: { borderRadius: 12, borderWidth: 1, marginBottom: 14, overflow: 'hidden' },
  menuRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52, paddingHorizontal: 14 },
  settingRowLeft: { flexDirection: 'row', alignItems: 'center' },
  settingText: { marginLeft: 10, fontSize: 14, fontWeight: '500' },
  footerWrap: { alignItems: 'center', marginTop: 16, marginBottom: 8 },
  footerText: { fontSize: 12, fontWeight: '500' },
});
