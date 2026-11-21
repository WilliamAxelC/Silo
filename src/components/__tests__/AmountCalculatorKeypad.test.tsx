import React from 'react';
import { Text } from 'react-native';
import { AmountCalculatorKeypad } from '../AmountCalculatorKeypad';
import { useSettingsStore } from '../../store/useSettingsStore';

const ReactTestRenderer = require('react-test-renderer');

function pressKey(renderer: any, accessibilityLabel: string) {
  const btn = renderer.root.findByProps({ accessibilityLabel });
  ReactTestRenderer.act(() => {
    btn.props.onPress();
  });
}

function getAllText(renderer: any): string[] {
  return renderer.root.findAllByType(Text).map((node: any) =>
    Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')
  );
}

describe('AmountCalculatorKeypad', () => {
  beforeEach(() => {
    useSettingsStore.setState({ useThousandsSeparator: true });
  });

  it('hides the decimal key for zero-decimal currencies (IDR and JPY)', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="IDR" onDone={jest.fn()} />
      );
    });
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Decimal point' })).toHaveLength(0);
    ReactTestRenderer.act(() => renderer.unmount());

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="JPY" onDone={jest.fn()} />
      );
    });
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Decimal point' })).toHaveLength(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('shows the decimal key for minor-unit currencies (USD) and commits decimal math', () => {
    const onDone = jest.fn();
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="USD" onDone={onDone} />
      );
    });

    expect(renderer.root.findByProps({ accessibilityLabel: 'Decimal point' })).toBeDefined();

    // Enter 12.50 + 0.75
    pressKey(renderer, '1');
    pressKey(renderer, '2');
    pressKey(renderer, 'Decimal point');
    pressKey(renderer, '5');
    pressKey(renderer, '0');
    pressKey(renderer, 'Add');
    pressKey(renderer, 'Decimal point'); // inserts 0.
    pressKey(renderer, '7');
    pressKey(renderer, '5');

    const texts = getAllText(renderer);
    expect(texts).toContain('12.50 + 0.75');
    expect(texts.some((t) => t.includes('13,25'))).toBe(true);

    pressKey(renderer, 'Done');
    expect(onDone).toHaveBeenCalledWith('13.25');

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('evaluates IDR expressions, supports = chaining, backspace, and clear', () => {
    const onDone = jest.fn();
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="45.000" currencyCode="IDR" onDone={onDone} />
      );
    });

    pressKey(renderer, 'Add');
    pressKey(renderer, '1');
    pressKey(renderer, '8');
    pressKey(renderer, '5');
    pressKey(renderer, '0');
    pressKey(renderer, '0');

    expect(getAllText(renderer)).toContain('45.000 + 18.500');

    pressKey(renderer, 'Equals');
    expect(getAllText(renderer)).toContain('63.500');

    pressKey(renderer, 'Multiply');
    pressKey(renderer, '2');
    pressKey(renderer, '5');
    pressKey(renderer, 'Backspace'); // now 63500 * 2 = 127000
    pressKey(renderer, 'Done');

    expect(onDone).toHaveBeenCalledWith('127.000');

    pressKey(renderer, 'Clear');
    expect(getAllText(renderer)).toContain('0');

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('blocks Done on division by zero and incomplete expressions', () => {
    const onDone = jest.fn();
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="IDR" onDone={onDone} />
      );
    });

    // Incomplete expression: "50 +"
    pressKey(renderer, '5');
    pressKey(renderer, '0');
    pressKey(renderer, 'Add');

    expect(getAllText(renderer)).toContain('Finish the expression');
    const doneBtnIncomplete = renderer.root.findByProps({ accessibilityLabel: 'Done' });
    expect(doneBtnIncomplete.props.disabled).toBe(true);
    pressKey(renderer, 'Done');
    expect(onDone).not.toHaveBeenCalled();

    // Switch operator to Divide and press 0: "50 ÷ 0"
    pressKey(renderer, 'Divide');
    pressKey(renderer, '0');

    expect(getAllText(renderer)).toContain('Cannot divide by zero');
    const doneBtnDivZero = renderer.root.findByProps({ accessibilityLabel: 'Done' });
    expect(doneBtnDivZero.props.disabled).toBe(true);
    pressKey(renderer, 'Equals');
    pressKey(renderer, 'Done');
    expect(onDone).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('blocks negative results and respects allowZero', () => {
    const onDone = jest.fn();
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="IDR" allowZero={false} onDone={onDone} />
      );
    });

    // 10 - 25 = -15
    pressKey(renderer, '1');
    pressKey(renderer, '0');
    pressKey(renderer, 'Subtract');
    pressKey(renderer, '2');
    pressKey(renderer, '5');
    expect(getAllText(renderer)).toContain('Amount cannot be negative');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Done' }).props.disabled).toBe(true);
    pressKey(renderer, 'Done');
    expect(onDone).not.toHaveBeenCalled();

    // 0 disallowed when allowZero=false
    pressKey(renderer, 'Clear');
    pressKey(renderer, '0');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Done' }).props.disabled).toBe(true);
    ReactTestRenderer.act(() => renderer.unmount());

    // 0 allowed when allowZero=true (e.g. BudgetScreen)
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="IDR" allowZero={true} onDone={onDone} />
      );
    });
    pressKey(renderer, '0');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Done' }).props.disabled).toBe(false);
    pressKey(renderer, 'Done');
    expect(onDone).toHaveBeenCalledWith('0');
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('disables Done and shows overflow feedback above MAX_TRANSACTION_AMOUNT (1e13)', () => {
    const onDone = jest.fn();
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <AmountCalculatorKeypad initialValue="" currencyCode="USD" onDone={onDone} />
      );
    });

    // Enter 10000000000001 (1e13 + 1)
    for (const digit of ['1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1']) {
      pressKey(renderer, digit);
    }

    expect(getAllText(renderer)).toContain('Amount is too large');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Done' }).props.disabled).toBe(true);
    pressKey(renderer, 'Done');
    expect(onDone).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => renderer.unmount());
  });
});
