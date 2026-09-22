import {beforeEach, describe, expect, test} from 'vitest';
import {JSDOM} from 'jsdom';

await import('../internal/web/static/js/core/routes.js');

describe('application routes', () => {
  let window;
  let routes;

  beforeEach(() => {
    window = new JSDOM('', {url: 'http://localhost/'}).window;
    routes = globalThis.VylkRoutes.create(window);
  });

  test('initializes dashboard, note, and preferences URLs', () => {
    routes.initialize();
    expect(window.history.state).toEqual(routes.dashboardState());

    routes.setNote('note_1');
    expect(window.location.pathname).toBe('/note_1');
    expect(routes.noteID()).toBe('note_1');

    routes.setPreferences();
    expect(window.location.pathname).toBe('/preferences');
    expect(window.history.state).toEqual({
      app: 'vylk',
      screen: 'preferences',
      returnRoute: routes.noteState('note_1'),
    });
    expect(routes.current()).toEqual(routes.dashboardState());
  });

  test('rejects malformed note paths and preserves an existing valid route', () => {
    window.history.replaceState(routes.noteState('kept'), '', '/kept');
    routes.initialize();
    expect(routes.current()).toEqual(routes.noteState('kept'));

    window.history.replaceState(null, '', '/not%20a%20note');
    expect(routes.noteID()).toBeNull();
  });

  test('does not add duplicate history entries for the current route', () => {
    routes.setDashboard();
    const length = window.history.length;
    routes.setDashboard();
    expect(window.history.length).toBe(length);
  });

  test.each([
    ['/note-1', {app: 'vylk', screen: 'note', noteID: 'note-1'}],
    [
      '/preferences',
      {
        app: 'vylk',
        screen: 'preferences',
        returnRoute: {app: 'vylk', screen: 'dashboard'},
      },
    ],
  ])('keeps a dashboard entry behind a direct %s route', async (path, expectedState) => {
    window.close();
    window = new JSDOM('', {url: `http://localhost${path}`}).window;
    routes = globalThis.VylkRoutes.create(window);

    routes.initialize();

    expect(window.history.state).toEqual(expectedState);
    const popped = new Promise((resolve) =>
      window.addEventListener('popstate', resolve, {once: true}),
    );
    window.history.back();
    await popped;
    expect(window.location.pathname).toBe('/');
    expect(window.history.state).toEqual(routes.dashboardState());
  });
});
