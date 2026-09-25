import {describe, expect, test, vi} from 'vitest';
import {createApp} from './app-harness.js';
import {installAppLifecycle} from './frontend-test-context.js';

const track = installAppLifecycle();

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

describe('navigation route restoration', () => {
  test('does not restore a note after a newer Back route has been selected', async () => {
    const app = track(await createApp());
    const localNote = deferred();
    const listeners = new Map();
    const routeElements = new Map();
    let currentRoute = 'note';
    let dashboardVisible = false;
    const showNoteInEditor = vi.fn();

    const navigation = app.window.VylkNavigationController.create({
      api: vi.fn(),
      cancelPreviewDelay: vi.fn(),
      cancelPreviewRender: vi.fn(),
      clearCurrentNote: vi.fn(),
      closeModal: vi.fn(),
      document: {
        querySelector(selector) {
          if (selector === '#prefs-modal') return {classList: {contains: () => true}};
          if (!routeElements.has(selector)) {
            routeElements.set(selector, {addEventListener: vi.fn()});
          }
          return routeElements.get(selector);
        },
      },
      getCurrentNoteID: () => (currentRoute === 'note' ? 'note-a' : null),
      getLocalNote: () => localNote.promise,
      getLocalNotes: vi.fn(async () => []),
      getUnresolvedConflict: vi.fn(),
      hasPendingOperation: vi.fn(),
      isDashboardVisible: () => dashboardVisible,
      isDirty: () => false,
      isEditorVisible: () => false,
      loadDashboard: vi.fn(async () => {
        dashboardVisible = true;
      }),
      noteSaver: {cancelScheduled: vi.fn(), hasPendingSave: () => false},
      openPreferences: vi.fn(),
      pendingOperations: vi.fn(async () => []),
      putLocalNote: vi.fn(),
      routes: {
        isDashboard: () => currentRoute === 'dashboard',
        isNote: () => currentRoute === 'note',
        isPreferences: () => currentRoute === 'preferences',
        noteID: () => (currentRoute === 'note' ? 'note-a' : null),
        setDashboard: () => {
          currentRoute = 'dashboard';
        },
      },
      saveCurrentNote: vi.fn(async () => true),
      scheduleSync: vi.fn(),
      setDashboardHydrationState: vi.fn(),
      showConflictResolverFor: vi.fn(async () => false),
      showNoteInEditor,
      showToast: vi.fn(),
      startNewNote: vi.fn(),
      unresolvedConflictIDs: vi.fn(async () => []),
      window: {
        addEventListener: (type, listener) => listeners.set(type, listener),
        history: {state: null},
      },
    });

    const staleRestore = navigation.restoreRoute();
    currentRoute = 'dashboard';
    await navigation.restoreRoute();
    localNote.resolve({id: 'note-a', title: 'Cached note', content: ''});
    await staleRestore;

    expect(dashboardVisible).toBe(true);
    expect(showNoteInEditor).not.toHaveBeenCalled();
    expect(listeners.has('popstate')).toBe(true);
  });
});
