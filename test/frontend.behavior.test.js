import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import fs from 'node:fs';
import {
  createApp,
  deleteOfflineDatabase,
  response,
} from './app-harness.js';

let apps = [];

beforeEach(async () => {
  apps = [];
  await deleteOfflineDatabase();
});

afterEach(async () => {
  for (const app of apps.reverse()) await app.close();
  await deleteOfflineDatabase();
});

function track(app) {
  apps.push(app);
  return app;
}

function pointerEvent(window, type, {pointerId = 1, pointerType = 'mouse', ...init} = {}) {
  const event = new window.MouseEvent(type, {bubbles:true, cancelable:true, ...init});
  Object.defineProperties(event, {
    pointerId: {value:pointerId},
    pointerType: {value:pointerType},
    isPrimary: {value:true},
  });
  return event;
}
const styleSource = fs.readFileSync(new URL('../static/style.css', import.meta.url), 'utf8');

describe('keyboard shortcuts', () => {
  test('registers the curated commands with portable defaults', async () => {
    const app = track(await createApp());
    expect(app.hooks.shortcutCommands()).toEqual(expect.arrayContaining([
      'note.new', 'note.save', 'preferences.open', 'editor.title', 'editor.tags', 'editor.focus',
      'view.write', 'view.preview', 'view.split', 'view.zen', 'view.switch', 'format.bold', 'format.italic',
    ]));
    expect(app.hooks.shortcutCommands()).not.toContain('editor.details');
    expect(app.hooks.getShortcutBinding('note.save').steps).toEqual([{key:'s', modifiers:['Mod']}]);
    expect(app.hooks.getShortcutPrefix().steps).toEqual([{key:'/', modifiers:['Mod']}]);
    expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([{key:'/', modifiers:['Mod']}, {key:'t', modifiers:[]}]);
    expect(app.hooks.getShortcutBinding('format.link')).toBeNull();
  });

  test('uses the configurable Mod+/ sequence to reveal Details and select the title', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id:'note-a', title:'Rename me', tags:'work', content:'body'});
    app.window.document.querySelector('.meta-pane').classList.add('collapsed');
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'/', ctrlKey:true, bubbles:true, cancelable:true}));
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'t', bubbles:true, cancelable:true}));
    const title = app.window.document.querySelector('#note-title');
    expect(app.window.document.querySelector('.meta-pane').classList.contains('collapsed')).toBe(false);
    expect(app.window.document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(0);
    expect(title.selectionEnd).toBe(title.value.length);
  });

  test('starts global sequences from the dashboard', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#login-screen').classList.add('hidden');
    app.window.document.querySelector('#dashboard').classList.remove('hidden');
    app.window.document.querySelector('#editor').classList.add('hidden');
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'/', ctrlKey:true, bubbles:true, cancelable:true}));
    expect(app.window.document.querySelector('#shortcut-sequence-hint').classList.contains('hidden')).toBe(false);
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'p', bubbles:true, cancelable:true}));
    expect(app.window.document.querySelector('#prefs-modal').classList.contains('hidden')).toBe(false);
  });

  test('moves the view through the registry and exposes a shortcut recorder', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id:'note-a', title:'Note', tags:'', content:'body'});
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'/', ctrlKey:true, bubbles:true, cancelable:true}));
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'2', bubbles:true, cancelable:true}));
    expect(app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden')).toBe(true);
    expect(app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden')).toBe(false);
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    expect(app.window.document.querySelectorAll('[data-shortcut-command]')).not.toHaveLength(0);
    expect(app.window.document.querySelector('[data-shortcut-command="editor.title"]').textContent).toBe('Prefix, T');
    expect(app.window.document.querySelector('[data-shortcut-command="format.link"]').textContent).toBe('Not set');
    const viewGroup = [...app.window.document.querySelectorAll('.shortcut-group')].find(group => group.querySelector('h3').textContent === 'View');
    expect([...viewGroup.querySelectorAll('.shortcut-copy strong')].map(element => element.textContent)).toEqual(['Write view', 'Preview view', 'Split view', 'Zen mode', 'Switch editor and preview']);
  });

  test('uses Zen mode to leave only the editor, then returns on Escape', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id:'note-a', title:'Note', tags:'', content:'one two'});
    app.hooks.setPanelState('zen');
    const editor = app.window.document.querySelector('#editor');
    expect(editor.classList.contains('zen-mode')).toBe(true);
    expect(editor.classList.contains('header-hidden')).toBe(true);
    expect(app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden')).toBe(true);
    expect(app.window.document.querySelector('[data-panel="zen"]').getAttribute('aria-pressed')).toBe('true');
    expect(app.window.document.querySelectorAll('[data-zen-action]')).toHaveLength(3);
    expect(app.window.document.querySelector('#zen-note-title').textContent).toBe('Note');
    expect(app.window.document.querySelector('#zen-note-title').hidden).toBe(false);
    expect(app.window.document.querySelector('.zen-controls').classList.contains('is-minimal')).toBe(false);
    expect(app.window.document.querySelector('#zen-word-count').hidden).toBe(true);
    await app.hooks.savePref('zenWordCount', true);
    expect(app.window.document.querySelector('#zen-word-count').textContent).toBe('2 words');
    expect(app.window.document.querySelector('#zen-word-count').hidden).toBe(false);
    await app.hooks.savePref('zenShowTitle', false);
    expect(app.window.document.querySelector('#zen-note-title').hidden).toBe(true);
    await app.hooks.savePref('zenShowControls', false);
    expect(app.window.document.querySelector('.zen-controls').classList.contains('is-minimal')).toBe(true);
    expect(app.window.document.querySelector('[data-zen-action="exit"]').hidden).toBe(false);
    expect(app.window.document.querySelector('#zen-exit-icon').getAttribute('href')).toBe('#icon-x');
    app.window.document.querySelector('[data-zen-action="preview"]').click();
    expect(app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden')).toBe(false);
    expect(app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden')).toBe(true);
    expect(editor.classList.contains('zen-mode')).toBe(true);
    app.window.document.querySelector('[data-zen-action="editor"]').click();
    expect(app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden')).toBe(false);
    expect(app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden')).toBe(true);
    expect(editor.classList.contains('zen-mode')).toBe(true);
    app.hooks.setPanelState('both');
    app.hooks.setPanelState('zen');
    app.window.document.querySelector('[data-zen-action="exit"]').click();
    expect(editor.classList.contains('zen-mode')).toBe(false);
    app.hooks.setPanelState('zen');
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    expect(editor.classList.contains('zen-mode')).toBe(false);
    expect(editor.classList.contains('header-hidden')).toBe(false);
    expect(app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden')).toBe(false);
  });

  test('keeps Zen settings in their own preference tab', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-zen').click();

    expect(app.window.document.querySelector('#prefs-title').textContent).toBe('Zen mode');
    expect(app.window.document.querySelector('#prefs-panel-zen').hidden).toBe(false);
    expect(app.window.document.querySelector('#prefs-panel-editor').hidden).toBe(true);
    expect(app.window.document.querySelector('#pref-zen-interactive-preview')).toBeNull();
  });

  test('clears a shortcut from its recorder with Delete and keeps Escape as cancel', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    let titleShortcut = app.window.document.querySelector('[data-shortcut-command="editor.title"]');
    titleShortcut.click();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    titleShortcut = app.window.document.querySelector('[data-shortcut-command="editor.title"]');
    expect(titleShortcut.textContent).toBe('Prefix, T');
    titleShortcut.click();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'Delete', bubbles:true, cancelable:true}));
    await vi.waitFor(() => expect(app.hooks.getShortcutBinding('editor.title')).toBeNull());
    await vi.waitFor(() => expect(app.window.document.querySelector('[data-shortcut-command="editor.title"]').textContent).toBe('Not set'));
    await new Promise(resolve => app.window.setTimeout(resolve, 200));
  });

  test('records direct shortcuts or Prefix sequences for every command', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    const linkShortcut = app.window.document.querySelector('[data-shortcut-command="format.link"]');
    linkShortcut.click();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'y', ctrlKey:true, bubbles:true, cancelable:true}));
    await vi.waitFor(() => expect(app.hooks.getShortcutBinding('format.link').steps).toEqual([{key:'y', modifiers:['Mod']}]));
    expect(app.window.document.querySelector('[data-shortcut-command="format.link"]').textContent).toBe('Ctrl + Y');

    let titleShortcut = app.window.document.querySelector('[data-shortcut-command="editor.title"]');
    titleShortcut.click();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'/', ctrlKey:true, bubbles:true, cancelable:true}));
    expect(app.window.document.querySelector('[data-shortcut-command="editor.title"]').textContent).toBe('Prefix,');
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'t', bubbles:true, cancelable:true}));
    await vi.waitFor(() => expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([{key:'/', modifiers:['Mod']}, {key:'t', modifiers:[]}]));
    await new Promise(resolve => app.window.setTimeout(resolve, 200));
  });

  test('updates every sequence command when the prefix changes', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-shortcuts').click();
    app.window.document.querySelector('#shortcut-prefix').click();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key:'e', ctrlKey:true, bubbles:true, cancelable:true}));
    await vi.waitFor(() => expect(app.hooks.getShortcutPrefix().steps).toEqual([{key:'e', modifiers:['Mod']}]));
    expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([{key:'e', modifiers:['Mod']}, {key:'t', modifiers:[]}]);
    app.window.document.querySelector('#shortcut-reset').click();
    await vi.waitFor(() => expect(app.hooks.getShortcutPrefix().steps).toEqual([{key:'/', modifiers:['Mod']}]));
    expect(app.hooks.getShortcutBinding('editor.title').steps).toEqual([{key:'/', modifiers:['Mod']}, {key:'t', modifiers:[]}]);
    await new Promise(resolve => app.window.setTimeout(resolve, 200));
  });
});

