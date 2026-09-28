(function (root) {
  'use strict';

  const appState = 'vylk';
  const preferencesPath = '/preferences';
  const preferenceSections = new Set([
    'appearance',
    'editor',
    'zen',
    'shortcuts',
    'account',
    'encryption',
    'about',
  ]);
  const encryptionDetails = new Set(['setup', 'passphrase', 'recovery']);
  const noteIDPattern = /^[A-Za-z0-9_-]{1,64}$/;

  function create(browser) {
    const {history, location} = browser;

    function preferenceRouteFromPath(pathname = location.pathname) {
      if (pathname === preferencesPath) return {section: 'appearance', detail: null};
      if (!pathname.startsWith(`${preferencesPath}/`)) return null;
      const parts = pathname.slice(preferencesPath.length + 1).split('/');
      if (parts.length === 1 && preferenceSections.has(parts[0]))
        return {section: parts[0], detail: null};
      if (parts.length === 2 && parts[0] === 'encryption' && encryptionDetails.has(parts[1]))
        return {section: 'encryption', detail: parts[1]};
      return null;
    }

    function isPreferencesPath(pathname = location.pathname) {
      return preferenceRouteFromPath(pathname) !== null;
    }

    function noteID() {
      try {
        if (isPreferencesPath()) return null;
        const value = decodeURIComponent(location.pathname.slice(1));
        return noteIDPattern.test(value) ? value : null;
      } catch (_) {
        return null;
      }
    }

    const dashboardState = () => ({app: appState, screen: 'dashboard'});
    const noteState = (id) => ({app: appState, screen: 'note', noteID: id});
    const preferencesState = (returnRoute, section = 'appearance', detail = null, depth = 1) => ({
      app: appState,
      screen: 'preferences',
      returnRoute,
      section,
      preferencesDepth: depth,
      ...(detail ? {detail} : {}),
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
      if (isPreferences())
        return preferencesState(
          history.state.returnRoute,
          history.state.section || 'appearance',
          history.state.detail || null,
          history.state.preferencesDepth || 1,
        );
      if (isNote()) return noteState(history.state.noteID);
      if (isDashboard()) return dashboardState();
      const id = noteID();
      return id ? noteState(id) : dashboardState();
    }

    function initialize() {
      if (isPreferencesPath()) {
        const {section, detail} = preferenceRouteFromPath();
        if (isPreferences()) {
          if (history.state.section === section && (history.state.detail || null) === detail)
            return;
          history.replaceState(
            preferencesState(
              history.state.returnRoute || dashboardState(),
              section,
              detail,
              history.state.preferencesDepth || 1,
            ),
            '',
            location.pathname,
          );
          return;
        }
        const path = location.pathname;
        history.replaceState(dashboardState(), '', '/');
        history.pushState(preferencesState(dashboardState(), section, detail), '', path);
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

    function setPreferences({
      replace = false,
      push = false,
      returnRoute = isPreferences() ? history.state.returnRoute : current(),
      section = 'appearance',
      detail = null,
    } = {}) {
      if (!preferenceSections.has(section)) section = 'appearance';
      if (section !== 'encryption' || !encryptionDetails.has(detail)) detail = null;
      const path =
        section === 'appearance'
          ? preferencesPath
          : `${preferencesPath}/${section}${detail ? `/${detail}` : ''}`;
      const depth = isPreferences()
        ? push
          ? (history.state.preferencesDepth || 1) + 1
          : history.state.preferencesDepth || 1
        : 1;
      const state = preferencesState(returnRoute, section, detail, depth);
      if (isPreferencesPath() && location.pathname === path && !location.search && !location.hash) {
        if (
          !isPreferences() ||
          history.state.section !== section ||
          (history.state.detail || null) !== detail
        )
          history.replaceState(state, '', path);
        return;
      }
      history[replace || (isPreferencesPath() && !push) ? 'replaceState' : 'pushState'](
        state,
        '',
        path,
      );
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
