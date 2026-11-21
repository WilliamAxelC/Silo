import React, { useMemo, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  currencyHasDecimals,
  evaluateAmountExpression,
  formatAmountForInput,
  formatCalculatorExpression,
  formatDisplayCurrency,
  getCurrencyDecimals,
  parseSignedAmount,
  roundCurrency,
} from '../features/transactions/amount';
import { getBottomInsetPadding, useSafeInsets } from '../hooks/useSafeInsets';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAppTheme } from '../theme/useAppTheme';

const OPERATORS = new Set(['+', '-', '*', '/']);

function toInitialExpression(initialValue: string, currencyCode: string): string {
  if (!initialValue || !initialValue.trim()) return '';
  const parsed = Math.abs(parseSignedAmount(initialValue, undefined, currencyCode));
  if (!Number.isFinite(parsed) || parsed === 0) return '';
  const decimals = getCurrencyDecimals(currencyCode);
  return roundCurrency(parsed, decimals).toString();
}

function getCurrentNumberSegment(expr: string): string {
  let lastOpIndex = -1;
  for (let i = expr.length - 1; i >= 0; i--) {
    if (OPERATORS.has(expr[i])) {
      lastOpIndex = i;
      break;
    }
  }
  return expr.slice(lastOpIndex + 1);
}

export interface AmountCalculatorKeypadProps {
  initialValue: string;
  currencyCode: string;
  allowZero?: boolean;
  embedded?: boolean;
  onDone: (formattedValue: string) => void;
  onCancel?: () => void;
}

