import React, { useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { searchCurrencies, SUPPORTED_CURRENCIES } from '../features/currency/currencies';
import { getCurrencySymbol } from '../features/transactions/amount';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

interface Props {
  visible: boolean;
  title?: string;
  selected: string | null;
  /** Listed first (home currency, account currencies). */
  preferred?: ReadonlyArray<string | null | undefined>;
  onSelect: (code: string) => void;
  onClose: () => void;
}

/** Searchable list of every currency Silo supports. */
export function CurrencyPickerModal({ visible, title = 'Choose currency', selected, preferred = [], onSelect, onClose }: Props) {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const found = searchCurrencies(query);
    if (query.trim()) return found;
    const first = preferred.filter((c): c is string => Boolean(c));
    return [
      ...found.filter((c) => first.includes(c.code)).sort((a, b) => first.indexOf(a.code) - first.indexOf(b.code)),
      ...found.filter((c) => !first.includes(c.code)),
    ];
  }, [query, preferred]);

  const close = () => {
    setQuery('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.backdrop}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: getBottomInsetPadding(insets.bottom, 16) },
          ]}
        >
          <View style={styles.headerRow}>
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: theme.scaleFont(17), flex: 1 }}>{title}</Text>
            <TouchableOpacity onPress={close} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close currency list">
              <Ionicons name="close" size={22} color={theme.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={[styles.searchBox, { borderColor: theme.border, backgroundColor: theme.background }]}>
            <Ionicons name="search" size={18} color={theme.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${SUPPORTED_CURRENCIES.length} currencies`}
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, color: theme.text, fontSize: theme.scaleFont(15), paddingVertical: 8 }}
              accessibilityLabel="Search currencies"
            />
          </View>
          <FlatList
            data={rows}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={20}
            ListEmptyComponent={
              <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24, fontSize: theme.scaleFont(13) }}>
                No currency matches "{query.trim()}".
              </Text>
            }
            renderItem={({ item }) => {
              const isSelected = item.code === selected;
              return (
                <TouchableOpacity
                  style={[styles.row, { borderBottomColor: theme.border }]}
                  onPress={() => {
                    onSelect(item.code);
                    close();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.code}, ${item.name}`}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={{ color: theme.text, fontWeight: '700', width: 52, fontSize: theme.scaleFont(14) }}>{item.code}</Text>
                  <Text style={{ color: theme.text, flex: 1, fontSize: theme.scaleFont(14) }} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={{ color: theme.textMuted, fontSize: theme.scaleFont(13), marginRight: 8 }}>{getCurrencySymbol(item.code)}</Text>
                  {isSelected ? <Ionicons name="checkmark" size={20} color={theme.primary} /> : <View style={{ width: 20 }} />}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: '85%', minHeight: '60%' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  closeBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth },
});