describe('font preferences', () => {
  test('uses font controls and leaves Google Fonts fetching disabled by default', async () => {
    const app = track(await createApp());

    expect(app.window.document.querySelector('#pref-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-editor-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-preview-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-zen-font').tagName).toBe('INPUT');
    for (const selector of ['#pref-font-size', '#pref-editor-font-size', '#pref-preview-font-size', '#pref-zen-font-size']) {
      const sizeSelect = app.window.document.querySelector(selector);
      expect(sizeSelect.tagName).toBe('SELECT');
      expect([...sizeSelect.options].map(option => option.value)).toEqual(['0.8rem', '0.9rem', '1rem', '1.1rem', '1.25rem', '1.5rem']);
      expect(sizeSelect.value).toBe('1rem');
    }
    expect(app.window.document.querySelector('#pref-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-editor-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-preview-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-zen-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-font-google').closest('.font-input-wrap')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-editor-font-google').closest('.font-input-wrap')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-preview-font-google').closest('.font-input-wrap')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-zen-font-google').closest('.font-input-wrap')).not.toBeNull();
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
    expect((await app.hooks.pendingOperations()).filter(operation => operation.type === 'prefs.save')).toHaveLength(0);
    expect(JSON.parse(app.window.localStorage.getItem('vylk-prefs') || '{}').fontFamily).not.toBe('Bad"Font');

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
      expect(pending[0].prefs._sync_patch).toEqual({fontSize: '0.9rem', editorFontSize: '1.25rem', previewFontSize: '1.5rem'});
    });

    const root = app.window.document.documentElement;
    expect(root.style.getPropertyValue('--font-size')).toBe('0.9rem');
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('1.25rem');
    expect(root.style.getPropertyValue('--preview-font-size')).toBe('1.5rem');
  });

  test('keeps interface typography relative to the configured base size', () => {
    expect(styleSource).toContain('.btn-text,.btn-primary,.prefs-btn{');
    expect(styleSource).toMatch(/\.btn-text,[^}]+font-size:\.875em/);
    expect(styleSource).toContain('header h1{font-size:1.125em}');
  });

  test('keeps font controls aligned and gives the settings surface room to breathe', () => {
    expect(styleSource).toContain('grid-template-columns:minmax(0,1fr) 10rem;align-items:end;gap:.75rem');
    expect(styleSource).toContain('.prefs-modal-body{display:flex;width:min(95vw,84rem);height:min(50rem,calc(100dvh - 2rem))');
    expect(styleSource).toContain('.font-control input[type=text],.font-control select{height:2.5rem;min-height:2.5rem;box-sizing:border-box;padding:.55rem .7rem}');
  });

  test('does not probe Google Fonts for local-only custom preferences', async () => {
    const app = track(await createApp());
    await app.hooks.savePref('fontFamily', 'Aptos');
    const head = app.window.document.head;
    const append = head.append.bind(head);
    let probeCount = 0;
    head.append = (...nodes) => {
      append(...nodes);
      nodes.filter(node => node.rel === 'stylesheet' && !node.dataset.vylkFont).forEach(node => {
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
      nodes.filter(node => node.rel === 'stylesheet' && node.dataset.vylkFont).forEach(node => {
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
    expect(app.window.document.documentElement.style.getPropertyValue('--font')).toContain('ui-sans-serif');
  });

  test('requests a Google family without assuming unsupported weights or styles', async () => {
    const app = track(await createApp());
    const head = app.window.document.head;
    const append = head.append.bind(head);
    let stylesheet;
    head.append = (...nodes) => {
      append(...nodes);
      stylesheet ||= nodes.find(node => node.rel === 'stylesheet' && node.dataset.vylkFont);
      nodes.filter(node => node.rel === 'stylesheet' && node.dataset.vylkFont).forEach(node => {
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
      nodes.filter(node => node.rel === 'stylesheet' && node.dataset.vylkFont).forEach(node => {
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
    expect(app.window.document.querySelector('#editor').classList.contains('hide-save-button')).toBe(true);

    await app.hooks.savePref('autoSave', false);
    expect(app.window.document.querySelector('#editor').classList.contains('hide-save-button')).toBe(false);

    await app.hooks.savePref('statusDisplay', 'off');
    expect(root.dataset.statusDisplay).toBe('off');
  });

  test('uses outcome-based editor settings and keeps manual Save available without automatic sync', async () => {
    const app = track(await createApp());
    app.window.document.querySelector('#editor-prefs-btn').click();
    app.window.document.querySelector('#prefs-tab-editor').click();

    expect([...app.window.document.querySelectorAll('#pref-start-view option')].map(option => option.value)).toEqual(['split', 'editor', 'preview', 'zen']);
    expect(app.window.document.querySelector('#pref-hidepreview')).toBeNull();
    expect(app.window.document.querySelector('#pref-hideheader')).toBeNull();
    expect([...app.window.document.querySelectorAll('#prefs-panel-editor .pref-subsection h3')].map(heading => heading.textContent)).toEqual(['Start and layout', 'Writing', 'Controls', 'Saving and sync']);

    await app.hooks.savePref('autoSave', false);
    expect(app.window.document.querySelector('#pref-hidesave').disabled).toBe(true);
    expect(app.window.document.querySelector('#pref-hidesave').checked).toBe(true);
    expect(app.window.document.querySelector('#pref-manual-save-copy').textContent).toContain('stays available');

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
    app.hooks.showNoteInEditor({id:'note-a', title:'A note', tags:'', content:'Text'});
    expect(app.window.document.querySelector('#editor').classList.contains('zen-mode')).toBe(true);

    await app.hooks.savePref('startView', 'preview');
    app.hooks.showNoteInEditor({id:'note-b', title:'Another note', tags:'', content:'Text'});
    expect(app.window.document.querySelector('#preview-panel').classList.contains('panel-hidden')).toBe(false);
    expect(app.window.document.querySelector('#editor-panel').classList.contains('panel-hidden')).toBe(true);
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
    expect(styleSource).toContain('.editor-body{max-width:var(--content-max-width);margin-inline:auto}');

    app.hooks.cancelScheduledSync();
    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].prefs._sync_patch).toEqual({contentWidth: 'wide'});
  });
});

describe('markdown preview policy', () => {
  test('interactive preview is opt-in, keeps source editing available, and toggles task Markdown', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Tasks', content: '- [ ] ship this\n- [x] review that'});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    const checkbox = app.window.document.querySelector('#preview input[type="checkbox"]');
    expect(app.window.document.querySelector('#preview-edit-toggle')).toBeNull();
    expect(textarea.readOnly).toBe(false);
    app.hooks.setInteractiveSourceLocked(true);
    expect(textarea.readOnly).toBe(true);
    app.hooks.setInteractiveSourceLocked(false);
    expect(textarea.readOnly).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(app.window.document.querySelectorAll('#preview [data-preview-drag-indicator]')).toHaveLength(2);
    const preview = app.window.document.querySelector('#preview');
    preview.scrollTop = 37;
    checkbox.click();
    expect(textarea.value).toContain('- [x] ship this');
    expect(preview.scrollTop).toBe(37);
    expect(app.window.document.querySelector('#toast-region').children).toHaveLength(0);

    const interactiveUndo = new app.window.KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true, cancelable:true});
    app.window.document.querySelector('#preview input[type="checkbox"]').dispatchEvent(interactiveUndo);
    expect(interactiveUndo.defaultPrevented).toBe(true);
    expect(textarea.value).toContain('- [ ] ship this');
    expect(preview.scrollTop).toBe(37);
    expect(app.window.document.querySelector('#toast-region').children).toHaveLength(0);
    await app.hooks.savePref('interactivePreview', false);
    expect(textarea.readOnly).toBe(false);
    expect(app.window.document.querySelector('#preview').classList.contains('interactive-preview-active')).toBe(false);
    expect(app.window.document.querySelectorAll('#preview [data-preview-drag-indicator]')).toHaveLength(0);
  });

  test('keeps Zen preview read-only while preserving standard interactive preview', async () => {
    const app = track(await createApp({realMarked: true}));
    const source = '# Heading\n\n- [ ] ship this\n- Keep writing';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Tasks', content: source});
    await app.hooks.savePref('interactivePreview', true);
    app.hooks.setPanelState('zen');
    app.window.document.querySelector('[data-zen-action="preview"]').click();

    const editor = app.window.document.querySelector('#editor');
    const previewPanel = app.window.document.querySelector('.panel-preview');
    const editorPanel = app.window.document.querySelector('.panel-editor');
    const preview = app.window.document.querySelector('#preview');
    expect(editor.classList.contains('zen-mode')).toBe(true);
    expect(previewPanel.classList.contains('panel-hidden')).toBe(false);
    expect(editorPanel.classList.contains('panel-hidden')).toBe(true);
    expect(preview.classList.contains('interactive-preview-active')).toBe(false);
    expect(preview.querySelectorAll('[data-preview-drag-indicator]')).toHaveLength(0);
    expect(preview.querySelector('input[type="checkbox"]').disabled).toBe(true);

    app.hooks.setPanelState('both');
    expect(preview.classList.contains('interactive-preview-active')).toBe(true);
  });

  test('toggles a task checkbox without replacing the rendered preview', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Tasks', content: '- [ ] keep this row\n- other row'});
    await app.hooks.savePref('interactivePreview', true);

    const preview = app.window.document.querySelector('#preview');
    const checkbox = preview.querySelector('input[type="checkbox"]');
    const list = checkbox.closest('li');

    checkbox.click();

    expect(preview.querySelector('input[type="checkbox"]') === checkbox).toBe(true);
    expect(app.window.document.querySelector('#note-content').value).toContain('- [x] keep this row');
    expect(checkbox.checked).toBe(true);
    expect(preview.querySelector('li') === list).toBe(true);
  });

  test('does not apply a drag using stale preview ranges after source edits', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '- Alpha\n- Bravo'});
    await app.hooks.savePref('interactivePreview', true);

    const preview = app.window.document.querySelector('#preview');
    const items = [...preview.querySelectorAll('li[data-interactive-start]')];
    const rectangle = top => ({left:100, top, right:400, bottom:top + 40, width:300, height:40, x:100, y:top, toJSON() { return this; }});
    items[0].getBoundingClientRect = () => rectangle(80);
    items[1].getBoundingClientRect = () => rectangle(140);
    preview.getBoundingClientRect = () => ({left:80, top:60, right:420, bottom:240, width:340, height:180, x:80, y:60, toJSON() { return this; }});

    const textarea = app.window.document.querySelector('#note-content');
    const editedSource = 'Introduction\n\n- Alpha\n- Bravo';
    textarea.value = editedSource;
    textarea.dispatchEvent(new app.window.Event('input', {bubbles:true}));

    const handle = items[0].querySelector('.preview-drag-handle');
    handle.dispatchEvent(pointerEvent(app.window, 'pointerdown', {pointerId:7, button:0, clientX:120, clientY:100}));
    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointermove', {pointerId:7, buttons:1, clientX:120, clientY:175}));
    await new Promise(resolve => app.window.requestAnimationFrame(resolve));
    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointerup', {pointerId:7, button:0, clientX:120, clientY:175}));

    expect(textarea.value).toBe(editedSource);
  });

  test('leaves native undo and redo available without an interactive transaction', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'Original'});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    textarea.value = 'Ordinary source edit';
    textarea.dispatchEvent(new app.window.Event('input', {bubbles:true}));
    const title = app.window.document.querySelector('#note-title');
    const sourceUndo = new app.window.KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true, cancelable:true});
    const titleUndo = new app.window.KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true, cancelable:true});
    const sourceRedo = new app.window.KeyboardEvent('keydown', {key:'z', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true});

    textarea.dispatchEvent(sourceUndo);
    title.dispatchEvent(titleUndo);
    textarea.dispatchEvent(sourceRedo);

    expect([sourceUndo.defaultPrevented, titleUndo.defaultPrevented, sourceRedo.defaultPrevented]).toEqual([false, false, false]);
  });

  test('renders interactive blocks as gutter, handle, and content cards', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '13. [ ] first\n14. second\n\n---\n\nParagraph'});
    await app.hooks.savePref('interactivePreview', true);

    const preview = app.window.document.querySelector('#preview');
    const listItem = preview.querySelector('li[data-interactive-start]');
    const listCard = listItem.querySelector(':scope > .interactive-preview-card');
    expect(listCard.children[0].classList.contains('preview-drag-handle')).toBe(true);
    expect(listCard.children[1].classList.contains('preview-drag-content')).toBe(true);
    expect(listCard.children[2].classList.contains('preview-edit-button')).toBe(true);
    expect(listCard.children[2].getAttribute('aria-label')).toBe('Edit this block in source');
    expect(listCard.children[2].querySelector('use').getAttribute('href')).toBe('#icon-edit');
    expect(listCard.querySelector('.preview-list-marker').textContent).toBe('13.');
    expect(listCard.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(listCard.children[0].compareDocumentPosition(listCard.querySelector('.preview-list-marker')) & app.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const blockCard = preview.querySelector(':scope > .interactive-preview-block-card');
    expect(blockCard.querySelector(':scope > .preview-drag-handle')).not.toBeNull();
    const ruleCard = preview.querySelector(':scope > .interactive-preview-rule-card');
    expect(ruleCard.querySelector(':scope > .preview-block-content > hr')).not.toBeNull();
    expect(preview.querySelector(':scope > .interactive-preview-block-card .preview-block-content > p')?.textContent).toBe('Paragraph');
  });

  test('moves the source caret to an interactive block and leaves preview-only mode', async () => {
    const app = track(await createApp({realMarked: true}));
    const source = '# Heading\n\n13. [ ] first task';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: source});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    app.window.document.querySelector('.interactive-preview-block-card .preview-edit-button').click();
    expect(app.window.document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(source.indexOf('Heading'));
    expect(textarea.selectionEnd).toBe(source.indexOf('Heading'));
    expect(app.window.document.querySelector('.panel-editor').classList.contains('panel-hidden')).toBe(false);
    expect(app.window.document.querySelector('.panel-preview').classList.contains('panel-hidden')).toBe(false);

    app.hooks.setPanelState('preview');
    app.window.document.querySelector('.interactive-preview-list-card .preview-edit-button').click();
    expect(app.window.document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(source.indexOf('first task'));
    expect(app.window.document.querySelector('.panel-editor').classList.contains('panel-hidden')).toBe(false);
    expect(app.window.document.querySelector('.panel-preview').classList.contains('panel-hidden')).toBe(true);
  });

  test('preserves native text selection intent and keeps the drag ghost under the pointer', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading'});
    await app.hooks.savePref('interactivePreview', true);
    app.hooks.cancelScheduledSync();

    const card = app.window.document.querySelector('.interactive-preview-block-card');
    const content = card.querySelector('.preview-drag-content');
    content.dispatchEvent(pointerEvent(app.window, 'pointerdown', {button:0, clientX:120, clientY:100}));
    expect(app.hooks.getInteractivePreviewState().pending).toBe(false);
    content.dispatchEvent(new app.window.Event('selectstart', {bubbles:true, cancelable:true}));
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({pending:false, dragging:false, sourceLocked:false});

    const rect = {left:100, top:80, right:400, bottom:128, width:300, height:48, x:100, y:80, toJSON() { return this; }};
    card.getBoundingClientRect = () => rect;
    const preview = app.window.document.querySelector('#preview');
    preview.getBoundingClientRect = () => ({left:80, top:60, right:420, bottom:300, width:340, height:240, x:80, y:60, toJSON() { return this; }});
    app.window.document.elementFromPoint = () => card;
    const handle = card.querySelector('.preview-drag-handle');
    handle.dispatchEvent(pointerEvent(app.window, 'pointerdown', {pointerId:2, button:0, clientX:120, clientY:100}));
    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointermove', {pointerId:2, buttons:1, clientX:170, clientY:130}));
    await vi.waitFor(() => expect(app.hooks.getInteractivePreviewState().ghostTransform).toBe('translate3d(50px,30px,0)'));
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({pending:true, dragging:true, sourceLocked:true, outside:false});

    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointermove', {pointerId:2, buttons:1, clientX:460, clientY:130}));
    await vi.waitFor(() => expect(app.hooks.getInteractivePreviewState().outside).toBe(true));

    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointerup', {pointerId:2, button:0, clientX:460, clientY:130}));
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({pending:false, dragging:false, sourceLocked:false, outside:false});
  });

  test('does not claim touch gestures from preview content', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading'});
    await app.hooks.savePref('interactivePreview', true);

    const content = app.window.document.querySelector('.interactive-preview-block-card .preview-drag-content');
    content.dispatchEvent(pointerEvent(app.window, 'pointerdown', {pointerType:'touch', button:0, clientX:120, clientY:100}));

    expect(app.hooks.getInteractivePreviewState()).toMatchObject({pending:false, dragging:false, sourceLocked:false});
  });

  test('claims only the touch handle and arms a stationary hold', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading\n\nParagraph'});
    await app.hooks.savePref('interactivePreview', true);

    const card = app.window.document.querySelector('.interactive-preview-block-card');
    const handle = card.querySelector('.preview-drag-handle');
    const rect = {left:100, top:80, right:400, bottom:128, width:300, height:48, x:100, y:80, toJSON() { return this; }};
    card.getBoundingClientRect = () => rect;
    const preview = app.window.document.querySelector('#preview');
    preview.getBoundingClientRect = () => ({left:80, top:60, right:420, bottom:300, width:340, height:240, x:80, y:60, toJSON() { return this; }});
    app.window.document.elementFromPoint = () => card;

    const pointerDown = pointerEvent(app.window, 'pointerdown', {pointerId:3, pointerType:'touch', button:0, clientX:120, clientY:100});
    handle.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(card.classList.contains('is-drag-pending')).toBe(true);
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({pending:true, dragging:false, sourceLocked:false});

    await new Promise(resolve => setTimeout(resolve, 240));
    await vi.waitFor(() => expect(app.hooks.getInteractivePreviewState()).toMatchObject({pending:true, dragging:true, sourceLocked:true}));
    expect(card.classList.contains('is-drag-pending')).toBe(false);

    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointermove', {pointerId:3, pointerType:'touch', buttons:1, clientX:170, clientY:130}));
    await vi.waitFor(() => expect(app.hooks.getInteractivePreviewState().ghostTransform).toBe('translate3d(50px,30px,0)'));
    app.window.document.dispatchEvent(pointerEvent(app.window, 'pointercancel', {pointerId:3, pointerType:'touch', clientX:170, clientY:130}));
  });

  test('suppresses native long-press behavior only on preview drag handles', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading'});
    await app.hooks.savePref('interactivePreview', true);

    const card = app.window.document.querySelector('.interactive-preview-block-card');
    const handle = card.querySelector('.preview-drag-handle');
    const content = card.querySelector('.preview-drag-content');
    for (const type of ['touchstart', 'contextmenu', 'selectstart', 'dragstart']) {
      const handleEvent = new app.window.Event(type, {bubbles:true, cancelable:true});
      handle.dispatchEvent(handleEvent);
      expect(handleEvent.defaultPrevented, `${type} on handle`).toBe(true);

      const contentEvent = new app.window.Event(type, {bubbles:true, cancelable:true});
      content.dispatchEvent(contentEvent);
      expect(contentEvent.defaultPrevented, `${type} on content`).toBe(false);
    }
  });

  test('auto-scrolls only near reachable preview edges', async () => {
    const app = track(await createApp());
    const preview = {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
      getBoundingClientRect: () => ({top:100, bottom:400, height:300}),
    };

    expect(app.hooks.previewAutoScrollDelta(preview, 250)).toBe(0);
    expect(app.hooks.previewAutoScrollDelta(preview, 396)).toBeGreaterThan(0);
    expect(app.hooks.previewAutoScrollDelta(preview, 104)).toBeLessThan(0);
    preview.scrollTop = 0;
    expect(app.hooks.previewAutoScrollDelta(preview, 104)).toBe(0);
    preview.scrollTop = 700;
    expect(app.hooks.previewAutoScrollDelta(preview, 396)).toBe(0);
  });

  test('reorders only sibling list items and renumbers ordered Markdown', async () => {
    const app = track(await createApp());
    const source = '6. first\n7. second\n8. third';
    const entries = app.window.VylkInteractive.listItemRanges(source, 0, 'list:0');
    const moved = app.window.VylkInteractive.reorderListItems(source, entries, entries[2].start, entries[0].start, 'before');
    expect(moved.source).toBe('6. third\n7. first\n8. second');

    const nested = app.window.VylkInteractive.listItemRanges('- one\n  - nested\n- two', 0, 'list:0');
    expect(app.window.VylkInteractive.reorderListItems('- one\n  - nested\n- two', nested, nested[1].start, nested[2].start, 'before')).toBeNull();
  });

  test('keeps nested content attached when ordered-list renumbering crosses a digit boundary', async () => {
    const app = track(await createApp());
    const source = '9. first\n   - child-first\n10. second\n    - child-second';
    const entries = app.window.VylkInteractive.listItemRanges(source, 0, 'list:0');
    const siblings = entries.filter(entry => entry.parent === null);

    const moved = app.window.VylkInteractive.reorderListItems(source, entries, siblings[0].start, siblings[1].start, 'after');
    const lines = moved.source.split('\n');
    const movedItemIndex = lines.indexOf('10. first');
    const markerWidth = lines[movedItemIndex].match(/^\s*\d+[.)]\s+/)[0].length;
    const childIndent = lines[movedItemIndex + 1].match(/^\s*/)[0].length;

    expect(childIndent).toBeGreaterThanOrEqual(markerWidth);
  });

  test('moves valid Markdown units across block and list boundaries', async () => {
    const app = track(await createApp());
    const source = '# Heading\n\nParagraph\n\n- one\n- two';
    const heading = {start:0, end:'# Heading'.length, indent:0, kind:'block', scope:'blocks'};
    const paragraphStart = source.indexOf('Paragraph');
    const paragraph = {start:paragraphStart, end:paragraphStart + 'Paragraph'.length, indent:0, kind:'block', scope:'blocks'};
    const listStart = source.indexOf('- one');
    const listEntries = app.window.VylkInteractive.listItemRanges(source.slice(listStart), listStart, `list:${listStart}`);
    const entries = [heading, paragraph, ...listEntries];

    const headingIntoList = app.window.VylkInteractive.moveMarkdownUnit(source, entries, heading.start, heading.scope, listEntries[0].start, listEntries[0].scope, 'after');
    expect(headingIntoList).not.toBeNull();
    expect(headingIntoList.source.indexOf('- one')).toBeLessThan(headingIntoList.source.indexOf('# Heading'));
    expect(headingIntoList.source.indexOf('# Heading')).toBeLessThan(headingIntoList.source.indexOf('- two'));

    const listBeforeParagraph = app.window.VylkInteractive.moveMarkdownUnit(source, entries, listEntries[1].start, listEntries[1].scope, paragraph.start, paragraph.scope, 'before');
    expect(listBeforeParagraph).not.toBeNull();
    expect(listBeforeParagraph.source.indexOf('- two')).toBeLessThan(listBeforeParagraph.source.indexOf('Paragraph'));
  });

  test('preserves the starting number of ordered lists', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Note',
      content: '6. [ ] six\n7. [ ] seven\n8. [ ] eight',
    });
    app.hooks.updatePreview();

    const ordered = app.window.document.querySelector('#preview ol');
    expect(ordered).not.toBeNull();
    expect(ordered.getAttribute('start')).toBe('6');
  });

  test('preserves nested and signed ordered-list starts but strips malformed attributes', async () => {
    const app = track(await createApp({realMarked: true}));
    app.window.marked = {
      parse: () => '<ol start="6"><li>outer<ol start="-2"><li>nested</li></ol></li></ol><ol start="not-a-number"><li>bad</li></ol><p start="9">not a list</p>',
    };
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'ordered'});
    app.hooks.updatePreview();

    const lists = [...app.window.document.querySelectorAll('#preview ol')];
    expect(lists.map(list => list.getAttribute('start'))).toEqual(['6', '-2', null]);
    expect(app.window.document.querySelector('#preview p').getAttribute('start')).toBeNull();
  });

  test('keeps the editor compact and the native caret distinct', async () => {
    const app = track(await createApp());
    expect(app.window.document.querySelector('.editor-position-bar')).toBeNull();
    expect(app.window.document.querySelector('.editor-current-line')).not.toBeNull();
    expect(styleSource).toContain('caret-color:var(--accent)');
    expect(styleSource).toContain('.editor-caret-measure');
    expect(styleSource).toContain('.editor-source-wrap.is-caret-visible .editor-current-line');
    expect(styleSource).toContain('background:color-mix(in srgb,var(--accent) 6%,transparent)');
    expect(styleSource).toContain('#note-content{padding-bottom:1rem;scroll-padding-bottom:1rem;caret-color:var(--accent)}');
    expect(styleSource).not.toContain('.editor-source-wrap:focus-within{box-shadow:inset 3px 0 0 var(--accent)}');
    expect(styleSource).not.toMatch(/\.editor-current-line\{[^}]*transition:[^}]*\btop/);
  });

  test('softly aligns the preview anchor with the editor caret', async () => {
    const app = track(await createApp());

    expect(app.hooks.calculatePreviewScrollAdjustment({
      previewTop: 0,
      previewHeight: 200,
      previewScrollTop: 0,
      previewScrollHeight: 600,
      anchorTop: 300,
      caretTop: 100,
      margin: 30,
      deadband: 20,
    })).toBe(200);

    expect(app.hooks.calculatePreviewScrollAdjustment({
      previewTop: 0,
      previewHeight: 200,
      previewScrollTop: 100,
      previewScrollHeight: 600,
      anchorTop: 112,
      caretTop: 100,
      margin: 30,
      deadband: 20,
    })).toBe(0);
  });

  test('highlights the rendered block containing the caret', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading\n\n- first\n\n- second\n\n```text\ninside\n\ncode\n```\n\ntail'});
    app.hooks.updatePreview();

    const textarea = app.window.document.querySelector('#note-content');
    const codeOffset = textarea.value.indexOf('code');
    textarea.selectionStart = textarea.selectionEnd = codeOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[2].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('maps a caret inside a loose list to the exact list item', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '- first\n\n- second\n\nparagraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const secondItemOffset = content.indexOf('second');
    textarea.selectionStart = textarea.selectionEnd = secondItemOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    const items = [...blocks[0].querySelectorAll(':scope > li')];
    expect(blocks[0].tagName).toBe('UL');
    expect(blocks[0].classList.contains('highlight')).toBe(false);
    expect(items[0].classList.contains('highlight')).toBe(false);
    expect(items[1].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('highlights the deepest interactive list item containing the caret', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '- parent\n  - nested child\n- sibling';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('nested child');
    app.hooks.highlightBlock();

    const items = [...app.window.document.querySelectorAll('#preview li[data-interactive-start]')];
    const parentCard = items[0].querySelector(':scope > .interactive-preview-card');
    const nestedCard = items[1].querySelector(':scope > .interactive-preview-card');
    expect(parentCard.classList.contains('highlight')).toBe(false);
    expect(nestedCard.classList.contains('highlight')).toBe(true);
    expect(app.window.document.querySelector('#preview > ul').classList.contains('highlight')).toBe(false);
  });

  test('highlights blocks at their boundaries but not separator whitespace', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '# First\n\nfirst paragraph\n\n# Second\n\nsecond paragraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});
    app.hooks.updatePreview();

    const textarea = app.window.document.querySelector('#note-content');
    const blocks = [...app.window.document.querySelector('#preview').children];
    const positions = [
      {position: content.indexOf('# First') + '# First'.length, block: 0},
      {position: content.indexOf('\n\nfirst') + 1, block: -1},
      {position: content.indexOf('\n\n# Second') + 1, block: -1},
      {position: content.length, block: blocks.length - 1},
    ];

    for (const {position, block} of positions) {
      textarea.selectionStart = textarea.selectionEnd = position;
      app.hooks.highlightBlock();
      expect(blocks.filter(element => element.classList.contains('highlight'))).toHaveLength(block < 0 ? 0 : 1);
      if (block >= 0) expect(blocks[block].classList.contains('highlight')).toBe(true);
    }
  });

  test('maps a caret inside fenced code across blank lines to the code block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '```text\ninside\n\ncode\n```\n\ntail';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const codeOffset = content.indexOf('code');
    textarea.selectionStart = textarea.selectionEnd = codeOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[0].tagName).toBe('PRE');
    expect(blocks[0].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('does not use preview ranges from an older source while rendering is pending', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'first paragraph\n\nsecond paragraph'});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.value = 'short\n\nsecond';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.indexOf('second');
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks.every(block => !block.classList.contains('highlight'))).toBe(true);

    app.hooks.updatePreview();
    app.hooks.highlightBlock();
    const refreshedBlocks = [...app.window.document.querySelector('#preview').children];
    expect(refreshedBlocks[1].classList.contains('highlight')).toBe(true);
  });

  test('maps headings, blockquotes, thematic breaks, and tables to their blocks', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '> quoted\n\n## heading\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const preview = app.window.document.querySelector('#preview');
    const blocks = [...preview.children];
    expect(blocks.map(block => block.tagName)).toEqual(['BLOCKQUOTE', 'H2', 'HR', 'TABLE']);
    for (const [index, marker] of ['quoted', 'heading', '---', '| 1'].entries()) {
      textarea.selectionStart = textarea.selectionEnd = content.indexOf(marker);
      app.hooks.highlightBlock();
      expect(blocks[index].classList.contains('highlight')).toBe(true);
    }
  });

  test('maps a Setext heading to its rendered heading block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = 'Setext heading\n==============\n\nparagraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('Setext');
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks.map(block => block.tagName)).toEqual(['H1', 'P']);
    expect(blocks[0].classList.contains('highlight')).toBe(true);
  });

  test('maps rendered blocks after an omitted link-reference definition', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '[docs]: https://example.com\n\nParagraph with [docs].';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('Paragraph');
    app.hooks.highlightBlock();

    const paragraph = app.window.document.querySelector('#preview > p');
    expect(paragraph).not.toBeNull();
    expect(paragraph.classList.contains('highlight')).toBe(true);
  });

  test('highlighting does not change preview block geometry', () => {
    expect(styleSource).toMatch(/\.preview \.highlight\{[^}]*background:/);
    expect(styleSource).not.toMatch(/\.preview \.highlight\{[^}]*\bmargin:/);
    expect(styleSource).not.toMatch(/\.preview \.highlight\{[^}]*\bpadding:/);
    expect(styleSource).toContain('.preview p{margin:0 0 1em}');
  });

  test('escapes raw HTML, rejects unsafe resource URLs, and lazy-loads images', async () => {
    const app = track(await createApp());
    app.window.marked = {
      Renderer: class {},
      parse: (markdown, options) => [
        '<p>before</p>',
        options.renderer.html({text: '<form action="/delete"><input name="title"></form>'}),
        '<a href="javascript:alert(1)">unsafe link</a>',
        '<img src="https://example.com/image.png" alt="remote">',
        '<img src="data:text/html,unsafe" alt="blocked">',
      ].join(''),
    };

    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Note'});

    const preview = app.window.document.querySelector('#preview');
    expect(preview.querySelector('form')).toBeNull();
    expect(preview.textContent).toContain('<form action="/delete">');
    expect(preview.querySelector('a').getAttribute('href')).toBeNull();
    const remoteImage = preview.querySelector('img[src="https://example.com/image.png"]');
    expect(remoteImage).not.toBeNull();
    expect(remoteImage.getAttribute('loading')).toBe('lazy');
    expect(remoteImage.getAttribute('decoding')).toBe('async');
    expect(preview.querySelector('img[src^="data:"]')).toBeNull();
  });
});

