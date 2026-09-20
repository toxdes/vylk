(function (root) {
  'use strict';

  const defaults = {
    revision: 1,
    autoSave: true,
    startView: 'split',
    hideToolbar: false,
    hideSaveButton: false,
    saveButtonLocation: 'panel',
    collapseDetails: false,
    hideCursorHighlight: false,
    interactivePreview: false,
    statusDisplay: 'normal',
    contentWidth: 'standard',
    zenPageWidth: 'standard',
    theme: 'default-light',
    accentColor: '',
    fontFamily: 'system-sans',
    fontFamilyGoogle: false,
    fontSize: '1rem',
    editorFontFamily: 'system-monospace',
    editorFontFamilyGoogle: false,
    editorFontSize: '1rem',
    previewFontFamily: 'system-sans',
    previewFontFamilyGoogle: false,
    previewFontSize: '1rem',
    zenFontFamily: 'system-monospace',
    zenFontFamilyGoogle: false,
    zenFontSize: '1rem',
    zenWordCount: false,
    zenShowTitle: true,
    zenShowControls: true,
    zenInteractivePreview: false,
    shortcutPrefix: {steps: [{key: '/', modifiers: ['Mod']}]},
    keyboardShortcuts: {},
    shortcutConfirmationSkips: {},
  };
  const contentWidths = ['compact', 'standard', 'wide', 'full'];
  const fontSizeOptions = [
    {value: '0.8rem', label: 'Small (80%)'},
    {value: '0.9rem', label: 'Smaller (90%)'},
    {value: '1rem', label: 'Default (100%)'},
    {value: '1.1rem', label: 'Large (110%)'},
    {value: '1.25rem', label: 'Larger (125%)'},
    {value: '1.5rem', label: 'Extra large (150%)'},
  ];
  const fontSizes = fontSizeOptions.map((option) => option.value);

  function validAccentColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '';
  }

  function validFontValue(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    return (
      Boolean(normalized) &&
      normalized.length <= 120 &&
      !/[\u0000-\u001f\u007f"\\;,]/.test(normalized)
    );
  }

  function normalizeFontValue(value, key) {
    if (value === 'system')
      return ['editorFontFamily', 'zenFontFamily'].includes(key)
        ? 'system-monospace'
        : 'system-sans';
    return validFontValue(value) ? value.trim() : defaults[key];
  }

  function normalizeFontSizeValue(value, key) {
    return typeof value === 'string' && fontSizes.includes(value.trim())
      ? value.trim()
      : defaults[key];
  }

  function legacyThemeID() {
    const saved = root.localStorage.getItem('theme');
    if (saved === 'dark') return 'default-dark';
    if (saved === 'light') return 'default-light';
    return root.matchMedia('(prefers-color-scheme:dark)').matches
      ? 'default-dark'
      : 'default-light';
  }

  function normalizeShortcutOverrides(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value)
      .slice(0, 64)
      .flatMap(([id, binding]) => {
        if (!/^[a-z][a-z0-9.-]{0,63}$/.test(id)) return [];
        if (binding === null) return [[id, null]];
        const normalized = root.VylkShortcuts?.normalizeBinding(binding);
        return normalized ? [[id, normalized]] : [];
      });
    return Object.fromEntries(entries);
  }

  function normalizeShortcutPrefix(value) {
    const binding = root.VylkShortcuts?.normalizeBinding(value);
    if (!root.VylkShortcuts?.isAllowedPrefix(binding)) return defaults.shortcutPrefix;
    return binding;
  }

  function normalizeShortcutConfirmationSkips(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .filter(([id, skip]) => /^[a-z][a-z0-9.-]{0,63}$/.test(id) && skip === true),
    );
  }

  function normalize(value = {}, fallback = {}) {
    const merged = {...defaults, ...fallback, ...value};
    merged.revision =
      Number.isSafeInteger(Number(merged.revision)) && Number(merged.revision) > 0
        ? Number(merged.revision)
        : 1;
    if (!['normal', 'compact', 'off'].includes(merged.statusDisplay))
      merged.statusDisplay = defaults.statusDisplay;
    if (!contentWidths.includes(merged.contentWidth)) merged.contentWidth = defaults.contentWidth;
    if (!contentWidths.includes(merged.zenPageWidth)) merged.zenPageWidth = defaults.zenPageWidth;
    const savedStartView = value.startView ?? fallback.startView;
    if (['editor', 'preview', 'split', 'zen'].includes(savedStartView))
      merged.startView = savedStartView;
    else
      merged.startView =
        (value.hidePreview ?? fallback.hidePreview) ? 'editor' : defaults.startView;
    if (!['panel', 'header'].includes(merged.saveButtonLocation))
      merged.saveButtonLocation = defaults.saveButtonLocation;
    const themes = new Set((root.VylkThemes || []).map((theme) => theme.id));
    if (!value.theme && !fallback.theme) merged.theme = legacyThemeID();
    if (!themes.has(merged.theme)) merged.theme = legacyThemeID();
    merged.accentColor = validAccentColor(merged.accentColor);
    ['fontFamily', 'editorFontFamily', 'previewFontFamily', 'zenFontFamily'].forEach((key) => {
      merged[key] = normalizeFontValue(merged[key], key);
    });
    ['fontSize', 'editorFontSize', 'previewFontSize', 'zenFontSize'].forEach((key) => {
      merged[key] = normalizeFontSizeValue(merged[key], key);
    });
    merged.shortcutPrefix = normalizeShortcutPrefix(merged.shortcutPrefix);
    merged.keyboardShortcuts = normalizeShortcutOverrides(merged.keyboardShortcuts);
    merged.shortcutConfirmationSkips = normalizeShortcutConfirmationSkips(
      merged.shortcutConfirmationSkips,
    );
    merged.zenWordCount = Boolean(merged.zenWordCount);
    merged.zenShowTitle = Boolean(merged.zenShowTitle);
    merged.zenShowControls = Boolean(merged.zenShowControls);
    merged.zenInteractivePreview = Boolean(merged.zenInteractivePreview);
    delete merged.hidePreview;
    delete merged.hideHeaderOnFullscreen;
    return merged;
  }

  function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function mergeNestedPatch(current, base, desired) {
    if (
      !current ||
      typeof current !== 'object' ||
      !base ||
      typeof base !== 'object' ||
      !desired ||
      typeof desired !== 'object'
    )
      return null;
    const merged = {...current};
    let conflict = false;
    let changed = false;
    new Set([...Object.keys(base), ...Object.keys(desired)]).forEach((key) => {
      const currentValue = Object.hasOwn(current, key) ? current[key] : undefined;
      const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
      const desiredValue = Object.hasOwn(desired, key) ? desired[key] : undefined;
      if (valuesEqual(baseValue, desiredValue)) return;
      if (!valuesEqual(currentValue, baseValue) && !valuesEqual(currentValue, desiredValue)) {
        conflict = true;
        return;
      }
      changed = true;
      if (desiredValue === undefined) delete merged[key];
      else merged[key] = desiredValue;
    });
    return {value: merged, conflict, changed};
  }

  root.VylkPreferences = {
    defaults,
    fontSizeOptions,
    mergeNestedPatch,
    normalize,
    validFontValue,
    valuesEqual,
  };
})(typeof window !== 'undefined' ? window : globalThis);
