import React, { useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { endOfDay, startOfDay } from 'date-fns';

import { useAppTheme } from '../theme/useAppTheme';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { formatCachedLocaleDate } from '../features/transactions/periods';
import {
  DATE_PRESETS,
  EMPTY_FILTERS,
  TYPE_OPTIONS,
  computeDatePresetBounds,
  countActiveFilters,
  type TransactionFilters,
} from '../features/transactions/filters';
import type { CategoryRecord, TagRecord, Wallet } from '../features/transactions/types';
import { SHEET_WIDTH } from '../theme/layout';

export type FilterSection = 'type' | 'account' | 'category' | 'tag' | 'date';

type Props = {
  visible: boolean;
  onClose: () => void;
  sections: FilterSection[];
  filters: TransactionFilters;
  onChange: (next: TransactionFilters) => void;
  wallets: Wallet[];
  categories: CategoryRecord[];
  tags: TagRecord[];
  /** Limits the category list when the screen itself picks expense or income (Reports). */
  categoryType?: 'expense' | 'income' | null;
  monthStartDay?: number;
  locale?: string;
};

const DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

/** One sheet holding every filter as tap-to-toggle chips. Changes apply as you tap. */
export function FilterSheet({
  visible,
  onClose,
  sections,
  filters,
  onChange,
  wallets,
  categories,
  tags,
  categoryType,
  monthStartDay = 1,
  locale = 'en-GB',
}: Props) {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const [datePickerTarget, setDatePickerTarget] = useState<'from' | 'to' | null>(null);

  const set = (patch: Partial<TransactionFilters>) => onChange({ ...filters, ...patch });

  const effectiveCategoryType = categoryType ?? (filters.type === 'expense' || filters.type === 'income' ? filters.type : null);
  const categoryNames = useMemo(() => {
    const seen = new Set<string>();
    for (const c of categories) {
      if (effectiveCategoryType && c.type !== effectiveCategoryType) continue;
      seen.add(c.name);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [categories, effectiveCategoryType]);

  const selectType = (next: TransactionFilters['type']) => {
    const patch: Partial<TransactionFilters> = { type: filters.type === next ? null : next };
    if (patch.type === 'transfer') patch.category = null;
    else if (patch.type && filters.category) {
      const stillValid = categories.some((c) => c.type === patch.type && c.name === filters.category);
      if (!stillValid) patch.category = null;
    }
    set(patch);
  };

  const selectPreset = (key: (typeof DATE_PRESETS)[number]['key']) => {
    if (filters.datePreset === key) {
      set({ datePreset: null, dateFrom: null, dateTo: null });
      return;
    }
    const bounds = computeDatePresetBounds(key, new Date(), monthStartDay);
    set({ datePreset: key, dateFrom: bounds.from, dateTo: bounds.to });
  };

  const onPickDate = (_event: unknown, picked?: Date) => {
    const target = datePickerTarget;
    setDatePickerTarget(null);
    if (!picked || !target) return;
    if (target === 'from') {
      const from = startOfDay(picked).getTime();
      set({
        datePreset: 'custom',
        dateFrom: from,
        dateTo: filters.dateTo != null && from > filters.dateTo ? endOfDay(picked).getTime() : filters.dateTo,
      });
    } else {
      const to = endOfDay(picked).getTime();
      set({
        datePreset: 'custom',
        dateTo: to,
        dateFrom: filters.dateFrom != null && to < filters.dateFrom ? startOfDay(picked).getTime() : filters.dateFrom,
      });
    }
  };

  const chip = (label: string, selected: boolean, onPress: () => void, a11y: string) => (
    <TouchableOpacity
      key={a11y}
      style={[
        styles.chip,
        { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primary : theme.background },
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected }}
    >
      {selected ? <Ionicons name="checkmark" size={14} color={theme.onPrimary} /> : null}
      <Text style={[styles.chipText, { color: selected ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const heading = (text: string) => (
    <Text style={[styles.sectionTitle, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>{text}</Text>
  );

  const activeCount = countActiveFilters(filters);
  const showCategory = sections.includes('category') && filters.type !== 'transfer' && categoryNames.length > 0;
  const showTag = sections.includes('tag') && tags.length > 0;

  return (
    <Modal statusBarTranslucent navigationBarTranslucent visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1}
          accessible={false} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          accessible={false}
          onPress={(e) => e.stopPropagation()}
          testID="filter-sheet"
          style={[
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: getBottomInsetPadding(insets.bottom, 16) },
          ]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text, fontSize: theme.scaleFont(17) }]}>Filters</Text>
            {activeCount > 0 ? (
              <TouchableOpacity
                onPress={() => onChange({ ...EMPTY_FILTERS })}
                accessibilityRole="button"
                accessibilityLabel="Clear all filters"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={{ color: theme.expense, fontWeight: '700', fontSize: theme.scaleFont(13) }}>Clear all</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {sections.includes('type') ? (
              <>
                {heading('Type')}
                <View style={styles.chipWrap}>
                  {TYPE_OPTIONS.map((opt) => chip(opt.label, filters.type === opt.key, () => selectType(opt.key), `Type option ${opt.label}`))}
                </View>
              </>
            ) : null}

            {sections.includes('account') && wallets.length > 0 ? (
              <>
                {heading('Account')}
                <View style={styles.chipWrap}>
                  {wallets.map((w) =>
                    chip(
                      `${w.name}${w.isActive ? '' : ' (archived)'}`,
                      filters.walletId === w.id,
                      () => set({ walletId: filters.walletId === w.id ? null : w.id }),
                      `Account option ${w.name}`
                    )
                  )}
                </View>
              </>
            ) : null}

            {showCategory ? (
              <>
                {heading('Category')}
                <View style={styles.chipWrap}>
                  {categoryNames.map((name) =>
                    chip(name, filters.category === name, () => set({ category: filters.category === name ? null : name }), `Category option ${name}`)
                  )}
                </View>
              </>
            ) : null}

            {showTag ? (
              <>
                {heading('Tag')}
                <View style={styles.chipWrap}>
                  {tags.map((t) =>
                    chip(`#${t.name}`, filters.tag === t.name, () => set({ tag: filters.tag === t.name ? null : t.name }), `Tag option ${t.name}`)
                  )}
                </View>
              </>
            ) : null}

            {sections.includes('date') ? (
              <>
                {heading('Date')}
                <View style={styles.chipWrap}>
                  {DATE_PRESETS.map((p) => chip(p.label, filters.datePreset === p.key, () => selectPreset(p.key), `Date option ${p.label}`))}
                </View>
                <View style={styles.customDateRow}>
                  {(['from', 'to'] as const).map((target) => {
                    const value = target === 'from' ? filters.dateFrom : filters.dateTo;
                    const custom = filters.datePreset === 'custom' && value != null;
                    return (
                      <TouchableOpacity
                        key={target}
                        style={[
                          styles.customDateBtn,
                          { borderColor: custom ? theme.primary : theme.border, backgroundColor: theme.background },
                        ]}
                        onPress={() => setDatePickerTarget(target)}
                        accessibilityRole="button"
                        accessibilityLabel={target === 'from' ? 'Pick start date' : 'Pick end date'}
                      >
                        <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(11) }}>{target === 'from' ? 'From' : 'To'}</Text>
                        <Text style={{ color: theme.text, fontSize: theme.scaleFont(13), fontWeight: '600' }}>
                          {value != null ? formatCachedLocaleDate(value, locale, DATE_OPTIONS) : 'Any'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            ) : null}
          </ScrollView>

          <TouchableOpacity
            style={[styles.doneBtn, { backgroundColor: theme.primary }]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done filtering"
          >
            <Text style={{ color: theme.onPrimary, fontWeight: '700', fontSize: theme.scaleFont(15) }}>Done</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>

      {datePickerTarget !== null ? (
        <DateTimePicker
          value={new Date((datePickerTarget === 'from' ? filters.dateFrom : filters.dateTo) ?? Date.now())}
          mode="date"
          display="default"
          accentColor={theme.primary}
          onChange={onPickDate}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  card: { ...SHEET_WIDTH, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, paddingTop: 16, paddingHorizontal: 18, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  title: { fontWeight: '800' },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingBottom: 12 },
  sectionTitle: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 12,
    minHeight: 44,
    maxWidth: '100%',
  },
  chipText: { fontWeight: '600' },
  customDateRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  customDateBtn: { flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  doneBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
});