describe('typed API outcomes', () => {
  test('preserves server status, stable code, and retry policy', async () => {
    const app = track(await createApp({fetchImpl: async () => response(409, JSON.stringify({error: 'note changed', code: 'note_revision_conflict'}))}));
    app.window.console.error = () => {};

    await expect(app.hooks.api('/api/notes/note-a')).rejects.toMatchObject({
      kind: 'http',
      responseStatus: 409,
      code: 'note_revision_conflict',
      retryable: false,
    });
  });

  test('classifies transport failures separately from HTTP errors', async () => {
    const app = track(await createApp({fetchImpl: async () => { throw new TypeError('network unavailable'); }}));
    app.window.console.error = () => {};

    await expect(app.hooks.api('/api/check')).rejects.toMatchObject({
      kind: 'network',
      responseStatus: 0,
      retryable: true,
    });
  });
});

describe('sync scheduling while hidden', () => {
  test('keeps pending sync work dormant until the tab becomes visible', async () => {
    const requests = [];
    const app = track(await createApp({
      fetchImpl: async url => {
        requests.push(url);
        const path = String(url);
        if (path.includes('/api/sync')) return response(200, {changes: [], nextSequence: 0, hasMore: false});
        if (path.endsWith('/api/notes')) return response(200, []);
        return response(200, {});
      },
    }));
    const setVisibility = value => Object.defineProperty(app.window.document, 'visibilityState', {value, configurable: true});

    setVisibility('hidden');
    app.hooks.scheduleSync({reconcile: true});
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(requests).toHaveLength(0);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {reconcile: true}});

    setVisibility('visible');
    app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
    expect(app.hooks.getSyncScheduleState().scheduled).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(requests.some(url => String(url).includes('/api/sync'))).toBe(true);
  });
});

