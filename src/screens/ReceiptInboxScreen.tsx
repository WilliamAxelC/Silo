import React, { useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Image, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';

import { NavigationProps } from '../navigation/types';
import { useReceiptQueueStore, type ReceiptQueueItem } from '../store/useReceiptQueueStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { ConfidenceBadge } from '../components/ConfidenceBadge';
import { scanReceiptDocuments } from '../services/ocr/documentScanner';
import { useAppTheme } from '../theme/useAppTheme';

/** Opens the gallery with multi-select and queues every picked photo. Returns how many were queued. */
export async function importReceiptsFromGallery(): Promise<number> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 0,
    quality: 0.9,
  });
  if (result.canceled || !result.assets?.length) return 0;
  const uris = result.assets.map((asset) => asset.uri).filter(Boolean);
  await useReceiptQueueStore.getState().enqueue(uris);
  return uris.length;
}

const STATUS_LABEL: Record<ReceiptQueueItem['status'], string> = {
  pending: 'Waiting…',
  processing: 'Reading…',
  done: 'Ready to review',
  failed: "Couldn't read",
};

interface RowProps {
  item: ReceiptQueueItem;
  onOpen: (item: ReceiptQueueItem) => void;
  onRetry: (id: number) => void;
  onRemove: (item: ReceiptQueueItem) => void;
}

const ReceiptRow = React.memo(function ReceiptRow({ item, onOpen, onRetry, onRemove }: RowProps) {
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const result = item.status === 'done' ? item.result : null;
  const title = result?.merchantName || STATUS_LABEL[item.status];
  const subtitle =
    item.status === 'failed'
      ? item.error ?? STATUS_LABEL.failed
      : result
        ? [
            typeof result.totalAmount === 'number' ? formatDisplayCurrency(result.totalAmount, currencyCode, useThousands) : 'No total found',
            result.date,
          ]
            .filter(Boolean)
            .join(' · ')
        : item.status === 'processing'
          ? 'Reading this receipt on your device'
          : 'Queued';

  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
      onPress={() => onOpen(item)}
      disabled={item.status !== 'done'}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityHint={item.status === 'done' ? 'Opens the receipt to review and save' : undefined}
    >
      <Image source={{ uri: item.imageUri }} style={[styles.thumb, { backgroundColor: theme.border }]} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.rowSub, { color: item.status === 'failed' ? theme.expense : theme.textMuted }]} numberOfLines={2}>
          {subtitle}
        </Text>
        {result?.confidence ? <ConfidenceBadge level={result.confidence} /> : null}
      </View>
      <View style={styles.rowActions}>
        {item.status === 'processing' ? <ActivityIndicator color={theme.primary} /> : null}
        {item.status === 'failed' ? (
          <TouchableOpacity onPress={() => onRetry(item.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry reading this receipt">
            <Ionicons name="refresh" size={20} color={theme.primary} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={() => onRemove(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove this receipt">
          <Ionicons name="trash-outline" size={20} color={theme.textMuted} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

export const ReceiptInboxScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const items = useReceiptQueueStore((s) => s.items);
  const retry = useReceiptQueueStore((s) => s.retry);
  const remove = useReceiptQueueStore((s) => s.remove);

  const waiting = items.filter((i) => i.status === 'pending' || i.status === 'processing').length;
  const ready = items.filter((i) => i.status === 'done').length;

  const handleImport = useCallback(async () => {
    try {
      await importReceiptsFromGallery();
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'Could not open your photos.');
    }
  }, []);

  const handleScan = useCallback(async () => {
    try {
      const uris = await scanReceiptDocuments();
      await useReceiptQueueStore.getState().enqueue(uris);
    } catch {
      Alert.alert('Scanner unavailable', 'The document scanner needs Google Play services. Import photos from your gallery instead.');
    }
  }, []);

  const handleOpen = useCallback(
    (item: ReceiptQueueItem) => navigation.navigate('AddTransactionStack', { receiptQueueId: item.id }),
    [navigation],
  );

  const handleRemove = useCallback(
    (item: ReceiptQueueItem) =>
      Alert.alert('Remove receipt?', 'The photo and anything read from it will be discarded.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void remove(item.id) },
      ]),
    [remove],
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: theme.text }]}>Receipt Inbox</Text>
          <Text style={[styles.subtitle, { color: theme.textMuted }]}>
            {items.length === 0 ? 'Import many receipts at once' : `${ready} ready · ${waiting} reading`}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.importBtn, { backgroundColor: theme.primary }]}
          onPress={handleScan}
          accessibilityRole="button"
          accessibilityLabel="Scan receipts with the camera"
        >
          <Ionicons name="scan" size={16} color={theme.onPrimary} />
          <Text style={[styles.importText, { color: theme.onPrimary }]}>Scan</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.importBtn, { borderColor: theme.primary, borderWidth: 1 }]}
          onPress={handleImport}
          accessibilityRole="button"
          accessibilityLabel="Import receipt photos"
        >
          <Ionicons name="images-outline" size={16} color={theme.primary} />
          <Text style={[styles.importText, { color: theme.primary }]}>Import</Text>
        </TouchableOpacity>
      </View>

      {waiting > 0 ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Receipts are read on this phone, one at a time. You can keep using Silo meanwhile; if you close it, reading
          continues next time you open the app.
        </Text>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <ReceiptRow item={item} onOpen={handleOpen} onRetry={retry} onRemove={handleRemove} />}
        contentContainerStyle={items.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={44} color={theme.textMuted} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No receipts waiting</Text>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>
              Scan a stack of receipts or pick several photos at once. Silo reads them in the background, then you check and save each one.
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
  headerText: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  importBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  importText: { fontSize: 13, fontWeight: '700' },
  hint: { fontSize: 12, paddingHorizontal: 16, marginBottom: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 120, gap: 10 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32 },
  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700' },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 10, gap: 12 },
  thumb: { width: 56, height: 72, borderRadius: 8 },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowSub: { fontSize: 12 },
  rowActions: { alignItems: 'center', gap: 14 },
});
