import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Image, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';

import { NavigationProps } from '../navigation/types';
import { useReceiptQueueStore, type EnqueueReceiptsResult, type ReceiptQueueItem } from '../store/useReceiptQueueStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDisplayCurrency } from '../features/transactions/amount';
import { ConfidenceBadge } from '../components/ConfidenceBadge';
import { captureReceiptWithFallback } from '../services/ocr/documentScanner';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

/** Opens the gallery with multi-select and queues every picked photo, skipping duplicates. */
export async function importReceiptsFromGallery(): Promise<EnqueueReceiptsResult> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 0,
    quality: 0.9,
  });
  if (result.canceled || !result.assets?.length) return { added: 0, skippedDuplicates: 0 };
  const uris = result.assets.map((asset) => asset.uri).filter(Boolean);
  return useReceiptQueueStore.getState().enqueue(uris);
}

const STATUS_LABEL: Record<ReceiptQueueItem['status'], string> = {
  pending: 'Waiting…',
  processing: 'Reading…',
  done: 'Ready to review',
  failed: "Couldn't read",
};

interface RowProps {
  item: ReceiptQueueItem;
  selectionMode: boolean;
  isSelected: boolean;
  onOpen: (item: ReceiptQueueItem) => void;
  onToggleSelect: (id: number) => void;
  onEnterSelection: (id: number) => void;
  onRetry: (id: number) => void;
  onRemove: (item: ReceiptQueueItem) => void;
}