describe('server change invalidation', () => {
  test('refreshes preferences without scheduling an unrelated note sync', async () => {
    const requests = [];
    const app = track(await createApp({
      fetchImpl: async path => {
        requests.push(String(path));
        if (String(path) === '/api/prefs') return response(200, {revision: 2, theme: 'default-light'});
        if (String(path).startsWith('/api/sync?')) return response(200, {changes: [], nextSequence: 0, hasMore: false});
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});

    await expect(app.hooks.handleServerChangeEvent({type: 'preferences', revision: 2})).resolves.toBe(true);
    await vi.waitFor(() => expect(requests.filter(path => path === '/api/prefs')).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(requests.some(path => path.startsWith('/api/sync?'))).toBe(false);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {}});
  });

  test('ignores a note event already covered by the local sync cursor', async () => {
    const app = track(await createApp());
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});
    await app.hooks.applyRemoteChangePage([], new Map(), 42);

    await expect(app.hooks.handleServerChangeEvent({type: 'notes', sequence: 42})).resolves.toBe(false);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {}});

    await expect(app.hooks.handleServerChangeEvent({type: 'notes', sequence: 43})).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(app.hooks.getSyncScheduleState().scheduled).toBe(true);
    app.hooks.cancelScheduledSync();
  });

  test('pulls again when a newer note event arrives during sync completion', async () => {
    let pullRequests = 0;
    const app = track(await createApp({
      deferredSyncCompletion: true,
      fetchImpl: async path => {
        if (!String(path).startsWith('/api/sync?')) throw new Error(`unexpected request: ${path}`);
        pullRequests++;
        return response(200, {changes: [], nextSequence: pullRequests > 1 ? 1 : 0, hasMore: false});
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});

    const sync = app.hooks.syncNow();
    await app.syncCompletionStarted;
    await app.hooks.handleServerChangeEvent({type: 'notes', sequence: 1});
    app.releaseSyncCompletion();
    await sync;

    await vi.waitFor(() => expect(pullRequests).toBe(2));
  });
});

