// Wraps app.json. SILO_DISTRIBUTION=play builds the Google Play variant: no self-updating (Play policy), so
// the install-packages permission from modules/receipt-normalize is stripped and the app turns off its
// cuang.dev update checks (src/services/distribution.ts). Anything else builds the cuang.dev APK.
module.exports = ({ config }) => {
  const play = process.env.SILO_DISTRIBUTION === 'play';
  const blocked = config.android?.blockedPermissions ?? [];
  return {
    ...config,
    extra: { ...(config.extra ?? {}), distribution: play ? 'play' : 'web' },
    android: {
      ...config.android,
      blockedPermissions: play ? [...new Set([...blocked, 'android.permission.REQUEST_INSTALL_PACKAGES'])] : blocked,
    },
  };
};
