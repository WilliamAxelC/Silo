import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useAppTheme } from '../theme/useAppTheme';
import { formatCachedLocaleDate } from '../features/transactions/periods';
import { DATE_PRESETS, TYPE_OPTIONS, type TransactionFilters } from '../features/transactions/filters';

type ViewToggleOption<T extends string> = { key: T; icon: keyof typeof Ionicons.glyphMap; label: string };

/** Compact icon-only segmented toggle (e.g. list / calendar). */
export function IconToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ViewToggleOption<T>[];
  onChange: (next: T) => void;
}) {
  const theme = useAppTheme();
  return (
    <View style={[styles.toggleWrap, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {options.map((opt) => {
        const selected = value === opt.key;
        return (
          <TouchableOpacity
            key={opt.key}
            style={[styles.toggleBtn, selected && { backgroundColor: theme.primary }]}
            onPress={() => onChange(opt.key)}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected }}
          >
            <Ionicons name={opt.icon} size={18} color={selected ? theme.onPrimary : theme.textMuted} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

type ToolbarProps = {
  /** Shown at the start of the row, e.g. an IconToggle. */
  leading?: React.ReactNode;
  searchQuery: string;
  onChangeSearch: (text: string) => void;
  searchPlaceholder: string;
  searchAccessibilityLabel?: string;
  /** 'inline' opens the search box beside the button, 'below' opens it under the row. */
  searchPlacement?: 'inline' | 'below';
  activeFilterCount: number;
  onOpenFilters: () => void;
  /** Hide search and filters (e.g. calendar view). */
  hideSearchAndFilters?: boolean;
};

/**
 * Search collapsed into an icon that opens a box, and every filter behind one Filters button.
 * Both turn solid primary while they are narrowing the results.
 */
export function ListToolbar({
  leading,
  searchQuery,
  onChangeSearch,
  searchPlaceholder,
  searchAccessibilityLabel = 'Search',
  searchPlacement = 'inline',
  activeFilterCount,
  onOpenFilters,
  hideSearchAndFilters,
}: ToolbarProps) {
  const theme = useAppTheme();
  const [open, setOpen] = useState(searchQuery.length > 0);
  const inputRef = useRef<TextInput>(null);
  const expanded = open || searchQuery.length > 0;
  const filtersOn = activeFilterCount > 0;

  useEffect(() => {
    if (open) inputRef.current?.focus?.();
  }, [open]);

  const closeSearch = () => {
    onChangeSearch('');
    setOpen(false);
  };

  const searchBox = (
    <View
      style={[
        styles.searchBox,
        searchPlacement === 'below' && styles.searchBoxBelow,
        { backgroundColor: theme.surface, borderColor: searchQuery ? theme.primary : theme.border },
      ]}
    >
      <Ionicons name="search-outline" size={16} color={searchQuery ? theme.primary : theme.textMuted} />
      <TextInput
        ref={inputRef}
        style={[styles.searchInput, { color: theme.text, fontSize: theme.scaleFont(14) }]}
        placeholder={searchPlaceholder}
        placeholderTextColor={theme.textMuted}
        selectionColor={theme.primary}
        value={searchQuery}
        onChangeText={onChangeSearch}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={searchAccessibilityLabel}
      />
      <TouchableOpacity
        onPress={closeSearch}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="Close search"
      >
        <Ionicons name="close-circle" size={18} color={theme.textMuted} />
      </TouchableOpacity>
    </View>
  );

  const inlineSearchOpen = expanded && searchPlacement === 'inline';

  return (
    <View testID="list-toolbar">
      <View style={styles.row}>
        {leading}
        {hideSearchAndFilters ? (
          <View style={styles.spacer} />
        ) : (
          <>
            {inlineSearchOpen ? searchBox : <View style={styles.spacer} />}
            {!inlineSearchOpen ? (
              <TouchableOpacity
                style={[
                  styles.iconBtn,
                  expanded
                    ? { backgroundColor: theme.primary, borderColor: theme.primary }
                    : { backgroundColor: theme.surface, borderColor: theme.border },
                ]}
                onPress={() => (expanded ? closeSearch() : setOpen(true))}
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Close search' : 'Open search'}
                accessibilityState={{ expanded }}
                testID="toolbar-search-button"
              >
                <Ionicons name="search" size={18} color={expanded ? theme.onPrimary : theme.text} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[
                styles.filterBtn,
                inlineSearchOpen && styles.filterBtnCompact,
                filtersOn
                  ? { backgroundColor: theme.primary, borderColor: theme.primary }
                  : { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
              onPress={onOpenFilters}
              accessibilityRole="button"
              accessibilityLabel={filtersOn ? `Filters, ${activeFilterCount} on` : 'Filters'}
              accessibilityState={{ selected: filtersOn }}
              testID="toolbar-filter-button"
            >
              <Ionicons name="options-outline" size={18} color={filtersOn ? theme.onPrimary : theme.text} />
              {!inlineSearchOpen ? (
                <Text style={[styles.filterText, { color: filtersOn ? theme.onPrimary : theme.text, fontSize: theme.scaleFont(13) }]}>
                  Filters
                </Text>
              ) : null}
              {filtersOn ? (
                <View style={[styles.badge, { backgroundColor: theme.onPrimary }]}>
                  <Text style={[styles.badgeText, { color: theme.primary }]}>{activeFilterCount}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          </>
        )}
      </View>
      {!hideSearchAndFilters && expanded && searchPlacement === 'below' ? searchBox : null}
    </View>
  );
}

const SHORT_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

/** Removable chips naming each filter that is on, under the toolbar. */
export function ActiveFilterChips({
  filters,
  onChange,
  walletNames,
  locale = 'en-GB',
}: {
  filters: TransactionFilters;
  onChange: (next: TransactionFilters) => void;
  walletNames: Map<number, string>;
  locale?: string;
}) {
  const theme = useAppTheme();
  const chips: Array<{ key: string; label: string; clear: Partial<TransactionFilters> }> = [];
  if (filters.type) chips.push({ key: 'type', label: TYPE_OPTIONS.find((t) => t.key === filters.type)?.label ?? filters.type, clear: { type: null } });
  if (filters.walletId != null) chips.push({ key: 'account', label: walletNames.get(filters.walletId) ?? 'Account', clear: { walletId: null } });
  if (filters.category) chips.push({ key: 'category', label: filters.category, clear: { category: null } });
  if (filters.tag) chips.push({ key: 'tag', label: `#${filters.tag}`, clear: { tag: null } });
  if (filters.dateFrom != null || filters.dateTo != null) {
    const preset = DATE_PRESETS.find((p) => p.key === filters.datePreset);
    const fmt = (ms: number) => formatCachedLocaleDate(ms, locale, SHORT_DATE);
    const label = preset
      ? preset.label
      : filters.dateFrom != null && filters.dateTo != null
        ? `${fmt(filters.dateFrom)} to ${fmt(filters.dateTo)}`
        : filters.dateFrom != null
          ? `From ${fmt(filters.dateFrom)}`
          : `Until ${fmt(filters.dateTo!)}`;
    chips.push({ key: 'date', label, clear: { datePreset: null, dateFrom: null, dateTo: null } });
  }
  if (chips.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.activeRow}
      style={styles.activeScroll}
      testID="active-filter-chips"
    >
      {chips.map((c) => (
        <TouchableOpacity
          key={c.key}
          style={[styles.activeChip, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
          onPress={() => onChange({ ...filters, ...c.clear })}
          accessibilityRole="button"
          accessibilityLabel={`Remove filter ${c.label}`}
        >
          <Text style={[styles.activeChipText, { color: theme.primary, fontSize: theme.scaleFont(12) }]} numberOfLines={1}>
            {c.label}
          </Text>
          <Ionicons name="close" size={14} color={theme.primary} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spacer: { flex: 1 },
  toggleWrap: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, padding: 3, gap: 2 },
  toggleBtn: { width: 40, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  filterBtnCompact: { paddingHorizontal: 10 },
  filterText: { fontWeight: '700' },
  badge: { minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { fontSize: 11, fontWeight: '800' },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  searchBoxBelow: { flex: 0, marginTop: 8 },
  searchInput: { flex: 1, paddingVertical: 0 },
  activeScroll: { flexGrow: 0, marginTop: 8 },
  activeRow: { gap: 6, alignItems: 'center' },
  activeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, height: 30 },
  activeChipText: { fontWeight: '700', maxWidth: 180 },
});