describe('sync coordinator', () => {
  test('reports a durable queued edit as saved but waiting to sync', async () => {
    const app = track(await createApp());
    app.hooks.setEditorState({
      id: 'note-a', dirty: true, title: 'Note', content: 'local edit',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    await app.hooks.saveCurrentNote(false);
    await vi.waitFor(() => {
      const status = app.window.document.querySelector('#editor-status');
      expect(status).toMatchObject({
        dataset: expect.objectContaining({state: 'local'}),
        title: 'Saved on this device; waiting to sync',
      });
      expect(status.querySelector('.sync-indicator-label').textContent).toBe('Saved');
      expect(status.getAttribute('aria-label')).toBe('Saved on this device; waiting to sync');
    });
  });

  test('does not run a redundant follow-up for requests made during an idle sync', async () => {
    let markSyncStarted;
    let releaseSync;
    const syncStarted = new Promise(resolve => { markSyncStarted = resolve; });
    const syncGate = new Promise(resolve => { releaseSync = resolve; });
    let syncRequests = 0;
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path).startsWith('/api/sync?')) {
          syncRequests++;
          if (syncRequests === 1) {
            markSyncStarted();
            await syncGate;
          }
          return response(200, {changes: [], nextSequence: 0, hasMore: false});
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});

    const sync = app.hooks.syncNow();
    await syncStarted;
    app.hooks.scheduleSync();
    app.hooks.scheduleSync();
    releaseSync();
    await sync;
    await new Promise(resolve => setTimeout(resolve, 180));

    expect(syncRequests).toBe(1);
  });

  test('keeps one logical syncing state across pull, push, and final pull', async () => {
    let markPushStarted;
    let releasePush;
    const pushStarted = new Promise(resolve => { markPushStarted = resolve; });
    const pushGate = new Promise(resolve => { releasePush = resolve; });
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        const value = String(path);
        if (value.startsWith('/api/sync?')) return response(200, {changes: [], nextSequence: 0, hasMore: false});
        if (value === '/api/sync/push') {
          const request = JSON.parse(options.body);
          markPushStarted();
          await pushGate;
          return response(200, {
            acknowledged: request.operations.map(operation => ({
              client_sequence: operation.client_sequence,
              op_id: operation.op_id,
              status: 'applied',
              revision: 1,
            })),
            expected_sequence: request.operations.at(-1).client_sequence + 1,
          });
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});
    await app.hooks.putLocalNote({id: 'note-a', title: 'Note', tags: '', content: 'body', revision: 0, pending: true, base_revision: 0});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 0, note: {id: 'note-a', title: 'Note', tags: '', content: 'body', revision: 0}});

    const states = [];
    const status = app.window.document.querySelector('#sync-status');
    const observer = new app.window.MutationObserver(() => states.push(status.dataset.state));
    observer.observe(status, {attributes: true, subtree: true, childList: true});
    const sync = app.hooks.syncNow();
    await pushStarted;
    await new Promise(resolve => setTimeout(resolve, 180));
    releasePush();
    await sync;
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();

    expect(states.filter((state, index) => index === 0 || state !== states[index - 1])).toEqual(['syncing', 'online']);
  });

  test('flushes a local edit made during sync without starting an empty extra cycle', async () => {
    let markFirstPushStarted;
    let releaseFirstPush;
    const firstPushStarted = new Promise(resolve => { markFirstPushStarted = resolve; });
    const firstPushGate = new Promise(resolve => { releaseFirstPush = resolve; });
    let app;
    let pullRequests = 0;
    let pushRequests = 0;
    const fetchImpl = async (path, options) => {
      const value = String(path);
      if (value.startsWith('/api/sync?')) {
        pullRequests++;
        return response(200, {changes: [], nextSequence: 0, hasMore: false});
      }
      if (value === '/api/sync/push') {
        pushRequests++;
        const request = JSON.parse(options.body);
        if (pushRequests === 1) {
          markFirstPushStarted();
          await firstPushGate;
        }
        return response(200, {
          acknowledged: request.operations.map(operation => ({
            client_sequence: operation.client_sequence,
            op_id: operation.op_id,
            status: 'applied',
            revision: 1,
          })),
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        });
      }
      throw new Error(`unexpected request: ${path}`);
    };
    app = track(await createApp({fetchImpl}));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});
    const first = {id: 'note-a', title: 'Note', tags: '', content: 'first', revision: 0};
    await app.hooks.putLocalNote({...first, pending: true, base_revision: 0});
    await app.hooks.queueOperation({type: 'note.save', note_id: first.id, base_revision: 0, note: first});

    const sync = app.hooks.syncNow();
    await firstPushStarted;
    const second = {...first, content: 'second', pending: true, base_revision: 0};
    await app.hooks.putLocalNote(second);
    await app.hooks.queueOperation({type: 'note.save', note_id: second.id, base_revision: 0, note: second});
    app.hooks.scheduleSync();
    releaseFirstPush();
    await sync;
    await new Promise(resolve => setTimeout(resolve, 180));

    expect(pushRequests).toBe(2);
    expect(pullRequests).toBe(2);
  });

  test('shows a loading state instead of a final empty state during initial hydration', async () => {
    let markCheckStarted;
    let releaseCheck;
    const checkStarted = new Promise(resolve => { markCheckStarted = resolve; });
    const checkGate = new Promise(resolve => { releaseCheck = resolve; });
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/check') {
          markCheckStarted();
          await checkGate;
          return response(503, 'offline');
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};

    const startup = app.hooks.init();
    await checkStarted;
    expect(app.window.document.querySelector('#note-list').textContent).toContain('Loading notes');
    releaseCheck();
    await startup;
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

describe('F-01 editor save coordination', () => {
  test('returns to the dashboard with one Back after closing note preferences', async () => {
    const app = track(await createApp());
    app.hooks.showNoteInEditor({id: 'note-a', revision: 1, title: 'Note', tags: '', content: 'saved version'});
    app.window.history.replaceState({app: 'vylk', screen: 'dashboard'}, '', '/');
    app.window.history.pushState({app: 'vylk', screen: 'note', noteID: 'note-a'}, '', '/note-a');

    app.window.document.querySelector('#editor-prefs-btn').click();
    expect(app.window.location.pathname).toBe('/preferences');
    app.window.document.querySelector('#prefs-close').click();
    await vi.waitFor(() => expect(app.window.location.pathname).toBe('/note-a'));

    app.window.document.querySelector('#back-btn').click();
    await vi.waitFor(() => {
      expect(app.window.location.pathname).toBe('/');
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(false);
    });
  });

  test('returns to the dashboard without waiting for an in-flight network sync', async () => {
    let resolvePushStarted;
    let releasePush;
    const pushStarted = new Promise(resolve => { resolvePushStarted = resolve; });
    const pushGate = new Promise(resolve => { releasePush = resolve; });
    const app = track(await createApp({
      fetchImpl: async (path, options = {}) => {
        const url = String(path);
        if (url.startsWith('/api/sync?')) {
          return response(200, {changes: [], nextSequence: 0, hasMore: false});
        }
        if (url === '/api/sync/push') {
          resolvePushStarted();
          await pushGate;
          const payload = JSON.parse(options.body);
          return response(200, {
            acknowledged: payload.operations.map(operation => ({
              op_id: operation.op_id,
              status: 'applied',
              revision: 1,
            })),
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    }));
    app.hooks.showNoteInEditor({id: 'note-a', revision: 0, title: 'Note', tags: '', content: 'saved version'});
    app.window.history.replaceState({app: 'vylk', screen: 'dashboard'}, '', '/');
    app.window.history.pushState({app: 'vylk', screen: 'note', noteID: 'note-a'}, '', '/note-a');
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Note',
      content: 'new version',
      savedSnapshot: {title: 'Note', tags: '', content: 'saved version'},
    });

    const save = app.hooks.saveCurrentNote();
    await pushStarted;
    app.window.document.querySelector('#back-btn').click();

    let navigationError;
    try {
      await vi.waitFor(() => {
        expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(false);
        expect(app.window.location.pathname).toBe('/');
      }, {timeout: 250});
    } catch (error) {
      navigationError = error;
    } finally {
      releasePush();
      await save;
    }

    await vi.waitFor(() => {
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(false);
      expect(app.window.location.pathname).toBe('/');
    });
    expect(navigationError).toBeUndefined();
  });

  test('drains an edit made while the previous local save is in flight', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Note',
      content: 'first version',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const firstSave = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;

    app.window.document.querySelector('#note-content').value = 'newest version';
    app.hooks.markDirty();
    const secondSave = app.hooks.saveCurrentNote(false);
    expect(secondSave).toBe(firstSave);

    app.releaseFirstSave();
    await firstSave;

    expect(app.saveCalls).toHaveLength(2);
    expect(app.saveCalls[0].note.content).toBe('first version');
    expect(app.saveCalls[1].note.content).toBe('newest version');
    expect(app.hooks.getState()).toMatchObject({
      currentNoteId: 'note-a',
      isDirty: false,
      savedSnapshot: {content: 'newest version'},
    });
  });

  test('does not let an old save completion mutate a newly opened note', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Old note',
      content: 'old content',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const save = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;
    app.hooks.showNoteInEditor({id: 'note-b', revision: 4, title: 'New note', tags: '', content: 'new content'});
    app.releaseFirstSave();
    await save;

    expect(app.saveCalls).toHaveLength(1);
    expect(app.hooks.getState()).toMatchObject({
      currentNoteId: 'note-b',
      currentRevision: 4,
      isDirty: false,
      savedSnapshot: {title: 'New note', content: 'new content'},
    });
  });

  test('drains the latest snapshot before exposing the new-note action', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.showNoteInEditor({id: 'note-a', revision: 1, title: 'Old note', tags: '', content: 'saved version'});
    app.window.history.replaceState({}, '', '/note-a');
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Old note',
      content: 'first version',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const firstSave = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;
    app.window.document.querySelector('#note-content').value = 'newest version';
    app.hooks.markDirty();
    app.hooks.saveCurrentNote(false);

    app.window.document.querySelector('#back-btn').click();
    expect(app.window.document.querySelector('#new-note-btn').closest('#dashboard').classList.contains('hidden')).toBe(true);
    app.releaseFirstSave();
    await firstSave;
    await vi.waitFor(() => {
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(false);
      expect(app.window.location.pathname).toBe('/');
    });

    expect(app.saveCalls).toHaveLength(2);
    expect(app.saveCalls[1]).toMatchObject({
      note: {id: 'note-a', content: 'newest version'},
      operation: {note_id: 'note-a'},
    });

    app.window.document.querySelector('#new-note-btn').click();
    expect(app.hooks.getState().currentNoteId).not.toBe('note-a');
  });
});

