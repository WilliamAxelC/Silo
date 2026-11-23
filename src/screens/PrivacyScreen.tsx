import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';

import type { NavigationProps } from '../navigation/types';
import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';

/** Every network request Silo can make, in plain words. Keep in sync with the code that makes them. */
export const NETWORK_USES: Array<{ icon: keyof typeof Ionicons.glyphMap; title: string; what: string; when: string }> = [
  {
    icon: 'swap-horizontal-outline',
    title: 'Exchange rates',
    what: 'Your home currency code (for example IDR) to a public currency-rate service (jsDelivr / currency-api).',
    when: 'At most once a day, only if you use another currency.',
  },
  {
    icon: 'arrow-up-circle-outline',
    title: 'Updates',
    what: 'A small version file from cuang.dev, and the new Silo app file when you tap Update. Nothing about you is sent.',
    when: 'The check runs at most once a day (turn off "Tell me about new versions" in More, App info); the download only when you tap Update.',
  },
  {
    icon: 'sparkles-outline',
    title: 'AI model download',
    what: 'The on-device AI model files from Hugging Face.',
    when: 'Only when you tap Download Model. After that the AI runs on your phone.',
  },
  {
    icon: 'cloud-outline',
    title: 'External AI (optional)',
    what: 'Your question, earlier chat messages and the finance facts needed to answer it, and receipt text (and the receipt photo in AI vision mode) when reading receipts, to the AI service you configure. If the on-device model is not ready, Silo uses that service instead.',
    when: 'Only if you switch AI to External in Settings, AI & Receipt Scanning. Off by default.',
  },
  {
    icon: 'logo-google',
    title: 'Google Drive (optional)',
    what: 'Your backups, and receipt photos you choose to move, go to a Silo folder in your own Google Drive. Silo can only see files it created there.',
    when: 'Only after you connect Drive in Settings, Data & System. Disconnect any time.',
  },
  {
    icon: 'bug-outline',
    title: 'Bug reports and feature requests',
    what: "Your text, Silo version, phone model and Android version; the error log or a screenshot only if you add them. They go to the developer's server and private Discord.",
    when: 'Only when you press Send on a report.',
  },
];

const STAYS = [
  'Your transactions, accounts, budgets, goals and receipt photos (unless you connect Google Drive or use External AI)',
  'Receipt reading (OCR) and the on-device AI chat',
  'Nothing is ever sent to the developer except a report you choose to send',
];

export { PRIVACY_URL as PRIVACY_POLICY_URL, TERMS_URL } from '../services/terms';
import { PRIVACY_URL as PRIVACY_POLICY_URL, TERMS_URL } from '../services/terms';

export const PrivacyScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const body = { color: theme.text, fontSize: theme.scaleFont(14), lineHeight: theme.scaleFont(20) };
  const muted = { color: theme.textMuted, fontSize: theme.scaleFont(13), lineHeight: theme.scaleFont(18) };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]} accessibilityRole="header">
          Privacy
        </Text>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: getBottomInsetPadding(insets.bottom, 24) }]}>
        <Text style={[body, styles.lead]}>
          No account, and nothing is sent to the developer. Your money data stays on this phone unless you turn on Google
          Drive or External AI. These are the only times Silo uses the internet:
        </Text>

        {NETWORK_USES.map((use) => (
          <View key={use.title} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.cardHead}>
              <Ionicons name={use.icon} size={20} color={theme.primary} />
              <Text style={[body, styles.cardTitle]} accessibilityRole="header">
                {use.title}
              </Text>
            </View>
            <Text style={body}>{use.what}</Text>
            <Text style={[muted, styles.when]}>{use.when}</Text>
          </View>
        ))}

        <Text style={[body, styles.subhead]} accessibilityRole="header">
          Never leaves your phone
        </Text>
        {STAYS.map((line) => (
          <View key={line} style={styles.stayRow}>
            <Ionicons name="lock-closed-outline" size={16} color={theme.income} />
            <Text style={[body, styles.stayText]}>{line}</Text>
          </View>
        ))}

        <Text style={[muted, styles.footer]}>
          To remove everything Silo keeps on this phone, use Settings, Data & System, Erase All Data.
        </Text>
        <View style={styles.links}>
          {[
            ['Privacy Policy', PRIVACY_POLICY_URL],
            ['Terms of Service', TERMS_URL],
          ].map(([label, url]) => (
            <TouchableOpacity
              key={url}
              style={[styles.linkBtn, { borderColor: theme.border }]}
              onPress={() => void Linking.openURL(url)}
              accessibilityRole="link"
              accessibilityLabel={`Open the ${label}`}
            >
              <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>{label}</Text>
              <Ionicons name="open-outline" size={16} color={theme.primary} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingHorizontal: 8, paddingVertical: 8 },
  backBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontWeight: '800' },
  content: { padding: 16 },
  lead: { marginBottom: 12 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { fontWeight: '700' },
  when: { marginTop: 2 },
  subhead: { fontWeight: '800', marginTop: 12, marginBottom: 8 },
  stayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  stayText: { flex: 1 },
  footer: { marginTop: 16 },
  links: { flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14 },
});
