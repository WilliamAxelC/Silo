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
