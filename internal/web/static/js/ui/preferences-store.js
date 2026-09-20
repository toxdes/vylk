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
    const saveTasks = new Set();

    async function persist(key, value) {
      const previous = {...getPreferences()};
      const next = normalize({...previous, [key]: value});
      setPreferences(next);
      localStorage.setItem('vylk-prefs', JSON.stringify(next));
      await queueOperation({
        type: 'prefs.save',
        note_id: '__prefs__',
        base_revision: previous.revision || 1,
        prefs: {
          ...next,
          _sync_patch: {[key]: next[key]},
          _sync_base: {[key]: previous[key]},
        },
      });
      onChanged(key);
      scheduleSync();
    }

    function save(key, value) {
      const task = persist(key, value);
      saveTasks.add(task);
      void task.then(
        () => saveTasks.delete(task),
        () => saveTasks.delete(task),
      );
      return task;
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

    async function whenIdle() {
      while (saveTasks.size) await Promise.allSettled([...saveTasks]);
    }

    return {load, save, whenIdle};
  }

  global.VylkPreferencesStore = {create};
})(typeof window !== 'undefined' ? window : globalThis);
