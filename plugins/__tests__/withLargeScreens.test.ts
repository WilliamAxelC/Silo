import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyLargeScreenManifest, applyLargeScreenActivity } = require('../withLargeScreens');

const ACTIVITY = `package dev.cuang.silo

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

function manifestWith(activity: Record<string, string>) {
  return { manifest: { application: [{ $: {}, activity: [{ $: { 'android:name': '.MainActivity', ...activity } }] }] } };
}

describe('withLargeScreens (tablets and foldables)', () => {
  it('drops the manifest portrait lock and keeps Silo running through fold and unfold', () => {
    const out = applyLargeScreenManifest(
      manifestWith({
        'android:screenOrientation': 'portrait',
        'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode',
      })
    );
    const attrs = out.manifest.application[0].activity[0].$;
    expect(attrs['android:screenOrientation']).toBeUndefined();
    expect(attrs['android:resizeableActivity']).toBe('true');
    expect(attrs['android:configChanges'].split('|')).toEqual(
      expect.arrayContaining(['orientation', 'screenSize', 'screenLayout', 'smallestScreenSize'])
    );
  });

  it('does not duplicate smallestScreenSize when run twice', () => {
    const once = applyLargeScreenManifest(manifestWith({ 'android:configChanges': 'orientation|screenSize' }));
    const twice = applyLargeScreenManifest(once);
    const changes = twice.manifest.application[0].activity[0].$['android:configChanges'].split('|');
    expect(changes.filter((c: string) => c === 'smallestScreenSize')).toHaveLength(1);
  });

  it('locks phones to portrait at runtime and frees screens 600dp and wider', () => {
    const out = applyLargeScreenActivity(ACTIVITY);
    expect(out).toContain('smallestScreenWidthDp >= 600');
    expect(out).toContain('SCREEN_ORIENTATION_PORTRAIT');
    expect(out).toContain('SCREEN_ORIENTATION_UNSPECIFIED');
    expect(out).toMatch(/super\.onCreate\(null\)\s*\n\s*applySiloOrientation\(\)/);
    expect(out).toContain('override fun onConfigurationChanged');
    // Idempotent: a second prebuild pass doesn't add it again.
    expect(applyLargeScreenActivity(out)).toBe(out);
  });

  it('is listed in app.json, which no longer forces portrait everywhere', () => {
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../../app.json'), 'utf8'));
    expect(app.expo.plugins).toContain('./plugins/withLargeScreens');
    expect(app.expo.orientation).toBe('default');
  });
});
