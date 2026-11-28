// Configures Android native theme polish through Expo prebuild:
// 1. Sets android:enforceNavigationBarContrast=false on AppTheme so Dark Mode does not paint a stark
//    white contrast scrim over the 3-button navigation bar under edge-to-edge mode (F-22).
// 2. Sets colorAccent / colorControlActivated / colorPrimary to Silo's blue brand palette so native
//    DatePicker dialogs and Material controls match Silo instead of AppCompat's default #00796B teal (F-30).
// 3. Replaces React Native's Theme.FullScreenDialog (used by every Modal) with the same items plus a
//    transparent nav bar and no contrast scrim, so popups don't show a light bar in Dark Mode either.
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require('expo/config-plugins');

const LIGHT_ACCENT = '#0EA5E9';
const DARK_ACCENT = '#38BDF8';

function upsertStyleItem(items, name, value, extraAttrs) {
  const next = Array.isArray(items) ? [...items] : [];
  const idx = next.findIndex((item) => item?.$?.name === name);
  const entry = {
    $: { name, ...(extraAttrs || {}) },
    _: value,
  };
  if (idx >= 0) {
    next[idx] = {
      ...next[idx],
      $: { ...(next[idx].$ || {}), ...(extraAttrs || {}), name },
      _: value,
    };
  } else {
    next.push(entry);
  }
  return next;
}

function applyAndroidStyles(stylesXml) {
  const resources = stylesXml.resources || {};
  const styleList = Array.isArray(resources.style) ? resources.style : [];
  const appTheme = styleList.find((style) => style?.$?.name === 'AppTheme');
  if (appTheme) {
    appTheme.item = upsertStyleItem(appTheme.item, 'android:enforceNavigationBarContrast', 'false', {
      'tools:targetApi': '29',
    });
    appTheme.item = upsertStyleItem(appTheme.item, 'colorAccent', '@color/colorAccent');
    appTheme.item = upsertStyleItem(appTheme.item, 'colorControlActivated', '@color/colorAccent');
  }
  const dialogItems = [
    ['android:windowNoTitle', 'true'],
    ['android:windowIsFloating', 'false'],
    ['android:windowBackground', '@android:color/transparent'],
    ['android:windowDrawsSystemBarBackgrounds', 'true'],
    ['android:statusBarColor', '@android:color/transparent'],
    ['android:navigationBarColor', '@android:color/transparent'],
  ];
  let dialog = styleList.find((style) => style?.$?.name === 'Theme.FullScreenDialog');
  if (!dialog) {
    dialog = { $: { name: 'Theme.FullScreenDialog' }, item: [] };
    styleList.push(dialog);
  }
  for (const [name, value] of dialogItems) dialog.item = upsertStyleItem(dialog.item, name, value);
  dialog.item = upsertStyleItem(dialog.item, 'android:enforceNavigationBarContrast', 'false', {
    'tools:targetApi': '29',
  });
  resources.style = styleList;
  stylesXml.resources = resources;
  return stylesXml;
}

function applyLightColors(colorsXml) {
  let next = AndroidConfig.Colors.assignColorValue(colorsXml, {
    name: 'colorAccent',
    value: LIGHT_ACCENT,
  });
  next = AndroidConfig.Colors.assignColorValue(next, {
    name: 'colorPrimary',
    value: LIGHT_ACCENT,
  });
  return next;
}

function applyNightColors(colorsXml) {
  return AndroidConfig.Colors.assignColorValue(colorsXml, {
    name: 'colorAccent',
    value: DARK_ACCENT,
  });
}

function withAndroidThemePolish(config) {
  config = withAndroidStyles(config, (cfg) => {
    cfg.modResults = applyAndroidStyles(cfg.modResults);
    return cfg;
  });

  config = withAndroidColors(config, (cfg) => {
    cfg.modResults = applyLightColors(cfg.modResults);
    return cfg;
  });

  config = withAndroidColorsNight(config, (cfg) => {
    cfg.modResults = applyNightColors(cfg.modResults);
    return cfg;
  });

  return config;
}

withAndroidThemePolish.LIGHT_ACCENT = LIGHT_ACCENT;
withAndroidThemePolish.DARK_ACCENT = DARK_ACCENT;
withAndroidThemePolish.applyAndroidStyles = applyAndroidStyles;
withAndroidThemePolish.applyLightColors = applyLightColors;
withAndroidThemePolish.applyNightColors = applyNightColors;

module.exports = withAndroidThemePolish;
