import {describe, expect, test, vi} from 'vitest';
import {createApp} from './app-harness.js';
import {installAppLifecycle, styleSource} from './frontend-test-context.js';

const track = installAppLifecycle();

describe('keyboard shortcuts', () => {
  test('registers the curated commands with portable defaults', async () => {
    const app = track(await createApp());
    expect(app.hooks.shortcutCommands()).toEqual(
      expect.arrayContaining([
        'note.new',
        'note.save',
        'preferences.open',
        'editor.title',
        'editor.tags',
        'editor.focus',
        'view.write',
        'view.preview',
        'view.split',
        'view.zen',
        'view.switch',
        'format.bold',
        'format.italic',
      ]),
    );
    expect(app.hooks.shortcutCommands()).not.toContain('editor.details');
    expect(app.hooks.getShortcutBinding('note.save').steps).toEqual([
      {key: 's', modifiers: ['Mod']},
    ]);
    expect(app.hooks.getShortcutPrefix().steps).toEqual([{key: '/', modifiers: ['Mod']}]);
    expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([
      {key: '/', modifiers: ['Mod']},
      {key: 't', modifiers: []},
    ]);
    expect(app.hooks.getShortcutBinding('format.link')).toBeNull();
  });

  test('uses the configurable Mod+/ sequence to reveal Details and select the title', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Rename me', tags: 'work', content: 'body'});
    app.window.document.querySelector('.meta-pane').classList.add('collapsed');
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: '/',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: 't', bubbles: true, cancelable: true}),
    );
    const title = app.window.document.querySelector('#note-title');
    expect(app.window.document.querySelector('.meta-pane').classList.contains('collapsed')).toBe(
      false,
    );
    expect(app.window.document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(0);
    expect(title.selectionEnd).toBe(title.value.length);
  });

  test('starts global sequences from the dashboard', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#login-screen').classList.add('hidden');
    app.window.document.querySelector('#dashboard').classList.remove('hidden');
    app.window.document.querySelector('#editor').classList.add('hidden');
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: '/',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      app.window.document.querySelector('#shortcut-sequence-hint').classList.contains('hidden'),
    ).toBe(false);
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: 'p', bubbles: true, cancelable: true}),
    );
    expect(app.window.document.querySelector('#prefs-modal').classList.contains('hidden')).toBe(
      false,
    );
  });

  test('moves the view through the registry and exposes a shortcut recorder', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', tags: '', content: 'body'});
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: '/',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: '2', bubbles: true, cancelable: true}),
    );
    expect(
      app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden'),
    ).toBe(true);
    expect(
      app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden'),
    ).toBe(false);
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    expect(app.window.document.querySelectorAll('[data-shortcut-command]')).not.toHaveLength(0);
    expect(
      app.window.document.querySelector('[data-shortcut-command="editor.title"]').textContent,
    ).toBe('Prefix, T');
    expect(
      app.window.document.querySelector('[data-shortcut-command="format.link"]').textContent,
    ).toBe('Not set');
    const viewGroup = [...app.window.document.querySelectorAll('.shortcut-group')].find(
      (group) => group.querySelector('h3').textContent === 'View',
    );
    expect(
      [...viewGroup.querySelectorAll('.shortcut-copy strong')].map(
        (element) => element.textContent,
      ),
    ).toEqual([
      'Write view',
      'Preview view',
      'Split view',
      'Zen mode',
      'Switch editor and preview',
    ]);
  });

  test('uses Zen mode to leave only the editor, then returns on Escape', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', tags: '', content: 'one two'});
    app.hooks.setPanelState('zen');
    const editor = app.window.document.querySelector('#editor');
    expect(editor.classList.contains('zen-mode')).toBe(true);
    expect(editor.classList.contains('header-hidden')).toBe(true);
    expect(
      app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden'),
    ).toBe(true);
    expect(
      app.window.document.querySelector('[data-panel="zen"]').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(app.window.document.querySelectorAll('[data-zen-action]')).toHaveLength(3);
    expect(app.window.document.querySelector('#zen-note-title').textContent).toBe('Note');
    expect(app.window.document.querySelector('#zen-note-title').hidden).toBe(false);
    expect(
      app.window.document.querySelector('.zen-controls').classList.contains('is-minimal'),
    ).toBe(false);
    expect(app.window.document.querySelector('#zen-word-count').hidden).toBe(true);
    await app.hooks.savePref('zenWordCount', true);
    expect(app.window.document.querySelector('#zen-word-count').textContent).toBe('2 words');
    expect(app.window.document.querySelector('#zen-word-count').hidden).toBe(false);
    await app.hooks.savePref('zenShowTitle', false);
    expect(app.window.document.querySelector('#zen-note-title').hidden).toBe(true);
    await app.hooks.savePref('zenShowControls', false);
    expect(
      app.window.document.querySelector('.zen-controls').classList.contains('is-minimal'),
    ).toBe(true);
    expect(app.window.document.querySelector('[data-zen-action="exit"]').hidden).toBe(false);
    expect(app.window.document.querySelector('#zen-exit-icon').getAttribute('href')).toBe(
      '#icon-x',
    );
    app.window.document.querySelector('[data-zen-action="preview"]').click();
    expect(
      app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden'),
    ).toBe(false);
    expect(
      app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden'),
    ).toBe(true);
    expect(editor.classList.contains('zen-mode')).toBe(true);
    app.window.document.querySelector('[data-zen-action="editor"]').click();
    expect(
      app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden'),
    ).toBe(false);
    expect(
      app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden'),
    ).toBe(true);
    expect(editor.classList.contains('zen-mode')).toBe(true);
    app.hooks.setPanelState('both');
    app.hooks.setPanelState('zen');
    app.window.document.querySelector('[data-zen-action="exit"]').click();
    expect(editor.classList.contains('zen-mode')).toBe(false);
    app.hooks.setPanelState('zen');
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}),
    );
    expect(editor.classList.contains('zen-mode')).toBe(false);
    expect(editor.classList.contains('header-hidden')).toBe(false);
    expect(
      app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden'),
    ).toBe(false);
  });

  test('keeps Zen settings in their own preference tab', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-zen').click();

    expect(app.window.document.querySelector('#prefs-title').textContent.trim()).toBe('Zen mode');
    expect(app.window.document.querySelector('#prefs-panel-zen').hidden).toBe(false);
    expect(app.window.document.querySelector('#prefs-panel-editor').hidden).toBe(true);
    expect(app.window.document.querySelector('#pref-zen-interactive-preview')).toBeNull();
    expect(
      [...app.window.document.querySelectorAll('#pref-zen-page-width option')].map(
        (option) => option.value,
      ),
    ).toEqual(['compact', 'standard', 'wide', 'full']);
  });

  test('clears a shortcut from its recorder with Delete and keeps Escape as cancel', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    let titleShortcut = app.window.document.querySelector('[data-shortcut-command="editor.title"]');
    titleShortcut.click();
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}),
    );
    titleShortcut = app.window.document.querySelector('[data-shortcut-command="editor.title"]');
    expect(titleShortcut.textContent).toBe('Prefix, T');
    titleShortcut.click();
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: 'Delete', bubbles: true, cancelable: true}),
    );
    await vi.waitFor(() => expect(app.hooks.getShortcutBinding('editor.title')).toBeNull());
    await vi.waitFor(() =>
      expect(
        app.window.document.querySelector('[data-shortcut-command="editor.title"]').textContent,
      ).toBe('Not set'),
    );
    await new Promise((resolve) => app.window.setTimeout(resolve, 200));
  });

  test('records direct shortcuts or Prefix sequences for every command', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    const linkShortcut = app.window.document.querySelector('[data-shortcut-command="format.link"]');
    linkShortcut.click();
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(app.hooks.getShortcutBinding('format.link').steps).toEqual([
        {key: 'y', modifiers: ['Mod']},
      ]),
    );
    expect(
      app.window.document.querySelector('[data-shortcut-command="format.link"]').textContent,
    ).toBe('Ctrl + Y');

    let titleShortcut = app.window.document.querySelector('[data-shortcut-command="editor.title"]');
    titleShortcut.click();
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: '/',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      app.window.document.querySelector('[data-shortcut-command="editor.title"]').textContent,
    ).toBe('Prefix,');
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {key: 't', bubbles: true, cancelable: true}),
    );
    await vi.waitFor(() =>
      expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([
        {key: '/', modifiers: ['Mod']},
        {key: 't', modifiers: []},
      ]),
    );
    await new Promise((resolve) => app.window.setTimeout(resolve, 200));
  });

  test('updates every sequence command when the prefix changes', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    app.window.document.querySelector('#shortcut-prefix').click();
    app.window.document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', {
        key: 'e',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(app.hooks.getShortcutPrefix().steps).toEqual([{key: 'e', modifiers: ['Mod']}]),
    );
    expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([
      {key: 'e', modifiers: ['Mod']},
      {key: 't', modifiers: []},
    ]);
    app.window.document.querySelector('#shortcut-reset').click();
    await vi.waitFor(() =>
      expect(app.hooks.getShortcutPrefix().steps).toEqual([{key: '/', modifiers: ['Mod']}]),
    );
    expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([
      {key: '/', modifiers: ['Mod']},
      {key: 't', modifiers: []},
    ]);
    await new Promise((resolve) => app.window.setTimeout(resolve, 200));
  });
});

