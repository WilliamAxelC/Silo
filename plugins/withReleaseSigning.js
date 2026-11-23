// Signs release builds with Silo's private release key when the build machine provides it.
//
// The key never lives in this repo. The build box exports SILO_RELEASE_SIGNING=/path/to/release.properties:
//   storeFile=/abs/path/silo-release.jks
//   storePassword=...
//   keyAlias=silo
//   keyPassword=...
// Without it (local/dev builds) release builds keep the debug key, so the APK cannot update a real install
// (different signature), which is what we want for throwaway builds.
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// silo: release-signing';

const SIGNING_CONFIG = `
        ${MARKER}
        release {
            def siloSigning = System.getenv('SILO_RELEASE_SIGNING')
            if (siloSigning && new File(siloSigning).isFile()) {
                def p = new Properties()
                new File(siloSigning).withInputStream { p.load(it) }
                storeFile file(p.getProperty('storeFile'))
                storePassword p.getProperty('storePassword')
                keyAlias p.getProperty('keyAlias')
                keyPassword p.getProperty('keyPassword')
            }
        }`;

function applyReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle;
  // 1. Add a `release` signing config after the debug one.
  const debugBlock = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/m;
  if (!debugBlock.test(gradle)) throw new Error('withReleaseSigning: signingConfigs.debug not found in app/build.gradle');
  let out = gradle.replace(debugBlock, `$1${SIGNING_CONFIG}`);
  // 2. Use it for release builds when the key was provided; otherwise stay on debug.
  const releaseType = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/m;
  if (!releaseType.test(out)) throw new Error('withReleaseSigning: buildTypes.release signingConfig not found');
  out = out.replace(
    releaseType,
    `$1signingConfig (System.getenv('SILO_RELEASE_SIGNING') && new File(System.getenv('SILO_RELEASE_SIGNING')).isFile()) ? signingConfigs.release : signingConfigs.debug`,
  );
  return out;
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
