import type { WeekStartDay } from './types';

export const MIN_MONTH_START_DAY = 1;
export const MAX_MONTH_START_DAY = 28;

export interface PeriodBounds {
  /** Local start of the period (00:00:00.000). */
  start: Date;
  /** Local end of the period (23:59:59.999). */
  end: Date;
  startMs: number;
  endMs: number;
  monthStartDay: number;
}

export interface CalendarDayCell {
  /** Local YYYY-MM-DD key matching SQLite strftime('%Y-%m-%d', ..., 'localtime'). */
  dayKey: string;
  date: Date;
  dayOfMonth: number;
  inCurrentMonth: boolean;
  isToday: boolean;
}

/**
 * Clamps a configured month start day into the safe 1..28 range (present in every month including Feb).
 */
export function clampMonthStartDay(day: number | null | undefined): number {
  if (typeof day !== 'number' || !Number.isFinite(day)) {
    return MIN_MONTH_START_DAY;
  }
  return Math.min(MAX_MONTH_START_DAY, Math.max(MIN_MONTH_START_DAY, Math.trunc(day)));
}

/**
 * Computes the local start and end bounds of the monthly billing period containing `date`.
 * Uses local year/month/day arithmetic directly so DST spring-forward/fall-back days never shift boundaries.
 *
 * Examples:
 * - monthStartDay = 1, date = 2024-02-15 -> 2024-02-01 00:00:00.000 .. 2024-02-29 23:59:59.999
 * - monthStartDay = 25, date = 2026-11-10 -> 2026-10-25 00:00:00.000 .. 2026-11-24 23:59:59.999
 * - monthStartDay = 25, date = 2026-12-25 -> 2026-12-25 00:00:00.000 .. 2027-01-24 23:59:59.999
 * - monthStartDay = 28, date = 2025-02-27 -> 2025-01-28 00:00:00.000 .. 2025-02-27 23:59:59.999
 * - monthStartDay = 28, date = 2025-02-28 -> 2025-02-28 00:00:00.000 .. 2025-03-27 23:59:59.999
 */
export function getPeriodBounds(date: Date | number, monthStartDay: number = 1): PeriodBounds {
  const anchor = date instanceof Date ? date : new Date(date);
  const startDay = clampMonthStartDay(monthStartDay);

  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const dayOfMonth = anchor.getDate();

  let startYear = year;
  let startMonth = month;
  if (dayOfMonth < startDay) {
    if (month === 0) {
      startYear = year - 1;
      startMonth = 11;
    } else {
      startMonth = month - 1;
    }
  }

  const nextYear = startMonth === 11 ? startYear + 1 : startYear;
  const nextMonth = (startMonth + 1) % 12;

  const start = new Date(startYear, startMonth, startDay, 0, 0, 0, 0);
  // Day 0 of nextMonth resolves to the last day of startMonth when startDay === 1,
  // and day (startDay - 1) of nextMonth when startDay > 1.
  const end = new Date(nextYear, nextMonth, startDay - 1, 23, 59, 59, 999);

  return {
    start,
    end,
    startMs: start.getTime(),
    endMs: end.getTime(),
    monthStartDay: startDay,
  };
}

export function isDateInPeriod(dateOrMs: Date | number | null | undefined, bounds: PeriodBounds): boolean {
  if (dateOrMs === null || dateOrMs === undefined) return false;
  const ts = dateOrMs instanceof Date ? dateOrMs.getTime() : dateOrMs;
  if (!Number.isFinite(ts)) return false;
  return ts >= bounds.startMs && ts <= bounds.endMs;
}

export function isSamePeriod(a: Date | number, b: Date | number, monthStartDay: number = 1): boolean {
  const boundsA = getPeriodBounds(a, monthStartDay);
  const boundsB = getPeriodBounds(b, monthStartDay);
  return (
    boundsA.start.getFullYear() === boundsB.start.getFullYear() &&
    boundsA.start.getMonth() === boundsB.start.getMonth() &&
    boundsA.start.getDate() === boundsB.start.getDate()
  );
}

/**
 * Moves a date forward or backward by `offset` billing periods without ever skipping or overflowing short months.
 */
