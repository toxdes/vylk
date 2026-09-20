import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticDirectory = path.join(testDirectory, '..', 'internal', 'web', 'static');
const appSource = fs.readFileSync(path.join(staticDirectory, 'js', 'app.js'), 'utf8');
const themesSource = fs.readFileSync(path.join(staticDirectory, 'js', 'ui', 'themes.js'), 'utf8');
const dashboardSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'dashboard.js'),
  'utf8',
);
const dashboardControllerSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'dashboard-controller.js'),
  'utf8',
);
const authSource = fs.readFileSync(path.join(staticDirectory, 'js', 'ui', 'auth.js'), 'utf8');
const preferencesSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'preferences.js'),
  'utf8',
);
const preferencesDialogSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'preferences-dialog.js'),
  'utf8',
);
const preferencesStoreSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'preferences-store.js'),
  'utf8',
);
const appearanceSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'appearance.js'),
  'utf8',
);
const modalSource = fs.readFileSync(path.join(staticDirectory, 'js', 'ui', 'modal.js'), 'utf8');
const conflictResolverSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'conflict-resolver.js'),
  'utf8',
);
const feedbackSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'feedback.js'),
  'utf8',
);
const panelControllerSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'panel-controller.js'),
  'utf8',
);
const navigationControllerSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'ui', 'navigation-controller.js'),
  'utf8',
);
const markedSource = fs.readFileSync(path.join(staticDirectory, 'vendor', 'marked.min.js'), 'utf8');
const mergeSource = fs.readFileSync(path.join(staticDirectory, 'js', 'editor', 'merge.js'), 'utf8');
const httpSource = fs.readFileSync(path.join(staticDirectory, 'js', 'core', 'http.js'), 'utf8');
const apiClientSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'core', 'api-client.js'),
  'utf8',
);
const routesSource = fs.readFileSync(path.join(staticDirectory, 'js', 'core', 'routes.js'), 'utf8');
const indexedDBSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'core', 'indexeddb.js'),
  'utf8',
);
const offlineStoreSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'core', 'offline-store.js'),
  'utf8',
);
const syncBatchSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'core', 'sync-batch.js'),
  'utf8',
);
const serverEventsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'server-events.js'),
  'utf8',
);
const conflictActionsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'conflict-actions.js'),
  'utf8',
);
const compactedOperationsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'compacted-operations.js'),
  'utf8',
);
const conflictWorkflowSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'conflict-workflow.js'),
  'utf8',
);
const acknowledgementsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'acknowledgements.js'),
  'utf8',
);
const syncPusherSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'pusher.js'),
  'utf8',
);
const preferenceConflictsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'preference-conflicts.js'),
  'utf8',
);
const syncLeadershipSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'leadership.js'),
  'utf8',
);
const remoteNotesSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'remote-notes.js'),
  'utf8',
);
const syncCoordinatorSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'sync', 'coordinator.js'),
  'utf8',
);
const interactivePreviewSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'interactive-preview.js'),
  'utf8',
);
const interactivePreviewSessionSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'interactive-preview-session.js'),
  'utf8',
);
const previewContentSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-content.js'),
  'utf8',
);
const previewDOMSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-dom.js'),
  'utf8',
);
const previewNavigationSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-navigation.js'),
  'utf8',
);
const previewWorkerClientSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-worker-client.js'),
  'utf8',
);
const previewHighlighterSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-highlighter.js'),
  'utf8',
);
const previewRendererSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-renderer.js'),
  'utf8',
);
const previewDecorationSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-decoration.js'),
  'utf8',
);
const previewModelSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-model.js'),
  'utf8',
);
const previewDragLayoutSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-drag-layout.js'),
  'utf8',
);
const previewDragControllerSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'preview-drag-controller.js'),
  'utf8',
);
const markdownFormattingSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'markdown-formatting.js'),
  'utf8',
);
const formattingToolbarSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'formatting-toolbar.js'),
  'utf8',
);
const noteSaverSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'note-saver.js'),
  'utf8',
);
const shortcutsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'shortcuts.js'),
  'utf8',
);
const shortcutControllerSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'shortcut-controller.js'),
  'utf8',
);
const defaultCommandsSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'default-commands.js'),
  'utf8',
);
const zenEditorSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'zen-editor.js'),
  'utf8',
);
const editorSourceAdapterSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'source-adapter.js'),
  'utf8',
);
const zenOverlaysSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'zen-overlays.js'),
  'utf8',
);
const caretControllerSource = fs.readFileSync(
  path.join(staticDirectory, 'js', 'editor', 'caret-controller.js'),
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
  applyFonts: appearance.applyFonts,
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
    pending: Boolean(previewDrag.active()),
    dragging: Boolean(previewDrag.active()?.armed),
    sourceLocked: interactivePreviewSession.locked(),
    ghostTransform: previewDrag.active()?.ghost?.style.transform || '',
    outside: document.documentElement.classList.contains('preview-drag-outside'),
  }),
  previewAutoScrollDelta,
  highlightBlock,
  calculatePreviewScrollAdjustment,
  closeDatabase: closeOfflineDatabaseConnection,
  cancelScheduledSync: syncCoordinator.cancelScheduled,
  waitForSyncIdle: syncCoordinator.waitForIdle,
  waitForPreferenceIdle: async () => {
    await preferencesStore.whenIdle();
    await appearance.whenIdle();
  },
  getSyncScheduleState: syncCoordinator.scheduleState,
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
  const dom = new JSDOM(fs.readFileSync(path.join(staticDirectory, 'index.html'), 'utf8'), {
    url: 'http://localhost:8080/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
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
  window.eval(apiClientSource);
  window.eval(routesSource);
  window.eval(indexedDBSource);
  window.eval(offlineStoreSource);
  window.eval(syncBatchSource);
  window.eval(serverEventsSource);
  window.eval(conflictActionsSource);
  window.eval(compactedOperationsSource);
  window.eval(conflictWorkflowSource);
  window.eval(acknowledgementsSource);
  window.eval(syncPusherSource);
  window.eval(preferenceConflictsSource);
  window.eval(syncLeadershipSource);
  window.eval(remoteNotesSource);
  window.eval(syncCoordinatorSource);
  window.eval(previewContentSource);
  window.eval(previewDOMSource);
  window.eval(previewNavigationSource);
  window.eval(previewHighlighterSource);
  window.eval(previewWorkerClientSource);
  window.eval(previewRendererSource);
  window.eval(previewDecorationSource);
  window.eval(previewModelSource);
  window.eval(previewDragLayoutSource);
  window.eval(previewDragControllerSource);
  window.eval(interactivePreviewSource);
  window.eval(interactivePreviewSessionSource);
  window.eval(markdownFormattingSource);
  window.eval(formattingToolbarSource);
  window.eval(noteSaverSource);
  window.eval(shortcutsSource);
  window.eval(shortcutControllerSource);
  window.eval(defaultCommandsSource);
  window.eval(zenEditorSource);
  window.eval(editorSourceAdapterSource);
  window.eval(zenOverlaysSource);
  window.eval(caretControllerSource);
  window.eval(dashboardSource);
  window.eval(dashboardControllerSource);
  window.eval(authSource);
  window.eval(preferencesSource);
  window.eval(preferencesDialogSource);
  window.eval(preferencesStoreSource);
  window.eval(appearanceSource);
  window.eval(modalSource);
  window.eval(conflictResolverSource);
  window.eval(feedbackSource);
  window.eval(panelControllerSource);
  window.eval(navigationControllerSource);
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
