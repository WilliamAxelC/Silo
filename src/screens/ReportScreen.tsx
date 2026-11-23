import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import type { NavigationProps, RootStackParamList } from '../navigation/types';
import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { formatErrorLog, getErrorLog } from '../services/errorLog';
import { getInstalledVersion } from '../services/updates';
import { deviceSummary, getSentTickets, submitTicket, validateTicket, type TicketKind } from '../services/tickets';
import { PRIVACY_POLICY_URL } from './PrivacyScreen';

const MAX_SCREENSHOT_BYTES = 1.8 * 1024 * 1024;

/** Shrinks a picked screenshot to a JPEG small enough to send (about 1 MB). */
async function prepareScreenshot(uri: string): Promise<{ uri: string; base64: string }> {
  for (const [width, compress] of [[1080, 0.6], [800, 0.45]] as const) {
    const out = await manipulateAsync(uri, [{ resize: { width } }], { compress, format: SaveFormat.JPEG, base64: true });
    if (out.base64 && (out.base64.length * 3) / 4 <= MAX_SCREENSHOT_BYTES) return { uri: out.uri, base64: out.base64 };
  }
  throw new Error('That image is too large to send.');
}

export const ReportScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const route = useRoute<RouteProp<RootStackParamList, 'Report'>>();
  const theme = useAppTheme();
  const insets = useSafeInsets();

  const [kind, setKind] = useState<TicketKind>(route.params?.kind ?? 'bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attachLog, setAttachLog] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [screenshot, setScreenshot] = useState<{ uri: string; base64: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentList, setSentList] = useState(() => getSentTickets());

  const errorEntries = useMemo(() => getErrorLog(), []);
  const logText = useMemo(() => formatErrorLog(errorEntries), [errorEntries]);
  const installed = getInstalledVersion();
  const { device, osVersion } = deviceSummary();

  const pickScreenshot = async () => {
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (picked.canceled || !picked.assets?.[0]?.uri) return;
      setScreenshot(await prepareScreenshot(picked.assets[0].uri));
    } catch (e) {
      Alert.alert("Couldn't add the screenshot", e instanceof Error ? e.message : 'Please try another image.');
    }
  };

  const send = async () => {
    const input = {
      kind,
      title,
      description,
      errorLog: attachLog ? logText : undefined,
      screenshotBase64: screenshot?.base64,
    };
    const problem = validateTicket(input);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSending(true);
    try {
      const sent = await submitTicket(input);
      setSentList(getSentTickets());
      setTitle('');
      setDescription('');
      setAttachLog(false);
      setScreenshot(null);
      Alert.alert('Thanks!', `Report #${sent.ticket} was sent. It goes straight to the developer.`, [
        { text: 'Done', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sending failed.');
    } finally {
      setSending(false);
    }
  };

  const field = [styles.input, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(15) }];
  const label = [styles.label, { color: theme.text, fontSize: theme.scaleFont(13) }];
  const muted = { color: theme.textMuted, fontSize: theme.scaleFont(12) };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]}>
          {kind === 'bug' ? 'Report a bug' : 'Request a feature'}
        </Text>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: getBottomInsetPadding(insets.bottom, 24) }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.segment, { borderColor: theme.border, backgroundColor: theme.surface }]}>
            {(['bug', 'feature'] as const).map((k) => {
              const selected = kind === k;
              return (
                <TouchableOpacity
                  key={k}
                  style={[styles.segmentBtn, selected && { backgroundColor: theme.primary }]}
                  onPress={() => setKind(k)}
                  accessibilityRole="button"
                  accessibilityLabel={k === 'bug' ? 'Bug report' : 'Feature request'}
                  accessibilityState={{ selected }}
                >
                  <Ionicons name={k === 'bug' ? 'bug-outline' : 'bulb-outline'} size={18} color={selected ? theme.onPrimary : theme.textMuted} />
                  <Text style={{ color: selected ? theme.onPrimary : theme.text, fontWeight: '700', fontSize: theme.scaleFont(14) }}>
                    {k === 'bug' ? 'Bug' : 'Feature'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={label}>Title</Text>
          <TextInput
            style={field}
            value={title}
            onChangeText={setTitle}
            maxLength={120}
            placeholder={kind === 'bug' ? 'e.g. Tapping Amount does nothing' : 'e.g. Split a bill with friends'}
            placeholderTextColor={theme.textMuted}
            accessibilityLabel="Report title"
          />

          <Text style={label}>{kind === 'bug' ? 'What happened? What did you expect?' : 'What would you like Silo to do?'}</Text>
          <TextInput
            style={[field, styles.multiline]}
            value={description}
            onChangeText={setDescription}
            maxLength={4000}
            multiline
            textAlignVertical="top"
            placeholder={kind === 'bug' ? 'Steps to make it happen help a lot.' : 'How would you use it?'}
            placeholderTextColor={theme.textMuted}
            accessibilityLabel="Report description"
          />

          <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.switchRow}>
              <View style={styles.flex}>
                <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }}>Attach Silo's error log</Text>
                <Text style={muted}>
                  {errorEntries.length === 0
                    ? 'No errors recorded.'
                    : `${errorEntries.length} recent ${errorEntries.length === 1 ? 'entry' : 'entries'}. Numbers are masked.`}
                </Text>
              </View>
              <Switch
                value={attachLog}
                onValueChange={setAttachLog}
                disabled={errorEntries.length === 0}
                accessibilityLabel="Attach Silo's error log"
                trackColor={{ true: theme.primary, false: theme.border }}
              />
            </View>
            {errorEntries.length > 0 ? (
              <TouchableOpacity onPress={() => setShowLog((v) => !v)} accessibilityRole="button" accessibilityLabel="Show the error log">
                <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13), marginTop: 8 }}>
                  {showLog ? 'Hide log' : 'See what is sent'}
                </Text>
              </TouchableOpacity>
            ) : null}
            {showLog ? (
              <Text style={[styles.logText, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]} selectable>
                {logText}
              </Text>
            ) : null}
          </View>

          <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontWeight: '600', fontSize: theme.scaleFont(14) }}>Screenshot (optional)</Text>
            <Text style={[muted, styles.warn]}>
              Screenshots can show your balances and names. Only add one if you're happy to share what's on it.
            </Text>
            {screenshot ? (
              <View style={styles.shotRow}>
                <Image source={{ uri: screenshot.uri }} style={styles.shot} accessibilityLabel="Selected screenshot" />
                <TouchableOpacity
                  style={[styles.smallBtn, { borderColor: theme.border }]}
                  onPress={() => setScreenshot(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Remove screenshot"
                >
                  <Text style={{ color: theme.expense, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Remove</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.smallBtn, { borderColor: theme.border, alignSelf: 'flex-start' }]}
                onPress={() => void pickScreenshot()}
                accessibilityRole="button"
                accessibilityLabel="Add a screenshot"
              >
                <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Add screenshot</Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={[muted, styles.disclosure]} testID="report-disclosure">
            Sent to the developer: your title and text, Silo {installed.version} (build {installed.versionCode}), {device}, Android{' '}
            {osVersion}
            {attachLog ? ', the error log' : ''}
            {screenshot ? ', the screenshot' : ''}. Sending is voluntary. It goes to the developer's server and private Discord (stored in the USA). Your transactions
            and amounts are never added automatically.{' '}
            <Text style={{ color: theme.primary, fontWeight: '700' }} onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} accessibilityRole="link">
              Privacy Policy
            </Text>
          </Text>

          {error ? (
            <Text accessibilityRole="alert" style={{ color: theme.expense, fontSize: theme.scaleFont(13), marginBottom: 8 }}>
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: theme.primary, opacity: sending ? 0.7 : 1 }]}
            onPress={() => void send()}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Send report"
          >
            {sending ? (
              <ActivityIndicator color={theme.onPrimary} />
            ) : (
              <Text style={{ color: theme.onPrimary, fontWeight: '800', fontSize: theme.scaleFont(15) }}>Send</Text>
            )}
          </TouchableOpacity>

          {sentList.length > 0 ? (
            <View style={styles.sentWrap}>
              <Text style={[label, { marginTop: 18 }]}>Your reports</Text>
              {sentList.slice(0, 10).map((t) => (
                <Text key={`${t.ticket}-${t.sentAt}`} style={[muted, styles.sentRow]}>
                  #{t.ticket} · {t.kind === 'bug' ? 'Bug' : 'Feature'} · {t.title}
                </Text>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingHorizontal: 8, paddingVertical: 8 },
  backBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontWeight: '800' },
  content: { padding: 16 },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 14, padding: 4, gap: 4, marginBottom: 14 },
  segmentBtn: { flex: 1, minHeight: 48, borderRadius: 10, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '700', marginBottom: 6, marginTop: 4 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, marginBottom: 12 },
  multiline: { minHeight: 130, paddingTop: 12 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logText: { marginTop: 8, fontFamily: Platform.OS === 'android' ? 'monospace' : undefined },
  warn: { marginTop: 4, marginBottom: 10 },
  shotRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  shot: { width: 72, height: 128, borderRadius: 8 },
  smallBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: 'center' },
  disclosure: { marginVertical: 8, lineHeight: 18 },
  sendBtn: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  sentWrap: { marginTop: 4 },
  sentRow: { paddingVertical: 4 },
});
