import React from 'react';
import { Alert, Text } from 'react-native';

const mockGoBack = jest.fn();
let mockReportParams: Record<string, string> = { kind: 'bug' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useRoute: () => ({ params: mockReportParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockSubmit = jest.fn();
jest.mock('../../services/tickets', () => {
  const actual = jest.requireActual('../../services/tickets');
  return { ...actual, submitTicket: (...args: unknown[]) => mockSubmit(...args), getSentTickets: () => [] };
});
jest.mock('../../services/errorLog', () => ({
  getErrorLog: () => [{ at: 1, kind: 'error', message: 'TypeError: x is undefined' }],
  formatErrorLog: () => '1970-01-01T00:00:00.001Z [error] TypeError: x is undefined',
}));

import { ReportScreen } from '../ReportScreen';

const ReactTestRenderer = require('react-test-renderer');

const textOf = (node: any) => {
  const c = node.props.children;
  return (Array.isArray(c) ? c : [c]).flat().map((x: any) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
};

describe('ReportScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockSubmit.mockResolvedValue({ ticket: 7, kind: 'bug', title: 'x', sentAt: 1 });
  });

  it('says exactly what will be sent, and sends the error log only after the user turns it on', async () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<ReportScreen />);
    });
    const disclosure = () => textOf(r.root.findByProps({ testID: 'report-disclosure' }));
    expect(disclosure()).toContain('never added automatically');
    expect(disclosure()).not.toContain('error log');

    ReactTestRenderer.act(() => {
      r.root.findByProps({ accessibilityLabel: 'Report title' }).props.onChangeText('Amount tap');
      r.root.findByProps({ accessibilityLabel: 'Report description' }).props.onChangeText('Tapping Amount does nothing at all');
    });
    await ReactTestRenderer.act(async () => {
      await r.root.findByProps({ accessibilityLabel: 'Send report' }).props.onPress();
    });
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ kind: 'bug', title: 'Amount tap', errorLog: undefined, screenshotBase64: undefined });

    ReactTestRenderer.act(() => {
      r.root.findByProps({ accessibilityLabel: 'Report title' }).props.onChangeText('Again');
      r.root.findByProps({ accessibilityLabel: 'Report description' }).props.onChangeText('Still nothing when tapping');
      r.root.findAll((n: any) => n.props.accessibilityLabel === "Attach Silo's error log" && n.props.onValueChange)[0].props.onValueChange(true);
    });
    expect(disclosure()).toContain('the error log');
    await ReactTestRenderer.act(async () => {
      await r.root.findByProps({ accessibilityLabel: 'Send report' }).props.onPress();
    });
    expect(mockSubmit.mock.calls[1][0].errorLog).toContain('TypeError');
    expect(Alert.alert).toHaveBeenCalledWith('Thanks!', expect.stringContaining('#7'), expect.any(Array));
    ReactTestRenderer.act(() => r.unmount());
  });

  it('shows the problem instead of sending an empty report', async () => {
    let r: any;
    ReactTestRenderer.act(() => {
      r = ReactTestRenderer.create(<ReportScreen />);
    });
    await ReactTestRenderer.act(async () => {
      await r.root.findByProps({ accessibilityLabel: 'Send report' }).props.onPress();
    });
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(r.root.findAllByType(Text).some((t: any) => textOf(t).includes('short title'))).toBe(true);
    ReactTestRenderer.act(() => r.unmount());
  });

  it('opens prefilled when reporting a Silo AI answer, and nothing is sent until the user taps Send', async () => {
    mockReportParams = { kind: 'bug', title: 'Silo AI answer', description: "What's wrong with this answer: \n\nAnswer:\nSpend more" };
    try {
      let r: any;
      ReactTestRenderer.act(() => {
        r = ReactTestRenderer.create(<ReportScreen />);
      });
      expect(r.root.findByProps({ accessibilityLabel: 'Report title' }).props.value).toBe('Silo AI answer');
      expect(r.root.findByProps({ accessibilityLabel: 'Report description' }).props.value).toContain('Spend more');
      expect(mockSubmit).not.toHaveBeenCalled();
      ReactTestRenderer.act(() => r.unmount());
    } finally {
      mockReportParams = { kind: 'bug' };
    }
  });
});
