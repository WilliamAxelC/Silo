// Sets android:hasFragileUserData="true". On Android 10 and later the uninstall dialog then offers
// "Keep app data", so someone who uninstalls Silo (to reinstall it, or to switch between the Google Play and
// cuang.dev versions, which share a signing key) can keep their records. Android decides the default; Silo
// never keeps data without that box ticked.
const { withAndroidManifest } = require('expo/config-plugins');

function applyKeepData(manifest) {
  const app = manifest.manifest.application && manifest.manifest.application[0];
  if (app) app.$ = { ...(app.$ || {}), 'android:hasFragileUserData': 'true' };
  return manifest;
}

const withKeepDataOnUninstall = (config) =>
  withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyKeepData(cfg.modResults);
    return cfg;
  });

module.exports = withKeepDataOnUninstall;
module.exports.applyKeepData = applyKeepData;
