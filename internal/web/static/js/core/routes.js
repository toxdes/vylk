(function (root) {
  'use strict';

  const appState = 'vylk';
  const preferencesPath = '/preferences';
  const noteIDPattern = /^[A-Za-z0-9_-]{1,64}$/;

  function create(browser) {
    const {history, location} = browser;

    function noteID() {
      try {
        if (location.pathname === preferencesPath) return null;
        const value = decodeURIComponent(location.pathname.slice(1));
        return noteIDPattern.test(value) ? value : null;
      } catch (_) {
        return null;
      }
    }

    const dashboardState = () => ({app: appState, screen: 'dashboard'});
    const noteState = (id) => ({app: appState, screen: 'note', noteID: id});
    const preferencesState = (returnRoute) => ({
      app: appState,
      screen: 'preferences',
      returnRoute,
    });

    function isNote(state = history.state) {
      return (
        state?.app === appState && state.screen === 'note' && noteIDPattern.test(state.noteID || '')
      );
    }

    function isDashboard(state = history.state) {
      return state?.app === appState && state.screen === 'dashboard';
    }

    function isPreferences(state = history.state) {
      return state?.app === appState && state.screen === 'preferences';
    }

    function current() {
      if (isNote()) return noteState(history.state.noteID);
      if (isDashboard()) return dashboardState();
      const id = noteID();
      return id ? noteState(id) : dashboardState();
    }

    function initialize() {
      if (location.pathname === preferencesPath) {
        if (isPreferences()) return;
        const path = location.pathname;
        history.replaceState(dashboardState(), '', '/');
        history.pushState(preferencesState(dashboardState()), '', path);
        return;
      }

      const id = noteID();
      if (id) {
        if (isNote() && history.state.noteID === id) return;
        const path = location.pathname;
        history.replaceState(dashboardState(), '', '/');
        history.pushState(noteState(id), '', path);
        return;
      }

      if (location.pathname === '/' && !location.search && !location.hash) {
        history.replaceState(dashboardState(), '', '/');
      }
    }

    function setNote(id, {replace = false} = {}) {
      const path = `/${encodeURIComponent(id)}`;
      const state = noteState(id);
      if (location.pathname === path && !location.search && !location.hash) {
        if (!isNote() || history.state.noteID !== id) history.replaceState(state, '', path);
        return;
      }
      history[replace ? 'replaceState' : 'pushState'](state, '', path);
    }

    function setDashboard({replace = false} = {}) {
      const state = dashboardState();
      if (location.pathname === '/' && !location.search && !location.hash) {
        if (!isDashboard()) history.replaceState(state, '', '/');
        return;
      }
      history[replace ? 'replaceState' : 'pushState'](state, '', '/');
    }

    function setPreferences({replace = false, returnRoute = current()} = {}) {
      const state = preferencesState(returnRoute);
      if (location.pathname === preferencesPath && !location.search && !location.hash) {
        if (!isPreferences()) history.replaceState(state, '', preferencesPath);
        return;
      }
      history[replace ? 'replaceState' : 'pushState'](state, '', preferencesPath);
    }

    return Object.freeze({
      current,
      dashboardState,
      initialize,
      isDashboard,
      isNote,
      isPreferences,
      noteID,
      noteState,
      preferencesState,
      setDashboard,
      setNote,
      setPreferences,
    });
  }

  root.VylkRoutes = Object.freeze({create});
})(globalThis);
