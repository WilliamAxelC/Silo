// @react-native-ml-kit/text-recognition bundles Chinese, Devanagari, Japanese and Korean recognizers next to
// Latin. Silo only reads Latin-script (Indonesian/English) receipts, so exclude the others (-2.4 MB arm64 APK).
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// silo: ml-kit latin only';
const BLOCK = `
${MARKER}
configurations.all {
    exclude group: 'com.google.mlkit', module: 'text-recognition-chinese'
    exclude group: 'com.google.mlkit', module: 'text-recognition-devanagari'
    exclude group: 'com.google.mlkit', module: 'text-recognition-japanese'
    exclude group: 'com.google.mlkit', module: 'text-recognition-korean'
}
`;

module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARKER)) {
      cfg.modResults.contents += BLOCK;
    }
    return cfg;
  });
