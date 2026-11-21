import { useContext } from 'react';
import * as SafeArea from 'react-native-safe-area-context';
import type { EdgeInsets } from 'react-native-safe-area-context';

export const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Shared safe-area inset reader for modals, bottom sheets, and edge-to-edge screens.
 * Uses SafeAreaInsetsContext directly when available so isolated unit tests rendered
 * without SafeAreaProvider or under partial mocks never throw.
 */
export function useSafeInsets(): EdgeInsets {
  if (SafeArea.SafeAreaInsetsContext) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useContext(SafeArea.SafeAreaInsetsContext) ?? ZERO_INSETS;
  }
  if (typeof SafeArea.useSafeAreaInsets === 'function') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return SafeArea.useSafeAreaInsets();
  }
  return ZERO_INSETS;
}

/**
 * Computes bottom padding for a bottom sheet or pinned CTA so interactive controls
 * stay clear of Android 3-button and gesture navigation bars under edge-to-edge mode.
 */
export function getBottomInsetPadding(bottomInset: number, basePadding = 18): number {
  const safeBottom = Number.isFinite(bottomInset) ? Math.max(bottomInset, 0) : 0;
  return basePadding + safeBottom;
}

/**
 * Computes vertical padding for a centered modal overlay so tall dialogs remain
 * bounded inside the top and bottom system bars.
 */
export function getModalOverlayInsetStyle(insets: EdgeInsets, basePadding = 16) {
  const safeTop = Number.isFinite(insets.top) ? Math.max(insets.top, 0) : 0;
  const safeBottom = Number.isFinite(insets.bottom) ? Math.max(insets.bottom, 0) : 0;
  return {
    paddingTop: basePadding + safeTop,
    paddingBottom: basePadding + safeBottom,
  };
}