describe('F-02 immutable queue operations', () => {
  test('appends a new identity after an operation has been attempted', async () => {
    const app = track(await createApp());
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'first'},
    });
    const first = (await app.hooks.pendingOperations())[0];
    const attempted = await app.hooks.claimQueueOperation(first.id);

    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'second'},
    });

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({id: first.id, op_id: first.op_id, attempted_at: expect.any(String)});
    expect(pending[0].note.content).toBe('first');
    expect(pending[1].note.content).toBe('second');
    expect(pending[1].op_id).not.toBe(first.op_id);

    expect(await app.hooks.removePendingOperationIfIdentityMatches(attempted.id, attempted)).toBe(true);
    expect((await app.hooks.pendingOperations()).map(operation => operation.note.content)).toEqual(['second']);
  });

  test('does not self-conflict when a newer note save is queued during an earlier push', async () => {
    let revision = 1;
    let remote = {id: 'note-a', title: 'Note', tags: '', content: 'base', revision};
    const pushes = [];
    const app = track(await createApp({
      fetchImpl: async (path, options = {}) => {
        if (String(path) === '/api/sync/push') {
          const request = JSON.parse(options.body);
          pushes.push(request.operations);
          const acknowledged = request.operations.map(operation => {
            if (operation.base_revision !== revision) {
              return {
                client_sequence: operation.client_sequence,
                op_id: operation.op_id,
                status: 'conflict',
                current_revision: revision,
              };
            }
            revision++;
            remote = {...remote, title: operation.title, tags: operation.tags, content: operation.content, revision};
            return {
              client_sequence: operation.client_sequence,
              op_id: operation.op_id,
              status: 'applied',
              revision,
            };
          });
          return response(200, JSON.stringify({
            acknowledged,
            expected_sequence: request.operations.at(-1).client_sequence + 1,
          }));
        }
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        throw new Error(`unexpected request: ${path}`);
      },
    }));

    await app.hooks.putLocalNote({
      ...remote,
      pending: true,
      base_revision: revision,
      base_content: remote.content,
      base_title: remote.title,
      base_tags: remote.tags,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: revision,
      note: {...remote, content: 'first edit', base_revision: revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags},
    });
    const first = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(first.id);

    await app.hooks.putLocalNote({
      ...remote,
      content: 'newest edit',
      pending: true,
      base_revision: revision,
      base_content: remote.content,
      base_title: remote.title,
      base_tags: remote.tags,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: revision,
      note: {...remote, content: 'newest edit', base_revision: revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags},
    });

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toHaveLength(1);
    expect(pushes[1]).toHaveLength(1);
    expect(pushes[1][0].base_revision).toBe(2);
    expect(remote.content).toBe('newest edit');
    expect(app.window.document.querySelector('#toast-region').textContent).not.toContain('conflict');
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });

  test('does not overwrite a remote edit when a stale pin precedes a local save', async () => {
    let revision = 3;
    let remote = {
      id: 'note-a', title: 'Note', tags: '',
      content: 'one\ntwo\nthree\nremote change',
      revision, pinned: false, pin_order: 0,
    };
    const app = track(await createApp({
      realMerge: true,
      fetchImpl: async (path, options = {}) => {
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        const acknowledged = request.operations.map(operation => {
          if (operation.type !== 'noop' && operation.base_revision !== revision) {
            return {op_id: operation.op_id, status: 'conflict', current_revision: revision};
          }
          if (operation.type === 'noop') return {op_id: operation.op_id, status: 'applied'};
          revision++;
          if (operation.type === 'note.save') {
            remote = {...remote, title: operation.title, tags: operation.tags, content: operation.content, revision};
          } else if (operation.type === 'note.pin') {
            remote = {...remote, pinned: operation.pinned, pin_order: operation.pinned ? 9 : 0, revision};
          }
          return {op_id: operation.op_id, status: 'applied', revision, pin_order: remote.pin_order};
        });
        return response(200, JSON.stringify({
          acknowledged,
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        }));
      },
    }));
    const base = 'one\ntwo\nthree\nfour';
    const localContent = 'one\nlocal change\nthree\nfour';
    await app.hooks.putLocalNote({
      ...remote, content: localContent, revision: 2, pinned: true, pin_order: 5,
      pending: true, base_revision: 2, base_content: base, base_title: 'Note', base_tags: '',
    });
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});
    await app.hooks.queueOperation({
      type: 'note.save', note_id: 'note-a', base_revision: 2,
      note: {id: 'note-a', title: 'Note', tags: '', content: localContent, revision: 2, pinned: true, base_revision: 2, base_content: base, base_title: 'Note', base_tags: ''},
    });

    await app.hooks.flushPendingChanges();

    expect(remote.content).toBe('one\nlocal change\nthree\nremote change');
  });

  test('preserves a later pin when an earlier save conflicts', async () => {
    let revision = 2;
    let remote = {
      id: 'note-a', title: 'Note', tags: '',
      content: 'one\ntwo\nthree\nremote change',
      revision, pinned: false, pin_order: 0,
    };
    const app = track(await createApp({
      realMerge: true,
      fetchImpl: async (path, options = {}) => {
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        const acknowledged = request.operations.map(operation => {
          if (operation.type !== 'noop' && operation.base_revision !== revision) {
            return {op_id: operation.op_id, status: 'conflict', current_revision: revision};
          }
          if (operation.type === 'noop') return {op_id: operation.op_id, status: 'applied'};
          revision++;
          if (operation.type === 'note.save') {
            remote = {...remote, title: operation.title, tags: operation.tags, content: operation.content, pinned: operation.pinned, revision, pin_order: operation.pinned ? 12 : 0};
          } else if (operation.type === 'note.pin') {
            remote = {...remote, pinned: operation.pinned, revision, pin_order: operation.pinned ? 12 : 0};
          }
          return {op_id: operation.op_id, status: 'applied', revision, pin_order: remote.pin_order};
        });
        return response(200, JSON.stringify({acknowledged, expected_sequence: request.operations.at(-1).client_sequence + 1}));
      },
    }));
    const base = 'one\ntwo\nthree\nfour';
    const localContent = 'one\nlocal change\nthree\nfour';
    await app.hooks.putLocalNote({
      ...remote, content: localContent, revision: 1, pinned: true, pin_order: 5,
      pending: true, base_revision: 1, base_content: base, base_title: 'Note', base_tags: '',
    });
    await app.hooks.queueOperation({
      type: 'note.save', note_id: 'note-a', base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: localContent, revision: 1, pinned: false, base_revision: 1, base_content: base, base_title: 'Note', base_tags: ''},
    });
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 1, pinned: true, pin_order: 5});

    await app.hooks.flushPendingChanges();

    expect(remote).toMatchObject({
      content: 'one\nlocal change\nthree\nremote change',
      pinned: true,
    });
  });

  test('allows only one tab to hold the fallback sync lease', async () => {
    const firstTab = track(await createApp());
    const secondTab = track(await createApp());
    let release;
    let resolveStarted;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });

    const leaderRun = firstTab.hooks.withSyncLeadership(async () => {
      resolveStarted();
      await gate;
      return 'leader';
    });
    await started;
    expect(await secondTab.hooks.withSyncLeadership(() => 'unexpected follower')).toBe(false);
    secondTab.hooks.cancelScheduledSync();
    release();
    expect(await leaderRun).toBe('leader');
  });

  test('does not fall through to the fallback lease when a Web Lock is held', async () => {
    const app = track(await createApp());
    Object.defineProperty(app.window.navigator, 'locks', {
      configurable: true,
      value: {request: vi.fn(async (_name, _options, callback) => callback(null))},
    });
    const work = vi.fn(() => 'unexpected leader');

    expect(await app.hooks.withSyncLeadership(work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    app.hooks.cancelScheduledSync();
  });
});

describe('F-03 compacted acknowledgement recovery', () => {
  async function queueAttemptedNote(app) {
    const note = {
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Local',
      tags: '',
      content: 'local content',
      revision: 2,
      base_revision: 2,
      base_content: 'remote base',
      base_title: 'Local',
      base_tags: '',
      pending: true,
    };
    await app.hooks.saveLocalNoteAndQueue(note, {
      type: 'note.save',
      note_id: note.id,
      base_revision: note.base_revision,
      note,
    });
    const queued = (await app.hooks.pendingOperations())[0];
    return app.hooks.claimQueueOperation(queued.id);
  }

  test('keeps the queue and local note when reconciliation times out', async () => {
    const app = track(await createApp({fetchImpl: async () => response(503, 'temporary failure')}));
    app.window.console.error = () => {};
    const operation = await queueAttemptedNote(app);

    await expect(app.hooks.acknowledgeCompactedOperation(operation)).rejects.toMatchObject({responseStatus: 503});
    expect(await app.hooks.pendingOperations()).toHaveLength(1);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: true, content: 'local content'});
  });

  test('removes local state only after an authoritative 404', async () => {
    const app = track(await createApp({fetchImpl: async () => response(404)}));
    app.window.console.error = () => {};
    const operation = await queueAttemptedNote(app);

    await app.hooks.acknowledgeCompactedOperation(operation);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
  });

  test('applies the authoritative remote note and clears pending state', async () => {
    const remote = {id: 'note-a', filename: 'note-a.md', title: 'Remote', tags: 'work', content: 'remote content', revision: 9};
    const app = track(await createApp({fetchImpl: async () => response(200, JSON.stringify(remote))}));
    const operation = await queueAttemptedNote(app);

    await app.hooks.acknowledgeCompactedOperation(operation);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({...remote, pending: false, base_revision: null});
  });
});

describe('conflict deletion recovery', () => {
  async function createDeletedConflictApp() {
    let remoteReads = 0;
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) === '/api/sync/push') {
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          return response(200, JSON.stringify({
            acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'conflict', current_revision: 2}],
            expected_sequence: operation.client_sequence + 1,
          }));
        }
        if (String(path) === '/api/notes/note-a') {
          remoteReads++;
          return response(404);
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local edit', content: 'Keep this', pending: true});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Local edit', content: 'Keep this'},
    });
    return {app, getRemoteReads: () => remoteReads};
  }

  test('persists the decision and keeps local content when the remote note was deleted', async () => {
    const {app, getRemoteReads} = await createDeletedConflictApp();

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(getRemoteReads()).toBe(1);
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({kind: 'remote-deleted', note_id: 'note-a'});
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: false, content: 'Keep this'});
    expect(app.window.document.querySelector('#conflict-title').textContent).toBe('Note deleted on another device');

    app.window.document.querySelector('#conflict-later').click();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({kind: 'remote-deleted'});

    app.hooks.setEditorState({id: 'note-a', dirty: true, title: 'Updated locally', content: 'Newer local content'});
    await app.hooks.saveCurrentNote(false);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({
      local: {title: 'Updated locally', content: 'Newer local content'},
    });
  });

  test('keeps the local version as a new note when requested', async () => {
    const {app} = await createDeletedConflictApp();

    await app.hooks.flushPendingChanges();
    app.window.document.querySelector('#conflict-copy').click();
    let pending = [];
    for (let attempt = 0; attempt < 20 && !pending.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      pending = await app.hooks.pendingOperations();
    }
    app.hooks.cancelScheduledSync();

    expect(pending).toHaveLength(1);
    expect(pending[0].note_id).not.toBe('note-a');
    expect(pending[0].note).toMatchObject({title: 'Local edit (conflict copy)', content: 'Keep this'});
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toBeUndefined();
  });

  test('discards the local version only when deletion is accepted', async () => {
    const {app} = await createDeletedConflictApp();

    await app.hooks.flushPendingChanges();
    app.window.document.querySelector('#conflict-save').click();
    let localNote;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      localNote = await app.hooks.getLocalNote('note-a');
      if (!localNote) break;
    }
    app.hooks.cancelScheduledSync();

    expect(localNote).toBeUndefined();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toBeUndefined();
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });

  test('keeps the original operation when the remote lookup fails transiently', async () => {
    let pushCount = 0;
    let remoteReads = 0;
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) === '/api/sync/push') {
          pushCount++;
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          return response(200, JSON.stringify({
            acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'conflict', current_revision: 2}],
            expected_sequence: operation.client_sequence + 1,
          }));
        }
        if (String(path) === '/api/notes/note-a') {
          remoteReads++;
          return response(503, 'temporary failure');
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local edit', content: 'Keep this', pending: true});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Local edit', content: 'Keep this'},
    });

    await expect(app.hooks.flushPendingChanges()).rejects.toMatchObject({responseStatus: 503});

    expect(pushCount).toBe(1);
    expect(remoteReads).toBe(1);
    expect(await app.hooks.pendingOperations()).toHaveLength(1);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: true, content: 'Keep this'});
  });
});

