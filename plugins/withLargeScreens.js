// Tablets and foldables. Phones stay portrait; screens 600dp and wider (tablets, unfolded foldables) can rotate.
// The lock is applied at runtime, not in the manifest, so Play doesn't see a hard orientation restriction and
// Android 16 large screens (which ignore manifest locks) behave the same as older ones. smallestScreenSize in
// configChanges keeps Silo running when a foldable is folded or unfolded instead of restarting the screen.
const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');

const MARKER = '// Silo: large screens';

function applyLargeScreenManifest(manifest) {
  const app = manifest.manifest.application && manifest.manifest.application[0];
  const main = app && (app.activity || []).find((a) => a.$ && a.$['android:name'] === '.MainActivity');
  if (!main) return manifest;
  const attrs = { ...main.$ };
  delete attrs['android:screenOrientation'];
  const changes = (attrs['android:configChanges'] || '').split('|').filter(Boolean);
  for (const c of ['orientation', 'screenSize', 'screenLayout', 'smallestScreenSize']) {
    if (!changes.includes(c)) changes.push(c);
  }
  attrs['android:configChanges'] = changes.join('|');
  attrs['android:resizeableActivity'] = 'true';
  main.$ = attrs;
  return manifest;
}

const ACTIVITY_CODE = `
  ${MARKER}: phones stay portrait; tablets and unfolded foldables (600dp+) rotate freely.
  private fun applySiloOrientation() {
    requestedOrientation =
        if (resources.configuration.smallestScreenWidthDp >= 600)
            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    applySiloOrientation()
  }
`;

function applyLargeScreenActivity(src) {
  if (src.includes(MARKER)) return src;
  if (!/super\.onCreate\(null\)/.test(src)) throw new Error('withLargeScreens: MainActivity.onCreate not found');
  let out = src.replace(/super\.onCreate\(null\)/, 'super.onCreate(null)\n    applySiloOrientation()');
  const end = out.lastIndexOf('}');
  out = out.slice(0, end) + ACTIVITY_CODE + out.slice(end);
  return out;
}

const withLargeScreens = (config) => {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyLargeScreenManifest(cfg.modResults);
    return cfg;
  });
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') throw new Error('withLargeScreens expects a Kotlin MainActivity');
    cfg.modResults.contents = applyLargeScreenActivity(cfg.modResults.contents);
    return cfg;
  });
};

module.exports = withLargeScreens;
module.exports.applyLargeScreenManifest = applyLargeScreenManifest;
module.exports.applyLargeScreenActivity = applyLargeScreenActivity;
