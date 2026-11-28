import fs from 'fs';
import path from 'path';
import React from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text } from 'react-native';

import { KeyboardSheet } from '../KeyboardSheet';

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
  it('pads instead of resizing on Android, so the sheet cannot loop', () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      let renderer: any;
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <KeyboardSheet style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', padding: 20 }} testID="shell">
            <Text>sheet</Text>
          </KeyboardSheet>
        );
      });
      const kav = renderer.root.findByType(KeyboardAvoidingView);
      expect(kav.props.behavior).toBe('padding');
      // The caller's padding lives on an inner view, so the keyboard padding never overrides it.
      expect(StyleSheet.flatten(kav.props.style).padding).toBeUndefined();
      const inner = renderer.root.findAllByProps({ testID: 'shell' })[0];
      expect(StyleSheet.flatten(inner.props.style).padding).toBe(20);
      ReactTestRenderer.act(() => renderer.unmount());
    } finally {
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
