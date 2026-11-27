import Constants from 'expo-constants';

/**
 * Where this build is installed from. `web` = the APK on cuang.dev (updates itself from there);
 * `play` = Google Play, which forbids self-updating, so every cuang.dev update path is off.
 * Set at build time: SILO_DISTRIBUTION=play (see app.config.js).
 */
export type Distribution = 'web' | 'play';

export function getDistribution(extra: unknown = Constants.expoConfig?.extra): Distribution {
  return (extra as { distribution?: unknown } | undefined)?.distribution === 'play' ? 'play' : 'web';
}

export function isPlayBuild(): boolean {
  return getDistribution() === 'play';
}
