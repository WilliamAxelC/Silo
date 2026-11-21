import {
  buildCalendarMonthGrid,
  clampMonthStartDay,
  formatPeriodLabel,
  getCalendarMonthBounds,
  getLocalDayBounds,
  getPeriodBounds,
  getWeekdayHeaders,
  isDateInPeriod,
  isSamePeriod,
  shiftPeriod,
  toLocalDayKey,
} from '../periods';

describe('periods helper', () => {
  describe('clampMonthStartDay', () => {
    it('clamps values to the safe 1..28 range and falls back to 1 for non-finite inputs', () => {
      expect(clampMonthStartDay(1)).toBe(1);
      expect(clampMonthStartDay(15)).toBe(15);
      expect(clampMonthStartDay(28)).toBe(28);
      expect(clampMonthStartDay(0)).toBe(1);
      expect(clampMonthStartDay(-5)).toBe(1);
      expect(clampMonthStartDay(29)).toBe(28);
      expect(clampMonthStartDay(31)).toBe(28);
      expect(clampMonthStartDay(25.9)).toBe(25);
      expect(clampMonthStartDay(Number.NaN)).toBe(1);
      expect(clampMonthStartDay(undefined)).toBe(1);
      expect(clampMonthStartDay(null)).toBe(1);
    });
  });

  describe('getPeriodBounds', () => {
    it('matches calendar month boundaries when monthStartDay is 1 (including leap and non-leap Feb)', () => {
      const leapFeb = getPeriodBounds(new Date(2024, 1, 15), 1);
      expect(toLocalDayKey(leapFeb.start)).toBe('2024-02-01');
      expect(toLocalDayKey(leapFeb.end)).toBe('2024-02-29');
      expect(leapFeb.start.getHours()).toBe(0);
      expect(leapFeb.end.getHours()).toBe(23);
      expect(leapFeb.end.getMinutes()).toBe(59);
      expect(leapFeb.end.getSeconds()).toBe(59);
      expect(leapFeb.end.getMilliseconds()).toBe(999);

      const nonLeapFeb = getPeriodBounds(new Date(2023, 1, 15), 1);
      expect(toLocalDayKey(nonLeapFeb.start)).toBe('2023-02-01');
      expect(toLocalDayKey(nonLeapFeb.end)).toBe('2023-02-28');

      const dec = getPeriodBounds(new Date(2026, 11, 15), 1);
      expect(toLocalDayKey(dec.start)).toBe('2026-12-01');
      expect(toLocalDayKey(dec.end)).toBe('2026-12-31');
    });

    it('handles start day 25 within a year and across year end (Dec -> Jan)', () => {
      // Mid-cycle in November: started 25 Oct, ends 24 Nov
      const nov10 = getPeriodBounds(new Date(2026, 10, 10), 25);
      expect(toLocalDayKey(nov10.start)).toBe('2026-10-25');
      expect(toLocalDayKey(nov10.end)).toBe('2026-11-24');

      // On the exact boundary day (25 Dec): starts 25 Dec 2026, ends 24 Jan 2027
      const dec25 = getPeriodBounds(new Date(2026, 11, 25, 0, 0, 0, 0), 25);
      expect(toLocalDayKey(dec25.start)).toBe('2026-12-25');
      expect(toLocalDayKey(dec25.end)).toBe('2027-01-24');

      // Early January before start day: still belongs to 25 Dec 2026 - 24 Jan 2027
      const jan1 = getPeriodBounds(new Date(2027, 0, 1, 0, 0, 0, 0), 25);
      expect(toLocalDayKey(jan1.start)).toBe('2026-12-25');
      expect(toLocalDayKey(jan1.end)).toBe('2027-01-24');

      const jan24End = getPeriodBounds(new Date(2027, 0, 24, 23, 59, 59, 999), 25);
      expect(toLocalDayKey(jan24End.start)).toBe('2026-12-25');
      expect(toLocalDayKey(jan24End.end)).toBe('2027-01-24');

      // 25 Jan starts the next period: 25 Jan 2027 - 24 Feb 2027
      const jan25 = getPeriodBounds(new Date(2027, 0, 25, 0, 0, 0, 0), 25);
      expect(toLocalDayKey(jan25.start)).toBe('2027-01-25');
      expect(toLocalDayKey(jan25.end)).toBe('2027-02-24');
    });

    it('handles February with start day 28 in both non-leap and leap years', () => {
      // Non-leap year 2025:
      const feb27NonLeap = getPeriodBounds(new Date(2025, 1, 27, 23, 59, 59, 999), 28);
      expect(toLocalDayKey(feb27NonLeap.start)).toBe('2025-01-28');
      expect(toLocalDayKey(feb27NonLeap.end)).toBe('2025-02-27');

      const feb28NonLeap = getPeriodBounds(new Date(2025, 1, 28, 0, 0, 0, 0), 28);
      expect(toLocalDayKey(feb28NonLeap.start)).toBe('2025-02-28');
      expect(toLocalDayKey(feb28NonLeap.end)).toBe('2025-03-27');

      // Leap year 2024 (Feb 29 belongs to the 28 Feb - 27 Mar period):
      const feb27Leap = getPeriodBounds(new Date(2024, 1, 27), 28);
      expect(toLocalDayKey(feb27Leap.start)).toBe('2024-01-28');
      expect(toLocalDayKey(feb27Leap.end)).toBe('2024-02-27');

      const feb28Leap = getPeriodBounds(new Date(2024, 1, 28), 28);
      expect(toLocalDayKey(feb28Leap.start)).toBe('2024-02-28');
      expect(toLocalDayKey(feb28Leap.end)).toBe('2024-03-27');

      const feb29Leap = getPeriodBounds(new Date(2024, 1, 29, 18, 30, 0, 0), 28);
      expect(toLocalDayKey(feb29Leap.start)).toBe('2024-02-28');
      expect(toLocalDayKey(feb29Leap.end)).toBe('2024-03-27');
      expect(isDateInPeriod(new Date(2024, 1, 29, 23, 59, 59, 999), feb28Leap)).toBe(true);
    });

    it('produces DST-free local calendar boundaries with zero gaps or overlaps across all 12 months', () => {
      for (const startDay of [1, 15, 25, 28]) {
        let cursor = new Date(2026, 0, startDay, 12, 0, 0, 0);
        for (let i = 0; i < 14; i += 1) {
          const current = getPeriodBounds(cursor, startDay);
          const nextCursor = shiftPeriod(cursor, 1, startDay);
          const next = getPeriodBounds(nextCursor, startDay);

          // Exact local wall-clock start and end times (never shifted by 1 hour on DST transitions)
          expect(current.start.getHours()).toBe(0);
          expect(current.start.getMinutes()).toBe(0);
          expect(current.start.getSeconds()).toBe(0);
          expect(current.start.getMilliseconds()).toBe(0);
          expect(current.end.getHours()).toBe(23);
          expect(current.end.getMinutes()).toBe(59);
          expect(current.end.getSeconds()).toBe(59);
          expect(current.end.getMilliseconds()).toBe(999);

          // The calendar day immediately following current.end is next.start
          const dayAfterEnd = new Date(
            current.end.getFullYear(),
            current.end.getMonth(),
            current.end.getDate() + 1,
            0,
            0,
            0,
            0
          );
          expect(toLocalDayKey(dayAfterEnd)).toBe(toLocalDayKey(next.start));
          expect(current.endMs).toBeLessThan(next.startMs);
          expect(isDateInPeriod(current.endMs, next)).toBe(false);
          expect(isDateInPeriod(next.startMs, current)).toBe(false);

          cursor = nextCursor;
        }
      }
    });
  });

  describe('shiftPeriod & isSamePeriod', () => {
    it('shifts forward and backward cleanly across year boundaries and short months', () => {
      const decCycle = new Date(2026, 11, 28); // in 25 Dec 2026 - 24 Jan 2027
      const next = shiftPeriod(decCycle, 1, 25);
      expect(toLocalDayKey(next)).toBe('2027-01-25');

      const prev = shiftPeriod(decCycle, -1, 25);
      expect(toLocalDayKey(prev)).toBe('2026-11-25');

      expect(isSamePeriod(new Date(2026, 11, 25), new Date(2027, 0, 24), 25)).toBe(true);
      expect(isSamePeriod(new Date(2026, 11, 24), new Date(2026, 11, 25), 25)).toBe(false);
    });
  });

  describe('formatPeriodLabel', () => {
    it('formats standard calendar months identically to Month Year when startDay is 1', () => {
      const bounds = getPeriodBounds(new Date(2026, 10, 15), 1);
      expect(formatPeriodLabel(bounds, 'en-GB')).toBe(
        new Date(2026, 10, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      );
      expect(formatPeriodLabel(bounds, 'en-GB', { compact: true })).toBe(
        new Date(2026, 10, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
      );
    });

    it('formats custom start day periods clearly within same year, prior year, and across year end', () => {
      const ref2026 = new Date(2026, 10, 15);
      const octNov = getPeriodBounds(new Date(2026, 10, 10), 25);
      expect(formatPeriodLabel(octNov, 'en-GB', { referenceDate: ref2026 })).toBe('25 Oct - 24 Nov');

      const decJan = getPeriodBounds(new Date(2026, 11, 26), 25);
      expect(formatPeriodLabel(decJan, 'en-GB', { referenceDate: ref2026 })).toBe('25 Dec 2026 - 24 Jan 2027');

      const priorYear = getPeriodBounds(new Date(2025, 10, 10), 25);
      expect(formatPeriodLabel(priorYear, 'en-GB', { referenceDate: ref2026 })).toBe('25 Oct - 24 Nov 2025');
    });
  });

  describe('calendar helpers', () => {
    it('returns local day and month bounds accurately', () => {
      const dayBounds = getLocalDayBounds(new Date(2026, 10, 21, 14, 30));
      expect(toLocalDayKey(dayBounds.start)).toBe('2026-11-21');
      expect(toLocalDayKey(dayBounds.end)).toBe('2026-11-21');
      expect(dayBounds.start.getHours()).toBe(0);
      expect(dayBounds.end.getHours()).toBe(23);

      const monthBounds = getCalendarMonthBounds(2024, 1);
      expect(toLocalDayKey(monthBounds.start)).toBe('2024-02-01');
      expect(toLocalDayKey(monthBounds.end)).toBe('2024-02-29');
    });

    it('aligns month grid weeks to Monday or Sunday and marks today accurately', () => {
      expect(getWeekdayHeaders('monday')[0]).toBe('Mon');
      expect(getWeekdayHeaders('sunday')[0]).toBe('Sun');

      // November 2026: Nov 1, 2026 is a Sunday (getDay() === 0).
      const today = new Date(2026, 10, 21, 12, 0);

      const monWeeks = buildCalendarMonthGrid(2026, 10, 'monday', today);
      expect(monWeeks.every((w) => w.length === 7)).toBe(true);
      // With Monday start, Nov 1 (Sunday) is at column index 6 of week 0 -> 6 leading blanks
      expect(monWeeks[0].slice(0, 6).every((c) => !c.inCurrentMonth)).toBe(true);
      expect(monWeeks[0][6].inCurrentMonth).toBe(true);
      expect(monWeeks[0][6].dayKey).toBe('2026-11-01');

      const sunWeeks = buildCalendarMonthGrid(2026, 10, 'sunday', today);
      expect(sunWeeks.every((w) => w.length === 7)).toBe(true);
      // With Sunday start, Nov 1 (Sunday) is at column index 0 of week 0 -> 0 leading blanks
      expect(sunWeeks[0][0].inCurrentMonth).toBe(true);
      expect(sunWeeks[0][0].dayKey).toBe('2026-11-01');

      // Today marker appears exactly once on 2026-11-21
      const allMonCells = monWeeks.flat();
      const todayCells = allMonCells.filter((c) => c.isToday);
      expect(todayCells).toHaveLength(1);
      expect(todayCells[0].dayKey).toBe('2026-11-21');
    });
  });
});
