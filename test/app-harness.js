import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(testDirectory, '..', 'static', 'js', 'app.js'), 'utf8');
const themesSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'ui', 'themes.js'),
  'utf8',
);
const markedSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'vendor', 'marked.min.js'),
  'utf8',
);
const mergeSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'editor', 'merge.js'),
  'utf8',
);
const httpSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'core', 'http.js'),
  'utf8',
);
const routesSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'core', 'routes.js'),
  'utf8',
);
const indexedDBSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'core', 'indexeddb.js'),
  'utf8',
);
const offlineStoreSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'core', 'offline-store.js'),
  'utf8',
);
const interactivePreviewSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'editor', 'interactive-preview.js'),
  'utf8',
);
const markdownFormattingSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'editor', 'markdown-formatting.js'),
  'utf8',
);
const shortcutsSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'editor', 'shortcuts.js'),
  'utf8',
);
const zenEditorSource = fs.readFileSync(
  path.join(testDirectory, '..', 'static', 'js', 'editor', 'zen-editor.js'),
  'utf8',
);

const testHookSource = `
globalThis.__vylkTestHooks = {
  saveCurrentNote,
  queueOperation,
  flushPendingChanges,
  quarantineQueueOperation,
  saveLocalNoteAndQueue,
  toggleNotePin,
  getLocalNotes,
  pendingOperations,
  pendingOperationsForNote,
  claimQueueOperation,
  removePendingOperationIfIdentityMatches,
  withSyncLeadership,
  registerServiceWorker,
  acknowledgeCompactedOperation,
  applySyncAcknowledgement,
  applyRemoteSnapshot,
  removeLocalNoteAndSupersede,
  savePref,
  applyFonts,
  loadPrefs,
  applyRemoteDeletion,
  applyRemoteChangePage,
  getLocalNote,
  getOfflineDatabaseInfo,
  getOfflineState,
  clearOfflineData,
  api,
  cancelActiveSyncRequests,
  scheduleSync,
  syncNow,
  handleServerChangeEvent,
  putLocalNote,
  init,
  restoreRoute,
  getState: () => ({
    currentNoteId,
    currentRevision,
    currentBaseRevision,
    isDirty,
    savedSnapshot: {...savedSnapshot},
    editorSessionGeneration,
  }),
  setEditorState(state = {}) {
    editorSessionGeneration++;
    currentNoteId = state.id ?? null;
    currentRevision = state.revision ?? 0;
    currentBaseRevision = state.baseRevision ?? null;
    isDirty = state.dirty ?? false;
    savedSnapshot = {...(state.savedSnapshot || {title: '', tags: '', content: ''})};
    $('#note-title').value = state.title ?? savedSnapshot.title ?? '';
    $('#note-tags').value = state.tags ?? savedSnapshot.tags ?? '';
    setEditorSourceValue(state.content ?? savedSnapshot.content ?? '');
  },
  markDirty,
  showNoteInEditor,
  updatePreview,
  setPanelState,
  executeShortcutCommand,
  getShortcutBinding: id => shortcutBindingFor(shortcutCommandsByID.get(id)),
  getShortcutPrefix: () => shortcutPrefixBinding(),
  shortcutCommands: () => shortcutCommands.map(command => command.id),
  undoInteractivePreview,
  setInteractiveSourceLocked,
  getInteractivePreviewState: () => ({
    pending: Boolean(activePreviewDrag),
    dragging: Boolean(activePreviewDrag?.armed),
    sourceLocked: interactiveSourceLocked,
    ghostTransform: activePreviewDrag?.ghost?.style.transform || '',
    outside: document.documentElement.classList.contains('preview-drag-outside'),
  }),
  previewAutoScrollDelta,
  highlightBlock,
  calculatePreviewScrollAdjustment,
  closeDatabase: closeOfflineDatabaseConnection,
  cancelScheduledSync: () => {
    if (syncScheduleTimer) clearTimeout(syncScheduleTimer);
    syncScheduleTimer = null;
    syncScheduleOptions = {};
    syncPendingWhileInFlight = false;
  },
  waitForSyncIdle: async () => {
    for (;;) {
      const lifecycle = syncLifecyclePromise;
      if (!lifecycle) return;
      await lifecycle.catch(() => {});
      if (syncLifecyclePromise === lifecycle) return;
    }
  },
  waitForPreferenceIdle: async () => {
    while (preferenceSaveTasks.size) {
      await Promise.allSettled([...preferenceSaveTasks]);
    }
    await fontApplyQueue;
  },
  getSyncScheduleState: () => ({
    scheduled: Boolean(syncScheduleTimer),
    options: {...syncScheduleOptions},
  }),
};
`;

