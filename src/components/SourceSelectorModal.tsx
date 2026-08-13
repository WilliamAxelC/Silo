import React from 'react';
import { Modal, TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../theme/useAppTheme';

interface SourceSelectorModalProps {
  visible: boolean;
  onClose: () => void;
  onPickImage: (source: 'gallery' | 'camera') => void;
}

export const SourceSelectorModal: React.FC<SourceSelectorModalProps> = ({ visible, onClose, onPickImage }) => {
  const theme = useAppTheme();
  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: theme.surface }]}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>Select a Source</Text>
          <View style={styles.modalActions}>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }]} onPress={() => onPickImage('gallery')}>
              <Ionicons name="images" size={34} color="#fff" />
              <Text style={styles.modalBtnText}>Gallery</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.primary }]} onPress={() => onPickImage('camera')}>
              <Ionicons name="camera" size={34} color="#fff" />
              <Text style={styles.modalBtnText}>Camera</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={[styles.cancelBtnText, { color: theme.expense }]}>Cancel</Text>
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
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  modalBtn: { flex: 1, minHeight: 108, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  modalBtnText: { marginTop: 8, color: '#fff', fontWeight: '700' },
  cancelBtn: { marginTop: 14, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  cancelBtnText: { fontSize: 14, fontWeight: '700' },
});
