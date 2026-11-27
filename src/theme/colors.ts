export const lightTheme = {
  background: '#f8f9fa',
  surface: '#ffffff',
  primary: '#0369a1', // Blue (sky-700: 5.9:1 on white, WCAG AA for text and white-on-blue)
  onPrimary: '#ffffff',
  primaryMuted: '#e0f2fe',
  /** Switch track when on. */
  primaryTrack: '#7dd3fc',
  text: '#1f2937',    // Dark Gray
  textMuted: '#6b7280',
  border: '#e5e7eb',
  borderLight: '#f3f4f6',
  expense: '#c81e1e', // Red (5.7:1 on white)
  expenseMuted: '#fee2e2',
  income: '#047857',  // Green (emerald-700: 5.5:1 on white)
  incomeMuted: '#d1fae5',
  warning: '#b45309', // Amber (amber-700: 5.0:1 on white)
  warningMuted: '#fef3c7',
};

export type ThemeColors = typeof lightTheme;

export const darkTheme: ThemeColors = {
  background: '#121212',
  surface: '#1e1e1e',
  primary: '#38bdf8', // Lighter Blue for contrast
  onPrimary: '#0b1220', // Dark text on light blue / red / green buttons (6.8:1 or more)
  primaryMuted: '#082f49',
  primaryTrack: '#0369a1',
  text: '#f9fafb',    // Off-White
  textMuted: '#b5bcc7',
  border: '#374151',  // Dark Gray Border
  borderLight: '#1f2937',
  expense: '#f87171', // Softer Red
  expenseMuted: '#450a0a',
  income: '#34d399',  // Softer Green
  incomeMuted: '#064e3b',
  warning: '#fbbf24', // Softer Amber
  warningMuted: '#451a03',
};

type AccentPalette = Pick<ThemeColors, 'primary' | 'primaryMuted' | 'primaryTrack'>;

/**
 * Colour themes: only the accent changes, so income stays green and expenses stay red.
 * Every accent passes WCAG AA in both modes (see theme/__tests__/contrast.test.ts).
 */
export const ACCENTS = {
  ocean: {
    label: 'Ocean',
    light: { primary: '#0369a1', primaryMuted: '#e0f2fe', primaryTrack: '#7dd3fc' },
    dark: { primary: '#38bdf8', primaryMuted: '#082f49', primaryTrack: '#0369a1' },
  },
  indigo: {
    label: 'Indigo',
    light: { primary: '#4338ca', primaryMuted: '#e0e7ff', primaryTrack: '#a5b4fc' },
    dark: { primary: '#818cf8', primaryMuted: '#1e1b4b', primaryTrack: '#4338ca' },
  },
  violet: {
    label: 'Violet',
    light: { primary: '#6d28d9', primaryMuted: '#ede9fe', primaryTrack: '#c4b5fd' },
    dark: { primary: '#a78bfa', primaryMuted: '#2e1065', primaryTrack: '#6d28d9' },
  },
  teal: {
    label: 'Teal',
    light: { primary: '#0f766e', primaryMuted: '#ccfbf1', primaryTrack: '#5eead4' },
    dark: { primary: '#2dd4bf', primaryMuted: '#042f2e', primaryTrack: '#0f766e' },
  },
  pink: {
    label: 'Pink',
    light: { primary: '#be185d', primaryMuted: '#fce7f3', primaryTrack: '#f9a8d4' },
    dark: { primary: '#f472b6', primaryMuted: '#500724', primaryTrack: '#be185d' },
  },
  orange: {
    label: 'Orange',
    light: { primary: '#c2410c', primaryMuted: '#ffedd5', primaryTrack: '#fdba74' },
    dark: { primary: '#fb923c', primaryMuted: '#431407', primaryTrack: '#c2410c' },
  },
  graphite: {
    label: 'Graphite',
    light: { primary: '#334155', primaryMuted: '#f1f5f9', primaryTrack: '#94a3b8' },
    dark: { primary: '#cbd5e1', primaryMuted: '#1e293b', primaryTrack: '#475569' },
  },
} as const satisfies Record<string, { label: string; light: AccentPalette; dark: AccentPalette }>;

export type AccentColor = keyof typeof ACCENTS;
export const ACCENT_KEYS = Object.keys(ACCENTS) as AccentColor[];

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACCENTS, value);
}

/** True black surfaces for OLED screens; text colours are unchanged, so contrast only goes up. */
const PURE_BLACK: Partial<ThemeColors> = {
  background: '#000000',
  surface: '#0d0d0d',
  border: '#2a2a2a',
  borderLight: '#141414',
};

export function buildThemeColors(isDark: boolean, accent: AccentColor = 'ocean', pureBlack = false): ThemeColors {
  const base = isDark ? darkTheme : lightTheme;
  const palette = (ACCENTS[accent] ?? ACCENTS.ocean)[isDark ? 'dark' : 'light'];
  return { ...base, ...palette, ...(isDark && pureBlack ? PURE_BLACK : {}) };
}

// Fallback export
export const colors = lightTheme;
