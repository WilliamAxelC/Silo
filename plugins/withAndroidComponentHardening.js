// Un-exports library components Silo never needs other apps to reach (security review 2026-11-28).
// - com.canhub.cropper.CropImageActivity (android-image-cropper, pulled in by expo-image-picker) ships
//   android:exported="true" with no permission, so any app on the phone could start it inside Silo's
//   process with its own source/output URIs. Silo never crops (no allowsEditing), and expo-image-picker
//   starts it with an explicit in-app intent, which still works when it is not exported.
// - expo.modules.clipboard.ClipboardFileProvider is exported so other apps can read images copied to the
//   clipboard. Silo only copies text.
const { withAndroidManifest } = require('expo/config-plugins');

const UNEXPORT = [
  { kind: 'activity', name: 'com.canhub.cropper.CropImageActivity' },
  {
    kind: 'provider',
    name: 'expo.modules.clipboard.ClipboardFileProvider',
    extra: { 'android:authorities': '${applicationId}.ClipboardFileProvider' },
  },
];

function applyHardening(manifest) {
  const root = manifest.manifest;
  root.$ = { ...(root.$ || {}), 'xmlns:tools': 'http://schemas.android.com/tools' };
  const app = (root.application && root.application[0]) || null;
  if (!app) return manifest;
  for (const { kind, name, extra } of UNEXPORT) {
    const list = Array.isArray(app[kind]) ? app[kind] : [];
    const existing = list.find((node) => node?.$?.['android:name'] === name);
    const attrs = {
      'android:name': name,
      ...(extra || {}),
      'android:exported': 'false',
      'tools:replace': 'android:exported',
    };
    if (existing) existing.$ = { ...existing.$, ...attrs };
    else list.push({ $: attrs });
    app[kind] = list;
  }
  return manifest;
}

const withAndroidComponentHardening = (config) =>
  withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyHardening(cfg.modResults);
    return cfg;
  });

module.exports = withAndroidComponentHardening;
module.exports.applyHardening = applyHardening;
module.exports.UNEXPORT = UNEXPORT;
