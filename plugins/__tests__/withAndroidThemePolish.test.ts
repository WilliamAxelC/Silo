const fs = require('fs');
const path = require('path');
const plugin = require('../withAndroidThemePolish');

describe('withAndroidThemePolish Expo config plugin (F-22, F-30)', () => {
  it('sets android:enforceNavigationBarContrast=false and Silo accent colors idempotently', () => {
    const stylesXml = {
      resources: {
        style: [
          {
            $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
            item: [{ $: { name: 'android:editTextBackground' }, _: '@drawable/rn_edit_text_material' }],
          },
        ],
      },
    };

    const updated = plugin.applyAndroidStyles(stylesXml);
    const items = updated.resources.style[0].item;
    const findItem = (name: string) => items.filter((item: any) => item?.$?.name === name);

    expect(findItem('android:enforceNavigationBarContrast')).toEqual([
      { $: { name: 'android:enforceNavigationBarContrast', 'tools:targetApi': '29' }, _: 'false' },
    ]);
    expect(findItem('colorAccent')).toEqual([{ $: { name: 'colorAccent' }, _: '@color/colorAccent' }]);
    expect(findItem('colorControlActivated')).toEqual([
      { $: { name: 'colorControlActivated' }, _: '@color/colorAccent' },
    ]);

    // Idempotent on second pass
    const twice = plugin.applyAndroidStyles(updated);
    expect(twice.resources.style[0].item).toEqual(items);
  });

  it('regression: popups get no light contrast bar over the nav bar in dark mode (React Native dialog theme)', () => {
    const stylesXml = { resources: { style: [{ $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' }, item: [] }] } };
    const updated = plugin.applyAndroidStyles(stylesXml);
    const dialogs = updated.resources.style.filter((s: any) => s?.$?.name === 'Theme.FullScreenDialog');
    expect(dialogs).toHaveLength(1);
    const value = (name: string) => dialogs[0].item.find((i: any) => i?.$?.name === name)?._;
    // React Native's own items are kept, since this replaces its style of the same name.
    expect(value('android:windowNoTitle')).toBe('true');
    expect(value('android:windowIsFloating')).toBe('false');
    expect(value('android:windowBackground')).toBe('@android:color/transparent');
    expect(value('android:windowDrawsSystemBarBackgrounds')).toBe('true');
    expect(value('android:statusBarColor')).toBe('@android:color/transparent');
    expect(value('android:navigationBarColor')).toBe('@android:color/transparent');
    expect(value('android:enforceNavigationBarContrast')).toBe('false');
    expect(plugin.applyAndroidStyles(updated).resources.style.filter((s: any) => s?.$?.name === 'Theme.FullScreenDialog')).toHaveLength(1);
  });

  it('assigns Silo light and dark accent hex values without duplicating entries', () => {
    const emptyColors = { resources: { color: [] } };
    const light = plugin.applyLightColors(emptyColors);
    expect(light.resources.color).toEqual(
      expect.arrayContaining([
        { $: { name: 'colorAccent' }, _: plugin.LIGHT_ACCENT },
        { $: { name: 'colorPrimary' }, _: plugin.LIGHT_ACCENT },
      ])
    );
    expect(plugin.applyLightColors(light)).toEqual(light);

    const dark = plugin.applyNightColors({ resources: { color: [] } });
    expect(dark.resources.color).toEqual(
      expect.arrayContaining([{ $: { name: 'colorAccent' }, _: plugin.DARK_ACCENT }])
    );
    expect(plugin.applyNightColors(dark)).toEqual(dark);
  });

  it('wires Android styles, light colors, and night colors mods and stays synchronized with local Android resources when present', async () => {
    const config = plugin({ name: 'Silo', slug: 'silo-app' });
    expect(typeof config.mods?.android?.styles).toBe('function');
    expect(typeof config.mods?.android?.colors).toBe('function');
    expect(typeof config.mods?.android?.colorsNight).toBe('function');

    const projectRoot = path.resolve(__dirname, '../..');
    const stylesPath = path.join(projectRoot, 'android/app/src/main/res/values/styles.xml');
    const lightColorsPath = path.join(projectRoot, 'android/app/src/main/res/values/colors.xml');
    const nightColorsPath = path.join(projectRoot, 'android/app/src/main/res/values-night/colors.xml');

    if (fs.existsSync(stylesPath) && fs.existsSync(lightColorsPath) && fs.existsSync(nightColorsPath)) {
      const stylesContent = fs.readFileSync(stylesPath, 'utf8');
      const lightColorsContent = fs.readFileSync(lightColorsPath, 'utf8');
      const nightColorsContent = fs.readFileSync(nightColorsPath, 'utf8');

      expect(stylesContent).toContain('android:enforceNavigationBarContrast');
      expect(stylesContent).toContain('>false<');
      expect(stylesContent).toContain('name="colorAccent"');
      expect(stylesContent).toContain('name="colorControlActivated"');
      expect(lightColorsContent).toContain(plugin.LIGHT_ACCENT);
      expect(nightColorsContent).toContain(plugin.DARK_ACCENT);
    }
  });
});
