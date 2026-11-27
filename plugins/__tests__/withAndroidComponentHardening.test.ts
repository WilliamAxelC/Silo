const plugin = require('../withAndroidComponentHardening');

describe('withAndroidComponentHardening (security review 2026-11-28)', () => {
  const base = () => ({
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{ $: { 'android:name': '.MainApplication' }, activity: [{ $: { 'android:name': '.MainActivity', 'android:exported': 'true' } }] }],
    },
  });

  it('regression: the cropper activity is not exported, the clipboard provider is left alone, MainActivity is untouched', () => {
    const out = plugin.applyHardening(base());
    const app = out.manifest.application[0];
    expect(out.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    const cropper = app.activity.find((a: any) => a.$['android:name'] === 'com.canhub.cropper.CropImageActivity');
    expect(cropper.$).toMatchObject({ 'android:exported': 'false', 'tools:replace': 'android:exported' });
    // expo-clipboard asserts its provider is exported and crashes Silo at launch otherwise.
    expect(plugin.UNEXPORT.map((c: any) => c.name)).not.toContain('expo.modules.clipboard.ClipboardFileProvider');
    expect(app.provider).toBeUndefined();
    expect(app.activity.find((a: any) => a.$['android:name'] === '.MainActivity').$['android:exported']).toBe('true');
  });

  it('is idempotent', () => {
    const once = plugin.applyHardening(base());
    const twice = plugin.applyHardening(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});
