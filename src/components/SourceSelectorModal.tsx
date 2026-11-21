import React from 'react';
import { Modal, TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getModalOverlayInsetStyle, useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

interface SourceSelectorModalProps {
  visible: boolean;
  onClose: () => void;
  onPickImage: (source: 'gallery' | 'camera') => void;
  /** Receipt scanning: the camera button opens the document scanner and the gallery allows several photos. */
  scanMode?: boolean;
}

export const SourceSelectorModal: React.FC<SourceSelectorModalProps> = ({ visible, onClose, onPickImage, scanMode }) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity
        style={[styles.modalOverlay, getModalOverlayInsetStyle(insets, 20)]}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: theme.surface }]}>
          <Text style={[styles.modalTitle, { color: theme.text, fontSize: theme.scaleFont(16) }]}>
            {scanMode ? 'Add receipts' : 'Select a Source'}
          </Text>
          {scanMode ? (
            <Text style={[styles.modalHint, { color: theme.textMuted, fontSize: theme.scaleFont(12) }]}>
              Scan or pick several at once; they are read in the background.
            </Text>
          ) : null}
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: theme.primary }]}
              onPress={() => onPickImage('gallery')}
              accessibilityRole="button"
              accessibilityLabel="Select from gallery"
            >
              <Ionicons name="images" size={34} color="#fff" />
              <Text style={[styles.modalBtnText, { fontSize: theme.scaleFont(14) }]}>Gallery</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: theme.primary }]}
              onPress={() => onPickImage('camera')}
              accessibilityRole="button"
              accessibilityLabel="Take photo with camera"
            >
              <Ionicons name={scanMode ? 'scan' : 'camera'} size={34} color="#fff" />
              <Text style={[styles.modalBtnText, { fontSize: theme.scaleFont(14) }]}>
                {scanMode ? 'Scan' : 'Camera'}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={[styles.cancelBtnText, { color: theme.expense, fontSize: theme.scaleFont(14) }]}>Cancel</Text>
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
  modalHint: { fontSize: 12, textAlign: 'center', marginTop: -8, marginBottom: 14 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  modalBtn: { flex: 1, minHeight: 108, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  modalBtnText: { marginTop: 8, color: '#fff', fontWeight: '700' },
  cancelBtn: { marginTop: 14, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  cancelBtnText: { fontSize: 14, fontWeight: '700' },
});
