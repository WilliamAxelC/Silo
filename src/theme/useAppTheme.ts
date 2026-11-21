import { useCallback, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { useSettingsStore } from '../store/useSettingsStore';
import { lightTheme, darkTheme } from './colors';
import { spacing } from './spacing';
import { scaleFontSize, typography } from './typography';

export const useAppTheme = () => {
  const themeMode = useSettingsStore((state) => state.themeMode);
  const rawFontScale = useSettingsStore((state) => state.fontScale);
  const fontScale =
    typeof rawFontScale === 'number' && Number.isFinite(rawFontScale) && rawFontScale > 0
      ? rawFontScale
      : 1;
  const systemColorScheme = useColorScheme();
  const isDarkMode = themeMode === 'system' ? systemColorScheme === 'dark' : themeMode === 'dark';
  const colors = isDarkMode ? darkTheme : lightTheme;

  const scaleFont = useCallback((size: number) => scaleFontSize(size, fontScale), [fontScale]);

  const scaledTypography = useMemo(
    () => ({
      h1: { ...typography.h1, fontSize: scaleFontSize(typography.h1.fontSize, fontScale) },
      body: { ...typography.body, fontSize: scaleFontSize(typography.body.fontSize, fontScale) },
      caption: { ...typography.caption, fontSize: scaleFontSize(typography.caption.fontSize, fontScale) },
    }),
    [fontScale]
  );

  return { ...colors, isDarkMode, spacing, typography: scaledTypography, fontScale, scaleFont };
};
