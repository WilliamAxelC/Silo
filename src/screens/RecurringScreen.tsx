import React, { useCallback, useState } from 'react';
import { Alert, FlatList, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import { NavigationProps } from '../navigation/types';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDisplayCurrency } from '../features/transactions/amount';
import {
  RECURRING_FREQUENCIES,
  deleteRecurringRule,
  listRecurringRules,
  setRecurringRuleActive,
  type RecurringRule,
} from '../services/recurring';
import { useAppTheme } from '../theme/useAppTheme';

export const RecurringScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const [rules, setRules] = useState<RecurringRule[]>([]);

  const refresh = useCallback(() => setRules(listRecurringRules()), []);
  useFocusEffect(refresh);

  const confirmDelete = (rule: RecurringRule) =>
    Alert.alert('Stop repeating?', `${rule.template.merchantName} won't be added again. Past transactions stay.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () => {
          deleteRecurringRule(rule.id);
          refresh();
        },
      },
    ]);

  const renderRule = ({ item }: { item: RecurringRule }) => {
    const label = RECURRING_FREQUENCIES.find((f) => f.key === item.frequency)?.label ?? item.frequency;
    const next = new Date(item.nextDate).toLocaleDateString(dateFormat || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const isIncome = item.template.type === 'income';
    return (
      <View style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border, opacity: item.isActive ? 1 : 0.6 }]}>
        <View style={styles.rowBody}>
          <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
            {item.template.merchantName}
          </Text>
          <Text style={[styles.rowSub, { color: theme.textMuted }]}>
            {label} · {item.isActive ? `next ${next}` : 'paused'}
          </Text>
        </View>
        <Text style={[styles.amount, { color: item.template.type === 'transfer' ? theme.primary : isIncome ? theme.income : theme.expense }]}>
          {formatDisplayCurrency(Math.abs(item.template.totalAmount), currencyCode, useThousands)}
        </Text>
        <Switch
          value={item.isActive}
          onValueChange={(on) => {
            setRecurringRuleActive(item.id, on);
            refresh();
          }}
          trackColor={{ false: '#767577', true: theme.primary }}
          accessibilityLabel={`${item.template.merchantName} repeating`}
        />
        <TouchableOpacity onPress={() => confirmDelete(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Stop repeating ${item.template.merchantName}`}>
          <Ionicons name="trash-outline" size={20} color={theme.textMuted} />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Recurring</Text>
      </View>
      <FlatList
        data={rules}
        keyExtractor={(r) => String(r.id)}
        renderItem={renderRule}
        contentContainerStyle={rules.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="repeat-outline" size={44} color={theme.textMuted} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>Nothing repeats yet</Text>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>
              When adding a transaction such as rent, salary or a subscription, set Repeat. Silo adds it on schedule the next
              time you open the app.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  list: { paddingHorizontal: 16, paddingBottom: 120, gap: 10 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32 },
  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 12, gap: 10 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowSub: { fontSize: 12, marginTop: 2 },
  amount: { fontSize: 14, fontWeight: '700' },
});
