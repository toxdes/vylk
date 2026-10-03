import {beforeAll, describe, expect, test} from 'bun:test';

beforeAll(async () => {
  globalThis.localStorage = {getItem: () => null};
  globalThis.matchMedia = () => ({matches: false});
  globalThis.VylkThemes = [{id: 'default-light'}, {id: 'default-dark'}];
  globalThis.VylkShortcuts = {
    normalizeBinding: (binding) => binding,
    isAllowedPrefix: (binding) => Boolean(binding?.steps?.length),
  };
  await import('./preferences.js');
});

describe('preference policy', () => {
  test('uses writing-first defaults with the configured Zen appearance and shortcuts', () => {
    expect(globalThis.VylkPreferences.normalize()).toMatchObject({
      startView: 'editor',
      interactivePreview: true,
      hideToolbar: false,
      hideSaveButton: true,
      zenFontFamily: 'Inter',
      zenFontFamilyGoogle: true,
      zenFontSize: '1.25rem',
      zenWordCount: true,
      zenShowTitle: true,
      zenShowControls: true,
      shortcutPrefix: {steps: [{key: 'e', modifiers: ['Mod']}]},
    });
  });

  test('preserves previously saved choices, including false boolean values', () => {
    const saved = {
      startView: 'split',
      interactivePreview: false,
      hideToolbar: true,
      hideSaveButton: false,
      zenFontFamily: 'system-monospace',
      zenFontFamilyGoogle: false,
      zenFontSize: '1rem',
      zenWordCount: false,
      zenShowTitle: false,
      zenShowControls: false,
      shortcutPrefix: {steps: [{key: '/', modifiers: ['Mod']}]},
    };
    expect(globalThis.VylkPreferences.normalize(saved)).toMatchObject(saved);
  });

  test('normalizes legacy and invalid appearance values', () => {
    expect(
      globalThis.VylkPreferences.normalize({
        hidePreview: true,
        accentColor: 'red',
        editorFontFamily: 'system',
        fontSize: 'huge',
      }),
    ).toMatchObject({
      startView: 'editor',
      accentColor: '',
      editorFontFamily: 'system-monospace',
      fontSize: '1rem',
    });
  });

  test('retains split view for the legacy explicitly visible preview preference', () => {
    expect(globalThis.VylkPreferences.normalize({hidePreview: false}).startView).toBe('split');
    expect(globalThis.VylkPreferences.normalize({hidePreview: true}).startView).toBe('editor');
    expect(
      globalThis.VylkPreferences.normalize({startView: 'zen', hidePreview: false}).startView,
    ).toBe('zen');
  });

  test('merges non-overlapping nested preference changes', () => {
    expect(
      globalThis.VylkPreferences.mergeNestedPatch(
        {save: {key: 's'}, open: {key: 'o'}},
        {save: {key: 's'}},
        {save: {key: 'x'}},
      ),
    ).toEqual({
      value: {save: {key: 'x'}, open: {key: 'o'}},
      conflict: false,
      changed: true,
    });
  });

  test('reports a nested preference conflict without overwriting the remote value', () => {
    expect(
      globalThis.VylkPreferences.mergeNestedPatch(
        {save: {key: 'remote'}},
        {save: {key: 'base'}},
        {save: {key: 'local'}},
      ),
    ).toEqual({
      value: {save: {key: 'remote'}},
      conflict: true,
      changed: false,
    });
  });
});