describe('F-04 service worker revisions', () => {
  test('does not register a provisional legacy revision before the server revision is known', async () => {
    const register = vi.fn(async () => {});
    track(await createApp({serviceWorker: {register}}));

    expect(register).not.toHaveBeenCalled();
  });

  test('registers the worker with the server-provided frontend revision', async () => {
    const register = vi.fn(async () => {});
    const app = track(await createApp({serviceWorker: {register}}));
    register.mockClear();

    app.hooks.registerServiceWorker('frontend-hash-123');
    await Promise.resolve();

    expect(register).toHaveBeenCalledWith('/sw.js?revision=frontend-hash-123', {updateViaCache: 'none'});
  });
});

describe('startup responsiveness', () => {
  test('shows a cached note before a slow server check completes', async () => {
    let markCheckStarted;
    let releaseCheck;
    const checkStarted = new Promise(resolve => { markCheckStarted = resolve; });
    const checkGate = new Promise(resolve => { releaseCheck = resolve; });
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/check') {
          markCheckStarted();
          await checkGate;
          return response(503, 'offline');
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Cached note',
      tags: '',
      content: 'Available immediately',
      revision: 1,
      pending: false,
    });
    app.window.history.replaceState({}, '', '/note-a');

    const startup = app.hooks.init();
    await checkStarted;

    expect(app.window.document.querySelector('#app').classList.contains('booting')).toBe(false);
    expect(app.window.document.querySelector('#editor').classList.contains('hidden')).toBe(false);
    expect(app.window.document.querySelector('#note-title').value).toBe('Cached note');

    releaseCheck();
    await startup;
  });
});

describe('remote deletion coordination', () => {
  test('preserves a note while a local operation is pending', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local edit', content: 'Keep me', pending: true});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 1, note: {id: 'note-a', content: 'Keep me'}});

    expect(await app.hooks.applyRemoteDeletion('note-a')).toBe(false);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({title: 'Local edit', content: 'Keep me'});
  });
});

describe('permanent queue rejection recovery', () => {
  test('quarantines a rejected head operation and replays its sequence as a noop', async () => {
    let pushCount = 0;
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        const operation = request.operations[0];
        pushCount++;
        if (pushCount === 1) {
          return response(400, JSON.stringify({
            error: 'invalid note save operation',
            code: 'invalid_sync_operation',
            permanent: true,
            op_id: operation.op_id,
          }));
        }
        if (pushCount === 2) {
          expect(request.operations).toHaveLength(1);
          expect(operation.type).toBe('note.save');
          return response(400, JSON.stringify({error: 'invalid note save operation', permanent: true, op_id: operation.op_id}));
        }
        if (pushCount === 3) expect(operation.type).toBe('noop');
        else expect(operation.type).toBe('note.save');
        return response(200, JSON.stringify({
          acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'applied', revision: pushCount === 3 ? undefined : 1}],
          expected_sequence: operation.client_sequence + 1,
        }));
      },
    }));
    await app.hooks.putLocalNote({id: 'note-a', title: 'Too large', content: 'Keep locally', pending: true});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Too large', content: 'Keep locally'},
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-b',
      base_revision: 0,
      note: {id: 'note-b', title: 'Later note', content: 'Continue syncing'},
    });

    expect(await app.hooks.flushPendingChanges()).toBe(true);
    expect(pushCount).toBe(4);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getOfflineState('rejectedSync:note-a')).toMatchObject({type: 'note.save'});
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: true, content: 'Keep locally'});
  });
});

describe('batched queue flushing', () => {
  test('keeps the conflict base local when syncing a large edited note', async () => {
    let pushBody = '';
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        pushBody = options.body;
        const request = JSON.parse(pushBody);
        const operation = request.operations[0];
        return response(200, JSON.stringify({
          acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'applied', revision: 2}],
          expected_sequence: operation.client_sequence + 1,
        }));
      },
    }));
    const baseContent = 'a'.repeat(3_310_106);
    const content = `${baseContent.slice(0, -1)}b`;
    await app.hooks.putLocalNote({
      id: 'large-note', title: 'Large note', tags: '', content,
      revision: 1, pending: true, base_revision: 1, base_content: baseContent,
    });
    await app.hooks.queueOperation({
      type: 'note.save', note_id: 'large-note', base_revision: 1,
      note: {id: 'large-note', title: 'Large note', tags: '', content, base_revision: 1, base_content: baseContent},
    });

    const queued = (await app.hooks.pendingOperations())[0];
    expect(queued.note.base_content).toBe(baseContent);
    await app.hooks.flushPendingChanges();

    const sent = JSON.parse(pushBody).operations[0];
    expect(new TextEncoder().encode(pushBody).byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(sent.content).toBe(content);
    expect(sent).not.toHaveProperty('base_content');
  });

  test('sends ordered pending operations in one bounded push', async () => {
    const requests = [];
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        requests.push(request);
        return response(200, JSON.stringify({
          acknowledged: request.operations.map((operation, index) => ({
            client_sequence: operation.client_sequence,
            op_id: operation.op_id,
            status: 'applied',
            revision: index + 1,
          })),
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        }));
      },
    }));
    for (const [index, id] of ['note-a', 'note-b', 'note-c'].entries()) {
      await app.hooks.queueOperation({
        type: 'note.save',
        note_id: id,
        base_revision: 0,
        note: {id, title: `Note ${index}`, content: `Content ${index}`},
      });
    }

    await app.hooks.flushPendingChanges();
    expect(requests).toHaveLength(1);
    expect(requests[0].operations.map(operation => operation.note_id)).toEqual(['note-a', 'note-b', 'note-c']);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });
});

describe('batched remote application', () => {
  test('applies a change page and cursor in one logical local update', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Old', content: 'Old content', revision: 1});
    await app.hooks.putLocalNote({id: 'note-b', title: 'Delete me', content: 'Remove', revision: 1});
    const remote = {id: 'note-a', title: 'New', tags: 'work', content: 'New content', revision: 2};

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', deleted: false}, {note_id: 'note-b', deleted: true}],
      new Map([['note-a', remote]]),
      42,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({...remote, pending: false});
    expect(await app.hooks.getLocalNote('note-b')).toBeUndefined();
    expect(await app.hooks.getOfflineState('syncSequence')).toBe(42);
  });
});

describe('sync request lifecycle', () => {
  test('tracks and cancels a pull-style request through the shared manager', async () => {
    let markStarted;
    let release;
    let signal;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        signal = options.signal;
        markStarted();
        await gate;
        return response(200, '{}');
      },
    }));
    const request = app.hooks.api('/api/sync?since=0', {syncRequest: true});
    await started;
    expect(app.window.document.querySelector('#sync-status').dataset.state).toBe('syncing');
    app.hooks.cancelActiveSyncRequests();
    expect(signal.aborted).toBe(true);
    release();
    await request;
    expect(app.window.document.querySelector('#sync-status').dataset.state).toBe('online');
  });
});

describe('preference sync coordination', () => {
  test('syncs every Google font fetch switch as preference patches', async () => {
    const app = track(await createApp());

    for (const selector of ['#pref-font-google', '#pref-editor-font-google', '#pref-preview-font-google', '#pref-zen-font-google']) {
      const fetchFonts = app.window.document.querySelector(selector);
      fetchFonts.checked = true;
      fetchFonts.dispatchEvent(new app.window.Event('change'));
      expect(fetchFonts.checked).toBe(true);
    }
    app.hooks.cancelScheduledSync();

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].prefs._sync_patch).toEqual({
      fontFamilyGoogle: true,
      editorFontFamilyGoogle: true,
      previewFontFamilyGoogle: true,
      zenFontFamilyGoogle: true,
    });
  });

  test('restores Google font fetch switches from remote preferences', async () => {
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/prefs') return response(200, JSON.stringify({
          revision: 2,
          autoSave: true,
          fontFamily: 'Inter',
          fontFamilyGoogle: true,
          editorFontFamily: 'system-monospace',
          editorFontFamilyGoogle: false,
          previewFontFamily: 'system-sans',
          previewFontFamilyGoogle: false,
        }));
        throw new Error(`unexpected request: ${path}`);
      },
    }));

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    await app.hooks.loadPrefs();
    expect(fetchFonts.checked).toBe(true);
  });

  test('restores and normalizes the global content width preference', async () => {
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/prefs') return response(200, JSON.stringify({
          revision: 2,
          autoSave: true,
          contentWidth: 'full',
        }));
        throw new Error(`unexpected request: ${path}`);
      },
    }));

    await app.hooks.loadPrefs();
    expect(app.window.document.documentElement.dataset.contentWidth).toBe('full');

    app.window.fetch = async path => {
      if (String(path) === '/api/prefs') return response(200, JSON.stringify({
        revision: 3,
        autoSave: true,
        contentWidth: 'not-a-width',
      }));
      throw new Error(`unexpected request: ${path}`);
    };
    await app.hooks.loadPrefs();
    expect(app.window.document.documentElement.dataset.contentWidth).toBe('standard');
  });

  test('restores font sizes from remote preferences and defaults missing sizes', async () => {
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/prefs') return response(200, JSON.stringify({
          revision: 2,
          autoSave: true,
          fontSize: '1.1rem',
          editorFontSize: 'bad-size',
          previewFontSize: '3rem',
        }));
        throw new Error(`unexpected request: ${path}`);
      },
    }));

    await app.hooks.loadPrefs();
    const root = app.window.document.documentElement;
    expect(root.style.getPropertyValue('--font-size')).toBe('1.1rem');
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('1rem');
    expect(root.style.getPropertyValue('--preview-font-size')).toBe('1rem');
  });

  test('coalesces preference changes into field-level patches', async () => {
    const app = track(await createApp());

    await app.hooks.savePref('theme', 'default-dark');
    await app.hooks.savePref('accentColor', '#123456');
    await app.hooks.savePref('saveButtonLocation', 'header');
    app.hooks.cancelScheduledSync();

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].base_revision).toBe(1);
    expect(pending[0].prefs._sync_patch).toEqual({theme: 'default-dark', accentColor: '#123456', saveButtonLocation: 'header'});
    expect(pending[0].prefs._sync_base).toEqual({theme: 'default-light', accentColor: '', saveButtonLocation: 'panel'});
  });

  test('surfaces same-field preference conflicts and keeps the remote value', async () => {
    const remote = {
      revision: 2,
      autoSave: true,
      startView: 'split',
      hideToolbar: false,
      collapseDetails: false,
      hideCursorHighlight: false,
      theme: 'solarized-dark',
      accentColor: '',
      fontFamily: 'system-sans',
      editorFontFamily: 'system-monospace',
      previewFontFamily: 'system-sans',
    };
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) === '/api/sync/push') {
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          return response(200, JSON.stringify({
            acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'conflict', current_revision: 2}],
            expected_sequence: operation.client_sequence + 1,
          }));
        }
        if (String(path) === '/api/prefs') return response(200, JSON.stringify(remote));
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.savePref('theme', 'default-dark');
    app.hooks.cancelScheduledSync();

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(JSON.parse(app.window.localStorage.getItem('vylk-prefs'))).toMatchObject({theme: 'solarized-dark', revision: 2});
    expect(app.window.document.querySelector('#toast-region').textContent).toContain('Some preferences changed on another device');
  });
});