const ReceiptRow = React.memo(function ReceiptRow({
  item,
  selectionMode,
  isSelected,
  onOpen,
  onToggleSelect,
  onEnterSelection,
  onRetry,
  onRemove,
}: RowProps) {
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
            typeof result.totalAmount === 'number'
              ? formatDisplayCurrency(result.totalAmount, currencyCode, useThousands)
              : 'No total found',
            result.date,
          ]
            .filter(Boolean)
            .join(' · ')
        : item.status === 'processing'
          ? 'Reading this receipt on your device'
          : 'Queued';

  const handlePress = () => {
    if (selectionMode) {
      onToggleSelect(item.id);
    } else if (item.status === 'done') {
      onOpen(item);
    }
  };

  return (
    <TouchableOpacity
      style={[
        styles.row,
        {
          backgroundColor: isSelected ? theme.primaryMuted : theme.surface,
          borderColor: isSelected ? theme.primary : theme.border,
        },
      ]}
      onPress={handlePress}
      onLongPress={() => onEnterSelection(item.id)}
      disabled={!selectionMode && item.status !== 'done'}
      accessibilityRole="button"
      accessibilityState={selectionMode ? { selected: isSelected } : undefined}
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityHint={
        selectionMode
          ? 'Toggles selection for this receipt'
          : item.status === 'done'
            ? 'Opens the receipt to review and save'
            : undefined
      }
    >
      {selectionMode ? (
        <Ionicons
          name={isSelected ? 'checkbox' : 'square-outline'}
          size={22}
          color={isSelected ? theme.primary : theme.textMuted}
        />
      ) : null}
      <Image source={{ uri: item.imageUri }} style={[styles.thumb, { backgroundColor: theme.border }]} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text, fontSize: theme.scaleFont(15) }]} numberOfLines={1}>
          {title}
        </Text>
        <Text
          style={[
            styles.rowSub,
            { color: item.status === 'failed' ? theme.expense : theme.textMuted, fontSize: theme.scaleFont(12) },
          ]}
          numberOfLines={2}
        >
          {subtitle}
        </Text>
        {result?.confidence ? <ConfidenceBadge level={result.confidence} /> : null}
      </View>
      {!selectionMode ? (
        <View style={styles.rowActions}>
          {item.status === 'processing' ? <ActivityIndicator color={theme.primary} /> : null}
          {item.status === 'failed' ? (
            <TouchableOpacity
              onPress={() => onRetry(item.id)}
              style={styles.rowIconBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry reading this receipt"
            >
              <Ionicons name="refresh" size={20} color={theme.primary} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => onRemove(item)}
            style={styles.rowIconBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Remove this receipt"
          >
            <Ionicons name="trash-outline" size={20} color={theme.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

export const ReceiptInboxScreen = () => {
  const navigation = useNavigation<NavigationProps>();
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const items = useReceiptQueueStore((s) => s.items);
  const retry = useReceiptQueueStore((s) => s.retry);
  const remove = useReceiptQueueStore((s) => s.remove);
  const removeMany = useReceiptQueueStore((s) => s.removeMany);
  const clearByStatus = useReceiptQueueStore((s) => s.clearByStatus);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);

  const readyItems = useMemo(() => items.filter((i) => i.status === 'done'), [items]);
  const waiting = items.filter((i) => i.status === 'pending' || i.status === 'processing').length;
  const ready = readyItems.length;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = items.length > 0 && selectedIds.length === items.length;

  const surfaceDuplicateFeedback = useCallback((result: EnqueueReceiptsResult) => {
    if (result.skippedDuplicates > 0) {
      const noun = result.skippedDuplicates === 1 ? 'duplicate receipt was' : 'duplicate receipts were';
      setDuplicateNotice(`${result.skippedDuplicates} ${noun} already in the inbox and skipped.`);
    } else if (result.added > 0) {
      setDuplicateNotice(null);
    }
  }, []);

  const handleImport = useCallback(async () => {
    try {
      const result = await importReceiptsFromGallery();
      surfaceDuplicateFeedback(result);
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'Could not open your photos.');
    }
  }, [surfaceDuplicateFeedback]);

  const handleScan = useCallback(async () => {
    const captured = await captureReceiptWithFallback({
      onImportFromGallery: handleImport,
    });
    if (captured.status === 'captured' && captured.uris.length > 0) {
      const result = await useReceiptQueueStore.getState().enqueue(captured.uris);
      surfaceDuplicateFeedback(result);
    }
  }, [handleImport, surfaceDuplicateFeedback]);

  const handleOpen = useCallback(
    (item: ReceiptQueueItem) => {
      const currentReady = useReceiptQueueStore.getState().items.filter((entry) => entry.status === 'done');
      const idx = currentReady.findIndex((entry) => entry.id === item.id);
      navigation.navigate('AddTransactionStack', {
        receiptQueueId: item.id,
        reviewBatchIndex: idx >= 0 ? idx + 1 : 1,
        reviewBatchTotal: Math.max(currentReady.length, 1),
      });
    },
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

  const handleClearDone = useCallback(() => {
    if (ready === 0) return;
    Alert.alert(
      'Clear ready receipts?',
      `Discard ${ready} ready receipt${ready === 1 ? '' : 's'} from the inbox? Saved transactions are not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear done',
          style: 'destructive',
          onPress: () => {
            void clearByStatus(['done']);
          },
        },
      ],
    );
  }, [clearByStatus, ready]);

  const handleToggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]));
  }, []);

  const handleEnterSelection = useCallback((id: number) => {
    setSelectionMode(true);
    setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const handleExitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds([]);
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(items.map((item) => item.id));
    }
  }, [allSelected, items]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const count = selectedIds.length;
    Alert.alert(
      `Remove ${count} receipt${count === 1 ? '' : 's'}?`,
      'The selected receipt photos and extracted data will be discarded.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await removeMany(selectedIds, true);
            setSelectionMode(false);
            setSelectedIds([]);
          },
        },
      ],
    );
  }, [removeMany, selectedIds]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text
            style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(20) }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            Receipt Inbox
          </Text>
          <Text
            style={[styles.subtitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}
            numberOfLines={1}
          >
            {items.length === 0 ? 'Import many receipts at once' : `${ready} ready · ${waiting} reading`}
          </Text>
        </View>
      </View>

      <View style={styles.primaryActionRow} testID="inbox-primary-actions">
        <TouchableOpacity
          style={[styles.importBtn, { backgroundColor: theme.primary }]}
          onPress={handleScan}
          accessibilityRole="button"
          accessibilityLabel="Scan receipts with the camera"
        >
          <Ionicons name="scan" size={16} color={theme.onPrimary} />
          <Text style={[styles.importText, { color: theme.onPrimary, fontSize: theme.scaleFont(13) }]}>Scan</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.importBtn, { borderColor: theme.primary, borderWidth: 1, backgroundColor: theme.surface }]}
          onPress={handleImport}
          accessibilityRole="button"
          accessibilityLabel="Import receipt photos"
        >
          <Ionicons name="images-outline" size={16} color={theme.primary} />
          <Text style={[styles.importText, { color: theme.primary, fontSize: theme.scaleFont(13) }]}>Import</Text>
        </TouchableOpacity>
      </View>

      {items.length > 0 ? (
        <View style={styles.toolbarRow}>
          {selectionMode ? (
            <>
              <TouchableOpacity
                style={[styles.toolbarBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
                onPress={handleToggleSelectAll}
                accessibilityRole="button"
                accessibilityLabel={allSelected ? 'Deselect all receipts' : 'Select all receipts'}
              >
                <Text style={[styles.toolbarBtnText, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  {allSelected ? 'Deselect all' : 'Select all'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.toolbarBtn,
                  {
                    borderColor: theme.expense,
                    backgroundColor: theme.expenseMuted,
                    opacity: selectedIds.length === 0 ? 0.5 : 1,
                  },
                ]}
                onPress={handleDeleteSelected}
                disabled={selectedIds.length === 0}
                accessibilityRole="button"
                accessibilityLabel="Delete selected receipts"
              >
                <Ionicons name="trash-outline" size={14} color={theme.expense} />
                <Text style={[styles.toolbarBtnText, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
                  Delete ({selectedIds.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
                onPress={handleExitSelection}
                accessibilityRole="button"
                accessibilityLabel="Cancel selection"
              >
                <Text style={[styles.toolbarBtnText, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
                  Done
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={[styles.toolbarBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
                onPress={() => setSelectionMode(true)}
                accessibilityRole="button"
                accessibilityLabel="Select receipts"
              >
                <Ionicons name="checkmark-done-outline" size={14} color={theme.text} />
                <Text style={[styles.toolbarBtnText, { color: theme.text, fontSize: theme.scaleFont(12) }]}>
                  Select
                </Text>
              </TouchableOpacity>
              {ready > 0 ? (
                <TouchableOpacity
                  style={[styles.toolbarBtn, { borderColor: theme.expense, backgroundColor: theme.surface }]}
                  onPress={handleClearDone}
                  accessibilityRole="button"
                  accessibilityLabel="Clear done receipts"
                >
                  <Ionicons name="trash-outline" size={14} color={theme.expense} />
                  <Text style={[styles.toolbarBtnText, { color: theme.expense, fontSize: theme.scaleFont(12) }]}>
                    Clear done ({ready})
                  </Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {duplicateNotice ? (
        <View
          style={[styles.noticeBanner, { backgroundColor: theme.warningMuted, borderColor: theme.warning }]}
          accessibilityRole="alert"
        >
          <Ionicons name="copy-outline" size={16} color={theme.warning} />
          <Text style={[styles.noticeText, { color: theme.warning, fontSize: theme.scaleFont(12) }]}>
            {duplicateNotice}
          </Text>
          <TouchableOpacity
            onPress={() => setDuplicateNotice(null)}
            style={styles.noticeDismissBtn}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Dismiss duplicate notice"
          >
            <Ionicons name="close" size={16} color={theme.warning} />
          </TouchableOpacity>
        </View>
      ) : null}

      {waiting > 0 ? (
        <Text style={[styles.hint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
          Receipts are read on this phone, one at a time. You can keep using Silo meanwhile; if you close it, reading
          continues next time you open the app.
        </Text>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <ReceiptRow
            item={item}
            selectionMode={selectionMode}
            isSelected={selectedIdSet.has(item.id)}
            onOpen={handleOpen}
            onToggleSelect={handleToggleSelect}
            onEnterSelection={handleEnterSelection}
            onRetry={retry}
            onRemove={handleRemove}
          />
        )}
        contentContainerStyle={
          items.length === 0
            ? styles.emptyContainer
            : [styles.list, { paddingBottom: getBottomInsetPadding(insets.bottom, 36) }]
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={44} color={theme.textMuted} />
            <Text style={[styles.emptyTitle, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
              No receipts waiting
            </Text>
            <Text style={[styles.emptyText, { color: theme.textMuted, fontSize: theme.scaleFont(13) }]}>
              Scan a stack of receipts or pick several photos at once. Silo reads them in the background, then you check
              and save each one.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 10 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  primaryActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  importBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  importText: { fontSize: 13, fontWeight: '700' },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  toolbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
  },
  toolbarBtnText: { fontWeight: '700' },
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  noticeText: { flex: 1, fontWeight: '600' },
  noticeDismissBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
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
  rowActions: { alignItems: 'center', gap: 6 },
  rowIconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