export function shiftPeriod(date: Date | number, offset: number, monthStartDay: number = 1): Date {
  const { start } = getPeriodBounds(date, monthStartDay);
  return new Date(start.getFullYear(), start.getMonth() + offset, start.getDate(), 0, 0, 0, 0);
}

function formatLocaleDateSafe(date: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return date.toLocaleDateString(locale || 'en-GB', options);
  } catch {
    return date.toLocaleDateString('en-GB', options);
  }
}

/**
 * Formats a billing period for display:
 * - Standard calendar month (startDay === 1): "November 2026" (or "Nov 2026" when compact).
 * - Custom period (startDay > 1): "25 Oct - 24 Nov" (includes years across year boundaries or non-current years).
 */
export function formatPeriodLabel(
  bounds: PeriodBounds,
  locale: string = 'en-GB',
  options?: { compact?: boolean; referenceDate?: Date }
): string {
  if (bounds.monthStartDay === 1) {
    return formatLocaleDateSafe(bounds.start, locale, {
      month: options?.compact ? 'short' : 'long',
      year: 'numeric',
    });
  }

  const startYear = bounds.start.getFullYear();
  const endYear = bounds.end.getFullYear();
  if (startYear !== endYear) {
    const startText = formatLocaleDateSafe(bounds.start, locale, { day: 'numeric', month: 'short', year: 'numeric' });
    const endText = formatLocaleDateSafe(bounds.end, locale, { day: 'numeric', month: 'short', year: 'numeric' });
    return `${startText} - ${endText}`;
  }

  const refYear = (options?.referenceDate ?? new Date()).getFullYear();
  const showYear = startYear !== refYear;
  const startText = formatLocaleDateSafe(bounds.start, locale, { day: 'numeric', month: 'short' });
  const endText = formatLocaleDateSafe(
    bounds.end,
    locale,
    showYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }
  );
  return `${startText} - ${endText}`;
}

/**
 * Formats a local Date or epoch ms as 'YYYY-MM-DD', matching SQLite's strftime('%Y-%m-%d', ..., 'localtime').
 */
export function toLocalDayKey(dateOrMs: Date | number): string {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns local start/end ms bounds for a single calendar day.
 */
export function getLocalDayBounds(dateOrMs: Date | number): { start: Date; end: Date; startMs: number; endMs: number } {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { start, end, startMs: start.getTime(), endMs: end.getTime() };
}

/**
 * Returns local start/end ms bounds for a full calendar month (1st 00:00:00.000 through last day 23:59:59.999).
 */
export function getCalendarMonthBounds(year: number, month: number): PeriodBounds {
  return getPeriodBounds(new Date(year, month, 1, 0, 0, 0, 0), 1);
}

const WEEKDAYS_MONDAY_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAYS_SUNDAY_FIRST = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function getWeekdayHeaders(weekStartDay: WeekStartDay = 'monday'): readonly string[] {
  return weekStartDay === 'sunday' ? WEEKDAYS_SUNDAY_FIRST : WEEKDAYS_MONDAY_FIRST;
}

/**
 * Builds complete 7-column weeks for the given calendar month respecting `weekStartDay`.
 * Leading and trailing slots outside the month have `inCurrentMonth: false`.
 */
export function buildCalendarMonthGrid(
  year: number,
  month: number,
  weekStartDay: WeekStartDay = 'monday',
  today: Date = new Date()
): CalendarDayCell[][] {
  const weekStartIndex = weekStartDay === 'sunday' ? 0 : 1;
  const firstOfMonth = new Date(year, month, 1, 0, 0, 0, 0);
  const leadingBlanks = (firstOfMonth.getDay() - weekStartIndex + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;
  const todayKey = toLocalDayKey(today);

  const cells: CalendarDayCell[] = [];
  for (let i = 0; i < totalCells; i += 1) {
    const dayOffset = i - leadingBlanks + 1;
    const cellDate = new Date(year, month, dayOffset, 0, 0, 0, 0);
    const inCurrentMonth = dayOffset >= 1 && dayOffset <= daysInMonth;
    const dayKey = toLocalDayKey(cellDate);
    cells.push({
      dayKey,
      date: cellDate,
      dayOfMonth: cellDate.getDate(),
      inCurrentMonth,
      isToday: inCurrentMonth && dayKey === todayKey,
    });
  }

  const weeks: CalendarDayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}
