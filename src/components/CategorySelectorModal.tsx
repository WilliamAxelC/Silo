import React, { useMemo, useState } from 'react';
import {
  Modal,
  TouchableOpacity,
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getModalOverlayInsetStyle, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';
import type { CategoryRecord } from '../features/transactions/types';
import { KeyboardSheet } from './KeyboardSheet';
import { DIALOG_WIDTH } from '../theme/layout';

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
  const insets = useSafeInsets();
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
      <KeyboardSheet style={styles.keyboardShell}>
        <TouchableOpacity
          style={[styles.modalOverlay, getModalOverlayInsetStyle(insets, 16)]}
          activeOpacity={1}
          accessible={false}
          onPress={handleClose}
        >
          <TouchableOpacity
            activeOpacity={1}
          accessible={false}
            onPress={(e) => e.stopPropagation()}
            style={[styles.modalContent, { backgroundColor: theme.surface, borderColor: theme.border }]}
          >
            {/* Header */}
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderTitleWrap}>
                <Ionicons name="pricetags-outline" size={20} color={theme.primary} />
                <Text style={[styles.modalTitle, { color: theme.text, fontSize: theme.scaleFont(17) }]}>
                  Select Category
                </Text>
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
                style={[styles.searchInput, { color: theme.text, fontSize: theme.scaleFont(14) }]}
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
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
                  accessibilityLabel={`Create ${searchQuery.trim()}`}
                >
                  <View style={[styles.instantCreateIcon, { backgroundColor: theme.primary }]}>
                    <Ionicons name="add" size={18} color={theme.onPrimary} />
                  </View>
                  <View style={styles.instantCreateTextWrap}>
                    <Text style={[styles.instantCreateLabel, { color: theme.primary, fontSize: theme.scaleFont(14) }]}>
                      Create "{searchQuery.trim()}"
                    </Text>
                    <Text style={[styles.instantCreateSub, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
                      Tap to add and select instantly
                    </Text>
                  </View>
                </TouchableOpacity>
              )}

              {filteredCategories.length === 0 && exactMatchExists ? (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyStateText, { color: theme.textMuted, fontSize: theme.scaleFont(14) }]}>
                    No categories found.
                  </Text>
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
                      accessibilityLabel={`Select category ${cat.name}`}
                    >
                      <View style={[styles.categoryDot, { backgroundColor: isSelected ? theme.primary : theme.textMuted }]} />
                      <Text
                        style={[
                          styles.categoryText,
                          {
                            color: isSelected ? theme.primary : theme.text,
                            fontWeight: isSelected ? '700' : '500',
                            fontSize: theme.scaleFont(15),
                          },
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
                style={[
                  styles.customCategoryInput,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.border,
                    color: theme.text,
                    fontSize: theme.scaleFont(14),
                  },
                ]}
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
                <Ionicons name="add" size={22} color={theme.onPrimary} />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardSheet>
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
    ...DIALOG_WIDTH,
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
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    minHeight: 48,
    marginBottom: 12,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    minHeight: 48,
  },
  clearSearchBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -6,
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
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 14,
    marginRight: 10,
  },
  addCategoryBtn: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
