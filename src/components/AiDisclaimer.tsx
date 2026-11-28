import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { expoDb } from '../db/index';
import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { SHEET_WIDTH } from '../theme/layout';

const KEY = 'aiDisclaimerSeen';
export const AI_DISCLAIMER_CAPTION = 'Silo AI can be wrong, even about your own numbers. Check important figures. Not financial advice.';

export function hasSeenAiDisclaimer(): boolean {
  try {
    return expoDb.getFirstSync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [KEY])?.value === 'true';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    expoDb.runSync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?);', [KEY, 'true']);
  } catch {
    // shown again next time; harmless
  }
}

/** Shown once, the first time the chat opens: what the AI can and cannot be trusted with. */
export function AiDisclaimerModal() {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const [visible, setVisible] = useState(() => !hasSeenAiDisclaimer());
  if (!visible) return null;
  const text = { color: theme.text, fontSize: theme.scaleFont(14), lineHeight: theme.scaleFont(21) };
  const points = [
    'Answers come from an AI model. It can misread your records, mix up numbers or make things up.',
    'Check important figures in Cashflow or Reports before you rely on them.',
    'It is not financial, tax or legal advice.',
    'With the on-device model, your questions and records stay on this phone.',
  ];
  const close = () => {
    markSeen();
    setVisible(false);
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View
          style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: getBottomInsetPadding(insets.bottom, 18) }]}
          testID="ai-disclaimer"
        >
          <View style={styles.head}>
            <Ionicons name="sparkles-outline" size={22} color={theme.primary} />
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(18) }} accessibilityRole="header">
              Before you chat with Silo AI
            </Text>
          </View>
          {points.map((p) => (
            <View key={p} style={styles.point}>
              <Ionicons name="information-circle-outline" size={18} color={theme.textMuted} />
              <Text style={[text, styles.pointText]}>{p}</Text>
            </View>
          ))}
          <TouchableOpacity
            style={[styles.button, { backgroundColor: theme.primary }]}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="I understand"
          >
            <Text style={{ color: theme.onPrimary, fontWeight: '800', fontSize: theme.scaleFont(15) }}>I understand</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: { ...SHEET_WIDTH, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 20, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  point: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  pointText: { flex: 1 },
  button: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
});
