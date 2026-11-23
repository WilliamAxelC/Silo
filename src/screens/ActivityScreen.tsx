import React, { useCallback, useMemo, useState } from 'react';
import { Alert, SectionList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import type { NavigationProps } from '../navigation/types';
import { useTransactionStore } from '../store/useTransactionStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { ActivityEntry } from '../features/activity/activityLog';
import { describeActivity } from '../features/activity/describeActivity';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

function timeAgo(at: number, now: number, locale: string): string {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** Everything changed recently, newest first; tap to open, Undo to revert. */
export const ActivityScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const homeCurrency = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const activity = useTransactionStore((s) => s.activity);
  const wallets = useTransactionStore((s) => s.wallets);
  const transactionsList = useTransactionStore((s) => s.transactionsList);
  const [busyId, setBusyId] = useState<number | null>(null);
  const locale = dateFormat || 'en-GB';

  useFocusEffect(
    useCallback(() => {
      useTransactionStore.getState().fetchActivity();
    }, [])
  );

  const existingIds = useMemo(() => new Set(transactionsList.map((t) => t.id)), [transactionsList]);
  const ctx = useMemo(
    () => ({
      homeCurrency,
      useThousands,
      dateLocale: locale,
      walletName: (id: number | null | undefined) => wallets.find((w) => w.id === id)?.name,
    }),
    [homeCurrency, useThousands, locale, wallets]
  );

  const sections = useMemo(() => {
    const byDay = new Map<string, ActivityEntry[]>();
    for (const entry of activity) {
      const day = new Date(entry.at).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
    return Array.from(byDay, ([title, data]) => ({ title, data }));
  }, [activity, locale]);

  const undo = async (entry: ActivityEntry) => {
    setBusyId(entry.id);
    const result = await useTransactionStore.getState().undoActivity(entry.id);
    setBusyId(null);
    if (!result.ok) Alert.alert("Couldn't undo", result.message ?? 'Something went wrong.');
    else if (result.message) Alert.alert('Undone', result.message);
  };

  const now = Date.now();
  const renderItem = ({ item }: { item: ActivityEntry }) => {
    const { title, detail, icon } = describeActivity(item, ctx);
    const openable = item.entity === 'transaction' && item.entityId != null && existingIds.has(item.entityId) && item.action !== 'delete';
    return (
      <View style={[styles.row, { backgroundColor: theme.surface, borderBottomColor: theme.border, opacity: item.undone ? 0.55 : 1 }]}>
        <TouchableOpacity
          style={styles.rowMain}
          disabled={!openable}
          onPress={() => navigation.navigate('AddTransactionStack', { transactionId: item.entityId as number })}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${detail}. ${timeAgo(item.at, now, locale)}${item.undone ? '. Undone' : ''}`}
        >
          <Ionicons name={icon} size={20} color={item.action === 'delete' ? theme.expense : theme.primary} />
          <View style={styles.rowText}>
            <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(14) }]} numberOfLines={1}>
              {title}
            </Text>
            {detail ? (
              <Text style={[styles.detail, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]} numberOfLines={2}>
                {detail}
              </Text>
            ) : null}
            <Text style={[styles.detail, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
              {timeAgo(item.at, now, locale)}
              {item.undone ? ' · undone' : ''}
            </Text>
          </View>
        </TouchableOpacity>
        {!item.undone ? (
          <TouchableOpacity
            style={[styles.undoBtn, { borderColor: theme.border }]}
            disabled={busyId === item.id}
            onPress={() => void undo(item)}
            accessibilityRole="button"
            accessibilityLabel={`Undo: ${title}`}
          >
            <Text style={{ color: theme.primary, fontSize: theme.scaleFont(12), fontWeight: '700' }}>Undo</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(18) }]}>Activity</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.section, { color: theme.textMuted, backgroundColor: theme.background, fontSize: theme.scaleFont(12) }]}>
            {section.title}
          </Text>
        )}
        contentContainerStyle={{ paddingBottom: getBottomInsetPadding(insets.bottom, 24) }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
            Changes you make to transactions, budgets, accounts and tags show up here for 90 days.
          </Text>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingHorizontal: 8, paddingVertical: 8 },
  backBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontWeight: '800' },
  section: { fontWeight: '700', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowText: { flex: 1, minWidth: 0 },
  title: { fontWeight: '700' },
  detail: { marginTop: 2 },
  undoBtn: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, minHeight: 32, justifyContent: 'center' },
  empty: { textAlign: 'center', padding: 24, lineHeight: 19 },
});
