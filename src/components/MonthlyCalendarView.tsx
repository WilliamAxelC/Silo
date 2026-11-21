import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

import { useAppTheme } from '../theme/useAppTheme';
import { formatCompactAmount } from '../features/transactions/amount';
import {
  buildCalendarMonthGrid,
  getWeekdayHeaders,
  type CalendarDayCell,
} from '../features/transactions/periods';
import type { DailyTotal } from '../db/index';
import type { WeekStartDay } from '../features/transactions/types';

export interface MonthlyCalendarViewProps {
  year: number;
  month: number;
  weekStartDay: WeekStartDay;
  dailyTotalsMap: Record<string, DailyTotal>;
  selectedDayKey: string | null;
  currencyCode: string;
  locale: string;
  onSelectDay: (day: CalendarDayCell) => void;
  today?: Date;
}

function formatDayA11yDate(date: Date, locale: string): string {
  try {
    return date.toLocaleDateString(locale || 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
}

export const MonthlyCalendarView: React.FC<MonthlyCalendarViewProps> = ({
  year,
  month,
  weekStartDay,
  dailyTotalsMap,
  selectedDayKey,
  currencyCode,
  locale,
  onSelectDay,
  today,
}) => {
  const theme = useAppTheme();

  const weekdayHeaders = useMemo(() => getWeekdayHeaders(weekStartDay), [weekStartDay]);
  const weeks = useMemo(
    () => buildCalendarMonthGrid(year, month, weekStartDay, today ?? new Date()),
    [year, month, weekStartDay, today]
  );

  return (
    <View
      testID="monthly-calendar-grid"
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      {/* Weekday Header Row */}
      <View style={styles.weekdayRow}>
        {weekdayHeaders.map((label) => (
          <View key={label} style={styles.weekdayCell}>
            <Text
              style={[styles.weekdayText, { color: theme.textMuted }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.2}
            >
              {label}
            </Text>
          </View>
        ))}
      </View>

      {/* Calendar Weeks */}
      {weeks.map((week, weekIndex) => (
        <View key={`${year}-${month}-w${weekIndex}`} style={styles.weekRow}>
          {week.map((cell) => {
            if (!cell.inCurrentMonth) {
              return <View key={cell.dayKey} style={styles.dayCellBlank} />;
            }

            const totals = dailyTotalsMap[cell.dayKey];
            const income = totals?.income ?? 0;
            const expense = totals?.expense ?? 0;
            const count = totals?.count ?? 0;
            const hasOnlyTransfers = count > 0 && income === 0 && expense === 0;
            const isSelected = selectedDayKey === cell.dayKey;

            const incomeLabel = income > 0 ? formatCompactAmount(income, currencyCode) : null;
            const expenseLabel = expense > 0 ? formatCompactAmount(expense, currencyCode) : null;

            const a11yParts = [formatDayA11yDate(cell.date, locale)];
            if (cell.isToday) a11yParts.push('today');
            if (incomeLabel) a11yParts.push(`income ${incomeLabel}`);
            if (expenseLabel) a11yParts.push(`expense ${expenseLabel}`);
            if (hasOnlyTransfers) a11yParts.push('transfer');
            if (!incomeLabel && !expenseLabel && !hasOnlyTransfers) a11yParts.push('no transactions');

            return (
              <TouchableOpacity
                key={cell.dayKey}
                testID={`calendar-day-${cell.dayKey}`}
                style={[
                  styles.dayCell,
                  {
                    backgroundColor: isSelected ? theme.primaryMuted : 'transparent',
                    borderColor: isSelected ? theme.primary : 'transparent',
                  },
                ]}
                onPress={() => onSelectDay(cell)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={a11yParts.join(', ')}
                accessibilityState={{ selected: isSelected }}
              >
                <View
                  style={[
                    styles.dayNumberWrap,
                    cell.isToday && { backgroundColor: theme.primary },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayNumberText,
                      {
                        color: cell.isToday
                          ? theme.onPrimary
                          : isSelected
                            ? theme.primary
                            : theme.text,
                      },
                    ]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.15}
                  >
                    {cell.dayOfMonth}
                  </Text>
                </View>

                <View style={styles.totalsStack}>
                  {incomeLabel ? (
                    <Text
                      style={[styles.amountText, { color: theme.income }]}
                      numberOfLines={1}
                      ellipsizeMode="clip"
                      adjustsFontSizeToFit
                      minimumFontScale={0.65}
                      maxFontSizeMultiplier={1.15}
                    >
                      {incomeLabel}
                    </Text>
                  ) : null}

                  {expenseLabel ? (
                    <Text
                      style={[styles.amountText, { color: theme.expense }]}
                      numberOfLines={1}
                      ellipsizeMode="clip"
                      adjustsFontSizeToFit
                      minimumFontScale={0.65}
                      maxFontSizeMultiplier={1.15}
                    >
                      {expenseLabel}
                    </Text>
                  ) : null}

                  {hasOnlyTransfers ? (
                    <View
                      style={[styles.transferDot, { backgroundColor: theme.primary }]}
                      accessibilityLabel="Transfer recorded"
                    />
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 8,
    marginTop: 8,
    paddingHorizontal: 4,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  weekdayRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  weekdayCell: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    paddingVertical: 4,
  },
  weekdayText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  weekRow: {
    flexDirection: 'row',
  },
  dayCellBlank: {
    flex: 1,
    minWidth: 0,
    minHeight: 56,
  },
  dayCell: {
    flex: 1,
    minWidth: 0,
    minHeight: 56,
    paddingHorizontal: 1,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflow: 'hidden',
  },
  dayNumberWrap: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  dayNumberText: {
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  totalsStack: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 1,
    overflow: 'hidden',
  },
  amountText: {
    fontSize: 9.5,
    fontWeight: '700',
    lineHeight: 12,
    textAlign: 'center',
    maxWidth: '100%',
  },
  transferDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginTop: 4,
  },
});
