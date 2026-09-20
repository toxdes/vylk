(function (root) {
  'use strict';

  const FONT_CACHE_NAME = 'vylk-fonts';
  const SYSTEM_FONT_STACK =
    'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const SYSTEM_SERIF_STACK = 'ui-serif,Georgia,Cambria,"Times New Roman",Times,serif';
  const SYSTEM_MONO_STACK =
    'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';
  const fontSlots = [
    {
      preference: 'fontFamily',
      fetchPreference: 'fontFamilyGoogle',
      sizePreference: 'fontSize',
      variable: '--font',
      sizeVariable: '--font-size',
      input: '#pref-font',
      sizeInput: '#pref-font-size',
      fetch: '#pref-font-google',
      error: '#pref-font-error',
      fallback: SYSTEM_FONT_STACK,
    },
    {
      preference: 'editorFontFamily',
      fetchPreference: 'editorFontFamilyGoogle',
      sizePreference: 'editorFontSize',
      variable: '--editor-font',
      sizeVariable: '--editor-font-size',
      input: '#pref-editor-font',
      sizeInput: '#pref-editor-font-size',
      fetch: '#pref-editor-font-google',
      error: '#pref-editor-font-error',
      fallback: SYSTEM_MONO_STACK,
    },
    {
      preference: 'previewFontFamily',
      fetchPreference: 'previewFontFamilyGoogle',
      sizePreference: 'previewFontSize',
      variable: '--preview-font',
      sizeVariable: '--preview-font-size',
      input: '#pref-preview-font',
      sizeInput: '#pref-preview-font-size',
      fetch: '#pref-preview-font-google',
      error: '#pref-preview-font-error',
      fallback: SYSTEM_FONT_STACK,
    },
    {
      preference: 'zenFontFamily',
      fetchPreference: 'zenFontFamilyGoogle',
      sizePreference: 'zenFontSize',
      variable: '--zen-font',
      sizeVariable: '--zen-font-size',
      input: '#pref-zen-font',
      sizeInput: '#pref-zen-font-size',
      fetch: '#pref-zen-font-google',
      error: '#pref-zen-font-error',
      fallback: SYSTEM_MONO_STACK,
    },
  ];

  function create({
    document,
    escapeHTML,
    fontSizeOptions,
    getPrefs,
    onLayoutChange,
    themes,
    validFont,
  }) {
    const select = (selector) => document.querySelector(selector);
    const themeByID = new Map(themes.map((theme) => [theme.id, theme]));
    let fontApplyQueue = Promise.resolve();

    function kebabCase(value) {
      return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    }

    function applyTheme(themeID = getPrefs().theme) {
      const prefs = getPrefs();
      const theme = themeByID.get(themeID) || themeByID.get('default-light');
      const documentRoot = document.documentElement;
      documentRoot.dataset.theme = theme.id;
      documentRoot.classList.toggle('dark', Boolean(theme.dark));
      Object.entries(theme.vars).forEach(([name, value]) =>
        documentRoot.style.setProperty(`--${kebabCase(name)}`, value),
      );
      if (prefs.accentColor) {
        documentRoot.style.setProperty('--accent', prefs.accentColor);
        documentRoot.style.setProperty(
          '--accent-hover',
          'color-mix(in srgb,var(--accent) 82%,#000)',
        );
      }
      select('meta[name="theme-color"]')?.setAttribute('content', theme.vars.bg);
    }

    function fontCSSURL(fontFamily) {
      const family = encodeURIComponent(fontFamily).replace(/%20/g, '+');
      return `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
    }

    function isSystemFont(fontFamily) {
      return ['system-sans', 'system-serif', 'system-monospace'].includes(fontFamily);
    }

    function fontCSSValue(fontFamily, fallback) {
      if (fontFamily === 'system-serif') return SYSTEM_SERIF_STACK;
      if (fontFamily === 'system-monospace') return SYSTEM_MONO_STACK;
      if (fontFamily === 'system-sans') return SYSTEM_FONT_STACK;
      return `"${fontFamily}",${fallback}`;
    }

    function setFontError(slot, message = '') {
      const error = select(slot.error);
      if (!error) return;
      error.textContent = message;
      error.hidden = !message;
      const input = select(slot.input);
      if (input) {
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
    }

    function removeLoadedFonts() {
      const prefs = getPrefs();
      document.querySelectorAll('[data-vylk-font]').forEach((link) => link.remove());
      fontSlots.forEach((slot) => {
        document.documentElement.style.setProperty(
          slot.variable,
          fontCSSValue(prefs[slot.preference], slot.fallback),
        );
        if (validFont(select(slot.input)?.value)) setFontError(slot);
      });
    }

    function waitForStylesheet(link, timeoutMs) {
      return new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timeout);
          link.removeEventListener('load', onLoad);
          link.removeEventListener('error', onError);
          if (error) reject(error);
          else resolve();
        };
        const onLoad = () => finish();
        const onError = () => finish(new Error('font stylesheet failed to load'));
        const timeout = setTimeout(() => finish(new Error('font load timed out')), timeoutMs);
        link.addEventListener('load', onLoad);
        link.addEventListener('error', onError);
      });
    }

    async function applyFontsNow(clearCache = false) {
      if (clearCache && 'caches' in root) await root.caches.delete(FONT_CACHE_NAME).catch(() => {});
      removeLoadedFonts();
      const prefs = getPrefs();
      const families = [
        ...new Set(
          fontSlots
            .filter((slot) => prefs[slot.fetchPreference] === true)
            .map((slot) => prefs[slot.preference])
            .filter((font) => font && !isSystemFont(font)),
        ),
      ];
      const loaded = new Set();
      const failed = new Set();
      await Promise.all(
        families.map(async (fontFamily) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.dataset.vylkFont = fontFamily;
          link.href = fontCSSURL(fontFamily);
          const stylesheet = waitForStylesheet(link, 5000);
          document.head.append(link);
          try {
            await stylesheet;
            const faces = await document.fonts.load(`1rem "${fontFamily}"`);
            if (!faces?.length) throw new Error('font face unavailable');
            loaded.add(fontFamily);
          } catch (error) {
            link.remove();
            failed.add(fontFamily);
            console.warn(`font unavailable: ${fontFamily}`, error);
          }
        }),
      );
      fontSlots.forEach((slot) => {
        const fontFamily = prefs[slot.preference];
        document.documentElement.style.setProperty(
          slot.variable,
          fontCSSValue(fontFamily, slot.fallback),
        );
        if (
          prefs[slot.fetchPreference] === true &&
          !isSystemFont(fontFamily) &&
          failed.has(fontFamily) &&
          !loaded.has(fontFamily)
        )
          setFontError(slot, 'Font not available from Google Fonts.');
      });
      onLayoutChange();
    }

    function applyFonts(clearCache = false) {
      const run = fontApplyQueue.then(() => applyFontsNow(clearCache));
      fontApplyQueue = run.catch(() => {});
      return run;
    }

    function applyFontSizes() {
      const prefs = getPrefs();
      fontSlots.forEach((slot) => {
        document.documentElement.style.setProperty(slot.sizeVariable, prefs[slot.sizePreference]);
      });
      onLayoutChange();
    }

    function renderOptions() {
      const prefs = getPrefs();
      select('#pref-theme').innerHTML = themes
        .map(
          (theme) => `<option value="${escapeHTML(theme.id)}">${escapeHTML(theme.name)}</option>`,
        )
        .join('');
      fontSlots.forEach((slot) => {
        const input = select(slot.input);
        if (input) input.value = prefs[slot.preference];
        const sizeSelect = select(slot.sizeInput);
        if (sizeSelect) {
          sizeSelect.innerHTML = fontSizeOptions
            .map((option) => `<option value="${option.value}">${option.label}</option>`)
            .join('');
          sizeSelect.value = prefs[slot.sizePreference];
        }
        const fetchToggle = select(slot.fetch);
        if (fetchToggle) fetchToggle.checked = Boolean(prefs[slot.fetchPreference]);
      });
    }

    function bindFontControls(savePreference) {
      fontSlots.forEach((slot) => {
        const input = select(slot.input);
        input.addEventListener('input', () => {
          if (!select(slot.error)?.hidden)
            setFontError(
              slot,
              validFont(input.value)
                ? ''
                : 'Enter a valid font name without quotes, backslashes, semicolons, or commas.',
            );
        });
        input.addEventListener('change', () => {
          if (!validFont(input.value)) {
            setFontError(
              slot,
              'Enter a valid font name without quotes, backslashes, semicolons, or commas.',
            );
            return;
          }
          input.value = input.value.trim();
          setFontError(slot);
          savePreference(slot.preference, input.value);
        });
        select(slot.fetch)?.addEventListener('change', (event) => {
          savePreference(slot.fetchPreference, event.currentTarget.checked);
        });
        select(slot.sizeInput).addEventListener('change', (event) => {
          savePreference(slot.sizePreference, event.currentTarget.value);
        });
      });
    }

    return {
      applyFontSizes,
      applyFonts,
      applyTheme,
      bindFontControls,
      renderOptions,
      themeAccent: (themeID) => themeByID.get(themeID)?.vars.accent,
      whenIdle: () => fontApplyQueue,
    };
  }

  root.VylkAppearance = {create};
})(typeof window !== 'undefined' ? window : globalThis);
