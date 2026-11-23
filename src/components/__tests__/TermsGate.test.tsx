import React from 'react';

const mockSettings = new Map<string, string>();
jest.mock('../../db/index', () => ({
  expoDb: {
    getFirstSync: (_s: string, p: string[]) => (mockSettings.has(p[0]) ? { value: mockSettings.get(p[0]) } : null),
    runSync: (_s: string, p: string[]) => void mockSettings.set(p[0], p[1]),
  },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { TermsGate } from '../TermsGate';
import { TERMS_VERSION, termsPrompt, useTermsStore } from '../../services/terms';

const ReactTestRenderer = require('react-test-renderer');

// Legal review 2026-11-23: under UU 8/1999 Art. 18(1)(g) changed terms bind only once accepted, so the app
// records acceptance and asks again when the terms change.
describe('Terms of Service acceptance', () => {
  beforeEach(() => {
    mockSettings.clear();
    useTermsStore.setState({ accepted: null, loaded: false, postponed: false });
  });

  it('asks on first launch with no way round it, and records the accepted version', () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<TermsGate />);
    });
    expect(r.root.findByProps({ testID: 'terms-gate' })).toBeTruthy();
    expect(r.root.findAllByProps({ accessibilityLabel: 'Decide later' })).toHaveLength(0);
    ReactTestRenderer.act(() => r.root.findByProps({ accessibilityLabel: 'Agree to the Terms of Service' }).props.onPress());
    expect(JSON.parse(mockSettings.get('termsAccepted')!).version).toBe(TERMS_VERSION);
    expect(r.root.findAllByProps({ testID: 'terms-gate' })).toHaveLength(0);
    ReactTestRenderer.act(() => r.unmount());
  });

  it('shows changed terms before they apply, and Later keeps the old ones for now', () => {
    mockSettings.set('termsAccepted', JSON.stringify({ version: '2020-01-01', at: 1 }));
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<TermsGate />);
    });
    expect(termsPrompt(useTermsStore.getState())).toBe('changed');
    ReactTestRenderer.act(() => r.root.findByProps({ accessibilityLabel: 'Decide later' }).props.onPress());
    expect(r.root.findAllByProps({ testID: 'terms-gate' })).toHaveLength(0);
    expect(JSON.parse(mockSettings.get('termsAccepted')!).version).toBe('2020-01-01');
    ReactTestRenderer.act(() => r.unmount());
  });
});
