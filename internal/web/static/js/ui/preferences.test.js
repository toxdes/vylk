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
