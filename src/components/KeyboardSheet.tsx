import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Platform,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import * as SafeArea from 'react-native-safe-area-context';

// Read the insets without throwing when a screen is rendered outside a SafeAreaProvider (some tests).
const NoInsets = createContext<{ bottom: number } | null>(null);
function useBottomInset(): number {
  const insets = useContext((SafeArea.SafeAreaInsetsContext as React.Context<{ bottom: number } | null>) ?? NoInsets);
  return insets?.bottom ?? 0;
}

type Props = {
  /** The popup's backdrop style (flex: 1, colour, alignment, padding). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: React.ReactNode;
};

/**
 * How much of a popup the keyboard covers on Android. `keyboardHeight` excludes the navigation bar
 * (React Native subtracts the system bars), so the keyboard reaches `keyboardHeight + navBar` up from the
 * bottom of the screen. If Android already shrank the popup window for the keyboard, that part is
 * subtracted, so phones that resize and phones that don't both end up with the sheet just above the keys.
 */
export function keyboardCover(keyboardHeight: number, navBar: number, screenHeight: number, popupHeight: number) {
  if (keyboardHeight <= 0 || popupHeight <= 0) return 0;
  const alreadyResized = Math.max(0, screenHeight - popupHeight);
  return Math.max(0, Math.round(keyboardHeight + navBar - alreadyResized));
}

function AndroidKeyboardSheet({ style, testID, children }: Props) {
  const navBar = useBottomInset();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [popupHeight, setPopupHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Only the outer view is measured, and padding never changes its own size, so this can't loop.
  const onLayout = (e: LayoutChangeEvent) => setPopupHeight(e.nativeEvent.layout.height);
  const cover = keyboardCover(keyboardHeight, navBar, Dimensions.get('screen').height, popupHeight);
  const backgroundColor = StyleSheet.flatten(style)?.backgroundColor;

  return (
    <View testID="keyboard-sheet" style={[styles.fill, { backgroundColor, paddingBottom: cover }]} onLayout={onLayout}>
      <View style={[style, styles.clear]} testID={testID}>
        {children}
      </View>
    </View>
  );
}

/**
 * Backdrop for a Modal popup with text fields: keeps its sheet or card above the keyboard.
 *
 * Android works the padding out from the keyboard height (see `keyboardCover`). React Native's
 * KeyboardAvoidingView misjudged it there: "height" resized the view it measured, which made sheets like
 * Edit account bounce on newer phones, and "padding" left the field under the keyboard in landscape.
 */
export function KeyboardSheet(props: Props) {
  if (Platform.OS === 'android') return <AndroidKeyboardSheet {...props} />;
  const backgroundColor = StyleSheet.flatten(props.style)?.backgroundColor;
  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor }]}>
      <View style={[props.style, styles.clear]} testID={props.testID}>
        {props.children}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  clear: { backgroundColor: 'transparent' },
});
