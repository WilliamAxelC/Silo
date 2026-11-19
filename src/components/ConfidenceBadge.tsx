import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ReceiptConfidence } from '../services/ocr/receiptConfidence';
import { useAppTheme } from '../theme/useAppTheme';

const LABELS: Record<ReceiptConfidence, string> = { high: 'Verified', medium: 'Check total', low: 'Low confidence' };
const ICONS: Record<ReceiptConfidence, keyof typeof Ionicons.glyphMap> = {
  high: 'checkmark-circle',
  medium: 'alert-circle',
  low: 'warning',
};

export function useConfidenceColors(level: ReceiptConfidence) {
  const theme = useAppTheme();
  if (level === 'high') return { fg: theme.income, bg: theme.incomeMuted };
  if (level === 'medium') return { fg: theme.warning, bg: theme.warningMuted };
  return { fg: theme.expense, bg: theme.expenseMuted };
}

export const ConfidenceBadge = ({ level }: { level: ReceiptConfidence }) => {
  const { fg, bg } = useConfidenceColors(level);
  return (
    <View
      style={[styles.badge, { backgroundColor: bg, borderColor: fg }]}
      accessibilityLabel={`Scan confidence: ${LABELS[level]}`}
    >
      <Ionicons name={ICONS[level]} size={12} color={fg} />
      <Text style={[styles.text, { color: fg }]}>{LABELS[level]}</Text>
    </View>
  );
};

/** Inline note under a scanned amount: why the total may be wrong. Renders nothing for 'high'. */
export const ConfidenceNotice = ({ level, reasons }: { level: ReceiptConfidence; reasons: string[] }) => {
  const { fg, bg } = useConfidenceColors(level);
  if (level === 'high') return null;
  const title = level === 'low' ? 'Compare the total with the receipt' : 'Double-check the total';
  return (
    <View
      style={[styles.notice, { backgroundColor: bg, borderColor: fg }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={ICONS[level]} size={16} color={fg} style={styles.noticeIcon} />
      <View style={styles.noticeBody}>
        <Text style={[styles.noticeTitle, { color: fg }]}>{title}</Text>
        {reasons.map((reason) => (
          <Text key={reason} style={[styles.noticeText, { color: fg }]}>
            {reason}
          </Text>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  text: { fontSize: 11, fontWeight: '700' },
  notice: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, padding: 8, marginTop: 6 },
  noticeIcon: { marginRight: 6, marginTop: 1 },
  noticeBody: { flex: 1 },
  noticeTitle: { fontSize: 12, fontWeight: '700' },
  noticeText: { fontSize: 11, marginTop: 2 },
});
