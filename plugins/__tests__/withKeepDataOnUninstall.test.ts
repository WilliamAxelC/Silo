import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyKeepData } = require('../withKeepDataOnUninstall');

describe('withKeepDataOnUninstall', () => {
  it('asks Android to offer "Keep app data" when Silo is uninstalled', () => {
    const manifest = { manifest: { application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'false' } }] } };
    const out = applyKeepData(manifest);
    expect(out.manifest.application[0].$['android:hasFragileUserData']).toBe('true');
    expect(out.manifest.application[0].$['android:allowBackup']).toBe('false');
  });

  it('is listed in app.json', () => {
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../../app.json'), 'utf8'));
    expect(app.expo.plugins).toContain('./plugins/withKeepDataOnUninstall');
  });
});
