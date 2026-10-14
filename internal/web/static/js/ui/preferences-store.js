(function (global) {
  'use strict';

  function create({
    api,
    getPreferences,
    hasPendingOperation,
    localStorage,
    normalize,
    onChanged,
    onLoaded,
    queueOperation,
    scheduleSync,
    setPreferences,
  }) {
    async function persist(values) {
      const previous = {...getPreferences()};
      const keys = Object.keys(values).filter((key) => key !== 'revision');
      const next = normalize({...previous, ...values, revision: previous.revision});
      setPreferences(next);
      localStorage.setItem('vylk-prefs', JSON.stringify(next));
      await queueOperation({
        type: 'prefs.save',
        note_id: '__prefs__',
        base_revision: previous.revision || 1,
        prefs: {
          ...next,
          _sync_patch: Object.fromEntries(keys.map((key) => [key, next[key]])),
          _sync_base: Object.fromEntries(keys.map((key) => [key, previous[key]])),
        },
      });
      onChanged(keys);
      scheduleSync();
    }

    function save(key, value) {
      return persist({[key]: value});
    }

    function saveMany(values) {
      return persist(values);
    }

    async function load() {
      let remote = null;
      try {
        remote = await api('/api/prefs');
      } catch (error) {
        console.warn('preferences unavailable; using cached preferences', error);
      }
      if (remote && !(await hasPendingOperation('__prefs__'))) {
        let cached = {};
        try {
          cached = JSON.parse(localStorage.getItem('vylk-prefs') || '{}');
        } catch (_) {}
        const next = normalize(remote, cached);
        setPreferences(next);
        localStorage.setItem('vylk-prefs', JSON.stringify(next));
        onLoaded();
        return;
      }
      try {
        const cached = localStorage.getItem('vylk-prefs');
        if (cached) setPreferences(normalize(JSON.parse(cached)));
      } catch (_) {}
      onLoaded();
    }

    return {load, save, saveMany};
  }

  global.VylkPreferencesStore = {create};
})(typeof window !== 'undefined' ? window : globalThis);
