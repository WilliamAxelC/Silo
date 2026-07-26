import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { NavigationProps } from '../navigation/types';
import { useAIStore } from '../store/useAIStore';
import { useAppTheme } from '../theme/useAppTheme';

export const SystemLogsScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const { logs, runtime, provisioning } = useAIStore();

  const systemLogs = useMemo(() => {
    return logs.filter((entry) => {
      const event = entry.event.toLowerCase();
      return (
        event.includes('runtime')
        || event.includes('generation')
        || event.includes('register')
        || event.includes('warmup')
        || event.includes('health')
        || event.includes('provision')
        || event.includes('download')
        || event.includes('model')
        || event.includes('cancel')
        || event.includes('index')
      );
    });
  }, [logs]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>System logs</Text>
          <Text style={[styles.headerSubtitle, { color: theme.textMuted }]}>Runtime, model, cancellation, and provisioning diagnostics</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.summaryTitle, { color: theme.text }]}>Current runtime snapshot</Text>
          <Text style={[styles.summaryText, { color: theme.textMuted }]}>Provisioning: {provisioning.status}</Text>
          <Text style={[styles.summaryText, { color: theme.textMuted }]}>Runtime state: {runtime.runtimeState}</Text>
          <Text style={[styles.summaryText, { color: theme.textMuted }]}>Active status: {runtime.activeStatusLabel ?? 'Idle'}</Text>
          <Text style={[styles.summaryText, { color: theme.textMuted }]}>Streaming buffer: {runtime.streamingResponseText ? `${runtime.streamingResponseText.length} chars` : 'Empty'}</Text>
          <Text style={[styles.summaryText, { color: theme.textMuted }]}>Active request: {runtime.activeGenerationRequestId ?? 'None'}</Text>
        </View>

        {systemLogs.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No system logs yet</Text>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>Runtime and model events will appear here once setup or generation starts.</Text>
          </View>
        ) : (
          systemLogs.map((entry) => (
            <View key={entry.id} style={[styles.logCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <View style={styles.logHeader}>
                <Text style={[styles.logEvent, { color: entry.level === 'error' ? theme.expense : theme.text }]}>{entry.event}</Text>
                <Text style={[styles.logTime, { color: theme.textMuted }]}>{new Date(entry.timestamp).toLocaleTimeString()}</Text>
              </View>
              <Text style={[styles.logMessage, { color: theme.textMuted }]}>{entry.message}</Text>
              {entry.details ? (
                <Text style={[styles.logDetails, { color: theme.textMuted }]}>{JSON.stringify(entry.details, null, 2)}</Text>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  backButton: { padding: 4 },
  headerCopy: { flex: 1, paddingHorizontal: 10 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  headerSubtitle: { fontSize: 11, marginTop: 2 },
  headerSpacer: { width: 28 },
  content: { padding: 12, paddingBottom: 120, gap: 10 },
  summaryCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 4 },
  summaryTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  summaryText: { fontSize: 12, lineHeight: 18 },
  emptyCard: { borderWidth: 1, borderRadius: 14, padding: 16, alignItems: 'center' },
  emptyTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  emptyText: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  logCard: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 6 },
  logHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  logEvent: { fontSize: 13, fontWeight: '700', flex: 1 },
  logTime: { fontSize: 11 },
  logMessage: { fontSize: 12, lineHeight: 18 },
  logDetails: { fontSize: 11, lineHeight: 16, fontFamily: 'monospace' },
});