const testHookMarker = '/* __VYLK_TEST_HOOKS__ */';

function response(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : 'OK',
    text: async () => body,
    json: async () => (typeof body === 'string' ? JSON.parse(body || '{}') : body),
  };
}

async function defaultFetch(path, options = {}) {
  const value = String(path);
  if (value.startsWith('/api/sync?'))
    return response(200, {changes: [], nextSequence: 0, hasMore: false});
  if (value === '/api/sync/push') {
    const request = JSON.parse(options.body || '{}');
    const operations = Array.isArray(request.operations) ? request.operations : [];
    return response(200, {
      acknowledged: operations.map((operation) => ({
        client_sequence: operation.client_sequence,
        op_id: operation.op_id,
        status: 'applied',
        revision: Number(operation.base_revision || 0) + 1,
      })),
      expected_sequence: operations.at(-1)?.client_sequence + 1 || 1,
    });
  }
  return response(200, '{}');
}

export async function deleteOfflineDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('vylk-offline');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('offline test database is blocked'));
  });
}

export async function createApp({
  deferredSave = false,
  deferredSyncCompletion = false,
  fetchImpl = defaultFetch,
  serviceWorker = null,
  realMarked = false,
  realMerge = false,
} = {}) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(testDirectory, '..', 'static', 'index.html'), 'utf8'),
    {
      url: 'http://localhost:8080/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    },
  );
  const {window} = dom;
  window.__vylkDisableAutoInit = true;
  window.__vylkDependencies = {};
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;
  window.fetch = fetchImpl;
  if (serviceWorker)
    Object.defineProperty(window.navigator, 'serviceWorker', {
      value: serviceWorker,
      configurable: true,
    });
  window.eval(themesSource);
  window.eval(httpSource);
  window.eval(routesSource);
  window.eval(indexedDBSource);
  window.eval(offlineStoreSource);
  window.eval(interactivePreviewSource);
  window.eval(markdownFormattingSource);
  window.eval(shortcutsSource);
  window.eval(zenEditorSource);
  if (realMerge) window.eval(mergeSource);
  if (realMarked) {
    window.eval(markedSource);
  } else {
    window.marked = {parse: () => ''};
  }
  window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.scrollTo = () => {};
  Object.defineProperty(window.document, 'fonts', {
    value: {load: async () => {}},
    configurable: true,
  });

  let resolveFirstSaveStarted;
  let releaseFirstSave;
  const firstSaveStarted = new Promise((resolve) => {
    resolveFirstSaveStarted = resolve;
  });
  const firstSaveGate = new Promise((resolve) => {
    releaseFirstSave = resolve;
  });
  const saveCalls = [];
  if (deferredSave) {
    window.__vylkDependencies.saveLocalNoteAndQueue = async (note, operation) => {
      saveCalls.push({note: structuredClone(note), operation: structuredClone(operation)});
      if (saveCalls.length === 1) {
        resolveFirstSaveStarted();
        await firstSaveGate;
      }
    };
  }

  let resolveSyncCompletionStarted;
  let releaseSyncCompletion;
  const syncCompletionStarted = new Promise((resolve) => {
    resolveSyncCompletionStarted = resolve;
  });
  const syncCompletionGate = new Promise((resolve) => {
    releaseSyncCompletion = resolve;
  });
  let syncCompletionCalls = 0;
  if (deferredSyncCompletion) {
    window.__vylkDependencies.beforeSyncCompletion = async () => {
      syncCompletionCalls++;
      if (syncCompletionCalls !== 1) return;
      resolveSyncCompletionStarted();
      await syncCompletionGate;
    };
  }

  if (!appSource.includes(testHookMarker)) throw new Error('app test hook marker was not found');
  const source = appSource.replace(testHookMarker, testHookSource);
  window.eval(source);

  return {
    window,
    hooks: window.__vylkTestHooks,
    saveCalls,
    firstSaveStarted,
    releaseFirstSave,
    syncCompletionStarted,
    releaseSyncCompletion,
    close: async () => {
      window.__vylkTestHooks.cancelScheduledSync();
      window.__vylkTestHooks.cancelActiveSyncRequests();
      await window.__vylkTestHooks.waitForPreferenceIdle();
      await window.__vylkTestHooks.waitForSyncIdle();
      await window.__vylkTestHooks.closeDatabase();
      window.close();
    },
  };
}

export {response};
