// Configures Android release size optimizations through Expo prebuild (instead of hand-editing android/):
// 1. Enables R8 minification, resource shrinking, and compressed native libraries (useLegacyPackaging).
// 2. Adds R8 keep rules for llama.rn JNI entry points and -dontwarn rules for non-Latin ML Kit scripts
//    excluded by plugins/withMlKitLatinOnly.js.
// 3. Excludes unused/unreachable arm64-v8a llama.rn native variants and Hexagon HTP DSP assets while keeping:
//    - librnllama.so (mandatory: RNLlama.java:260 unconditionally calls System.loadLibrary("rnllama"))
//    - librnllama_v8.so + librnllama_jni_v8.so (universal arm64 fallback)
//    - librnllama_v8_2_dotprod.so + librnllama_jni_v8_2_dotprod.so (mid-range phones with dotprod, no i8mm)
//    - librnllama_v8_2_dotprod_i8mm.so + librnllama_jni_v8_2_dotprod_i8mm.so (modern phones with dotprod + i8mm)
const fs = require('fs');
const path = require('path');
const {
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
} = require('expo/config-plugins');

const GRADLE_MARKER = '// silo: android-release-optimization';
const PROGUARD_MARKER = '# silo: android-release-optimization';
const PROGUARD_END_MARKER = '# silo: end android-release-optimization';

const GRADLE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  'expo.useLegacyPackaging': 'true',
};

// Scoped to arm64-v8a so x86_64 emulator builds keep librnllama_x86_64 / librnllama_jni_x86_64 / librnllama_jni intact.
const EXCLUDED_ARM64_LLAMA_LIBS = [
  // Hexagon / OpenCL GPU offload variant: GPU offload is not enabled on Android in Silo;
  // RNLlama.loadNative cleanly falls through via tryLoadLibrary to rnllama_jni_v8_2_dotprod_i8mm.
  '**/arm64-v8a/librnllama_v8_2_dotprod_i8mm_hexagon_opencl.so',
  '**/arm64-v8a/librnllama_jni_v8_2_dotprod_i8mm_hexagon_opencl.so',
  // Unreachable on real ARM64 Android CPUs: FEAT_DotProd is mandatory from ARMv8.4-A and present on
  // every core with FEAT_I8MM (ARMv8.6-A), so hasDotProd && hasI8mm always matches first (RNLlama.java:208).
  '**/arm64-v8a/librnllama_v8_2_i8mm.so',
  '**/arm64-v8a/librnllama_jni_v8_2_i8mm.so',
  // llama.rn stripped +fp16 from v8_2 (CMakeLists.txt:149-152), leaving plain -march=armv8.2-a with no
  // SIMD gain over v8; pre-dotprod ARMv8.2 devices cleanly fall through to rnllama_jni_v8.
  '**/arm64-v8a/librnllama_v8_2.so',
  '**/arm64-v8a/librnllama_jni_v8_2.so',
  // Kept on purpose: librnllama.so (base library, RNLlama.java:260 loads it unconditionally) and
  // librnllama_jni.so (the generic fallback RNLlama.java:256 loads if rnllama_jni_v8 ever fails; small,
  // and without it that path would crash at startup).
];

const APP_BUILD_GRADLE_BLOCK = `
${GRADLE_MARKER}
android {
    packagingOptions {
        jniLibs {
            excludes += [
${EXCLUDED_ARM64_LLAMA_LIBS.map((p) => `                '${p}',`).join('\n')}
            ]
        }
    }
}
tasks.matching { it.name == 'syncRNLlamaHtpAssets' }.configureEach {
    enabled = false
}
`;

const PROGUARD_RULES_BLOCK = `
${PROGUARD_MARKER}
# Preserve llama.rn JNI methods and loader class under R8
-keep class com.rnllama.** { *; }

# Preserve expo-notifications Serializable models/triggers (NotificationRequest, DailyTrigger, etc.);
# expo-notifications/android/proguard-rules.pro is not wired as consumerProguardFiles in its build.gradle.
-keep class expo.modules.notifications.** { *; }

# Suppress R8 missing-class errors for non-Latin ML Kit recognizers excluded by plugins/withMlKitLatinOnly.js
-dontwarn com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions$Builder
-dontwarn com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions$Builder
-dontwarn com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions$Builder
-dontwarn com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions$Builder
${PROGUARD_END_MARKER}
`;

function applyGradleProperties(properties) {
  const next = Array.isArray(properties) ? [...properties] : [];
  for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
    const idx = next.findIndex((item) => item.type === 'property' && item.key === key);
    if (idx >= 0) {
      next[idx] = { ...next[idx], value };
    } else {
      next.push({ type: 'property', key, value });
    }
  }
  return next;
}

function applyAppBuildGradle(contents) {
  if (contents.includes(GRADLE_MARKER)) {
    return contents;
  }
  return contents + APP_BUILD_GRADLE_BLOCK;
}

function applyProguardRules(contents) {
  const startIdx = contents.indexOf(PROGUARD_MARKER);
  if (startIdx >= 0) {
    const endIdx = contents.indexOf(PROGUARD_END_MARKER, startIdx);
    const prefix = contents.slice(0, startIdx).replace(/\n+$/, '');
    const suffix = endIdx >= 0 ? contents.slice(endIdx + PROGUARD_END_MARKER.length).replace(/^\n+/, '') : '';
    const base = prefix.length > 0 ? `${prefix}\n` : '';
    return base + PROGUARD_RULES_BLOCK + (suffix.length > 0 ? `\n${suffix}` : '');
  }
  const trimmed = contents.endsWith('\n') || contents.length === 0 ? contents : `${contents}\n`;
  return trimmed + PROGUARD_RULES_BLOCK;
}

function withAndroidReleaseOptimization(config) {
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = applyGradleProperties(cfg.modResults);
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyAppBuildGradle(cfg.modResults.contents);
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const proguardPath = path.join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
      const existing = fs.existsSync(proguardPath) ? fs.readFileSync(proguardPath, 'utf8') : '';
      const updated = applyProguardRules(existing);
      if (updated !== existing) {
        fs.mkdirSync(path.dirname(proguardPath), { recursive: true });
        fs.writeFileSync(proguardPath, updated, 'utf8');
      }
      return cfg;
    },
  ]);

  return config;
}

withAndroidReleaseOptimization.GRADLE_MARKER = GRADLE_MARKER;
withAndroidReleaseOptimization.PROGUARD_MARKER = PROGUARD_MARKER;
withAndroidReleaseOptimization.PROGUARD_END_MARKER = PROGUARD_END_MARKER;
withAndroidReleaseOptimization.GRADLE_PROPERTIES = GRADLE_PROPERTIES;
withAndroidReleaseOptimization.EXCLUDED_ARM64_LLAMA_LIBS = EXCLUDED_ARM64_LLAMA_LIBS;
withAndroidReleaseOptimization.applyGradleProperties = applyGradleProperties;
withAndroidReleaseOptimization.applyAppBuildGradle = applyAppBuildGradle;
withAndroidReleaseOptimization.applyProguardRules = applyProguardRules;

module.exports = withAndroidReleaseOptimization;