export const AmountCalculatorKeypad: React.FC<AmountCalculatorKeypadProps> = ({
  initialValue,
  currencyCode,
  allowZero = false,
  embedded = false,
  onDone,
  onCancel,
}) => {
  const theme = useAppTheme();
  const insets = useSafeInsets();
  const useThousands = useSettingsStore((s) => s.useThousandsSeparator);
  const allowDecimals = currencyHasDecimals(currencyCode);
  const decimals = getCurrencyDecimals(currencyCode);

  const [expr, setExpr] = useState(() => toInitialExpression(initialValue, currencyCode));

  const evalResult = useMemo(() => evaluateAmountExpression(expr, decimals), [expr, decimals]);
  const formattedExpression = useMemo(
    () => formatCalculatorExpression(expr, currencyCode),
    [expr, currencyCode]
  );

  const statusInfo = useMemo(() => {
    if (!expr) {
      return { text: 'Enter amount or math expression', tone: 'muted' as const, canSubmit: true };
    }
    if (!evalResult.ok) {
      if (evalResult.error === 'division_by_zero') {
        return { text: 'Cannot divide by zero', tone: 'error' as const, canSubmit: false };
      }
      if (evalResult.error === 'incomplete') {
        return { text: 'Finish the expression', tone: 'warning' as const, canSubmit: false };
      }
      if (evalResult.error === 'overflow') {
        return { text: 'Amount is too large', tone: 'error' as const, canSubmit: false };
      }
      return { text: 'Check expression', tone: 'error' as const, canSubmit: false };
    }
    if (evalResult.value < 0) {
      return { text: 'Amount cannot be negative', tone: 'error' as const, canSubmit: false };
    }
    if (!allowZero && evalResult.value === 0) {
      return { text: 'Amount must be greater than 0', tone: 'error' as const, canSubmit: false };
    }
    const formattedResult = formatDisplayCurrency(evalResult.value, currencyCode, useThousands);
    return {
      text: `= ${formattedResult}`,
      tone: 'valid' as const,
      canSubmit: true,
    };
  }, [allowZero, currencyCode, evalResult, expr, useThousands]);

  const appendDigit = (digit: string) => {
    setExpr((current) => {
      const segment = getCurrentNumberSegment(current);
      const dotIndex = segment.indexOf('.');
      if (dotIndex !== -1 && segment.length - dotIndex - 1 >= decimals) {
        return current;
      }
      if (segment === '0') {
        return current.slice(0, -1) + digit;
      }
      return current + digit;
    });
  };

  const appendDecimal = () => {
    if (!allowDecimals) return;
    setExpr((current) => {
      const segment = getCurrentNumberSegment(current);
      if (segment.includes('.')) return current;
      if (!segment) return `${current}0.`;
      return `${current}.`;
    });
  };

  const appendOperator = (op: '+' | '-' | '*' | '/') => {
    setExpr((current) => {
      if (!current) return current;
      const last = current[current.length - 1];
      if (last === '.') return current;
      if (OPERATORS.has(last)) {
        return current.slice(0, -1) + op;
      }
      return current + op;
    });
  };

  const handleBackspace = () => {
    setExpr((current) => current.slice(0, -1));
  };

  const handleClear = () => {
    setExpr('');
  };

  const handleEquals = () => {
    if (!evalResult.ok || evalResult.value < 0) return;
    setExpr(evalResult.value === 0 ? '0' : evalResult.value.toString());
  };

  const handleDone = () => {
    if (!statusInfo.canSubmit) return;
    if (!expr) {
      onDone('');
      return;
    }
    if (!evalResult.ok || evalResult.value < 0) return;
    if (!allowZero && evalResult.value === 0) return;
    onDone(formatAmountForInput(evalResult.value, currencyCode));
  };

  const statusColor =
    statusInfo.tone === 'error'
      ? theme.expense
      : statusInfo.tone === 'warning'
        ? theme.warning
        : statusInfo.tone === 'valid'
          ? theme.primary
          : theme.textMuted;

  const renderKey = (
    label: string,
    onPress: () => void,
    options?: {
      accessibilityLabel?: string;
      variant?: 'digit' | 'operator' | 'action' | 'primary';
      flex?: number;
      disabled?: boolean;
      icon?: keyof typeof Ionicons.glyphMap;
    }
  ) => {
    const variant = options?.variant ?? 'digit';
    const disabled = options?.disabled ?? false;
    const bg =
      variant === 'primary'
        ? theme.primary
        : variant === 'operator'
          ? theme.primaryMuted
          : variant === 'action'
            ? theme.background
            : theme.surface;
    const borderColor = variant === 'primary' ? theme.primary : theme.border;
    const textColor =
      variant === 'primary'
        ? theme.onPrimary
        : variant === 'operator'
          ? theme.primary
          : theme.text;

    return (
      <TouchableOpacity
        style={[
          styles.key,
          {
            flex: options?.flex ?? 1,
            backgroundColor: bg,
            borderColor,
            opacity: disabled ? 0.45 : 1,
          },
        ]}
        onPress={onPress}
        disabled={disabled}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={options?.accessibilityLabel ?? label}
        accessibilityState={{ disabled }}
      >
        {options?.icon ? (
          <Ionicons name={options.icon} size={20} color={textColor} />
        ) : (
          <Text
            style={[
              styles.keyText,
              variant === 'operator' && styles.opKeyText,
              { color: textColor, fontSize: theme.scaleFont(variant === 'operator' ? 20 : 18) },
            ]}
          >
            {label}
          </Text>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View
      style={
        embedded
          ? styles.embeddedPanel
          : [
              styles.panel,
              {
                backgroundColor: theme.surface,
                borderColor: theme.border,
                paddingBottom: getBottomInsetPadding(insets.bottom, 20),
              },
            ]
      }
    >
      {/* Header + Expression Display */}
      <View style={[styles.displayBox, { backgroundColor: theme.background, borderColor: theme.border }]}>
        <View style={styles.displayTopRow}>
          <Text style={[styles.currencyTag, { color: theme.textMuted, fontSize: theme.scaleFont(11) }]}>
            {currencyCode}
          </Text>
          {onCancel ? (
            <TouchableOpacity
              onPress={onCancel}
              style={styles.closeBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close calculator"
            >
              <Ionicons name="close" size={20} color={theme.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <Text
          style={[styles.expressionText, { color: theme.text, fontSize: theme.scaleFont(22) }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          accessibilityLabel={`Expression ${formattedExpression || '0'}`}
        >
          {formattedExpression || '0'}
        </Text>
        <Text
          style={[styles.resultText, { color: statusColor, fontSize: theme.scaleFont(13) }]}
          numberOfLines={1}
          accessibilityRole={statusInfo.tone === 'error' ? 'alert' : 'text'}
        >
          {statusInfo.text}
        </Text>
      </View>

      {/* Keypad Grid */}
      <View style={styles.grid}>
        <View style={styles.row}>
          {renderKey('C', handleClear, { accessibilityLabel: 'Clear', variant: 'action' })}
          {renderKey('÷', () => appendOperator('/'), { accessibilityLabel: 'Divide', variant: 'operator' })}
          {renderKey('×', () => appendOperator('*'), { accessibilityLabel: 'Multiply', variant: 'operator' })}
          {renderKey('⌫', handleBackspace, {
            accessibilityLabel: 'Backspace',
            variant: 'action',
            icon: 'backspace-outline',
          })}
        </View>

        <View style={styles.row}>
          {renderKey('7', () => appendDigit('7'))}
          {renderKey('8', () => appendDigit('8'))}
          {renderKey('9', () => appendDigit('9'))}
          {renderKey('-', () => appendOperator('-'), { accessibilityLabel: 'Subtract', variant: 'operator' })}
        </View>

        <View style={styles.row}>
          {renderKey('4', () => appendDigit('4'))}
          {renderKey('5', () => appendDigit('5'))}
          {renderKey('6', () => appendDigit('6'))}
          {renderKey('+', () => appendOperator('+'), { accessibilityLabel: 'Add', variant: 'operator' })}
        </View>

        <View style={styles.row}>
          {renderKey('1', () => appendDigit('1'))}
          {renderKey('2', () => appendDigit('2'))}
          {renderKey('3', () => appendDigit('3'))}
          {renderKey('=', handleEquals, { accessibilityLabel: 'Equals', variant: 'operator' })}
        </View>

        <View style={styles.row}>
          {renderKey('0', () => appendDigit('0'), { flex: allowDecimals ? 1 : 2 })}
          {allowDecimals
            ? renderKey('.', appendDecimal, { accessibilityLabel: 'Decimal point' })
            : null}
          {renderKey('Done', handleDone, {
            accessibilityLabel: 'Done',
            variant: 'primary',
            flex: 2,
            disabled: !statusInfo.canSubmit,
          })}
        </View>
      </View>
    </View>
  );
};

interface AmountCalculatorModalProps extends AmountCalculatorKeypadProps {
  visible: boolean;
  onClose: () => void;
}

export const AmountCalculatorModal: React.FC<AmountCalculatorModalProps> = ({
  visible,
  onClose,
  onDone,
  ...rest
}) => {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} style={styles.sheetWrap}>
          {visible ? (
            <AmountCalculatorKeypad
              {...rest}
              onDone={(val) => {
                onDone(val);
                onClose();
              }}
              onCancel={onClose}
            />
          ) : null}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    width: '100%',
  },
  panel: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    padding: 14,
    paddingBottom: 20,
  },
  embeddedPanel: {
    padding: 0,
  },
  displayBox: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
  },
  displayTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  currencyTag: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  closeBtn: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expressionText: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'right',
  },
  resultText: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'right',
    marginTop: 4,
  },
  grid: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  key: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {
    fontSize: 18,
    fontWeight: '700',
  },
  opKeyText: {
    fontSize: 20,
  },
});
