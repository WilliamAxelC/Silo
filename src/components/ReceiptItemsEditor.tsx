import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme/useAppTheme';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDisplayCurrency } from '../features/transactions/amount';

export type ReceiptLineItemDraft = {
  id: string;
  name: string;
  price: string;
  note: string;
};

interface ReceiptItemsEditorProps {
  lineItems: ReceiptLineItemDraft[];
  onAddRow: () => void;
  onRemoveRow: (id: string) => void;
  onUpdateRow: (id: string, field: keyof Omit<ReceiptLineItemDraft, 'id'>, value: string) => void;
}

export const ReceiptItemsEditor: React.FC<ReceiptItemsEditorProps> = ({
  lineItems,
  onAddRow,
  onRemoveRow,
  onUpdateRow,
}) => {
  const theme = useAppTheme();
  const currencyCode = useSettingsStore((s) => s.currencyCode);
  const useThousandsSeparator = useSettingsStore((s) => s.useThousandsSeparator);

  const itemsTotal = useMemo(() => {
    return lineItems.reduce((sum, item) => {
      const parsed = parseFloat(item.price.replace(/[^\d.]/g, ''));
      return sum + (isNaN(parsed) ? 0 : parsed);
    }, 0);
  }, [lineItems]);

  return (
    <View style={styles.receiptEditorBlock}>
      <View style={styles.receiptHeaderRow}>
        <View style={styles.headerLeft}>
          <Ionicons name="receipt-outline" size={16} color={theme.primary} />
          <Text style={[styles.receiptHeaderTitle, { color: theme.text }]}>Itemized Breakdown</Text>
          {lineItems.length > 0 && (
            <View style={[styles.countBadge, { backgroundColor: theme.primaryMuted }]}>
              <Text style={[styles.countBadgeText, { color: theme.primary }]}>{lineItems.length}</Text>
            </View>
          )}
        </View>
        <TouchableOpacity
          style={[styles.inlineAddButton, { borderColor: theme.primary, backgroundColor: theme.primaryMuted }]}
          onPress={onAddRow}
          accessibilityRole="button"
          accessibilityLabel="Add line item"
        >
          <Ionicons name="add" size={16} color={theme.primary} />
          <Text style={[styles.inlineAddButtonText, { color: theme.primary }]}>Add Item</Text>
        </TouchableOpacity>
      </View>

      {lineItems.length === 0 ? (
        <TouchableOpacity
          style={[styles.emptyReceiptState, { borderColor: theme.border, backgroundColor: theme.surface }]}
          onPress={onAddRow}
          accessibilityRole="button"
          accessibilityLabel="Add itemized lines"
        >
          <Ionicons name="receipt-outline" size={18} color={theme.textMuted} />
          <Text style={[styles.emptyReceiptText, { color: theme.textMuted }]}>No items added yet. Tap to add line items.</Text>
        </TouchableOpacity>
      ) : (
        <>
          {lineItems.map((item, index) => (
            <View
              key={item.id}
              style={[styles.receiptRowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <View style={styles.receiptRowTop}>
                <View style={[styles.itemNumberBadge, { backgroundColor: theme.background }]}>
                  <Text style={[styles.itemNumberText, { color: theme.textMuted }]}>#{index + 1}</Text>
                </View>
                <TextInput
                  style={[styles.receiptNameInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }]}
                  value={item.name}
                  onChangeText={(value) => onUpdateRow(item.id, 'name', value)}
                  placeholder="Item name"
                  placeholderTextColor={theme.textMuted}
                />
                <View style={[styles.receiptPriceBox, { borderColor: theme.border, backgroundColor: theme.background }]}>
                  <Text style={[styles.receiptPricePrefix, { color: theme.textMuted }]}>{currencyCode}</Text>
                  <TextInput
                    style={[styles.receiptPriceInput, { color: theme.text }]}
                    value={item.price}
                    onChangeText={(value) => onUpdateRow(item.id, 'price', value)}
                    placeholder="0"
                    placeholderTextColor={theme.textMuted}
                    keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                  />
                </View>
                <TouchableOpacity
                  style={styles.receiptRemoveBtn}
                  onPress={() => onRemoveRow(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove item ${index + 1}`}
                >
                  <Ionicons name="trash-outline" size={18} color={theme.expense} />
                </TouchableOpacity>
              </View>
              <TextInput
                style={[styles.receiptNoteInput, { color: theme.text, borderTopColor: theme.border, backgroundColor: theme.surface }]}
                value={item.note}
                onChangeText={(value) => onUpdateRow(item.id, 'note', value)}
                placeholder="Item notes / quantity (optional)"
                placeholderTextColor={theme.textMuted}
              />
            </View>
          ))}

          {/* Subtotal Summary Bar */}
          <View style={[styles.totalBar, { backgroundColor: theme.background, borderColor: theme.border }]}>
            <Text style={[styles.totalLabel, { color: theme.textMuted }]}>Items Subtotal ({lineItems.length}):</Text>
            <Text style={[styles.totalValue, { color: theme.primary }]}>
              {formatDisplayCurrency(itemsTotal, currencyCode, useThousandsSeparator)}
            </Text>
          </View>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  receiptEditorBlock: {
    marginTop: 4,
    marginBottom: 6,
  },
  receiptHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  receiptHeaderTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  countBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  inlineAddButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 34,
    justifyContent: 'center',
  },
  inlineAddButtonText: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 4,
  },
  emptyReceiptState: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 14,
    borderStyle: 'dashed',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  emptyReceiptText: {
    marginLeft: 8,
    fontSize: 13,
  },
  receiptRowCard: {
    borderWidth: 1,
    borderRadius: 14,
    marginBottom: 8,
    overflow: 'hidden',
  },
  receiptRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    gap: 6,
  },
  itemNumberBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemNumberText: {
    fontSize: 10,
    fontWeight: '700',
  },
  receiptNameInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  receiptPriceBox: {
    width: 110,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  receiptPricePrefix: {
    fontSize: 11,
    fontWeight: '700',
    marginRight: 4,
  },
  receiptPriceInput: {
    flex: 1,
    minHeight: 40,
    fontSize: 13,
    fontWeight: '600',
  },
  receiptRemoveBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  receiptNoteInput: {
    minHeight: 40,
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
  },
  totalBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  totalLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  totalValue: {
    fontSize: 13,
    fontWeight: '800',
  },
});
