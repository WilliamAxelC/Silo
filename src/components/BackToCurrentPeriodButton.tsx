import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAppTheme } from '../theme/useAppTheme';

type Props = {
  onPress: () => void;
  /** Locale for the month name, e.g. 'en-GB'. */
  locale?: string;
  now?: Date;
};

/**
 * Shown beside the month selector when another month is open. Worded and drawn as an action
 * ("↩ Back to Nov", outlined) so it isn't mistaken for a label saying the open month is the current one.
 */
export function BackToCurrentPeriodButton({ onPress, locale, now = new Date() }: Props) {
  const theme = useAppTheme();
  let month: string;
  try {
    month = now.toLocaleDateString(locale || 'en-GB', { month: 'short' });
  } catch {
    month = now.toLocaleDateString('en-GB', { month: 'short' });
  }
  return (
    <TouchableOpacity
      testID="back-to-current-period"
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Back to current month"
      style={[styles.button, { borderColor: theme.primary }]}
    >
      <Ionicons name="arrow-undo" size={12} color={theme.primary} />
      <Text style={[styles.text, { color: theme.primary, fontSize: theme.scaleFont(11) }]} numberOfLines={1}>
        Back to {month}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  text: { fontWeight: '700' },
});
