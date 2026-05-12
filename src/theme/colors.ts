export const lightTheme = {
  background: '#f8f9fa',
  surface: '#ffffff',
  primary: '#0ea5e9', // Blue
  text: '#1f2937',    // Dark Gray
  textMuted: '#6b7280',
  border: '#e5e7eb',
  expense: '#ef4444', // Red
  income: '#10b981',  // Green
};

export const darkTheme = {
  background: '#121212',
  surface: '#1e1e1e',
  primary: '#38bdf8', // Lighter Blue for contrast
  text: '#f9fafb',    // Off-White
  textMuted: '#9ca3af',
  border: '#374151',  // Dark Gray Border
  expense: '#f87171', // Softer Red
  income: '#34d399',  // Softer Green
};

// We will keep exporting the light theme as a fallback, 
// but screens should now dynamically pick the theme from the store!
export const colors = lightTheme;