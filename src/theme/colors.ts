export const lightTheme = {
  background: '#f8f9fa',
  surface: '#ffffff',
  primary: '#0369a1', // Blue (sky-700: 5.9:1 on white, WCAG AA for text and white-on-blue)
  onPrimary: '#ffffff',
  primaryMuted: '#e0f2fe',
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

export const darkTheme = {
  background: '#121212',
  surface: '#1e1e1e',
  primary: '#38bdf8', // Lighter Blue for contrast
  onPrimary: '#0b1220', // Dark text on light blue / red / green buttons (6.8:1 or more)
  primaryMuted: '#082f49',
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

// Fallback export
export const colors = lightTheme;