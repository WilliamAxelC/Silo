import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';

import { NavigationProps } from '../navigation/types';
import { useAIStore, AIEventLog } from '../store/useAIStore';
import { useAppTheme } from '../theme/useAppTheme';

type LogLevelFilter = 'all' | 'info' | 'warn' | 'error';

interface LogRowProps {
  entry: AIEventLog;
  onCopy: (entry: AIEventLog) => void;
}

const LogRow = React.memo(function LogRow({ entry, onCopy }: LogRowProps) {
  const theme = useAppTheme();

  const badgeColor =
    entry.level === 'error' ? theme.expense : entry.level === 'warn' ? theme.warning : theme.primary;
  const badgeBg =
    entry.level === 'error' ? theme.expenseMuted : entry.level === 'warn' ? theme.warningMuted : theme.primaryMuted;

  const handleCopy = useCallback(() => {
    onCopy(entry);
  }, [entry, onCopy]);

  return (
    <View style={[styles.logCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.logHeader}>
        <View style={[styles.levelBadge, { backgroundColor: badgeBg, borderColor: badgeColor }]}>
          <Text style={[styles.levelBadgeText, { color: badgeColor, fontSize: theme.scaleFont(9) }]}>
            {entry.level.toUpperCase()}
          </Text>
        </View>
        <Text style={[styles.logEvent, { color: theme.text, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
          {entry.event}
        </Text>
        <Text style={[styles.logTime, { color: theme.textMuted, fontSize: theme.scaleFont(10) }]}>
          {new Date(entry.timestamp).toLocaleTimeString()}
        </Text>
        <TouchableOpacity
          onPress={handleCopy}
          style={styles.copySingleBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Copy this log"
        >
          <Ionicons name="copy-outline" size={15} color={theme.textMuted} />
        </TouchableOpacity>
      </View>

      <Text style={[styles.logMessage, { color: theme.text, fontSize: theme.scaleFont(12) }]}>{entry.message}</Text>

      {entry.details ? (
        <View style={[styles.detailsBox, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <Text style={[styles.logDetails, { color: theme.textMuted, fontSize: theme.scaleFont(10) }]}>
            {JSON.stringify(entry.details, null, 2)}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

export const SystemLogsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const logs = useAIStore((state) => state.logs);
  const clearLogs = useAIStore((state) => state.clearLogs);
  const provisioningStatus = useAIStore((state) => state.provisioning.status);
  const runtimeState = useAIStore((state) => state.runtime.runtimeState);
  const activeStatusLabel = useAIStore((state) => state.runtime.activeStatusLabel);
  const streamingBufferLength = useAIStore((state) => state.runtime.streamingResponseText?.length ?? 0);

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

  const handleCopySingleLog = useCallback(async (entry: AIEventLog) => {
    const text = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.event}] ${entry.message}${
      entry.details ? `\nDetails: ${JSON.stringify(entry.details, null, 2)}` : ''
    }`;
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Log entry copied to clipboard.');
  }, []);

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

  const keyExtractor = useCallback((item: AIEventLog) => item.id, []);

  const renderLogItem = useCallback(
    ({ item }: { item: AIEventLog }) => <LogRow entry={item} onCopy={handleCopySingleLog} />,
    [handleCopySingleLog]
  );

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
          <Text style={[styles.headerTitle, { color: theme.text, fontSize: theme.scaleFont(17) }]}>System Logs</Text>
          <Text style={[styles.headerSubtitle, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
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
                hitSlop={{ top: 5, bottom: 5, left: 0, right: 0 }}
                accessibilityRole="button"
                accessibilityLabel={`Filter ${level} logs (${count})`}
              >
                <Text
                  style={[
                    styles.filterPillText,
                    { color: isSelected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(11) },
                  ]}
                >
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
                  <Text
                    style={[
                      styles.filterCountText,
                      { color: isSelected ? theme.onPrimary : theme.textMuted, fontSize: theme.scaleFont(10) },
                    ]}
                  >
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
            style={[styles.searchInput, { color: theme.text, fontSize: theme.scaleFont(13) }]}
            placeholder="Search events or messages..."
            placeholderTextColor={theme.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={styles.clearSearchBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Ionicons name="close-circle" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={systemLogs}
        keyExtractor={keyExtractor}
        renderItem={renderLogItem}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.summaryHeader}>
              <Ionicons name="hardware-chip-outline" size={16} color={theme.primary} />
              <Text style={[styles.summaryTitle, { color: theme.text, fontSize: theme.scaleFont(13) }]}>
                Runtime Diagnostics
              </Text>
            </View>
            <View style={styles.summaryGrid}>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Provisioning:
                </Text>
                <Text style={[styles.summaryValue, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  {provisioningStatus}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Runtime State:
                </Text>
                <Text style={[styles.summaryValue, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  {runtimeState}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Active Status:
                </Text>
                <Text style={[styles.summaryValue, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  {activeStatusLabel ?? 'Idle'}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                  Streaming Buffer:
                </Text>
                <Text style={[styles.summaryValue, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  {streamingBufferLength > 0 ? `${streamingBufferLength} chars` : 'Empty'}
                </Text>
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Ionicons name="document-text-outline" size={32} color={theme.textMuted} style={{ marginBottom: 8 }} />
            <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]}>
              No matching logs
            </Text>
            <Text style={[styles.emptyText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              {logs.length === 0
                ? 'Runtime, model, and inference events will appear here once active.'
                : 'No logs match your filter criteria.'}
            </Text>
          </View>
        }
      />
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
    width: 44,
    height: 44,
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
    minWidth: 28,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
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