describe('font preferences', () => {
  test('uses font controls and leaves Google Fonts fetching disabled by default', async () => {
    const app = track(await createApp());

    expect(app.window.document.querySelector('#pref-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-editor-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-preview-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-zen-font').tagName).toBe('INPUT');
    for (const selector of [
      '#pref-font-size',
      '#pref-editor-font-size',
      '#pref-preview-font-size',
      '#pref-zen-font-size',
    ]) {
      const sizeSelect = app.window.document.querySelector(selector);
      expect(sizeSelect.tagName).toBe('SELECT');
      expect([...sizeSelect.options].map((option) => option.value)).toEqual([
        '0.8rem',
        '0.9rem',
        '1rem',
        '1.1rem',
        '1.25rem',
        '1.5rem',
      ]);
      expect(sizeSelect.value).toBe('1rem');
    }
    expect(app.window.document.querySelector('#pref-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-editor-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-preview-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-zen-font-google').checked).toBe(false);
    expect(
      app.window.document.querySelector('#pref-font-google').closest('.font-input-wrap'),
    ).not.toBeNull();
    expect(
      app.window.document.querySelector('#pref-editor-font-google').closest('.font-input-wrap'),
    ).not.toBeNull();
    expect(
      app.window.document.querySelector('#pref-preview-font-google').closest('.font-input-wrap'),
    ).not.toBeNull();
    expect(
      app.window.document.querySelector('#pref-zen-font-google').closest('.font-input-wrap'),
    ).not.toBeNull();
  });

  test('gives each font size select an accessible name without a visible size label', async () => {
    const app = track(await createApp());
    const labels = [
      ['#pref-font-size', 'Interface font size'],
      ['#pref-editor-font-size', 'Editor font size'],
      ['#pref-preview-font-size', 'Preview font size'],
      ['#pref-zen-font-size', 'Zen mode editor font size'],
    ];

    expect(app.window.document.querySelectorAll('.font-size-label')).toHaveLength(0);
    for (const [selector, accessibleName] of labels) {
      const sizeSelect = app.window.document.querySelector(selector);
      expect(sizeSelect.tagName).toBe('SELECT');
      expect(sizeSelect.getAttribute('aria-label')).toBe(accessibleName);
    }
  });

  test('keeps arbitrary local font names and applies slot-specific system fallbacks', async () => {
    const app = track(await createApp());

    await app.hooks.savePref('fontFamily', 'Aptos');
    await app.hooks.savePref('editorFontFamily', 'Fira Code');
    await app.hooks.savePref('previewFontFamily', 'Source Serif 4');
    await app.hooks.applyFonts();

    const root = app.window.document.documentElement;
    expect(root.style.getPropertyValue('--font')).toContain('"Aptos"');
    expect(root.style.getPropertyValue('--font')).toContain('ui-sans-serif');
    expect(root.style.getPropertyValue('--editor-font')).toContain('"Fira Code"');
    expect(root.style.getPropertyValue('--editor-font')).toContain('ui-monospace');
    expect(root.style.getPropertyValue('--preview-font')).toContain('"Source Serif 4"');
    expect(root.style.getPropertyValue('--preview-font')).toContain('ui-sans-serif');
    await app.hooks.savePref('previewFontFamily', 'system-serif');
    await app.hooks.applyFonts();
    expect(root.style.getPropertyValue('--preview-font')).toContain('ui-serif');
    expect(app.window.document.querySelectorAll('[data-vylk-font]')).toHaveLength(0);
    expect(app.window.document.querySelector('#pref-font-error').hidden).toBe(true);
  });

  test('keeps an invalid font name visible and does not save it', async () => {
    const app = track(await createApp());
    const input = app.window.document.querySelector('#pref-font');
    const error = app.window.document.querySelector('#pref-font-error');

    input.value = 'Bad"Font';
    input.dispatchEvent(new app.window.Event('change'));

    await vi.waitFor(() => expect(error.hidden).toBe(false));
    expect(input.value).toBe('Bad"Font');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.textContent).toContain('valid font name');
    expect(
      (await app.hooks.pendingOperations()).filter((operation) => operation.type === 'prefs.save'),
    ).toHaveLength(0);
    expect(JSON.parse(app.window.localStorage.getItem('vylk-prefs') || '{}').fontFamily).not.toBe(
      'Bad"Font',
    );

    await app.hooks.applyFonts();
    expect(input.value).toBe('Bad"Font');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.hidden).toBe(false);
  });

  test('offers common preset sizes and applies them per font slot', async () => {
    const app = track(await createApp());
    const sizes = [
      ['#pref-font-size', '0.9rem', '--font-size'],
      ['#pref-editor-font-size', '1.25rem', '--editor-font-size'],
      ['#pref-preview-font-size', '1.5rem', '--preview-font-size'],
    ];

    for (const [selector, value] of sizes) {
      const input = app.window.document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new app.window.Event('change'));
    }

    await vi.waitFor(async () => {
      const pending = await app.hooks.pendingOperations();
      expect(pending).toHaveLength(1);
      expect(pending[0].prefs._sync_patch).toEqual({
        fontSize: '0.9rem',
        editorFontSize: '1.25rem',
        previewFontSize: '1.5rem',
      });
    });

    const root = app.window.document.documentElement;
    expect(root.style.getPropertyValue('--font-size')).toBe('0.9rem');
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('1.25rem');
    expect(root.style.getPropertyValue('--preview-font-size')).toBe('1.5rem');
  });

  test('keeps interface typography relative to the configured base size', () => {
    expect(styleSource).toContain('.btn-text,.btn-primary,.prefs-btn{');
    expect(styleSource).toMatch(/\.btn-text,[^}]+font-size:0?\.875em/);
    expect(styleSource).toContain('header h1{font-size:1.125em}');
  });

  test('keeps font controls aligned and gives the settings surface room to breathe', () => {
    expect(styleSource).toContain(
      'grid-template-columns:minmax(0,1fr) 10rem;align-items:end;gap:0.75rem',
    );
    expect(styleSource).toContain(
      '.prefs-modal-body{display:flex;width:min(95vw,84rem);height:min(50rem,100dvh - 2rem)',
    );
    expect(styleSource).toContain(
      '.font-control input[type="text"],.font-control select{height:2.5rem;min-height:2.5rem;box-sizing:border-box;padding:0.55rem 0.7rem}',
    );
  });

  test('does not probe Google Fonts for local-only custom preferences', async () => {
    const app = track(await createApp());
    await app.hooks.savePref('fontFamily', 'Aptos');
    const head = app.window.document.head;
    const append = head.append.bind(head);
    let probeCount = 0;
    head.append = (...nodes) => {
      append(...nodes);
      nodes
        .filter((node) => node.rel === 'stylesheet' && !node.dataset.vylkFont)
        .forEach((node) => {
          probeCount++;
          setTimeout(() => node.dispatchEvent(new app.window.Event('error')), 0);
        });
    };

    await app.hooks.loadPrefs();

    expect(probeCount).toBe(0);
    expect(app.window.document.querySelectorAll('[data-vylk-font]')).toHaveLength(0);
    expect(app.window.document.querySelector('#pref-font-error').hidden).toBe(true);
  });

  test('shows a font error when opt-in Google loading fails', async () => {
    const app = track(await createApp());
    app.window.console.warn = () => {};
    const head = app.window.document.head;
    const append = head.append.bind(head);
    head.append = (...nodes) => {
      append(...nodes);
      nodes
        .filter((node) => node.rel === 'stylesheet' && node.dataset.vylkFont)
        .forEach((node) => {
          setTimeout(() => node.dispatchEvent(new app.window.Event('error')), 0);
        });
    };

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    fetchFonts.checked = true;
    fetchFonts.dispatchEvent(new app.window.Event('change'));
    await app.hooks.savePref('fontFamily', 'Definitely Not A Google Font');
    await app.hooks.applyFonts();

    const error = app.window.document.querySelector('#pref-font-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Font not available');
    expect(app.window.document.documentElement.style.getPropertyValue('--font')).toContain(
      'ui-sans-serif',
    );
  });

  test('requests a Google family without assuming unsupported weights or styles', async () => {
    const app = track(await createApp());
    const head = app.window.document.head;
    const append = head.append.bind(head);
    let stylesheet;
    head.append = (...nodes) => {
      append(...nodes);
      stylesheet ||= nodes.find((node) => node.rel === 'stylesheet' && node.dataset.vylkFont);
      nodes
        .filter((node) => node.rel === 'stylesheet' && node.dataset.vylkFont)
        .forEach((node) => {
          setTimeout(() => node.dispatchEvent(new app.window.Event('load')), 0);
        });
    };
    app.window.document.fonts.load = async () => [{}];

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    fetchFonts.checked = true;
    fetchFonts.dispatchEvent(new app.window.Event('change'));
    await app.hooks.savePref('fontFamily', 'Crimson Pro');
    await app.hooks.applyFonts();

    expect(stylesheet.href).toContain('family=Crimson+Pro&display=swap');
    expect(stylesheet.href).not.toContain('ital,wght');
  });

  test('keeps Google fetching independent for each font slot', async () => {
    const app = track(await createApp());
    const head = app.window.document.head;
    const append = head.append.bind(head);
    head.append = (...nodes) => {
      append(...nodes);
      nodes
        .filter((node) => node.rel === 'stylesheet' && node.dataset.vylkFont)
        .forEach((node) => {
          setTimeout(() => node.dispatchEvent(new app.window.Event('load')), 0);
        });
    };
    app.window.document.fonts.load = async () => [{}];

    await app.hooks.savePref('editorFontFamily', 'Fira Code');
    const editorFetch = app.window.document.querySelector('#pref-editor-font-google');
    editorFetch.checked = true;
    editorFetch.dispatchEvent(new app.window.Event('change'));
    await app.hooks.pendingOperations();
    await app.hooks.applyFonts();

    const requested = [...app.window.document.querySelectorAll('[data-vylk-font]')];
    expect(requested).toHaveLength(1);
    expect(requested[0].href).toContain('family=Fira+Code&display=swap');
    expect(app.window.document.querySelector('#pref-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-preview-font-google').checked).toBe(false);
  });
});

