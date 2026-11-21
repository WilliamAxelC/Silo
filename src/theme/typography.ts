export const typography = {
  h1: { fontSize: 24, fontWeight: '700' as const },
  body: { fontSize: 14, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
};

export function scaleFontSize(baseSize: number, fontScale: number = 1): number {
  const safeScale = typeof fontScale === 'number' && Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.round(baseSize * safeScale * 10) / 10;
}
