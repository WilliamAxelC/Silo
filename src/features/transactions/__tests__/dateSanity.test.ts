import { getUnrealisticDateWarning } from '../dateSanity';

describe('getUnrealisticDateWarning', () => {
  const now = new Date(2026, 10, 22, 16, 30);

  it('accepts today, tomorrow and recent past dates', () => {
    expect(getUnrealisticDateWarning(now, now)).toBeNull();
    expect(getUnrealisticDateWarning(new Date(2026, 10, 23, 23, 59), now)).toBeNull();
    expect(getUnrealisticDateWarning(new Date(2025, 0, 5), now)).toBeNull();
  });

  it('flags far-future dates such as a 97 year read as 2097', () => {
    expect(getUnrealisticDateWarning(new Date(2097, 6, 7), now)).toBe('That is 71 years in the future.');
    expect(getUnrealisticDateWarning(new Date(2026, 10, 25), now)).toBe('That is 2 days in the future.');
  });

  it('flags dates more than two years ago', () => {
    expect(getUnrealisticDateWarning(new Date(2019, 0, 1), now)).toBe('That is 8 years ago.');
    expect(getUnrealisticDateWarning(new Date(NaN), now)).toBe('The date is not valid.');
  });
});

describe('scanned receipt dates', () => {
  const { isFarFromToday, describeDateDistance } = jest.requireActual('../dateSanity');
  const now = new Date(2026, 10, 22, 16, 30);
  it('flags dates more than a week from today and describes how far', () => {
    expect(isFarFromToday(new Date(2026, 10, 16), now)).toBe(false);
    expect(isFarFromToday(new Date(2026, 10, 14), now)).toBe(true);
    expect(isFarFromToday(new Date(2025, 10, 22), now)).toBe(true);
    expect(describeDateDistance(new Date(2025, 10, 22), now)).toBe('a year ago');
    expect(describeDateDistance(new Date(2026, 10, 12), now)).toBe('10 days ago');
    expect(describeDateDistance(new Date(2026, 7, 22), now)).toBe('3 months ago');
    expect(describeDateDistance(new Date(2026, 11, 2), now)).toBe('in 10 days');
  });
});
