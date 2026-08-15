import React, { useMemo, useState } from 'react';
import {
  Modal,
  TouchableOpacity,
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
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
  onAddCustomCategory: (name?: string) => void;
  selectedCategory?: string;
}

export const CategorySelectorModal: React.FC<CategorySelectorModalProps> = ({
  visible,
  onClose,
  categories,
  onSelectCategory,
  customCategory,
  onChangeCustomCategory,
  onAddCustomCategory,
  selectedCategory,
}) => {
  const theme = useAppTheme();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCategories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((cat) => cat.name.toLowerCase().includes(q));
  }, [categories, searchQuery]);

  const exactMatchExists = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return categories.some((cat) => cat.name.toLowerCase() === q);
  }, [categories, searchQuery]);

  const handleInstantCreateFromSearch = () => {
    const trimmed = searchQuery.trim();
    if (trimmed) {
      onAddCustomCategory(trimmed);
      setSearchQuery('');
    }
  };

  const handleClose = () => {
    setSearchQuery('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.keyboardShell}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={handleClose}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
            style={[styles.modalContent, { backgroundColor: theme.surface, borderColor: theme.border }]}
          >
            {/* Header */}
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderTitleWrap}>
                <Ionicons name="pricetags-outline" size={20} color={theme.primary} />
                <Text style={[styles.modalTitle, { color: theme.text }]}>Select Category</Text>
              </View>
              <TouchableOpacity
                style={styles.closeIconButton}
                onPress={handleClose}
                accessibilityRole="button"
                accessibilityLabel="Close category modal"
              >
                <Ionicons name="close" size={22} color={theme.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Fast Search Input */}
            <View style={[styles.searchBox, { backgroundColor: theme.background, borderColor: theme.border }]}>
              <Ionicons name="search-outline" size={18} color={theme.textMuted} style={styles.searchIcon} />
              <TextInput
                style={[styles.searchInput, { color: theme.text }]}
                placeholder="Search or create category..."
                placeholderTextColor={theme.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCorrect={false}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  style={styles.clearSearchBtn}
                  onPress={() => setSearchQuery('')}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                >
                  <Ionicons name="close-circle" size={18} color={theme.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Category List */}
            <ScrollView
              style={styles.categoryScroll}
              contentContainerStyle={styles.categoryScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={true}
            >
              {/* Instant Creation Option if search query doesn't match existing */}
              {!exactMatchExists && searchQuery.trim().length > 0 && (
                <TouchableOpacity
                  style={[styles.instantCreateCard, { backgroundColor: theme.primaryMuted, borderColor: theme.primary }]}
                  onPress={handleInstantCreateFromSearch}
                  accessibilityRole="button"
                >
                  <View style={[styles.instantCreateIcon, { backgroundColor: theme.primary }]}>
                    <Ionicons name="add" size={18} color="#fff" />
                  </View>
                  <View style={styles.instantCreateTextWrap}>
                    <Text style={[styles.instantCreateLabel, { color: theme.primary }]}>
                      Create "{searchQuery.trim()}"
                    </Text>
                    <Text style={[styles.instantCreateSub, { color: theme.textMuted }]}>
                      Tap to add and select instantly
                    </Text>
                  </View>
                </TouchableOpacity>
              )}

              {filteredCategories.length === 0 && exactMatchExists ? (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyStateText, { color: theme.textMuted }]}>No categories found.</Text>
                </View>
              ) : (
                filteredCategories.map((cat) => {
                  const isSelected = selectedCategory === cat.name;
                  return (
                    <TouchableOpacity
                      key={cat.id}
                      style={[
                        styles.categoryRow,
                        { borderBottomColor: theme.border },
                        isSelected && { backgroundColor: theme.primaryMuted, borderRadius: 10 },
                      ]}
                      onPress={() => {
                        onSelectCategory(cat.name);
                        setSearchQuery('');
                      }}
                      accessibilityRole="button"
                    >
                      <View style={[styles.categoryDot, { backgroundColor: isSelected ? theme.primary : theme.textMuted }]} />
                      <Text
                        style={[
                          styles.categoryText,
                          { color: isSelected ? theme.primary : theme.text, fontWeight: isSelected ? '700' : '500' },
                        ]}
                        numberOfLines={1}
                      >
                        {cat.name}
                      </Text>
                      {isSelected ? (
                        <Ionicons name="checkmark-circle" size={18} color={theme.primary} />
                      ) : (
                        <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>

            {/* Quick Add Custom Category Row */}
            <View style={styles.customCategoryBox}>
              <TextInput
                style={[styles.customCategoryInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
                placeholderTextColor={theme.textMuted}
                placeholder="New category name..."
                value={customCategory}
                onChangeText={onChangeCustomCategory}
                onSubmitEditing={() => onAddCustomCategory()}
              />
              <TouchableOpacity
                style={[styles.addCategoryBtn, { backgroundColor: theme.primary, opacity: customCategory.trim() ? 1 : 0.6 }]}
                onPress={() => onAddCustomCategory()}
                disabled={!customCategory.trim()}
                accessibilityRole="button"
                accessibilityLabel="Add category"
              >
                <Ionicons name="add" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  keyboardShell: {
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 16,
  },
  modalContent: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 18,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  modalHeaderTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  closeIconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    minHeight: 46,
    marginBottom: 12,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    minHeight: 44,
  },
  clearSearchBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryScroll: {
    maxHeight: 280,
  },
  categoryScrollContent: {
    paddingVertical: 2,
  },
  instantCreateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    minHeight: 48,
  },
  instantCreateIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  instantCreateTextWrap: {
    flex: 1,
  },
  instantCreateLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
  instantCreateSub: {
    fontSize: 11,
    marginTop: 2,
  },
  categoryRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 6,
  },
  categoryDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 12,
  },
  categoryText: {
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  emptyState: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 14,
  },
  customCategoryBox: {
    flexDirection: 'row',
    marginTop: 14,
    alignItems: 'center',
  },
  customCategoryInput: {
    flex: 1,
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 14,
    marginRight: 10,
  },
  addCategoryBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
