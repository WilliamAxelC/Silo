import React, { useEffect, useState } from 'react';
import {
  Dimensions,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useSafeInsets } from '../hooks/useSafeInsets';
import { useAppTheme } from '../theme/useAppTheme';

interface ReceiptPhotoModalProps {
  visible: boolean;
  imageUri: string | null;
  onClose: () => void;
}

const ZOOM_STEPS = [1, 2, 3] as const;

export const ReceiptPhotoModal: React.FC<ReceiptPhotoModalProps> = ({ visible, imageUri, onClose }) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const [zoomIndex, setZoomIndex] = useState(0);

  useEffect(() => {
    if (visible) {
      setZoomIndex(0);
    }
  }, [visible, imageUri]);

  if (!visible || !imageUri) {
    return null;
  }

  const scale = ZOOM_STEPS[zoomIndex] ?? 1;
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
  const viewportHeight = Math.max(screenHeight - insets.top - insets.bottom - 120, 320);
  const imageWidth = Math.round(screenWidth * scale);
  const imageHeight = Math.round(viewportHeight * scale);

  const handleToggleZoom = () => {
    setZoomIndex((prev) => (prev + 1) % ZOOM_STEPS.length);
  };

  const handleZoomOut = () => {
    setZoomIndex((prev) => Math.max(0, prev - 1));
  };

  const handleZoomIn = () => {
    setZoomIndex((prev) => Math.min(ZOOM_STEPS.length - 1, prev + 1));
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={[
          styles.backdrop,
          {
            paddingTop: Math.max(insets.top, 12),
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
        <View style={styles.topBar}>
          <Text style={[styles.hintText, { fontSize: theme.scaleFont(13) }]}>
            {scale === 1 ? 'Tap photo to zoom in' : `Zoom ${scale}× · drag to pan`}
          </Text>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close photo viewer"
          >
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scrollOuter}
          contentContainerStyle={styles.scrollOuterContent}
          maximumZoomScale={3}
          minimumZoomScale={1}
          showsVerticalScrollIndicator={scale > 1}
          centerContent
        >
          <ScrollView
            horizontal
            contentContainerStyle={styles.scrollInnerContent}
            showsHorizontalScrollIndicator={scale > 1}
          >
            <TouchableOpacity
              activeOpacity={0.95}
              onPress={handleToggleZoom}
              accessibilityRole="button"
              accessibilityLabel={`Toggle receipt zoom, currently ${scale}x`}
            >
              <Image
                source={{ uri: imageUri }}
                style={{ width: imageWidth, height: imageHeight }}
                resizeMode="contain"
              />
            </TouchableOpacity>
          </ScrollView>
        </ScrollView>

        <View style={styles.controlsBar}>
          <TouchableOpacity
            style={[styles.zoomBtn, { opacity: zoomIndex === 0 ? 0.45 : 1 }]}
            onPress={handleZoomOut}
            disabled={zoomIndex === 0}
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
          >
            <Ionicons name="remove" size={22} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.zoomBadge}
            onPress={handleToggleZoom}
            accessibilityRole="button"
            accessibilityLabel="Cycle zoom level"
          >
            <Text style={[styles.zoomText, { fontSize: theme.scaleFont(13) }]}>{scale}×</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.zoomBtn, { opacity: zoomIndex === ZOOM_STEPS.length - 1 ? 0.45 : 1 }]}
            onPress={handleZoomIn}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
          >
            <Ionicons name="add" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  hintText: {
    color: '#e5e7eb',
    fontWeight: '600',
  },
  closeBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollOuter: {
    flex: 1,
  },
  scrollOuterContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollInnerContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  zoomBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBadge: {
    minWidth: 56,
    minHeight: 48,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomText: {
    color: '#fff',
    fontWeight: '700',
  },
});
