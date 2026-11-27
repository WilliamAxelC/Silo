const plugin = require('../withAndroidComponentHardening');

describe('withAndroidComponentHardening (security review 2026-11-28)', () => {
  const base = () => ({
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{ $: { 'android:name': '.MainApplication' }, activity: [{ $: { 'android:name': '.MainActivity', 'android:exported': 'true' } }] }],
    },
  });

  it('regression: the cropper activity and clipboard provider are not exported, and MainActivity is untouched', () => {
    const out = plugin.applyHardening(base());
    const app = out.manifest.application[0];
    expect(out.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    const cropper = app.activity.find((a: any) => a.$['android:name'] === 'com.canhub.cropper.CropImageActivity');
    expect(cropper.$).toMatchObject({ 'android:exported': 'false', 'tools:replace': 'android:exported' });
    const clip = app.provider.find((p: any) => p.$['android:name'] === 'expo.modules.clipboard.ClipboardFileProvider');
    expect(clip.$).toMatchObject({
      'android:exported': 'false',
      'tools:replace': 'android:exported',
      'android:authorities': '${applicationId}.ClipboardFileProvider',
    });
    expect(app.activity.find((a: any) => a.$['android:name'] === '.MainActivity').$['android:exported']).toBe('true');
  });

  it('is idempotent', () => {
    const once = plugin.applyHardening(base());
    const twice = plugin.applyHardening(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});