describe('editor display preferences', () => {
  test('applies status display modes and save button visibility', async () => {
    const app = track(await createApp());
    const root = app.window.document.documentElement;
    const statusLabel = app.window.document.querySelector('#editor-status .sync-indicator-label');
    expect(app.window.document.querySelector('#pref-status')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-start-view')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-hidesave')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-save-location')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-content-width')).not.toBeNull();
    expect(app.window.document.querySelectorAll('.panel-width')).toHaveLength(0);
    expect(app.window.document.querySelector('#panel-save-slot #save-btn')).not.toBeNull();

    await app.hooks.savePref('saveButtonLocation', 'header');
    expect(app.window.document.querySelector('#header-save-slot #save-btn')).not.toBeNull();
    await app.hooks.savePref('saveButtonLocation', 'panel');
    expect(app.window.document.querySelector('#panel-save-slot #save-btn')).not.toBeNull();

    app.hooks.setPanelState('preview');
    const previewSave = app.window.document.querySelector('#preview-save-slot #save-btn');
    expect(previewSave).not.toBeNull();
    expect(previewSave.disabled).toBe(true);
    app.hooks.setPanelState('both');
    expect(app.window.document.querySelector('#panel-save-slot #save-btn').disabled).toBe(false);

    await app.hooks.savePref('statusDisplay', 'compact');
    expect(root.dataset.statusDisplay).toBe('compact');
    expect(statusLabel).not.toBeNull();

    await app.hooks.savePref('hideSaveButton', true);
    expect(
      app.window.document.querySelector('#editor').classList.contains('hide-save-button'),
    ).toBe(true);

    await app.hooks.savePref('autoSave', false);
    expect(
      app.window.document.querySelector('#editor').classList.contains('hide-save-button'),
    ).toBe(false);

    await app.hooks.savePref('statusDisplay', 'off');
    expect(root.dataset.statusDisplay).toBe('off');
  });

  test('uses outcome-based editor settings and keeps manual Save available without automatic sync', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-editor').click();

    expect(
      [...app.window.document.querySelectorAll('#pref-start-view option')].map(
        (option) => option.value,
      ),
    ).toEqual(['split', 'editor', 'preview', 'zen']);
    expect(app.window.document.querySelector('#pref-hidepreview')).toBeNull();
    expect(app.window.document.querySelector('#pref-hideheader')).toBeNull();
    expect(
      [...app.window.document.querySelectorAll('#prefs-panel-editor .pref-subsection h3')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['Start and layout', 'Writing', 'Controls', 'Saving and sync']);

    await app.hooks.savePref('autoSave', false);
    expect(app.window.document.querySelector('#pref-hidesave').disabled).toBe(true);
    expect(app.window.document.querySelector('#pref-hidesave').checked).toBe(true);
    expect(app.window.document.querySelector('#pref-manual-save-copy').textContent).toContain(
      'stays available',
    );

    await app.hooks.savePref('accentColor', '#123456');
    app.window.history.replaceState({}, '', '/');
    app.window.document.querySelector('#prefs-close').click();
    app.window.document.querySelector('#editor-prefs-btn').click();
    expect(app.window.document.querySelector('#pref-accent-mode').value).toBe('custom');
    expect(app.window.document.querySelector('#pref-accent').hidden).toBe(false);
    await app.hooks.savePref('accentColor', '');
    app.window.history.replaceState({}, '', '/');
    app.window.document.querySelector('#prefs-close').click();
    app.window.document.querySelector('#editor-prefs-btn').click();
    expect(app.window.document.querySelector('#pref-accent-mode').value).toBe('theme');
    expect(app.window.document.querySelector('#pref-accent').hidden).toBe(true);
    app.hooks.cancelScheduledSync();
  });

  test('opens notes in the selected starting view', async () => {
    const app = track(await createApp());
    await app.hooks.savePref('startView', 'zen');
    app.hooks.showNoteInEditor({id: 'note-a', title: 'A note', tags: '', content: 'Text'});
    expect(app.window.document.querySelector('#editor').classList.contains('zen-mode')).toBe(true);

    await app.hooks.savePref('startView', 'preview');
    app.hooks.showNoteInEditor({id: 'note-b', title: 'Another note', tags: '', content: 'Text'});
    expect(
      app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden'),
    ).toBe(false);
    expect(
      app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden'),
    ).toBe(true);
    app.hooks.cancelScheduledSync();
  });

  test('applies the global content width preference to the shared layout', async () => {
    const app = track(await createApp());
    const root = app.window.document.documentElement;

    expect(root.dataset.contentWidth).toBe('standard');
    expect(styleSource).toContain(':root{--content-max-width:76.25rem;--font-size:1rem;');
    expect(styleSource).toContain(':root[data-content-width="compact"]{--content-max-width:54rem}');
    expect(styleSource).toContain(':root[data-content-width="wide"]{--content-max-width:90rem}');
    expect(styleSource).toContain(':root[data-content-width="full"]{--content-max-width:100%}');
    await app.hooks.savePref('contentWidth', 'wide');
    expect(root.dataset.contentWidth).toBe('wide');
    expect(styleSource).toContain(':root[data-content-width="wide"]');
    expect(styleSource).toContain('.dashboard-body{max-width:var(--content-max-width)}');
    expect(styleSource).toContain(
      '.editor-body{max-width:var(--content-max-width);margin-inline:auto}',
    );

    app.hooks.cancelScheduledSync();
    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].prefs._sync_patch).toEqual({contentWidth: 'wide'});
  });

  test('applies and syncs Zen page width independently from the app content width', async () => {
    const app = track(await createApp());
    const root = app.window.document.documentElement;

    expect(root.dataset.contentWidth).toBe('standard');
    expect(root.dataset.zenPageWidth).toBe('standard');
    await app.hooks.savePref('contentWidth', 'full');
    await app.hooks.savePref('zenPageWidth', 'compact');
    expect(root.dataset.contentWidth).toBe('full');
    expect(root.dataset.zenPageWidth).toBe('compact');
    expect(styleSource).toContain(
      ':root[data-zen-page-width="compact"]{--zen-content-max-width:54rem}',
    );
    expect(styleSource).toContain('--zen-page-width:min(100%,var(--zen-content-max-width));');

    app.hooks.cancelScheduledSync();
    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].prefs._sync_patch).toEqual({contentWidth: 'full', zenPageWidth: 'compact'});
  });
});
