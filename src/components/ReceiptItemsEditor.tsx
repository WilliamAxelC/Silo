import React from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme/useAppTheme';

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
  
  return (
    <View style={styles.receiptEditorBlock}>
      <View style={styles.receiptHeaderRow}>
        <Text style={[styles.receiptHeaderTitle, { color: theme.text }]}>Receipt Items</Text>
        <TouchableOpacity style={[styles.inlineAddButton, { borderColor: theme.primary }]} onPress={onAddRow}>
          <Ionicons name="add" size={15} color={theme.primary} />
          <Text style={[styles.inlineAddButtonText, { color: theme.primary }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {lineItems.length === 0 ? (
        <TouchableOpacity style={[styles.emptyReceiptState, { borderColor: theme.border, backgroundColor: theme.surface }]} onPress={onAddRow}>
          <Ionicons name="receipt-outline" size={16} color={theme.textMuted} />
          <Text style={[styles.emptyReceiptText, { color: theme.textMuted }]}>Add itemized lines</Text>
        </TouchableOpacity>
      ) : (
        lineItems.map((item) => (
          <View key={item.id} style={[styles.receiptRowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.receiptRowTop}>
              <TextInput
                style={[styles.receiptNameInput, { color: theme.text }]}
                value={item.name}
                onChangeText={(value) => onUpdateRow(item.id, 'name', value)}
                placeholder="Item"
                placeholderTextColor={theme.textMuted}
              />
              <View style={[styles.receiptPriceBox, { borderColor: theme.border, backgroundColor: theme.background }]}>
                <Text style={[styles.receiptPricePrefix, { color: theme.textMuted }]}>Rp</Text>
                <TextInput
                  style={[styles.receiptPriceInput, { color: theme.text }]}
                  value={item.price}
                  onChangeText={(value) => onUpdateRow(item.id, 'price', value)}
                  placeholder="0"
                  placeholderTextColor={theme.textMuted}
                  keyboardType="numeric"
                />
              </View>
              <TouchableOpacity style={styles.receiptRemoveBtn} onPress={() => onRemoveRow(item.id)}>
                <Ionicons name="close-circle" size={20} color={theme.expense} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={[styles.receiptNoteInput, { color: theme.textMuted, borderTopColor: theme.border }]}
              value={item.note}
              onChangeText={(value) => onUpdateRow(item.id, 'note', value)}
              placeholder="Notes"
              placeholderTextColor={theme.textMuted}
            />
          </View>
        ))
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  receiptEditorBlock: { marginTop: 2 },
  receiptHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  receiptHeaderTitle: { fontSize: 14, fontWeight: '700' },
  inlineAddButton: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  inlineAddButtonText: { fontSize: 12, fontWeight: '700', marginLeft: 4 },
  emptyReceiptState: { minHeight: 44, borderWidth: 1, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  emptyReceiptText: { marginLeft: 6, fontSize: 13 },
  receiptRowCard: { borderWidth: 1, borderRadius: 14, marginBottom: 8, overflow: 'hidden' },
  receiptRowTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  receiptNameInput: { flex: 1, fontSize: 14, marginRight: 8 },
  receiptPriceBox: { minWidth: 98, borderWidth: 1, borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, marginRight: 6 },
  receiptPricePrefix: { fontSize: 12, fontWeight: '700', marginRight: 4 },
  receiptPriceInput: { flex: 1, minHeight: 34, fontSize: 13 },
  receiptRemoveBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  receiptNoteInput: { minHeight: 38, borderTopWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12 },
});
