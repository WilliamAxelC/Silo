const { applyReleaseSigning } = require('../withReleaseSigning');

const TEMPLATE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}`;

// Security (2026-11-23): release APKs were signed with the public React Native debug key, so anyone could
// sign an APK that Android accepts as a Silo update.
describe('withReleaseSigning', () => {
  it('regression: release builds use the private key from SILO_RELEASE_SIGNING, debug builds stay on debug', () => {
    const out = applyReleaseSigning(TEMPLATE);
    expect(out).toContain("System.getenv('SILO_RELEASE_SIGNING')");
    expect(out).toMatch(/release \{\s*\/\/ |release \{\s*def siloSigning/);
    const releaseType = out.slice(out.indexOf('buildTypes'));
    expect(releaseType).toMatch(/release \{\s*signingConfig \(System\.getenv\('SILO_RELEASE_SIGNING'\)[^\n]*\? signingConfigs\.release : signingConfigs\.debug/);
    expect(releaseType).toMatch(/debug \{\s*signingConfig signingConfigs\.debug/);
    expect(out).not.toMatch(/storePassword '(?!android')/); // no secrets written into the file
  });

  it('is idempotent', () => {
    const once = applyReleaseSigning(TEMPLATE);
    expect(applyReleaseSigning(once)).toBe(once);
  });
});