describe('deep-link restoration', () => {
  test('fetches an uncached deep-linked note before declaring it missing', async () => {
    const remote = {id: 'note-a', filename: 'note-a.md', title: 'Remote note', tags: 'work', content: 'Loaded directly', revision: 4};
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.history.replaceState({}, '', '/note-a');

    await app.hooks.restoreRoute({fetchRemote: true});

    expect(app.window.location.pathname).toBe('/note-a');
    expect(app.window.document.querySelector('#note-title').value).toBe('Remote note');
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject(remote);
  });
});

describe('logout storage cleanup', () => {
  test('waits for other database connections before reporting cleanup complete', async () => {
    const first = track(await createApp());
    const originalIndexedDB = first.window.indexedDB;
    let deleteRequest;
    Object.defineProperty(first.window, 'indexedDB', {
      configurable: true,
      value: {
        deleteDatabase: () => {
          deleteRequest = {};
          setTimeout(() => deleteRequest.onblocked?.(), 0);
          return deleteRequest;
        },
      },
    });

    let completed = false;
    const cleanup = first.hooks.clearOfflineData().then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);

    deleteRequest.onsuccess();
    await cleanup;
    expect(completed).toBe(true);
    Object.defineProperty(first.window, 'indexedDB', {configurable: true, value: originalIndexedDB});
  });
});

describe('note pinning', () => {
  test('folds a pin into an unsynced note save', async () => {
    const app = track(await createApp());
    const note = {id: 'new-note', title: 'New', tags: '', content: 'body', revision: 0, base_revision: 0, pending: true};
    await app.hooks.putLocalNote(note);
    await app.hooks.queueOperation({type: 'note.save', note_id: note.id, base_revision: 0, note});

    await app.hooks.toggleNotePin(note.id);

    const operations = await app.hooks.pendingOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({type: 'note.save', base_revision: 0, note: {pinned: true}});
    expect(await app.hooks.getLocalNote(note.id)).toMatchObject({pinned: true, pending: true});
  });

  test('keeps a newer pin made after an initial save was claimed', async () => {
    const app = track(await createApp());
    const note = {id: 'new-note', title: 'New', tags: '', content: 'body', revision: 0, base_revision: 0, pending: true, pinned: false, pin_order: 0};
    await app.hooks.putLocalNote(note);
    await app.hooks.queueOperation({type: 'note.save', note_id: note.id, base_revision: 0, note});
    const save = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(save.id);
    await app.hooks.toggleNotePin(note.id);
    const pinnedLocally = await app.hooks.getLocalNote(note.id);

    await app.hooks.applySyncAcknowledgement(save, {status: 'applied', revision: 1});

    expect(await app.hooks.getLocalNote(note.id)).toMatchObject({pinned: true, pin_order: pinnedLocally.pin_order, revision: 1, pending: true, base_revision: 1});
    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.pin', pinned: true, base_revision: 1}),
    ]));
  });


  test('filters before sorting and queues an offline pin without changing content', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'pinned-work', title: 'Pinned work', tags: 'work', content: 'keep', updated_at: '2026-01-01T00:00:00Z', revision: 2, pinned: true, pin_order: 10});
    await app.hooks.putLocalNote({id: 'recent-work', title: 'Recent work', tags: 'work', content: 'recent', updated_at: '2026-02-01T00:00:00Z', revision: 2});
    await app.hooks.putLocalNote({id: 'pinned-home', title: 'Pinned home', tags: 'home', content: 'hidden', updated_at: '2026-03-01T00:00:00Z', revision: 2, pinned: true, pin_order: 20});

    const notes = await app.hooks.getLocalNotes();
    expect(notes.map(note => note.id)).toEqual(['pinned-home', 'pinned-work', 'recent-work']);
    expect(notes.filter(note => (note.tags || '').split(',').includes('work')).map(note => note.id)).toEqual(['pinned-work', 'recent-work']);

    await app.hooks.toggleNotePin('recent-work');
    expect(await app.hooks.getLocalNote('recent-work')).toMatchObject({content: 'recent', pinned: true, pending: true});
    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.pin', note_id: 'recent-work', pinned: true, base_revision: 2}),
    ]));

    await app.hooks.toggleNotePin('recent-work');
    const pinOperations = (await app.hooks.pendingOperations()).filter(operation => operation.note_id === 'recent-work' && operation.type === 'note.pin');
    expect(pinOperations).toHaveLength(1);
    expect(pinOperations[0].pinned).toBe(false);
    expect(await app.hooks.getLocalNote('recent-work')).toMatchObject({content: 'recent', pinned: false, pin_order: 0});
  });

  test('does not let a remote pin update replace a pending local pin', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local', content: 'keep', revision: 2, pending: true, base_revision: 2, pinned: true, pin_order: 42});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', revision: 3, deleted: false}],
      new Map([['note-a', {id: 'note-a', title: 'Remote', content: 'replace', revision: 3, pinned: false, pin_order: 0}]]),
      3,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'keep', pinned: true, pin_order: 42, pending: true});
  });

  test('does not accept remote deletion while a pin operation is queued', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Pinned locally', content: 'keep', revision: 2, pinned: true, pin_order: 9});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});

    await expect(app.hooks.applyRemoteDeletion('note-a')).resolves.toBe(false);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'keep', pinned: true});
  });

  test('rebases a later content save after a pin acknowledgement', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Note', content: 'body', revision: 1, pinned: false});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 1, pinned: true});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 1, note: {id: 'note-a', title: 'Note', tags: '', content: 'edited'}});
    const pin = (await app.hooks.pendingOperations()).find(operation => operation.type === 'note.pin');

    await app.hooks.applySyncAcknowledgement(pin, {status: 'applied', op_id: pin.op_id, revision: 2, pin_order: 11});

    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.save', note_id: 'note-a', base_revision: 2}),
    ]));
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: true, pin_order: 11, revision: 2});
  });

  test('does not let an older pin acknowledgement undo a newer toggle', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Note', content: 'body', revision: 1, pinned: true, pin_order: 10, pending: true, base_revision: 1});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 1, pinned: true, pin_order: 10});
    const firstPin = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(firstPin.id);
    await app.hooks.toggleNotePin('note-a');

    await app.hooks.applySyncAcknowledgement(firstPin, {status: 'applied', revision: 2, pin_order: 11});

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: false, pin_order: 0, revision: 2, pending: true, base_revision: 2});
    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.pin', pinned: false, base_revision: 2}),
    ]));
  });

  test('does not retry a stale pin over a newer toggle after conflict', async () => {
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'body', revision: 3, pinned: false, pin_order: 0};
    const app = track(await createApp({fetchImpl: async path => String(path) === '/api/notes/note-a' ? response(200, JSON.stringify(remote)) : response(200, '{}')}));
    await app.hooks.putLocalNote({...remote, revision: 2, pinned: true, pin_order: 10, pending: true, base_revision: 2});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true, pin_order: 10});
    const firstPin = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(firstPin.id);
    await app.hooks.toggleNotePin('note-a');

    await app.hooks.applySyncAcknowledgement(firstPin, {status: 'conflict', current_revision: 3});

    const remaining = await app.hooks.pendingOperations();
    expect(remaining.filter(operation => operation.type === 'note.pin')).toEqual([
      expect.objectContaining({pinned: false, base_revision: 3}),
    ]);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: false, pin_order: 0, revision: 3, pending: true});
  });

  test('retries a stale pin against the latest remote revision', async () => {
    let pushCount = 0;
    let lastOperationID = '';
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'remote', revision: 3, pinned: false, pin_order: 0};
    const app = track(await createApp({fetchImpl: async (path, options) => {
      if (String(path) === '/api/sync/push') {
        pushCount++;
        lastOperationID = JSON.parse(options.body).operations[0].op_id;
        return response(200, JSON.stringify(pushCount === 1
          ? {acknowledged: [{op_id: lastOperationID, status: 'conflict', current_revision: 3}], expected_sequence: 2}
          : {acknowledged: [{op_id: lastOperationID, status: 'applied', revision: 4, pin_order: 12}], expected_sequence: 3}));
      }
      if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
      throw new Error(`unexpected request: ${path}`);
    }}));
    await app.hooks.putLocalNote({...remote, title: 'Stale local', content: 'stale local', updated_at: '2025-01-01T00:00:00Z', pinned: false});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});

    await app.hooks.flushPendingChanges();
    expect(pushCount).toBe(2);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({title: 'Remote', content: 'remote', pinned: true, pin_order: 12, revision: 4});
  });

  test('keeps a later local content save while rebasing a stale pin', async () => {
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'remote', revision: 3, pinned: false, pin_order: 0};
    const app = track(await createApp({fetchImpl: async path => String(path) === '/api/notes/note-a' ? response(200, JSON.stringify(remote)) : response(200, '{}')}));
    await app.hooks.putLocalNote({...remote, title: 'Local edit', content: 'local edit', revision: 2, pending: true});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 2, note: {id: 'note-a', title: 'Local edit', tags: '', content: 'local edit'}});
    const pin = (await app.hooks.pendingOperations()).find(operation => operation.type === 'note.pin');

    await app.hooks.applySyncAcknowledgement(pin, {status: 'conflict', current_revision: 3});

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({title: 'Local edit', content: 'local edit', pinned: true, revision: 3, pending: true});
  });

  test('recovers a compacted pin acknowledgement from the remote note', async () => {
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'body', revision: 4, pinned: true, pin_order: 19};
    const app = track(await createApp({fetchImpl: async path => String(path) === '/api/notes/note-a' ? response(200, JSON.stringify(remote)) : response(200, '{}')}));
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local', content: 'body', revision: 3, pending: true, pinned: true, pin_order: 2});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 3, pinned: true});
    const operation = (await app.hooks.pendingOperations())[0];

    await app.hooks.acknowledgeCompactedOperation(operation);

    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: true, pin_order: 19, revision: 4, pending: false});
  });

  test('keeps a dirty open note while a remote pin update arrives', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local', content: 'typed', revision: 2, pinned: false});
    app.hooks.setEditorState({id: 'note-a', revision: 2, dirty: true, title: 'Local', content: 'typed'});

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', revision: 3, deleted: false}],
      new Map([['note-a', {id: 'note-a', title: 'Remote', content: 'remote', revision: 3, pinned: true, pin_order: 21}]]),
      3,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'typed', pinned: false});
  });

  test('preserves pin state during snapshot reconciliation', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Old', content: 'body', revision: 1, pinned: false});
    await app.hooks.applyRemoteSnapshot(new Map([['note-a', {id: 'note-a', title: 'New', content: 'body', revision: 2, pinned: true, pin_order: 30}]]), new Set(['note-a']));
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: true, pin_order: 30, revision: 2});
  });

  test('supersedes a queued pin when a new note is deleted locally', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'New', content: 'body', revision: 0});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 0, pinned: true});
    const operation = (await app.hooks.pendingOperations())[0];
    await app.hooks.removeLocalNoteAndSupersede('note-a', 0);
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
    expect(await app.hooks.pendingOperations()).toEqual([expect.objectContaining({id: operation.id, type: 'noop'})]);
  });
});

describe('offline database migrations', () => {
  test('upgrades the legacy layout to the explicit schema and queue index', async () => {
    const app = track(await createApp());
    const legacy = await new Promise((resolve, reject) => {
      const request = app.window.indexedDB.open('vylk-offline', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('notes', {keyPath: 'id'});
        const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
        queue.createIndex('note_id', 'note_id', {unique: false});
        db.createObjectStore('state', {keyPath: 'key'});
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    expect(legacy).toBeUndefined();

    expect(await app.hooks.getOfflineDatabaseInfo()).toMatchObject({
      version: 4,
      queueIndexes: expect.arrayContaining(['note_id', 'client_sequence']),
    });
  });
});
