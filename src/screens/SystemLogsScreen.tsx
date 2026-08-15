import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';

import { NavigationProps } from '../navigation/types';
import { useAIStore, AIEventLog } from '../store/useAIStore';
import { useAppTheme } from '../theme/useAppTheme';

type LogLevelFilter = 'all' | 'info' | 'warn' | 'error';

export const SystemLogsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const { logs, runtime, provisioning, clearLogs } = useAIStore();

  const [selectedLevel, setSelectedLevel] = useState<LogLevelFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const systemLogs = useMemo(() => {
    return logs.filter((entry) => {
      const matchesLevel = selectedLevel === 'all' || entry.level === selectedLevel;
      if (!matchesLevel) return false;

      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const eventMatch = entry.event.toLowerCase().includes(q);
      const messageMatch = entry.message.toLowerCase().includes(q);
      const detailsMatch = entry.details ? JSON.stringify(entry.details).toLowerCase().includes(q) : false;
      return eventMatch || messageMatch || detailsMatch;
    });
  }, [logs, selectedLevel, searchQuery]);

  const levelCounts = useMemo(() => {
    const counts = { all: logs.length, info: 0, warn: 0, error: 0 };
    logs.forEach((log) => {
      if (log.level === 'info') counts.info++;
      else if (log.level === 'warn') counts.warn++;
      else if (log.level === 'error') counts.error++;
    });
    return counts;
  }, [logs]);

  const handleCopyAllLogs = async () => {
    if (systemLogs.length === 0) {
      Alert.alert('No Logs', 'There are no logs to copy.');
      return;
    }

    const formatted = systemLogs
      .map(
        (l) =>
          `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.event}] ${l.message}${
            l.details ? ` | ${JSON.stringify(l.details)}` : ''
          }`
      )
      .join('\n');

    await Clipboard.setStringAsync(formatted);
    Alert.alert('Copied', `Copied ${systemLogs.length} log ${systemLogs.length === 1 ? 'entry' : 'entries'} to clipboard.`);
  };

  const handleCopySingleLog = async (entry: AIEventLog) => {
    const text = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.event}] ${entry.message}${
      entry.details ? `\nDetails: ${JSON.stringify(entry.details, null, 2)}` : ''
    }`;
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Log entry copied to clipboard.');
  };

  const handleClearLogsConfirm = () => {
    if (logs.length === 0) return;
    Alert.alert('Clear Logs', 'Are you sure you want to delete all system and diagnostics logs?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All',
        style: 'destructive',
        onPress: () => {
          clearLogs();
        },
      },
    ]);
  };

  const getLevelBadgeColor = (level: 'info' | 'warn' | 'error') => {
    switch (level) {
      case 'error':
        return theme.expense;
      case 'warn':
        return theme.warning;
      case 'info':
      default:
        return theme.primary;
    }
  };

  const getLevelBadgeBg = (level: 'info' | 'warn' | 'error') => {
    switch (level) {
      case 'error':
        return theme.expenseMuted;
      case 'warn':
        return theme.warningMuted;
      case 'info':
      default:
        return theme.primaryMuted;
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      {/* Top App Header */}
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.headerIconButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>System Logs</Text>
          <Text style={[styles.headerSubtitle, { color: theme.textMuted }]}>
            Runtime, model & inference diagnostics
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={handleCopyAllLogs}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel="Copy all logs"
          >
            <Ionicons name="copy-outline" size={20} color={theme.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleClearLogsConfirm}
            style={styles.headerIconButton}
            accessibilityRole="button"
            accessibilityLabel="Clear logs"
          >
            <Ionicons name="trash-outline" size={20} color={theme.expense} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Filter Level Pills & Search */}
      <View style={[styles.filterBar, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={styles.levelFilterRow}>
          {(['all', 'info', 'warn', 'error'] as const).map((level) => {
            const isSelected = selectedLevel === level;
            const count = levelCounts[level];
            return (
              <TouchableOpacity
                key={level}
                style={[
                  styles.filterPill,
                  {
                    backgroundColor: isSelected ? theme.primary : theme.background,
                    borderColor: isSelected ? theme.primary : theme.border,
                  },
                ]}
                onPress={() => setSelectedLevel(level)}
                accessibilityRole="button"
              >
                <Text style={[styles.filterPillText, { color: isSelected ? '#fff' : theme.text }]}>
                  {level.toUpperCase()}
                </Text>
                <View
                  style={[
                    styles.filterCountBadge,
                    {
                      backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : theme.surface,
                    },
                  ]}
                >
                  <Text style={[styles.filterCountText, { color: isSelected ? '#fff' : theme.textMuted }]}>
                    {count}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Search Filter Input */}
        <View style={[styles.searchWrap, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <Ionicons name="search-outline" size={16} color={theme.textMuted} style={{ marginRight: 6 }} />
          <TextInput
            style={[styles.searchInput, { color: theme.text }]}
            placeholder="Search events or messages..."
            placeholderTextColor={theme.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearSearchBtn}>
              <Ionicons name="close-circle" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Runtime Diagnostics Card */}
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.summaryHeader}>
            <Ionicons name="hardware-chip-outline" size={16} color={theme.primary} />
            <Text style={[styles.summaryTitle, { color: theme.text }]}>Runtime Diagnostics</Text>
          </View>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Provisioning:</Text>
              <Text style={[styles.summaryValue, { color: theme.text }]}>{provisioning.status}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Runtime State:</Text>
              <Text style={[styles.summaryValue, { color: theme.text }]}>{runtime.runtimeState}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Active Status:</Text>
              <Text style={[styles.summaryValue, { color: theme.text }]}>{runtime.activeStatusLabel ?? 'Idle'}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>Streaming Buffer:</Text>
              <Text style={[styles.summaryValue, { color: theme.text }]}>
                {runtime.streamingResponseText ? `${runtime.streamingResponseText.length} chars` : 'Empty'}
              </Text>
            </View>
          </View>
        </View>

        {/* Logs List */}
        {systemLogs.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Ionicons name="document-text-outline" size={32} color={theme.textMuted} style={{ marginBottom: 8 }} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No matching logs</Text>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>
              {logs.length === 0
                ? 'Runtime, model, and inference events will appear here once active.'
                : 'No logs match your filter criteria.'}
            </Text>
          </View>
        ) : (
          systemLogs.map((entry) => {
            const badgeColor = getLevelBadgeColor(entry.level);
            const badgeBg = getLevelBadgeBg(entry.level);

            return (
              <View
                key={entry.id}
                style={[
                  styles.logCard,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ]}
              >
                <View style={styles.logHeader}>
                  <View style={[styles.levelBadge, { backgroundColor: badgeBg, borderColor: badgeColor }]}>
                    <Text style={[styles.levelBadgeText, { color: badgeColor }]}>
                      {entry.level.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={[styles.logEvent, { color: theme.text }]} numberOfLines={1}>
                    {entry.event}
                  </Text>
                  <Text style={[styles.logTime, { color: theme.textMuted }]}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </Text>
                  <TouchableOpacity
                    onPress={() => handleCopySingleLog(entry)}
                    style={styles.copySingleBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Copy this log"
                  >
                    <Ionicons name="copy-outline" size={15} color={theme.textMuted} />
                  </TouchableOpacity>
                </View>

                <Text style={[styles.logMessage, { color: theme.text }]}>{entry.message}</Text>

                {entry.details ? (
                  <View style={[styles.detailsBox, { backgroundColor: theme.background, borderColor: theme.border }]}>
                    <Text style={[styles.logDetails, { color: theme.textMuted }]}>
                      {JSON.stringify(entry.details, null, 2)}
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: {
    flex: 1,
    marginHorizontal: 8,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  headerSubtitle: {
    fontSize: 11,
    marginTop: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  filterBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  levelFilterRow: {
    flexDirection: 'row',
    gap: 6,
  },
  filterPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 6,
    minHeight: 34,
  },
  filterPillText: {
    fontSize: 11,
    fontWeight: '800',
    marginRight: 4,
  },
  filterCountBadge: {
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  filterCountText: {
    fontSize: 10,
    fontWeight: '700',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 36,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    minHeight: 34,
    paddingVertical: 4,
  },
  clearSearchBtn: {
    padding: 4,
  },
  content: {
    padding: 12,
    paddingBottom: 120,
    gap: 8,
  },
  summaryCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 4,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  summaryTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  summaryGrid: {
    gap: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  summaryValue: {
    fontSize: 12,
    fontWeight: '700',
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  emptyText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  logCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  levelBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  levelBadgeText: {
    fontSize: 9,
    fontWeight: '800',
  },
  logEvent: {
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  logTime: {
    fontSize: 10,
  },
  copySingleBtn: {
    padding: 4,
  },
  logMessage: {
    fontSize: 12,
    lineHeight: 17,
  },
  detailsBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginTop: 2,
  },
  logDetails: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
});
