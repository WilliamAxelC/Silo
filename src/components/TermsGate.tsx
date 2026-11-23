import React, { useEffect } from 'react';
import { Linking, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { PRIVACY_URL, TERMS_URL, termsPrompt, useTermsStore } from '../services/terms';

/** First launch: agree to the Terms. Changed terms: shown before they apply; "Later" keeps the old ones. */
export function TermsGate() {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const state = useTermsStore();
  const prompt = termsPrompt(state);

  useEffect(() => {
    if (!state.loaded) state.load();
  }, [state]);

  if (prompt === 'none') return null;
  const text = { color: theme.text, fontSize: theme.scaleFont(14), lineHeight: theme.scaleFont(21) };
  const link = (label: string, url: string) => (
    <TouchableOpacity
      key={url}
      style={[styles.linkBtn, { borderColor: theme.border }]}
      onPress={() => void Linking.openURL(url)}
      accessibilityRole="link"
      accessibilityLabel={`Read the ${label}`}
    >
      <Text style={{ color: theme.primary, fontWeight: '700', fontSize: theme.scaleFont(14) }}>{label}</Text>
      <Ionicons name="open-outline" size={16} color={theme.primary} />
    </TouchableOpacity>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => (prompt === 'changed' ? state.postpone() : undefined)}>
      <View style={styles.overlay}>
        <View
          style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: getBottomInsetPadding(insets.bottom, 18) }]}
          testID="terms-gate"
        >
          <Text style={{ color: theme.text, fontWeight: '800', fontSize: theme.scaleFont(19) }} accessibilityRole="header">
            {prompt === 'first' ? 'Before you start' : 'Updated terms'}
          </Text>
          <Text style={text}>
            {prompt === 'first'
              ? 'Silo is free and keeps your money data on this phone. Please read and agree to the Terms of Service. The Privacy Policy explains exactly what leaves your phone and when.'
              : 'The Terms of Service have changed. They apply to you only after you agree. Until then, your current terms stay in place.'}
          </Text>
          <Text style={[text, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
            In short: Silo is not financial advice, receipt reading and AI answers can be wrong, and keeping backups is up to
            you.
          </Text>
          <View style={styles.links}>
            {link('Terms of Service', TERMS_URL)}
            {link('Privacy Policy', PRIVACY_URL)}
          </View>
          <TouchableOpacity
            style={[styles.agree, { backgroundColor: theme.primary }]}
            onPress={() => state.accept()}
            accessibilityRole="button"
            accessibilityLabel="Agree to the Terms of Service"
          >
            <Text style={{ color: theme.onPrimary, fontWeight: '800', fontSize: theme.scaleFont(15) }}>Agree</Text>
          </TouchableOpacity>
          {prompt === 'changed' ? (
            <TouchableOpacity style={styles.later} onPress={state.postpone} accessibilityRole="button" accessibilityLabel="Decide later">
              <Text style={{ color: theme.textMuted, fontWeight: '700', fontSize: theme.scaleFont(14) }}>Later</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 20, gap: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14 },
  agree: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  later: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
