import React from 'react';
import { KeyboardAvoidingView, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

type Props = {
  /** The popup's backdrop style (flex: 1, colour, alignment, padding). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: React.ReactNode;
};

/**
 * Backdrop for a Modal popup with text fields: keeps its sheet or card above the keyboard.
 *
 * Always uses the "padding" behavior. It adds space under the content without changing the size it
 * measures, so it settles in one pass whether or not Android also resizes the popup window. The
 * "height" behavior resized the very view it measured, and on newer Android phones that made sheets
 * like Edit account bounce up and down while a field was focused.
 */
export function KeyboardSheet({ style, testID, children }: Props) {
  const backgroundColor = StyleSheet.flatten(style)?.backgroundColor;
  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor }]}>
      <View style={[style, styles.clear]} testID={testID}>
        {children}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  clear: { backgroundColor: 'transparent' },
});
