import React from 'react';
import { Modal, TouchableOpacity, View, Text, ScrollView, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme/useAppTheme';
import type { CategoryRecord } from '../features/transactions/types';

interface CategorySelectorModalProps {
  visible: boolean;
  onClose: () => void;
  categories: CategoryRecord[];
  onSelectCategory: (name: string) => void;
  customCategory: string;
  onChangeCustomCategory: (text: string) => void;
  onAddCustomCategory: () => void;
}

export const CategorySelectorModal: React.FC<CategorySelectorModalProps> = ({
  visible,
  onClose,
  categories,
  onSelectCategory,
  customCategory,
  onChangeCustomCategory,
  onAddCustomCategory,
}) => {
  const theme = useAppTheme();
  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: theme.surface }]}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>Select Category</Text>
          <ScrollView style={{ maxHeight: 250 }}>
            {categories.map((cat) => (
              <TouchableOpacity key={cat.id} style={[styles.categoryRow, { borderBottomColor: theme.border }]} onPress={() => onSelectCategory(cat.name)}>
                <Text style={[styles.categoryText, { color: theme.text }]}>{cat.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.customCategoryBox}>
            <TextInput
              style={[styles.customCategoryInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
              placeholderTextColor={theme.textMuted}
              placeholder="Add new category"
              value={customCategory}
              onChangeText={onChangeCustomCategory}
            />
            <TouchableOpacity style={[styles.addCategoryBtn, { backgroundColor: theme.primary }]} onPress={onAddCustomCategory}>
              <Ionicons name="add" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={[styles.cancelBtnText, { color: theme.expense }]}>Close</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 20 },
  modalContent: { borderRadius: 18, padding: 18 },
  modalTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 14 },
  cancelBtn: { marginTop: 14, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  cancelBtnText: { fontSize: 14, fontWeight: '700' },
  categoryRow: { minHeight: 46, justifyContent: 'center', borderBottomWidth: 1, paddingHorizontal: 4 },
  categoryText: { fontSize: 14, fontWeight: '500' },
  customCategoryBox: { flexDirection: 'row', marginTop: 12 },
  customCategoryInput: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 14, marginRight: 10 },
  addCategoryBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
