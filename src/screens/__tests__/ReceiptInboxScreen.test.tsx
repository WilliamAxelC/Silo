import React from 'react';
import { Alert, Image, InteractionManager, Linking, StyleSheet, Text } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import DocumentScanner from 'react-native-document-scanner-plugin';

import { ReceiptInboxScreen } from '../ReceiptInboxScreen';
import { useReceiptQueueStore } from '../../store/useReceiptQueueStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
  };
});

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

describe('ReceiptInboxScreen (F-07, F-08, F-09)', () => {
  const mockEnqueue = jest.fn();
  const mockEnsureThumbnail = jest.fn().mockResolvedValue(null);
  const mockRemove = jest.fn();
  const mockRemoveMany = jest.fn();
  const mockClearByStatus = jest.fn();
  const mockRetry = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    useSettingsStore.setState({ currencyCode: 'IDR', useThousandsSeparator: true, fontScale: 1 });
    useReceiptQueueStore.setState({
      items: [
        {
          id: 10,
          imageUri: 'file:///docs/receipts/r1.jpg',
          imageHash: 'md5:aaa',
          thumbnailUri: 'file:///cache/thumbs/t1.jpg',
          status: 'done',
          result: { merchantName: 'Kopi Tuku', totalAmount: 35000, confidence: 'high' },
          error: null,
          createdAt: 1000,
        },
        {
          id: 11,
          imageUri: 'file:///docs/receipts/r2.jpg',
          imageHash: 'md5:bbb',
          thumbnailUri: 'file:///cache/thumbs/t2.jpg',
          status: 'done',
          result: { merchantName: 'Warung Makan', totalAmount: 48000, confidence: 'medium' },
          error: null,
          createdAt: 2000,
        },
      ],
      isProcessing: false,
      enqueue: mockEnqueue,
      ensureThumbnail: mockEnsureThumbnail,
      remove: mockRemove,
      removeMany: mockRemoveMany,
      clearByStatus: mockClearByStatus,
      retry: mockRetry,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes batch review progress (index & total) when opening a ready receipt (F-08)', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReceiptInboxScreen />);
    });

    const firstRow = renderer.root.findAll(
      (node: any) =>
        typeof node.props?.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Kopi Tuku') &&
        typeof node.props?.onPress === 'function'
    )[0];
    expect(firstRow).toBeDefined();
    ReactTestRenderer.act(() => {
      firstRow.props.onPress();
    });

    expect(mockNavigate).toHaveBeenCalledWith('AddTransactionStack', {
      receiptQueueId: 10,
      reviewBatchIndex: 1,
      reviewBatchTotal: 2,
    });

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('supports Clear done and multi-select delete in the inbox (F-08)', async () => {
    mockClearByStatus.mockResolvedValue(2);
    mockRemoveMany.mockResolvedValue(undefined);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReceiptInboxScreen />);
    });

    // Clear done flow
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Clear done receipts' }).props.onPress();
    });
    const clearAlert = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Clear ready receipts?');
    expect(clearAlert).toBeDefined();
    await ReactTestRenderer.act(async () => {
      await clearAlert[2].find((b: any) => b.text === 'Clear done').onPress();
    });
    expect(mockClearByStatus).toHaveBeenCalledWith(['done']);

    // Multi-select delete flow
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Select receipts' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Select all receipts' }).props.onPress();
    });
    ReactTestRenderer.act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Delete selected receipts' }).props.onPress();
    });
    const deleteAlert = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Remove 2 receipts?');
    expect(deleteAlert).toBeDefined();
    await ReactTestRenderer.act(async () => {
      await deleteAlert[2].find((b: any) => b.text === 'Delete').onPress();
    });
    expect(mockRemoveMany).toHaveBeenCalledWith([10, 11], true);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('falls back to camera when document scanner is unavailable and offers Open settings + Import from gallery on permission denial (F-09)', async () => {
    // 1. Document scanner throws -> falls back to camera and enqueues photo
    (DocumentScanner.scanDocument as jest.Mock).mockRejectedValueOnce(new Error('Google Play services unavailable'));
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: true });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///camera/receipt.jpg' }],
    });
    mockEnqueue.mockResolvedValueOnce({ added: 1, skippedDuplicates: 0 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReceiptInboxScreen />);
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Scan receipts with the camera' }).props.onPress();
    });

    expect(ImagePicker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(['file:///camera/receipt.jpg']);

    // 2. Document scanner throws + camera permission denied -> alert offers Open settings and Import from gallery
    (DocumentScanner.scanDocument as jest.Mock).mockRejectedValueOnce(new Error('Google Play services unavailable'));
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Scan receipts with the camera' }).props.onPress();
    });

    const permAlert = (Alert.alert as jest.Mock).mock.calls.find((c) => c[0] === 'Camera Permission Required');
    expect(permAlert).toBeDefined();
    const buttons = permAlert[2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons.some((b) => b.text === 'Open settings')).toBe(true);
    expect(buttons.some((b) => b.text === 'Import from gallery')).toBe(true);

    buttons.find((b) => b.text === 'Open settings')?.onPress?.();
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('surfaces a notice when duplicate receipts are skipped during import (F-07)', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///gallery/dup.jpg' }],
    });
    mockEnqueue.mockResolvedValueOnce({ added: 0, skippedDuplicates: 1 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReceiptInboxScreen />);
    });

    await ReactTestRenderer.act(async () => {
      await renderer.root.findByProps({ accessibilityLabel: 'Import receipt photos' }).props.onPress();
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children ?? ''));
    expect(texts.some((t: string) => t.includes('1 duplicate receipt was already in the inbox'))).toBe(true);

    // Verify >= 44pt touch target on dismiss button (R3A-09)
    const dismissBtn = renderer.root.findByProps({ accessibilityLabel: 'Dismiss duplicate notice' });
    const dismissStyle = StyleSheet.flatten(dismissBtn.props.style);
    expect(dismissStyle.width).toBeGreaterThanOrEqual(44);
    expect(dismissStyle.height).toBeGreaterThanOrEqual(44);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('uses >= 44pt Scan/Import touch targets in a dedicated action row without squeezing the header title (R3A-09)', () => {
    useSettingsStore.setState({ fontScale: 1.2 });

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReceiptInboxScreen />);
    });

    const titleNode = renderer.root.findAllByType(Text).find((t: any) => t.props.children === 'Receipt Inbox');
    expect(titleNode).toBeDefined();
    expect(titleNode.props.numberOfLines).toBe(1);

    const actionRow = renderer.root.findByProps({ testID: 'inbox-primary-actions' });
    const scanBtn = actionRow.findByProps({ accessibilityLabel: 'Scan receipts with the camera' });
    const importBtn = actionRow.findByProps({ accessibilityLabel: 'Import receipt photos' });
    expect(StyleSheet.flatten(scanBtn.props.style).minHeight).toBeGreaterThanOrEqual(44);
    expect(StyleSheet.flatten(importBtn.props.style).minHeight).toBeGreaterThanOrEqual(44);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('uses stored thumbnails, falls back to original and lazily generates missing thumbnails, and recovers on thumbnail load error', () => {
    const scheduledCallbacks: Array<() => void> = [];
    jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((cb: any) => {
      scheduledCallbacks.push(cb);
      return { cancel: jest.fn(), then: jest.fn(), done: jest.fn() } as any;
    });

    useReceiptQueueStore.setState({
      items: [
        {
          id: 10,
          imageUri: 'file:///docs/receipts/r1.jpg',
          imageHash: 'md5:aaa',
          thumbnailUri: 'file:///cache/thumbs/t1.jpg',
          status: 'done',
          result: { merchantName: 'Has Thumb', totalAmount: 35000, confidence: 'high' },
          error: null,
          createdAt: 1000,
        },
        {
          id: 11,
          imageUri: 'file:///docs/receipts/legacy.jpg',
          imageHash: 'md5:bbb',
          thumbnailUri: null,
          status: 'done',
          result: { merchantName: 'Legacy Item', totalAmount: 48000, confidence: 'medium' },
          error: null,
          createdAt: 2000,
        },
      ],
      ensureThumbnail: mockEnsureThumbnail,
    } as any);

    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<ReceiptInboxScreen />);
    });

    const images = renderer.root.findAllByType(Image);
    expect(images).toHaveLength(2);
    // Row 1 uses its thumbnail; Row 2 falls back to original imageUri
    expect(images[0].props.source).toEqual({ uri: 'file:///cache/thumbs/t1.jpg' });
    expect(images[1].props.source).toEqual({ uri: 'file:///docs/receipts/legacy.jpg' });

    // Only legacy item (without thumbnailUri) schedules lazy thumbnail creation
    expect(scheduledCallbacks).toHaveLength(1);
    ReactTestRenderer.act(() => {
      scheduledCallbacks[0]();
    });
    expect(mockEnsureThumbnail).toHaveBeenCalledWith(11);

    // If thumbnail 1 fails to load (e.g. OS cache eviction), falls back to original and forces regeneration
    ReactTestRenderer.act(() => {
      images[0].props.onError();
    });
    const updatedImages = renderer.root.findAllByType(Image);
    expect(updatedImages[0].props.source).toEqual({ uri: 'file:///docs/receipts/r1.jpg' });
    expect(mockEnsureThumbnail).toHaveBeenCalledWith(10, { force: true });

    ReactTestRenderer.act(() => renderer.unmount());
  });
});
