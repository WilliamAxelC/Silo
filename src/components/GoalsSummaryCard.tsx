import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';

import type { NavigationProps } from '../navigation/types';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTransactionStore } from '../store/useTransactionStore';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { goalProgress, useGoalsStore } from '../features/goals/goals';

/** Budget tab: a compact look at active savings goals, opening the Goals screen. */
export function GoalsSummaryCard() {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const currency = useSettingsStore((s) => s.currencyCode);
  const thousands = useSettingsStore((s) => s.useThousandsSeparator);
  const wallets = useTransactionStore((s) => s.wallets);
  const goals = useGoalsStore((s) => s.goals).filter((g) => !g.archived);
  const ensureLoaded = useGoalsStore((s) => s.ensureLoaded);

  // Once is enough: every goal change goes through the store, and restore/erase reload it.
  useEffect(() => ensureLoaded(), [ensureLoaded]);

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      onPress={() => navigation.navigate('Goals')}
      accessibilityRole="button"
      accessibilityLabel={goals.length ? `Savings goals, ${goals.length} active` : 'Savings goals, set one up'}
      testID="goals-summary"
    >
      <View style={styles.head}>
        <Ionicons name="flag-outline" size={18} color={theme.primary} />
        <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(15) }]}>Savings goals</Text>
        <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
      </View>
      {goals.length === 0 ? (
        <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13) }}>Save towards something. Tap to set a goal.</Text>
      ) : (
        goals.slice(0, 3).map((goal) => {
          const p = goalProgress(goal, wallets, currency);
          return (
            <View key={goal.id} style={styles.goalRow}>
              <View style={styles.goalText}>
                <Text style={{ color: theme.text, fontSize: theme.scaleFont(13), fontWeight: '600', flex: 1 }} numberOfLines={1}>
                  {goal.name}
                </Text>
                <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(12) }}>
                  {formatDisplayCurrency(p.current, currency, thousands)} / {formatDisplayCurrency(goal.targetAmount, currency, thousands)}
                </Text>
              </View>
              <View style={[styles.bar, { backgroundColor: theme.border }]}>
                <View style={[styles.fill, { width: `${Math.round(p.fraction * 100)}%`, backgroundColor: p.done ? theme.income : theme.primary }]} />
              </View>
            </View>
          );
        })
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontWeight: '800', flex: 1 },
  goalRow: { gap: 4 },
  goalText: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});
