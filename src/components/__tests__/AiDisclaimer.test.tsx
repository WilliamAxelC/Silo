import React from 'react';

const mockSettings = new Map<string, string>();
jest.mock('../../db/index', () => ({
  expoDb: {
    getFirstSync: (_s: string, p: string[]) => (mockSettings.has(p[0]) ? { value: mockSettings.get(p[0]) } : null),
    runSync: (_s: string, p: string[]) => void mockSettings.set(p[0], p[1]),
  },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { AI_DISCLAIMER_CAPTION, AiDisclaimerModal } from '../AiDisclaimer';

const ReactTestRenderer = require('react-test-renderer');

// Requested 2026-11-24: "add a disclaimer before use about AI's accuracy".
describe('AI accuracy disclaimer', () => {
  beforeEach(() => mockSettings.clear());

  it('shows before first use, and not again once acknowledged', () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<AiDisclaimerModal />);
    });
    expect(r.root.findByProps({ testID: 'ai-disclaimer' })).toBeTruthy();
    ReactTestRenderer.act(() => r.root.findByProps({ accessibilityLabel: 'I understand' }).props.onPress());
    expect(r.root.findAllByProps({ testID: 'ai-disclaimer' })).toHaveLength(0);
    ReactTestRenderer.act(() => r.unmount());

    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<AiDisclaimerModal />);
    });
    expect(r.root.findAllByProps({ testID: 'ai-disclaimer' })).toHaveLength(0);
    ReactTestRenderer.act(() => r.unmount());
  });

  it('keeps a short reminder that answers can be wrong and are not advice', () => {
    expect(AI_DISCLAIMER_CAPTION).toMatch(/can be wrong/);
    expect(AI_DISCLAIMER_CAPTION).toMatch(/Not financial advice/);
  });
});
