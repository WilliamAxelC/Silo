import { ACCENT_KEYS, buildThemeColors, darkTheme, lightTheme } from '../colors';

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text/background pairs the app actually uses. WCAG AA for normal text is 4.5:1.
const PAIRS: Array<[keyof typeof lightTheme, keyof typeof lightTheme]> = [
  ['text', 'surface'],
  ['text', 'background'],
  ['textMuted', 'surface'],
  ['textMuted', 'background'],
  ['primary', 'surface'],
  ['primary', 'background'],
  ['primary', 'primaryMuted'],
  ['onPrimary', 'primary'],
  ['onPrimary', 'expense'],
  ['onPrimary', 'income'],
  ['expense', 'surface'],
  ['expense', 'expenseMuted'],
  ['income', 'surface'],
  ['income', 'incomeMuted'],
  ['warning', 'surface'],
];

// Requested 2026-11-23 ("better contrast colors"): several light-theme colours were 2.2-3.8:1 and
// white text on the dark theme's light-blue buttons was 2.1:1.
describe('theme contrast (WCAG AA)', () => {
  for (const [name, theme] of [
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const) {
    it.each(PAIRS)(`regression: ${name} %s on %s is at least 4.5:1`, (fg, bg) => {
      expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// Colour themes (2026-11-28): every accent, light and dark, with and without pure black, keeps AA.
describe('colour themes keep WCAG AA', () => {
  const variants = ACCENT_KEYS.flatMap((accent) => [
    [`${accent} light`, buildThemeColors(false, accent)],
    [`${accent} dark`, buildThemeColors(true, accent)],
    [`${accent} pure black`, buildThemeColors(true, accent, true)],
  ] as const);
  it.each(variants)('%s', (_name, theme) => {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(theme[fg], theme[bg]);
      if (ratio < 4.5) throw new Error(`${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  });

  it('only pure black changes the dark background, and never in light mode', () => {
    expect(buildThemeColors(true, 'ocean', true).background).toBe('#000000');
    expect(buildThemeColors(false, 'ocean', true).background).toBe(lightTheme.background);
    expect(buildThemeColors(true, 'ocean')).toEqual(darkTheme);
    expect(buildThemeColors(false, 'ocean')).toEqual(lightTheme);
  });
});
