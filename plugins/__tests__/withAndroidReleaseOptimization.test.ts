const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('../withAndroidReleaseOptimization');

describe('withAndroidReleaseOptimization Expo config plugin', () => {
  it('enables R8 minify, shrinkResources, and updates existing useLegacyPackaging without duplicates', () => {
    const initialProps = [
      { type: 'property', key: 'hermesEnabled', value: 'true' },
      { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' },
    ];

    const updated = plugin.applyGradleProperties(initialProps);
    const byKey = (k: string) => updated.filter((p: any) => p.type === 'property' && p.key === k);

    expect(byKey('android.enableMinifyInReleaseBuilds')).toEqual([
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' },
    ]);
    expect(byKey('android.enableShrinkResourcesInReleaseBuilds')).toEqual([
      { type: 'property', key: 'android.enableShrinkResourcesInReleaseBuilds', value: 'true' },
    ]);
    expect(byKey('expo.useLegacyPackaging')).toEqual([
      { type: 'property', key: 'expo.useLegacyPackaging', value: 'true' },
    ]);

    // Idempotent on second pass
    const twice = plugin.applyGradleProperties(updated);
    expect(twice).toEqual(updated);
  });

  it('excludes only unusable/unreachable arm64-v8a llama.rn variants and keeps mandatory base, v8, dotprod, dotprod_i8mm, and x86_64 libs', () => {
    const gradle = plugin.applyAppBuildGradle('android {}\n');
    expect(gradle).toContain(plugin.GRADLE_MARKER);
    expect(gradle).toContain("tasks.matching { it.name == 'syncRNLlamaHtpAssets' }.configureEach");

    // Excluded variants
    expect(gradle).toContain('**/arm64-v8a/librnllama_v8_2_dotprod_i8mm_hexagon_opencl.so');
    expect(gradle).toContain('**/arm64-v8a/librnllama_jni_v8_2_dotprod_i8mm_hexagon_opencl.so');
    expect(gradle).toContain('**/arm64-v8a/librnllama_v8_2_i8mm.so');
    expect(gradle).toContain('**/arm64-v8a/librnllama_jni_v8_2_i8mm.so');
    expect(gradle).toContain('**/arm64-v8a/librnllama_v8_2.so');
    expect(gradle).toContain('**/arm64-v8a/librnllama_jni_v8_2.so');
    expect(gradle).toContain('**/arm64-v8a/librnllama_jni.so');

    // Kept libraries MUST NOT appear in excludes
    const mustKeep = [
      'librnllama.so',
      'librnllama_v8.so',
      'librnllama_jni_v8.so',
      'librnllama_v8_2_dotprod.so',
      'librnllama_jni_v8_2_dotprod.so',
      'librnllama_v8_2_dotprod_i8mm.so',
      'librnllama_jni_v8_2_dotprod_i8mm.so',
      'x86_64',
    ];
    for (const lib of mustKeep) {
      expect(plugin.EXCLUDED_ARM64_LLAMA_LIBS.some((entry: string) => entry.endsWith(`/${lib}`) || entry.includes('x86_64'))).toBe(false);
    }

    // Idempotent on second pass
    expect(plugin.applyAppBuildGradle(gradle)).toBe(gradle);
  });

  it('adds llama.rn, expo-notifications keep rules and all 8 ML Kit -dontwarn rules idempotently to proguard-rules.pro', () => {
    const initial = '# default proguard\n';
    const updated = plugin.applyProguardRules(initial);

    expect(updated).toContain('-keep class com.rnllama.** { *; }');
    expect(updated).toContain('-keep class expo.modules.notifications.** { *; }');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions$Builder');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions$Builder');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions$Builder');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions');
    expect(updated).toContain('-dontwarn com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions$Builder');

    // Idempotent on second pass
    expect(plugin.applyProguardRules(updated)).toBe(updated);
  });

  it('upgrades an existing managed proguard block that predates the expo-notifications keep rule (R4-04)', () => {
    const legacyProguard = [
      '# default proguard',
      '',
      plugin.PROGUARD_MARKER,
      '-keep class com.rnllama.** { *; }',
      '',
    ].join('\n');

    const upgraded = plugin.applyProguardRules(legacyProguard);
    expect(upgraded).toContain('-keep class com.rnllama.** { *; }');
    expect(upgraded).toContain('-keep class expo.modules.notifications.** { *; }');
    expect(upgraded.split(plugin.PROGUARD_MARKER)).toHaveLength(2);
    expect(plugin.applyProguardRules(upgraded)).toBe(upgraded);
  });

  it('covers every dependency proguard-rules.pro that is not wired via consumerProguardFiles (R4-04)', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const packagesToAudit = Array.from(new Set([...Object.keys(pkg.dependencies || {}), 'expo-modules-core']));
    const generated = plugin.applyProguardRules('');
    const normalize = (rule: string) => rule.replace(/\s+/g, '');
    const normalizedGenerated = normalize(generated);

    const unwiredPackages: string[] = [];
    for (const dep of packagesToAudit) {
      const androidDir = path.join(projectRoot, 'node_modules', dep, 'android');
      const proguardFile = path.join(androidDir, 'proguard-rules.pro');
      if (!fs.existsSync(proguardFile)) continue;

      const gradleFile = ['build.gradle', 'build.gradle.kts']
        .map((name) => path.join(androidDir, name))
        .find((candidate) => fs.existsSync(candidate));
      const gradleContents = gradleFile ? fs.readFileSync(gradleFile, 'utf8') : '';
      if (/consumerProguardFiles/.test(gradleContents)) continue;

      unwiredPackages.push(dep);
      const ruleLines = fs
        .readFileSync(proguardFile, 'utf8')
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !line.startsWith('#'));

      for (const ruleLine of ruleLines) {
        expect(normalizedGenerated).toContain(normalize(ruleLine));
      }
    }

    expect(unwiredPackages).toContain('expo-notifications');
  });

  it('writes proguard-rules.pro through the Expo dangerous mod during plugin execution (R4-04)', async () => {
    const tmpAndroidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-r8-plugin-'));
    try {
      const config = plugin({ name: 'Silo', slug: 'silo-app' });
      const dangerousAction = config.mods?.android?.dangerous;
      expect(typeof dangerousAction).toBe('function');

      await dangerousAction({
        modRequest: { platformProjectRoot: tmpAndroidRoot },
      });

      const written = fs.readFileSync(path.join(tmpAndroidRoot, 'app', 'proguard-rules.pro'), 'utf8');
      expect(written).toContain('-keep class com.rnllama.** { *; }');
      expect(written).toContain('-keep class expo.modules.notifications.** { *; }');
    } finally {
      fs.rmSync(tmpAndroidRoot, { recursive: true, force: true });
    }
  });
});
