import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { MonthlyCalendarView } from '../MonthlyCalendarView';
import { lightTheme } from '../../theme/colors';

const ReactTestRenderer = require('react-test-renderer');

describe('MonthlyCalendarView', () => {
  it('respects Monday vs Sunday week start headers and column alignment', () => {
    const onSelectDay = jest.fn();
    let renderer: any;

    // November 2026 starts on Sunday (Nov 1 = Sunday)
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MonthlyCalendarView
          year={2026}
          month={10}
          weekStartDay="monday"
          dailyTotalsMap={{}}
          selectedDayKey={null}
          currencyCode="IDR"
          locale="en-GB"
          onSelectDay={onSelectDay}
          today={new Date(2026, 10, 21)}
        />
      );
    });

    const monTexts = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children));
    expect(monTexts.slice(0, 7)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

    ReactTestRenderer.act(() => {
      renderer.update(
        <MonthlyCalendarView
          year={2026}
          month={10}
          weekStartDay="sunday"
          dailyTotalsMap={{}}
          selectedDayKey={null}
          currencyCode="IDR"
          locale="en-GB"
          onSelectDay={onSelectDay}
          today={new Date(2026, 10, 21)}
        />
      );
    });

    const sunTexts = renderer.root.findAllByType(Text).map((t: any) => String(t.props.children));
    expect(sunTexts.slice(0, 7)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('displays abbreviated green income and red expense totals, marks today, protects against overflow, and selects days', () => {
    const onSelectDay = jest.fn();
    let renderer: any;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MonthlyCalendarView
          year={2026}
          month={10}
          weekStartDay="monday"
          dailyTotalsMap={{
            '2026-11-10': { dayKey: '2026-11-10', income: 1_200_000, expense: 45_000, count: 2 },
            '2026-11-12': { dayKey: '2026-11-12', income: 0, expense: 0, count: 1 }, // transfer only
          }}
          selectedDayKey="2026-11-10"
          currencyCode="IDR"
          locale="en-GB"
          onSelectDay={onSelectDay}
          today={new Date(2026, 10, 21)}
        />
      );
    });

    const day10 = renderer.root.findByProps({ testID: 'calendar-day-2026-11-10' });
    expect(day10.props.accessibilityState).toEqual({ selected: true });
    expect(day10.props.accessibilityLabel).toContain('income 1,2jt');
    expect(day10.props.accessibilityLabel).toContain('expense 45rb');

    // Cell style clips overflow and keeps >= 44pt height
    const cellStyle = StyleSheet.flatten(day10.props.style);
    expect(cellStyle.overflow).toBe('hidden');
    expect(cellStyle.minHeight).toBeGreaterThanOrEqual(44);

    // Compact income & expense text use theme tokens and single-line shrink-to-fit
    const day10Texts = day10.findAllByType(Text);
    const incomeNode = day10Texts.find((t: any) => t.props.children === '1,2jt');
    const expenseNode = day10Texts.find((t: any) => t.props.children === '45rb');
    expect(incomeNode).toBeDefined();
    expect(expenseNode).toBeDefined();
    expect(StyleSheet.flatten(incomeNode.props.style).color).toBe(lightTheme.income);
    expect(StyleSheet.flatten(expenseNode.props.style).color).toBe(lightTheme.expense);
    expect(incomeNode.props.numberOfLines).toBe(1);
    expect(incomeNode.props.adjustsFontSizeToFit).toBe(true);
    expect(expenseNode.props.numberOfLines).toBe(1);
    expect(expenseNode.props.adjustsFontSizeToFit).toBe(true);

    // Transfer-only day has no income/expense totals, only transfer marker
    const day12 = renderer.root.findByProps({ testID: 'calendar-day-2026-11-12' });
    expect(day12.props.accessibilityLabel).toContain('transfer');
    expect(day12.findByProps({ accessibilityLabel: 'Transfer recorded' })).toBeDefined();

    // Today is marked and tapping fires onSelectDay
    const todayCell = renderer.root.findByProps({ testID: 'calendar-day-2026-11-21' });
    expect(todayCell.props.accessibilityLabel).toContain('today');
    ReactTestRenderer.act(() => {
      todayCell.props.onPress();
    });
    expect(onSelectDay).toHaveBeenCalledWith(expect.objectContaining({ dayKey: '2026-11-21', isToday: true }));

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });

  it('abbreviates non-IDR currencies using k/M notation', () => {
    let renderer: any;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MonthlyCalendarView
          year={2026}
          month={10}
          weekStartDay="sunday"
          dailyTotalsMap={{
            '2026-11-05': { dayKey: '2026-11-05', income: 1200, expense: 45.5, count: 2 },
          }}
          selectedDayKey={null}
          currencyCode="USD"
          locale="en-US"
          onSelectDay={jest.fn()}
          today={new Date(2026, 10, 21)}
        />
      );
    });

    const day5 = renderer.root.findByProps({ testID: 'calendar-day-2026-11-05' });
    const texts = day5.findAllByType(Text).map((t: any) => String(t.props.children));
    expect(texts).toContain('1.2k');
    expect(texts).toContain('45.5');

    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
