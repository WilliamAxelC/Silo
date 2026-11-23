import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Alert, Linking, Switch, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { NavigationProps } from '../navigation/types';

import { useTransactionStore } from '../store/useTransactionStore';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { DOWNLOAD_PAGE_URL, isNewer, useUpdateStore } from '../services/updates';
import { formatCachedLocaleDate } from '../features/transactions/periods';
import { DB_SCHEMA_VERSION } from '../db/index';

export const MoreScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const [quickQuery, setQuickQuery] = useState('');
  const theme = useAppTheme();

  const clearAllData = useTransactionStore((state) => state.clearAllData);
  const injectDummyData = useTransactionStore((state) => state.injectDummyData);
  const locale = useSettingsStore((s) => s.dateFormat) || 'en-GB';
  const installed = useUpdateStore((s) => s.installed);
  const latest = useUpdateStore((s) => s.latest);
  const checkedAt = useUpdateStore((s) => s.checkedAt);
  const checking = useUpdateStore((s) => s.checking);
  const autoCheck = useUpdateStore((s) => s.enabled);
  const lastCheckFailed = useUpdateStore((s) => s.lastCheckFailed);
  const checkForUpdates = useUpdateStore((s) => s.check);
  const setAutoCheck = useUpdateStore((s) => s.setEnabled);
  const updateAvailable = isNewer(latest, installed);
  const updateStatus = checking
    ? 'Checking…'
    : lastCheckFailed
      ? "Couldn't reach the download page. Check your connection."
      : updateAvailable && latest
        ? `Silo ${latest.version} is available`
        : checkedAt
          ? `Up to date · checked ${formatCachedLocaleDate(checkedAt, locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
          : 'Not checked yet';

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

        <Text style={[styles.sectionTitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>App info</Text>
        <View style={[styles.menuCard, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="app-info">
          <View style={styles.menuRow}>
            <View style={styles.settingRowLeft}>
              <Ionicons name="information-circle-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Version</Text>
            </View>
            <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }} testID="app-version">
              {installed.version} (build {installed.versionCode})
            </Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.menuRow}>
            <View style={styles.settingRowLeft}>
              <Ionicons name="server-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Database</Text>
            </View>
            <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }} testID="db-version">
              v{DB_SCHEMA_VERSION}
            </Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.infoBlock}>
            <View style={styles.settingRowLeft}>
              <Ionicons
                name={updateAvailable ? 'arrow-up-circle' : 'checkmark-circle-outline'}
                size={20}
                color={updateAvailable ? theme.income : theme.primary}
              />
              <Text
                style={[styles.settingText, styles.flexText, { color: updateAvailable ? theme.income : theme.text, fontSize: theme.scaleFont(14) }]}
                testID="update-status"
              >
                {updateStatus}
              </Text>
            </View>
            {updateAvailable && latest?.notes?.length ? (
              <Text style={[styles.notesText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                {latest.notes.map((n) => `• ${n}`).join('\n')}
              </Text>
            ) : null}
            <View style={styles.infoButtons}>
              {updateAvailable && latest ? (
                <TouchableOpacity
                  style={[styles.infoBtn, { backgroundColor: theme.primary, borderColor: theme.primary }]}
                  onPress={() => void Linking.openURL(latest.url)}
                  accessibilityRole="button"
                  accessibilityLabel={`Download Silo ${latest.version}`}
                >
                  <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Download</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.infoBtn, { borderColor: theme.border, backgroundColor: theme.background }]}
                onPress={() => void checkForUpdates({ force: true })}
                disabled={checking}
                accessibilityRole="button"
                accessibilityLabel="Check for updates"
              >
                {checking ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Check now</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.menuRow}>
            <View style={[styles.settingRowLeft, styles.flexText]}>
              <Ionicons name="notifications-outline" size={20} color={theme.primary} />
              <View style={styles.flexText}>
                <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Tell me about new versions</Text>
                <Text style={[styles.settingText, { color: theme.textMuted, fontSize: theme.scaleFont(11), fontWeight: '400' }]}>
                  Once a day Silo reads a small file from cuang.dev. Nothing about you is sent.
                </Text>
              </View>
            </View>
            <Switch
              value={autoCheck}
              onValueChange={setAutoCheck}
              accessibilityLabel="Tell me about new versions"
              trackColor={{ true: theme.primary, false: theme.border }}
            />
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => void Linking.openURL(DOWNLOAD_PAGE_URL)}
            accessibilityRole="link"
            accessibilityLabel="Open the Silo download page"
          >
            <View style={styles.settingRowLeft}>
              <Ionicons name="globe-outline" size={20} color={theme.primary} />
              <Text style={[styles.settingText, { color: theme.text, fontSize: theme.scaleFont(14) }]}>Download page</Text>
            </View>
            <Ionicons name="open-outline" size={18} color={theme.textMuted} />
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
  infoBlock: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  flexText: { flex: 1 },
  notesText: { marginLeft: 30, lineHeight: 18 },
  infoButtons: { flexDirection: 'row', gap: 8, marginLeft: 30 },
  infoBtn: { minHeight: 36, minWidth: 96, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  footerWrap: { alignItems: 'center', marginTop: 16, marginBottom: 8 },
  footerText: { fontSize: 12, fontWeight: '500' },
});
