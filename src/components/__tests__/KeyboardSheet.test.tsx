import fs from 'fs';
import path from 'path';
import React from 'react';
import { Dimensions, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text } from 'react-native';

import { KeyboardSheet, keyboardCover } from '../KeyboardSheet';

const ReactTestRenderer = require('react-test-renderer');

const SRC = path.join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('KeyboardSheet (popups bouncing when a field is focused)', () => {
  it('works out the keyboard cover without measuring what it pads (no bounce loop)', () => {
    // Popup window not resized (edge-to-edge): keyboard 300 + nav bar 48 is covered.
    expect(keyboardCover(300, 48, 800, 800)).toBe(348);
    // Android already shrank the popup by the whole keyboard: nothing left to pad.
    expect(keyboardCover(300, 48, 800, 452)).toBe(0);
    // Keyboard hidden or not measured yet.
    expect(keyboardCover(0, 48, 800, 800)).toBe(0);
    expect(keyboardCover(300, 48, 800, 0)).toBe(0);
  });

  it('on Android pads the backdrop by the keyboard and keeps the caller\'s own padding', () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const listeners: Record<string, (e: any) => void> = {};
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, cb: (e: any) => void) => {
      listeners[name] = cb;
      return { remove: jest.fn() } as any;
    }) as any);
    try {
      let renderer: any;
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <KeyboardSheet style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', padding: 20 }} testID="shell">
            <Text>sheet</Text>
          </KeyboardSheet>
        );
      });
      expect(renderer.root.findAllByType(KeyboardAvoidingView)).toHaveLength(0);
      const outer = () => renderer.root.findAllByProps({ testID: 'keyboard-sheet' })[0];
      const screenHeight = Dimensions.get('screen').height;
      ReactTestRenderer.act(() => {
        outer().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: screenHeight } } });
        listeners.keyboardDidShow({ endCoordinates: { height: 280, screenY: 0, screenX: 0, width: 400 } });
      });
      expect(StyleSheet.flatten(outer().props.style).paddingBottom).toBe(280);
      const inner = renderer.root.findAllByProps({ testID: 'shell' })[0];
      expect(StyleSheet.flatten(inner.props.style).padding).toBe(20);
      ReactTestRenderer.act(() => listeners.keyboardDidHide({}));
      expect(StyleSheet.flatten(outer().props.style).paddingBottom).toBe(0);
      ReactTestRenderer.act(() => renderer.unmount());
    } finally {
      spy.mockRestore();
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    }
  });

  it('no popup uses the "height" behavior that made Edit account bounce', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /behavior=\{[^}]*'height'|behavior="height"/.test(fs.readFileSync(file, 'utf8'))
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('every popup with a text field keeps it above the keyboard', () => {
    const missing = sourceFiles(SRC).filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return /<Modal\b/.test(text) && /<TextInput\b/.test(text) && !/<KeyboardSheet\b/.test(text);
    });
    expect(missing.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
