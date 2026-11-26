import {beforeAll, expect, test} from 'bun:test';

beforeAll(async () => {
  await import('./preferences-store.js');
});

function store(initial, fetchPrefs) {
  let prefs = initial;
  const instance = globalThis.VylkPreferencesStore.create({
    api: fetchPrefs,
    getPreferences: () => prefs,
    hasPendingOperation: async () => false,
    localStorage: {getItem: () => null, setItem() {}},
    normalize: (value) => ({...value}),
    onChanged() {},
    onLoaded() {},
    queueOperation: async () => {},
    scheduleSync() {},
    setPreferences: (value) => {
      prefs = value;
    },
  });
  return {
    instance,
    prefs: () => prefs,
    acknowledge: (value) => {
      prefs = value;
    },
  };
}

test('a snapshot fetched before a newer save is acknowledged does not overwrite it', async () => {
  let respond;
  const subject = store({fontSize: '0.8rem', revision: 2}, () => new Promise((r) => (respond = r)));
  const loading = subject.instance.load();
  subject.acknowledge({fontSize: '1rem', revision: 3});
  respond({fontSize: '0.8rem', revision: 2});
  await loading;
  expect(subject.prefs()).toEqual({fontSize: '1rem', revision: 3});
});

test('a snapshot applies when nothing changed locally, even at a lower revision', async () => {
  const subject = store({fontSize: '1rem', revision: 9}, async () => ({
    fontSize: '0.8rem',
    revision: 1,
  }));
  await subject.instance.load();
  expect(subject.prefs()).toEqual({fontSize: '0.8rem', revision: 1});
});
