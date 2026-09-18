(function(){
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const editorSourceTextarea = $('#note-content');
const editorSourceWrap = $('.editor-source-wrap');
const editorCurrentLine = $('.editor-current-line');

const bootScreen = $('#boot-screen');
if (bootScreen) bootScreen.hidden = false;

const screens = {
  login: $('#login-screen'),
  dashboard: $('#dashboard'),
  editor: $('#editor'),
};

let currentNoteId = null;
let currentTag = null;
let isDirty = false;
let panelState = 'both';
let zenModeReturnState = 'editor';
let zenViewState = 'editor';
let savedSnapshot = { title: '', tags: '', content: '' };
let editorSessionGeneration = 0;
const DEFAULT_PREFS = {revision:1, autoSave:true, startView:'split', hideToolbar:false, hideSaveButton:false, saveButtonLocation:'panel',
  collapseDetails:false, hideCursorHighlight:false, interactivePreview:false, statusDisplay:'normal', contentWidth:'standard', theme:'default-light', accentColor:'', fontFamily:'system-sans',
  fontFamilyGoogle:false, fontSize:'1rem', editorFontFamily:'system-monospace', editorFontFamilyGoogle:false, editorFontSize:'1rem', previewFontFamily:'system-sans',
  previewFontFamilyGoogle:false, previewFontSize:'1rem', zenFontFamily:'system-monospace', zenFontFamilyGoogle:false, zenFontSize:'1rem', zenWordCount:false, zenShowTitle:true, zenShowControls:true, zenInteractivePreview:false,
  shortcutPrefix:{steps:[{key:'/', modifiers:['Mod']}]}, keyboardShortcuts:{}, shortcutConfirmationSkips:{}};
const CONTENT_WIDTH_VALUES = ['compact', 'standard', 'wide', 'full'];
const FONT_SIZE_OPTIONS = [
  {value: '0.8rem', label: 'Small (80%)'},
  {value: '0.9rem', label: 'Smaller (90%)'},
  {value: '1rem', label: 'Default (100%)'},
  {value: '1.1rem', label: 'Large (110%)'},
  {value: '1.25rem', label: 'Larger (125%)'},
  {value: '1.5rem', label: 'Extra large (150%)'},
];
const FONT_SIZE_VALUES = FONT_SIZE_OPTIONS.map(option => option.value);
const FONT_CACHE_NAME = 'vylk-fonts';
const SYSTEM_FONT_STACK = 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
const SYSTEM_SERIF_STACK = 'ui-serif,Georgia,Cambria,"Times New Roman",Times,serif';
const SYSTEM_MONO_STACK = 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';
let prefs = {...DEFAULT_PREFS};
let activeShortcutRecording = null;
let pendingShortcutSequence = null;
let fontLoadGeneration = 0;
let fontApplyQueue = Promise.resolve();
let renderedPreviewSource = null;
let previewCheckFrame = null;
let highlightFrame = null;
let editorCaretFrame = null;
let zenCaretFrame = null;
let editorCaretMeasurementCache = null;
let editorCaretMirror = null;
let editorCaretMirrorText = null;
let editorCaretMarker = null;
let editorCaretRange = null;
let editorCaretMirrorKey = '';
let previewRenderWorker = null;
let previewRenderGeneration = 0;
let previewRenderRequest = null;
let previewApplyHandle = null;
let previewDOMHandle = null;
let previewCacheHandle = null;
let previewCacheGeneration = 0;
let previewWorkerUnavailable = false;
let zenWordCountHandle = null;
let zenWordCountSource = null;
let zenWordCountValue = 0;
let renderedPreviewMetadata = null;
let previewDecorationObserver = null;
let previewDecorationEntryByElement = new WeakMap();
let previewObservedElements = new Set();
let interactiveEntryByElement = new WeakMap();
let interactivePreviewActive = false;
let interactiveSourceLocked = false;
let interactiveSourceMutation = false;
let interactiveHistory = [];
let interactiveListItems = [];
let interactiveBlockItems = [];
let activePreviewDrag = null;
let suppressNextPreviewAlignment = false;
let previewHighlightPending = false;
let currentRevision = 0;
let currentBaseRevision = null;
let syncInFlight = false;
let syncScheduleTimer = null;
let syncScheduleOptions = {};
let syncPendingWhileInFlight = false;
let syncRetryDelayMs = 0;
let activeSyncControllers = new Set();
let syncCancellationRequested = false;
let lastSuccessfulSyncAt = 0;
let syncNetworkRequestsInFlight = 0;
let offlineStorageFailureReported = false;
let lastSyncProblem = '';
let lastSyncDiagnostic = '';
let lastSyncResponseStatus = 0;
let authenticationRequired = false;
const syncTabID = `tab_${newLocalNoteID()}`;
const syncLeaseKey = 'syncLease';
const syncLeaseDurationMs = 60000;
let syncCoordinationChannel = null;
let syncLeaseRenewTimer = null;
let syncLifecyclePromise = null;
let panelRatio = Math.min(.8, Math.max(.2, Number(localStorage.getItem('vylk-panel-ratio')) || .5));
let appVersionAtLoad = localStorage.getItem('vylk-version') || null;
let appRevisionAtLoad = localStorage.getItem('vylk-revision') || null;
let registeredServiceWorkerRevision = null;
let updateToast = null;
let syncStatusRevealTimer = null;
let syncStatusGeneration = 0;
let dashboardHydrationState = 'ready';
let restoringHistoryRoute = false;
let backNavigationInFlight = false;
const pendingHistoryRestoreResolvers = [];

const httpRequestTimeoutMs = 15000;
const syncRetryDelaysMs = [1000, 5000, 15000, 60000, 300000];
const bulkNoteBatchSize = 25;
const healthySseFallbackSyncAgeMs = 5 * 60 * 1000;
const unhealthySseFallbackSyncAgeMs = 30 * 1000;

// Notes are stored locally before any network request. The service worker keeps
// the app shell available, while IndexedDB holds the user's working set and a
// durable queue of mutations to replay after connectivity returns.
const offlineDBName = 'vylk-offline';
const offlineDBVersion = 4;
let offlineDBPromise;

const syncOperationIDPattern = /^[A-Za-z0-9_-]{1,128}$/;
const noteRouteIDPattern = /^[A-Za-z0-9_-]{1,64}$/;
const appRouteState = 'vylk';
const preferencesPath = '/preferences';

function noteIDFromLocation() {
  try {
    if (window.location.pathname === preferencesPath) return null;
    const id = decodeURIComponent(window.location.pathname.slice(1));
    return noteRouteIDPattern.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}

function dashboardRouteState() {
  return {app: appRouteState, screen: 'dashboard'};
}

function noteRouteState(noteID) {
  return {app: appRouteState, screen: 'note', noteID};
}

function preferencesRouteState(returnRoute) {
  return {app: appRouteState, screen: 'preferences', returnRoute};
}

function isAppNoteRoute(state = history.state) {
  return state?.app === appRouteState && state.screen === 'note' && noteRouteIDPattern.test(state.noteID || '');
}

function isAppDashboardRoute(state = history.state) {
  return state?.app === appRouteState && state.screen === 'dashboard';
}

function isAppPreferencesRoute(state = history.state) {
  return state?.app === appRouteState && state.screen === 'preferences';
}

function currentAppRouteState() {
  if (isAppNoteRoute()) return noteRouteState(history.state.noteID);
  if (isAppDashboardRoute()) return dashboardRouteState();
  const noteID = noteIDFromLocation();
  return noteID ? noteRouteState(noteID) : dashboardRouteState();
}

function initializeHistoryRoute() {
  if (window.location.pathname === preferencesPath) {
    if (isAppPreferencesRoute()) return;
    const path = window.location.pathname;
    history.replaceState(dashboardRouteState(), '', '/');
    history.pushState(preferencesRouteState(dashboardRouteState()), '', path);
    return;
  }
  const noteID = noteIDFromLocation();
  if (noteID) {
    if (isAppNoteRoute() && history.state.noteID === noteID) return;
    const path = window.location.pathname;
    history.replaceState(dashboardRouteState(), '', '/');
    history.pushState(noteRouteState(noteID), '', path);
    return;
  }
  if (window.location.pathname === '/' && !window.location.search && !window.location.hash) {
    history.replaceState(dashboardRouteState(), '', '/');
  }
}

function setNoteRoute(noteID, {replace = false} = {}) {
  const path = `/${encodeURIComponent(noteID)}`;
  const state = noteRouteState(noteID);
  if (window.location.pathname === path && !window.location.search && !window.location.hash) {
    if (!isAppNoteRoute() || history.state.noteID !== noteID) history.replaceState(state, '', path);
    return;
  }
  history[replace ? 'replaceState' : 'pushState'](state, '', path);
}

function setDashboardRoute({replace = false} = {}) {
  const state = dashboardRouteState();
  if (window.location.pathname === '/' && !window.location.search && !window.location.hash) {
    if (!isAppDashboardRoute()) history.replaceState(state, '', '/');
    return;
  }
  history[replace ? 'replaceState' : 'pushState'](state, '', '/');
}

function setPreferencesRoute({replace = false, returnRoute = currentAppRouteState()} = {}) {
  const state = preferencesRouteState(returnRoute);
  if (window.location.pathname === preferencesPath && !window.location.search && !window.location.hash) {
    if (!isAppPreferencesRoute()) history.replaceState(state, '', preferencesPath);
    return;
  }
  history[replace ? 'replaceState' : 'pushState'](state, '', preferencesPath);
}

function openOfflineDB() {
  if (offlineDBPromise) return offlineDBPromise;
  offlineDBPromise = new Promise((resolve, reject) => {
    // Do not request a fixed database version here. A browser may have a
    // newer local schema from a prior build; opening it with an older version
    // fails before the app can read its offline notes.
    const request = indexedDB.open(offlineDBName, offlineDBVersion);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', {keyPath: 'id'});
      }
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('queue')) {
        const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
        queue.createIndex('note_id', 'note_id', {unique: false});
      }
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', {keyPath: 'key'});
      }
      if (event.oldVersion < 3 && db.objectStoreNames.contains('queue')) {
        const queue = event.target.transaction.objectStore('queue');
        if (!queue.indexNames.contains('note_id')) queue.createIndex('note_id', 'note_id', {unique: false});
        if (!queue.indexNames.contains('client_sequence')) queue.createIndex('client_sequence', 'client_sequence', {unique: false});
      }
    };
    request.onsuccess = async () => {
      request.result.onversionchange = () => {
        request.result.close();
        offlineDBPromise = undefined;
      };
      try {
        await repairOfflineQueue(request.result);
        resolve(request.result);
      } catch (error) {
        request.result.close();
        offlineDBPromise = undefined;
        reportOfflineStorageFailure(error);
        reject(error);
      }
    };
    request.onerror = () => {
      offlineDBPromise = undefined;
      const error = request.error?.name === 'VersionError'
        ? new Error('offline data was created by a newer app version')
        : request.error;
      reportOfflineStorageFailure(error);
      reject(error);
    };
    request.onblocked = () => showToast('Close other app tabs to update local storage.', 'warning');
  });
  return offlineDBPromise;
}

function reportOfflineStorageFailure(error) {
  setSyncDiagnostic(`local storage unavailable: ${error?.message || 'unknown error'}`);
  if (offlineStorageFailureReported) return;
  offlineStorageFailureReported = true;
  showToast('Local storage is unavailable. Your changes may not be saved.', 'warning');
}

// A previous development build could leave an operation without the replay
// metadata introduced in version 2. Repair it in place: the note snapshot is
// kept, and the operation can be acknowledged normally instead of making a
// healthy server look offline forever.
async function repairOfflineQueue(db) {
  if (!db.objectStoreNames.contains('queue') || !db.objectStoreNames.contains('state')) {
    throw new Error('offline database is missing required stores');
  }

  // Repair in two cursor passes instead of loading the complete queue into
  // memory. The queue can contain a large backlog after a long offline period.
  let largestSequence = 0;
  await withQueueCursor(db, 'readonly', operation => {
    if (Number.isSafeInteger(operation.client_sequence) && operation.client_sequence > largestSequence) {
      largestSequence = operation.client_sequence;
    }
  });

  const transaction = db.transaction(['queue', 'state'], 'readwrite');
  const queue = transaction.objectStore('queue');
  const state = transaction.objectStore('state');
  const complete = transactionComplete(transaction);
  const savedSequenceRequest = state.get('clientSequence');
  savedSequenceRequest.onsuccess = () => {
    const previousSequence = Number(savedSequenceRequest.result?.value || 0);
    largestSequence = Math.max(largestSequence, previousSequence);
    const cursorRequest = queue.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const operation = cursor.value;
        if (!Number.isSafeInteger(operation.client_sequence) || operation.client_sequence < 1) {
          operation.client_sequence = ++largestSequence;
        }
        if (!syncOperationIDPattern.test(operation.op_id || '')) operation.op_id = `legacy-${operation.id}`;
        if (operation.type === 'save') operation.type = 'note.save';
        if (operation.type === 'delete') operation.type = 'note.delete';
        if (operation.type === 'preferences') operation.type = 'prefs.save';
        if (!operation.type) operation.type = operation.kind === 'save' ? 'note.save' : operation.kind === 'delete' ? 'note.delete' : 'prefs.save';
        if (operation.type === 'note.save' && !operation.note) operation.note = operation.data;
        if (operation.type === 'note.save' && !operation.note_id) operation.note_id = operation.note?.id;
        if (operation.type === 'prefs.save') operation.note_id = '__prefs__';
        queue.put(operation);
        cursor.continue();
        return;
      }
      state.put({key: 'clientSequence', value: Math.max(previousSequence, largestSequence)});
    };
  };
  await complete;
}

function withQueueCursor(db, mode, visit) {
  const transaction = db.transaction(['queue'], mode);
  const cursorRequest = transaction.objectStore('queue').openCursor();
  const complete = transactionComplete(transaction);
  return new Promise((resolve, reject) => {
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        complete.then(resolve, reject);
        return;
      }
      visit(cursor.value, cursor);
      cursor.continue();
    };
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function withOfflineStore(names, mode, work) {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    const complete = transactionComplete(tx);
    const result = await work(stores);
    await complete;
    return result;
  } catch (error) {
    if (error?.name === 'QuotaExceededError' || error?.name === 'InvalidStateError' || error?.name === 'TransactionInactiveError') {
      reportOfflineStorageFailure(error);
    }
    throw error;
  }
}

function getLocalNote(id) {
  return withOfflineStore(['notes'], 'readonly', stores => requestValue(stores.notes.get(id)));
}

async function getOfflineDatabaseInfo() {
  const db = await openOfflineDB();
  return {
    version: db.version,
    queueIndexes: [...db.transaction('queue', 'readonly').objectStore('queue').indexNames],
  };
}

function putLocalNote(note) {
  return withOfflineStore(['notes'], 'readwrite', stores => requestValue(stores.notes.put(note)));
}

function removeLocalNote(id) {
  return withOfflineStore(['notes'], 'readwrite', stores => requestValue(stores.notes.delete(id)));
}

async function getLocalNotes() {
  const notes = await getAllLocalNotes();
  return notes.filter(note => !note.deleted).sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned && Number(a.pin_order || 0) !== Number(b.pin_order || 0)) return Number(b.pin_order || 0) - Number(a.pin_order || 0);
    return (b.updated_at || '').localeCompare(a.updated_at || '') || String(a.id).localeCompare(String(b.id));
  });
}

async function nextLocalPinOrder() {
  return withOfflineStore(['state'], 'readwrite', async stores => {
    const current = Number((await requestValue(stores.state.get('pinOrder')))?.value || 0);
    const next = Math.max(Date.now(), current + 1);
    await requestValue(stores.state.put({key: 'pinOrder', value: next}));
    return next;
  });
}

function getAllLocalNotes() {
  return withOfflineStore(['notes'], 'readonly', stores => requestValue(stores.notes.getAll()));
}

function getOfflineState(key) {
  return withOfflineStore(['state'], 'readonly', async stores => {
    const value = await requestValue(stores.state.get(key));
    return value && value.value;
  });
}

function setOfflineState(key, value) {
  return withOfflineStore(['state'], 'readwrite', stores => requestValue(stores.state.put({key, value})));
}

function unresolvedConflictKey(noteID) {
  return `unresolvedConflict:${noteID}`;
}

function rejectedSyncKey(noteID) {
  return `rejectedSync:${noteID}`;
}

function getUnresolvedConflict(noteID) {
  return getOfflineState(unresolvedConflictKey(noteID));
}

function setUnresolvedConflict(conflict) {
  return setOfflineState(unresolvedConflictKey(conflict.note_id), conflict);
}

function mergeQueuedPreferencePayload(existing, operation) {
  const existingPatch = existing.prefs?._sync_patch;
  const nextPatch = operation.prefs?._sync_patch;
  if (!existingPatch || !nextPatch) {
    existing.base_revision = operation.base_revision;
    existing.prefs = operation.prefs;
    return;
  }
  const patch = {...existingPatch};
  const base = {...(existing.prefs?._sync_base || {})};
  const nextBase = operation.prefs?._sync_base || {};
  Object.entries(nextPatch).forEach(([key, value]) => {
    if (!(key in base)) base[key] = nextBase[key];
    patch[key] = value;
  });
  existing.prefs = {...operation.prefs, _sync_patch: patch, _sync_base: base};
}

async function queueOperationInStores(stores, operation) {
  if (operation.type === 'note.save' || operation.type === 'note.delete' || operation.type === 'note.pin' || operation.type === 'prefs.save') {
    await requestValue(stores.state.delete(rejectedSyncKey(operation.note_id)));
  }
  if (operation.type === 'note.save' || operation.type === 'note.pin' || operation.type === 'prefs.save') {
    const queued = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    if (operation.type === 'note.pin') {
      const initialSave = queued
        .filter(item => !item.attempted_at && item.type === 'note.save' && Number(item.base_revision || 0) === 0)
        .sort((left, right) => right.client_sequence - left.client_sequence)[0];
      if (initialSave?.note) {
        initialSave.note.pinned = Boolean(operation.pinned);
        initialSave.note.pin_order = operation.pin_order || 0;
        await requestValue(stores.queue.put(initialSave));
        return;
      }
    }
    const existing = queued
      // Once a request has been attempted, its op_id/client_sequence and
      // payload are immutable. A later edit must get a new queue identity so
      // an acknowledgement for the old payload cannot remove the new edit.
      .filter(item => !item.attempted_at && item.type === operation.type)
      .sort((left, right) => right.client_sequence - left.client_sequence)[0];
    if (existing) {
      if (operation.type === 'prefs.save') mergeQueuedPreferencePayload(existing, operation);
      else if (operation.type === 'note.pin') {
        existing.base_revision = operation.base_revision;
        existing.pinned = operation.pinned;
      } else {
        existing.base_revision = operation.base_revision;
        existing.note = operation.note;
        existing.prefs = operation.prefs;
      }
      await requestValue(stores.queue.put(existing));
      return;
    }
  }
  const state = await requestValue(stores.state.get('clientSequence'));
  const sequence = Number(state?.value || 0) + 1;
  operation.client_sequence = sequence;
  operation.op_id = newLocalNoteID();
  await requestValue(stores.queue.add(operation));
  await requestValue(stores.state.put({key: 'clientSequence', value: sequence}));
}

function queueOperation(operation) {
  return withOfflineStore(['queue', 'state'], 'readwrite', stores => queueOperationInStores(stores, operation)).then(result => {
    notifySyncRequested();
    return result;
  });
}

async function saveLocalNoteAndQueue(note, operation) {
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(note));
    await queueOperationInStores(stores, operation);
  });
  notifySyncRequested();
}

async function removeLocalNoteAndQueue(id, operation) {
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(id));
    await queueOperationInStores(stores, operation);
  });
  notifySyncRequested();
}

function removeLocalNoteAndSupersede(id, afterSequence) {
  return withOfflineStore(['notes', 'queue'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(id));
    const operations = await requestValue(stores.queue.index('note_id').getAll(id));
    operations.forEach(operation => {
      if (operation.client_sequence > afterSequence && !operation.attempted_at) {
        operation.type = 'noop';
        stores.queue.put(operation);
      }
    });
  });
}

function pendingOperations() {
  return withOfflineStore(['queue'], 'readonly', async stores => {
    const items = await requestValue(stores.queue.getAll());
    return items.sort((a, b) => a.client_sequence - b.client_sequence);
  });
}

async function repairSyncSequenceGap(expectedSequence) {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) return false;
  return withOfflineStore(['queue', 'state'], 'readwrite', async stores => {
    const operations = (await requestValue(stores.queue.getAll()))
      .sort((left, right) => left.client_sequence - right.client_sequence || left.id - right.id);
    const unsent = operations.filter(operation => operation.client_sequence >= expectedSequence);
    if (!unsent.length) return false;
    let sequence = expectedSequence;
    for (const operation of unsent) {
      // The server returned 409 before applying this request, so these rows
      // are safe to re-arm and close the local sequence gap. A normal
      // acknowledgement never changes an attempted row.
      if (operation.client_sequence !== sequence || operation.attempted_at) {
        operation.client_sequence = sequence;
        delete operation.attempted_at;
        await requestValue(stores.queue.put(operation));
      }
      sequence++;
    }
    // These operations have not reached the server (it explicitly requested
    // expectedSequence), so it is safe to close the local numbering gap and
    // let future edits continue immediately after the repaired queue.
    await requestValue(stores.state.put({key: 'clientSequence', value: sequence - 1}));
    return true;
  });
}

async function hasPendingOperation(noteID) {
  return withOfflineStore(['queue', 'state'], 'readonly', async stores => {
    const item = await requestValue(stores.queue.index('note_id').get(noteID));
    if (item) return true;
    return Boolean(await requestValue(stores.state.get(rejectedSyncKey(noteID))));
  });
}

function pendingOperationsForNote(noteID) {
  return withOfflineStore(['queue'], 'readonly', stores => requestValue(stores.queue.index('note_id').getAll(noteID)));
}

function latestLaterOperation(operations, current, type) {
  return operations
    .filter(operation => operation.client_sequence > current.client_sequence && operation.type === type)
    .sort((left, right) => right.client_sequence - left.client_sequence)[0];
}

async function claimQueueOperation(id) {
  return withOfflineStore(['queue'], 'readwrite', async stores => {
    const operation = await requestValue(stores.queue.get(id));
    if (!operation) return null;
    if (!operation.attempted_at) {
      operation.attempted_at = new Date().toISOString();
      await requestValue(stores.queue.put(operation));
    }
    return operation;
  });
}

function queueOperationPayload(operation) {
  return JSON.stringify({
    type: operation.type,
    note_id: operation.note_id,
    base_revision: operation.base_revision,
    note: operation.note && {
      id: operation.note.id,
      title: operation.note.title,
      tags: operation.note.tags,
      content: operation.note.content,
      base_revision: operation.note.base_revision,
      base_content: operation.note.base_content,
      base_title: operation.note.base_title,
      base_tags: operation.note.base_tags,
      pinned: operation.note.pinned,
      pin_order: operation.note.pin_order,
    },
    pinned: operation.pinned,
    prefs: operation.prefs || null,
  });
}

function removePendingOperationIfIdentityMatches(id, expectedOperation) {
  return withOfflineStore(['queue'], 'readwrite', async stores => {
    const operation = await requestValue(stores.queue.get(id));
    if (!operation || operation.op_id !== expectedOperation.op_id || operation.client_sequence !== expectedOperation.client_sequence || queueOperationPayload(operation) !== queueOperationPayload(expectedOperation)) return false;
    await requestValue(stores.queue.delete(id));
    return true;
  });
}

async function quarantineQueueOperation(operation, reason) {
  return withOfflineStore(['queue', 'state'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) return false;
    await requestValue(stores.state.put({
      key: rejectedSyncKey(operation.note_id),
      value: {
        op_id: operation.op_id,
        client_sequence: operation.client_sequence,
        note_id: operation.note_id,
        type: operation.type,
        reason: reason || 'server rejected the operation',
        rejected_at: new Date().toISOString(),
      },
    }));
    queued.type = 'noop';
    delete queued.note;
    delete queued.prefs;
    delete queued.base_revision;
    queued.rejected = true;
    queued.rejected_reason = reason || 'server rejected the operation';
    await requestValue(stores.queue.put(queued));
    return true;
  });
}

async function syncDeviceID() {
  let deviceID = await getOfflineState('deviceID');
  if (!deviceID) {
    deviceID = `device_${newLocalNoteID()}`;
    await setOfflineState('deviceID', deviceID);
  }
  return deviceID;
}

async function rebaseQueuedNoteOperations(noteID, acknowledgedID, revision, baseNote) {
  return withOfflineStore(['queue'], 'readwrite', async stores => {
    const operations = await requestValue(stores.queue.index('note_id').getAll(noteID));
    let hasLater = false;
    operations.forEach(operation => {
      if (operation.id === acknowledgedID || operation.client_sequence < 1 || operation.attempted_at) return;
      if (operation.type === 'note.save' || operation.type === 'note.delete' || operation.type === 'note.pin') {
        operation.base_revision = revision;
        if (operation.note) {
          operation.note.base_revision = revision;
          operation.note.base_content = baseNote.content;
          operation.note.base_title = baseNote.title;
          operation.note.base_tags = baseNote.tags;
        }
        stores.queue.put(operation);
        hasLater = true;
      }
    });
    return hasLater;
  });
}

async function supersedeQueuedNoteOperations(noteID, afterSequence) {
  await withOfflineStore(['queue'], 'readwrite', async stores => {
    const operations = await requestValue(stores.queue.index('note_id').getAll(noteID));
    operations.forEach(operation => {
      if (operation.client_sequence > afterSequence && !operation.attempted_at) {
        operation.type = 'noop';
        stores.queue.put(operation);
      }
    });
  });
}

async function clearOfflineData() {
  try {
    syncCoordinationChannel?.postMessage({type: 'logout', sender: syncTabID});
  } catch (_) {}
  const dbPromise = offlineDBPromise;
  offlineDBPromise = undefined;
  if (dbPromise) {
    try { (await dbPromise).close(); } catch (_) {}
  }
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(offlineDBName);
    const timeout = setTimeout(() => reject(new Error('local data cleanup is blocked by another app tab')), 5000);
    request.onerror = () => {
      clearTimeout(timeout);
      reject(request.error);
    };
    request.onsuccess = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

async function closeOfflineDatabaseConnection() {
  const dbPromise = offlineDBPromise;
  offlineDBPromise = undefined;
  if (!dbPromise) return;
  try { (await dbPromise).close(); } catch (_) {}
}

function newLocalNoteID() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

try {
  if (typeof BroadcastChannel !== 'undefined') {
    syncCoordinationChannel = new BroadcastChannel('vylk-sync');
    syncCoordinationChannel.addEventListener('message', event => {
      if (!event.data || event.data.sender === syncTabID) return;
      if (event.data.type === 'sync-request') scheduleSync({}, 0);
      if (event.data.type === 'sync-complete') void refreshLocalStateFromStorage();
      if (event.data.type === 'logout') void closeOfflineDatabaseConnection();
    });
  }
} catch (_) {
  syncCoordinationChannel = null;
}

function notifySyncRequested() {
  try {
    syncCoordinationChannel?.postMessage({type: 'sync-request', sender: syncTabID});
  } catch (_) {}
}

function notifySyncCompleted() {
  try {
    syncCoordinationChannel?.postMessage({type: 'sync-complete', sender: syncTabID});
  } catch (_) {}
}

const syncStates = {
  online: {label: 'Saved', title: 'Saved and up to date'},
  local: {label: 'Saved', title: 'Saved on this device; waiting to sync'},
  syncing: {label: 'Syncing', title: 'Synchronizing changes'},
  offline: {label: 'Offline', title: 'Offline — changes are saved on this device'},
};
let syncFailed = false;

function setSyncStatus(state) {
  syncStatusGeneration++;
  const config = syncStates[state] || syncStates.offline;
  ['#sync-status', '#editor-status'].forEach(selector => {
    const element = $(selector);
    if (!element) return;
    element.dataset.state = state;
    element.title = config.title;
    element.setAttribute('aria-label', config.title);
    element.querySelector('.sync-indicator-label').textContent = config.label;
  });
}

function showToast(message, kind = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 180);
  }, 3200);
}

function showUpdateAvailable() {
  if (updateToast) return;
  const toast = document.createElement('div');
  toast.className = 'toast update';
  const message = document.createElement('span');
  message.textContent = 'New version available.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'toast-action';
  reload.textContent = 'Reload';
  reload.addEventListener('click', async () => {
    reload.disabled = true;
    reload.textContent = 'Updating…';
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      await registration?.update();
    } catch (error) {
      console.warn('service worker update check failed', error);
    }
    window.location.reload();
  });
  toast.append(message, reload);
  $('#toast-region').append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  updateToast = toast;
}

function setSyncDiagnostic(detail, responseStatus = 0) {
  lastSyncDiagnostic = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  lastSyncResponseStatus = Number.isInteger(responseStatus) ? responseStatus : 0;
}

function clearSyncDiagnostic() {
  lastSyncDiagnostic = '';
  lastSyncResponseStatus = 0;
}

function showOfflineNotice(checking = false) {
  $$('.offline-notice').forEach(notice => {
    notice.classList.remove('hidden');
    notice.querySelector('.offline-notice-message').textContent = checking ? 'Checking…' : "You're offline. Changes are saved on this device.";
    const retry = notice.querySelector('.offline-retry');
    retry.classList.toggle('hidden', checking);
    retry.disabled = checking;
  });
}

function hideOfflineNotice() {
  $$('.offline-notice').forEach(notice => notice.classList.add('hidden'));
}

function showSyncCompleteToast() {
  hideOfflineNotice();
  showToast('Changes synced.', 'success');
}

function cacheAppVersion(response) {
  const changedVersion = response?.version && appVersionAtLoad && response.version !== appVersionAtLoad;
  const changedRevision = response?.revision && appRevisionAtLoad && response.revision !== appRevisionAtLoad;
  if (changedVersion || changedRevision) showUpdateAvailable();
  if (response?.version) {
    if (!appVersionAtLoad) appVersionAtLoad = response.version;
    localStorage.setItem('vylk-version', response.version);
  }
  if (response?.revision) {
    if (!appRevisionAtLoad) appRevisionAtLoad = response.revision;
    localStorage.setItem('vylk-revision', response.revision);
    registerServiceWorker(response.revision);
  }
  const version = response?.version || localStorage.getItem('vylk-version') || 'dev';
  $('#app-version').textContent = `v${version}`;
}

function show(screen) {
  Object.values(screens).forEach(el => el.classList.add('hidden'));
  screen.classList.remove('hidden');
}

function clearCurrentNote() {
  editorSessionGeneration++;
  currentNoteId = null;
  currentRevision = 0;
  currentBaseRevision = null;
  isDirty = false;
}

function requireAuthentication() {
  authenticationRequired = true;
  show(screens.login);
  $('#login-form input').focus();
}

async function fetchWithTimeout(path, options = {}, {group = null, timeoutMs = httpRequestTimeoutMs} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('request timed out', 'TimeoutError')), timeoutMs);
  if (group) group.add(controller);
  try {
    return await fetch(path, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
    if (group) group.delete(controller);
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.kind === 'aborted';
}

function cancelActiveSyncRequests() {
  if (!activeSyncControllers.size) return;
  syncCancellationRequested = true;
  activeSyncControllers.forEach(controller => controller.abort());
}

function beginSyncNetworkRequest() {
  syncNetworkRequestsInFlight++;
  if (!syncInFlight) setSyncStatus('syncing');
}

async function endSyncNetworkRequest() {
  syncNetworkRequestsInFlight = Math.max(0, syncNetworkRequestsInFlight - 1);
  if (syncNetworkRequestsInFlight === 0 && !syncInFlight) await setIdleSyncStatus();
}

async function setIdleSyncStatus() {
  if (syncNetworkRequestsInFlight > 0 || syncInFlight) return;
  const generation = ++syncStatusGeneration;
  try {
    const operations = await pendingOperations();
    if (generation !== syncStatusGeneration || syncNetworkRequestsInFlight > 0 || syncInFlight) return;
    if (typeof document === 'undefined') return;
    setSyncStatus(syncFailed ? 'offline' : operations.length ? 'local' : 'online');
  } catch (error) {
    console.warn('could not determine pending sync status', error);
  }
}

function beginSyncStatusPresentation() {
  if (syncStatusRevealTimer || $('#sync-status')?.dataset.state === 'syncing') return;
  syncStatusRevealTimer = setTimeout(() => {
    syncStatusRevealTimer = null;
    if (syncInFlight) setSyncStatus('syncing');
  }, 150);
}

function finishSyncStatusPresentation(state) {
  if (syncStatusRevealTimer) {
    clearTimeout(syncStatusRevealTimer);
    syncStatusRevealTimer = null;
  }
  setSyncStatus(state);
}

class APIError extends Error {
  constructor(message, {status = 0, code = '', kind = 'http', retryable = null, cause = null} = {}) {
    super(message);
    this.name = 'APIError';
    this.kind = kind;
    this.code = code;
    this.responseStatus = status;
    this.retryable = retryable ?? (!status || status === 408 || status === 429 || status >= 500);
    if (cause) this.cause = cause;
  }
}

async function responseBody(response) {
  const text = await response.text();
  if (typeof text !== 'string') return text;
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

function apiErrorFromPayload(payload, status, statusText = '') {
  const message = typeof payload === 'string' ? payload : payload?.error || statusText || 'request failed';
  const code = typeof payload === 'object' && payload ? String(payload.code || '') : '';
  return new APIError(message, {status, code});
}

function apiErrorFromTransport(error) {
  if (error instanceof APIError) return error;
  const timedOut = error?.name === 'TimeoutError';
  const aborted = error?.name === 'AbortError';
  return new APIError(timedOut ? 'request timed out' : aborted ? 'request aborted' : 'network request failed', {
    kind: timedOut ? 'timeout' : aborted ? 'aborted' : 'network',
    retryable: !aborted,
    cause: error,
  });
}

async function api(path, opts) {
  const method = opts?.method || 'GET';
  const syncRequest = opts?.syncRequest === true;
  const requestOpts = {...opts};
  delete requestOpts.syncRequest;
  delete requestOpts.throwOnError;
  if (syncRequest) beginSyncNetworkRequest();
  try {
    const res = await fetchWithTimeout(path, {
      credentials: 'same-origin',
      headers: requestOpts?.body ? {'Content-Type':'application/json'} : {},
      ...requestOpts,
    }, {group: syncRequest ? activeSyncControllers : null});
    if (res.status === 204) return true;
    const body = await responseBody(res);
    if (!res.ok) {
      const error = apiErrorFromPayload(body, res.status, res.statusText);
      if (res.status === 401) requireAuthentication();
      throw error;
    }
    if (body === null) throw new APIError('invalid server response', {kind: 'protocol', retryable: false});
    return body;
  } catch(e) {
    const error = apiErrorFromTransport(e);
    setSyncDiagnostic(`${method} ${path} ${error?.responseStatus ? `returned HTTP ${error.responseStatus}` : 'failed'}: ${error?.message || 'unknown error'}`, error?.responseStatus);
    console.error(error);
    throw error;
  } finally {
    if (syncRequest) await endSyncNetworkRequest();
  }
}

async function syncFetch(path, options) {
  const method = options?.method || 'GET';
  beginSyncNetworkRequest();
  try {
    const response = await fetchWithTimeout(path, {
      credentials: 'same-origin',
      headers: options?.body ? {'Content-Type': 'application/json'} : {},
      ...options,
    }, {group: activeSyncControllers});
    const body = response.status === 204 ? null : await response.text();
    let data = null;
    if (body) {
      try { data = JSON.parse(body); } catch (_) { data = body; }
    }
    if (!response.ok) setSyncDiagnostic(`${method} ${path} returned HTTP ${response.status}: ${typeof data === 'string' ? data : response.statusText}`, response.status);
    return {response, data};
  } catch (error) {
    const typed = apiErrorFromTransport(error);
    setSyncDiagnostic(`${method} ${path} failed: ${typed.message}`);
    throw typed;
  } finally {
    await endSyncNetworkRequest();
  }
}

async function cacheRemoteNote(note) {
  const local = await getLocalNote(note.id);
  // A just-typed change may not have reached IndexedDB yet. Do not let a pull
  // replace that base snapshot before syncNow has a chance to save it locally.
  if (local?.pending || (currentNoteId === note.id && isDirty)) return;
  await putLocalNote({...local, ...note, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
  if (currentNoteId === note.id && !isDirty) {
    currentRevision = note.revision || 0;
    currentBaseRevision = null;
    savedSnapshot = {title: note.title || '', tags: note.tags || '', content: note.content || ''};
    $('#note-title').value = savedSnapshot.title;
    $('#note-tags').value = savedSnapshot.tags;
    $('#note-content').value = savedSnapshot.content;
    renderedPreviewSource = null;
    updatePreview();
  }
}

async function applyRemoteDeletion(noteID) {
  const removed = await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const pending = await requestValue(stores.queue.index('note_id').getAll(noteID));
    const conflict = await requestValue(stores.state.get(unresolvedConflictKey(noteID)));
    const rejected = await requestValue(stores.state.get(rejectedSyncKey(noteID)));
    if (pending.length || conflict || rejected) return false;
    await requestValue(stores.notes.delete(noteID));
    return true;
  });
  if (removed && currentNoteId === noteID && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
  return removed;
}

async function bulkRemoteNotes(noteIDs) {
  if (!noteIDs.length) return new Map();
  const notes = new Map();
  for (let index = 0; index < noteIDs.length; index += bulkNoteBatchSize) {
    const batch = noteIDs.slice(index, index + bulkNoteBatchSize);
    const response = await api(`/api/sync/notes?ids=${encodeURIComponent(batch.join(','))}`, {syncRequest: true});
    if (!response || !Array.isArray(response.notes) || !Array.isArray(response.missing)) {
      throw new Error('could not download changed notes');
    }
    response.notes.forEach(note => notes.set(note.id, note));
    response.missing.forEach(id => notes.set(id, null));
  }
  return notes;
}

async function loadSyncGuards() {
  return withOfflineStore(['queue', 'state'], 'readonly', async stores => {
    const [operations, records] = await Promise.all([
      requestValue(stores.queue.getAll()),
      requestValue(stores.state.getAll()),
    ]);
    const guarded = new Set(operations.map(operation => operation.note_id).filter(Boolean));
    records.forEach(record => {
      if (record.key.startsWith('unresolvedConflict:') || record.key.startsWith('rejectedSync:')) {
        const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
        if (noteID) guarded.add(noteID);
      }
    });
    return guarded;
  });
}

async function applyRemoteChangePage(changes, downloaded, nextSequence) {
  let activeNote = null;
  let activeDeleted = false;
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const [operations, records] = await Promise.all([
      requestValue(stores.queue.getAll()),
      requestValue(stores.state.getAll()),
    ]);
    const guarded = new Set(operations.map(operation => operation.note_id).filter(Boolean));
    records.forEach(record => {
      if (record.key.startsWith('unresolvedConflict:') || record.key.startsWith('rejectedSync:')) {
        const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
        if (noteID) guarded.add(noteID);
      }
    });
    for (const change of changes) {
      if (guarded.has(change.note_id)) continue;
      const remote = change.deleted ? null : downloaded.get(change.note_id);
      const local = await requestValue(stores.notes.get(change.note_id));
      if (local?.pending || (currentNoteId === change.note_id && isDirty)) continue;
      if (!remote) {
        await requestValue(stores.notes.delete(change.note_id));
        if (currentNoteId === change.note_id) activeDeleted = true;
        continue;
      }
      const next = {...local, ...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null};
      await requestValue(stores.notes.put(next));
      if (currentNoteId === change.note_id && !isDirty) activeNote = next;
    }
    await requestValue(stores.state.put({key: 'syncSequence', value: nextSequence}));
  });
  if (activeNote) updateOpenNote(activeNote);
  if (activeDeleted && currentNoteId && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}

async function applyRemoteSnapshot(remoteNotes, remoteIDs, sequence = null) {
  let activeNote = null;
  let activeDeleted = false;
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const [operations, records, locals] = await Promise.all([
      requestValue(stores.queue.getAll()),
      requestValue(stores.state.getAll()),
      requestValue(stores.notes.getAll()),
    ]);
    const localByID = new Map(locals.map(note => [note.id, note]));
    const guarded = new Set(operations.map(operation => operation.note_id).filter(Boolean));
    records.forEach(record => {
      if (record.key.startsWith('unresolvedConflict:') || record.key.startsWith('rejectedSync:')) {
        const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
        if (noteID) guarded.add(noteID);
      }
    });
    for (const [id, remote] of remoteNotes) {
      if (guarded.has(id)) continue;
      const local = localByID.get(id);
      if (local?.pending || (currentNoteId === id && isDirty)) continue;
      const next = {...local, ...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null};
      await requestValue(stores.notes.put(next));
      if (currentNoteId === id && !isDirty) activeNote = next;
    }
    for (const local of locals) {
      if (remoteIDs.has(local.id) || guarded.has(local.id)) continue;
      await requestValue(stores.notes.delete(local.id));
      if (currentNoteId === local.id) activeDeleted = true;
    }
    if (sequence !== null) await requestValue(stores.state.put({key: 'syncSequence', value: sequence}));
  });
  if (activeNote) updateOpenNote(activeNote);
  if (activeDeleted && currentNoteId && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}

async function pullRemoteChanges() {
  let since = Number(await getOfflineState('syncSequence') || 0);
  const fetchedNotes = new Map();
  const guards = await loadSyncGuards();
  for (;;) {
    const page = await api(`/api/sync?since=${since}&limit=100`, {syncRequest: true});
    if (!page) throw new Error('could not fetch sync changes');
    if (page.resetRequired) {
      await resetLocalNotesFromRemote(Number(page.nextSequence || 0));
      return;
    }
    const downloadIDs = [];
    for (const change of page.changes) {
      if (change.deleted || fetchedNotes.has(change.note_id)) continue;
      if (guards.has(change.note_id)) continue;
      downloadIDs.push(change.note_id);
    }
    const downloaded = await bulkRemoteNotes([...new Set(downloadIDs)]);
    downloaded.forEach((remote, id) => fetchedNotes.set(id, remote));
    const nextSince = Number(page.nextSequence || since);
    if (page.hasMore && nextSince <= since) {
      throw new Error(`sync cursor did not advance (since ${since}, next ${nextSince})`);
    }
    await applyRemoteChangePage(page.changes, fetchedNotes, nextSince);
    since = nextSince;
    if (!page.hasMore) return;
  }
}

async function resetLocalNotesFromRemote(sequence) {
  const summaries = await api('/api/notes', {syncRequest: true});
  if (!Array.isArray(summaries)) throw new Error('could not refresh notes after sync compaction');
  const remoteIDs = new Set(summaries.map(note => note.id));
  const remoteNotes = new Map();
  const downloadIDs = [];
  const guards = await loadSyncGuards();
  for (const summary of summaries) {
    if (guards.has(summary.id)) continue;
    downloadIDs.push(summary.id);
  }
  for (let index = 0; index < downloadIDs.length; index += 100) {
    const page = await bulkRemoteNotes(downloadIDs.slice(index, index + 100));
    page.forEach((remote, id) => remoteNotes.set(id, remote));
  }
  for (const id of downloadIDs) if (!remoteNotes.get(id)) throw new Error('could not download refreshed note');
  await applyRemoteSnapshot(remoteNotes, remoteIDs, sequence);
}

// A sync cursor records that this browser has observed the change feed, but a
// browser can still lose individual IndexedDB records (for example after a
// storage repair). Reconcile against note summaries at session start so a
// valid-but-stale cursor cannot leave the dashboard incomplete forever.
async function reconcileLocalNotes() {
  const summaries = await api('/api/notes', {syncRequest: true});
  if (!Array.isArray(summaries)) throw new Error('could not reconcile local notes');
  const remoteIDs = new Set(summaries.map(note => note.id));
  const downloadIDs = [];
  const remoteNotes = new Map();
  const guards = await loadSyncGuards();
  const locals = await getAllLocalNotes();
  const localByID = new Map(locals.map(note => [note.id, note]));
  for (const summary of summaries) {
    if (guards.has(summary.id)) continue;
    const local = localByID.get(summary.id);
    if (local && local.revision === summary.revision) continue;
    downloadIDs.push(summary.id);
  }
  for (let index = 0; index < downloadIDs.length; index += 100) {
    const page = await bulkRemoteNotes(downloadIDs.slice(index, index + 100));
    page.forEach((remote, id) => remoteNotes.set(id, remote));
  }
  for (const id of downloadIDs) if (!remoteNotes.get(id)) throw new Error('could not download reconciled note');
  await applyRemoteSnapshot(remoteNotes, remoteIDs);
}

function updateOpenNote(note) {
  if (currentNoteId !== note.id || isDirty) return;
  currentRevision = note.revision || 0;
  currentBaseRevision = note.base_revision ?? null;
  savedSnapshot = {title: note.title || '', tags: note.tags || '', content: note.content || ''};
  $('#note-title').value = savedSnapshot.title;
  $('#note-tags').value = savedSnapshot.tags;
  $('#note-content').value = savedSnapshot.content;
  renderedPreviewSource = null;
  updatePreview();
}

async function loadConflictRemoteNote(noteID) {
  try {
    return await api(`/api/notes/${encodeURIComponent(noteID)}`, {syncRequest: true});
  } catch (error) {
    // A 404 is authoritative: the remote note was deleted. Other failures
    // must abort conflict handling so the original operation can be retried.
    if (error?.responseStatus === 404) return null;
    throw error;
  }
}

async function mergeConflictedNote(operation, remote) {
  if (operation.type !== 'note.save' || !operation.note || !window.VylkMerge) return false;
  // A network response can arrive while the user is still typing. Capture that
  // newer local state before deriving the merge, rather than merging an older
  // queued snapshot and accidentally omitting the last keystrokes.
  if (currentNoteId === operation.note_id && isDirty) await saveCurrentNote(false);
  const local = await getLocalNote(operation.note_id);
  if (!local || !remote) return false;
  // Queued edits created before three-way metadata existed cannot be merged
  // safely for title/tags; the durable resolver handles them instead.
  if (local.base_title === undefined || local.base_tags === undefined) return false;

  const base = {
    title: local.base_title ?? operation.note.base_title ?? operation.note.title ?? '',
    tags: local.base_tags ?? operation.note.base_tags ?? operation.note.tags ?? '',
    content: local.base_content ?? operation.note.base_content ?? '',
  };
  const merged = window.VylkMerge.mergeNoteVersions(base, local, remote);
  if (!merged) return false;
  const queued = await pendingOperationsForNote(operation.note_id);
  const laterPin = latestLaterOperation(queued, operation, 'note.pin');

  const now = new Date().toISOString();
  const mergedLocal = {
    ...remote,
    ...merged,
    ...(laterPin ? {
      pinned: Boolean(laterPin.pinned),
      pin_order: laterPin.pinned ? (local.pin_order || 0) : 0,
    } : {}),
    updated_at: now,
    pending: true,
    base_revision: remote.revision,
    base_content: remote.content || '',
    base_title: remote.title || '',
    base_tags: remote.tags || '',
  };
  await putLocalNote(mergedLocal);
  // The conflicting operation is already recorded by the server. Later local
  // snapshots have the old base, so replace them with ordered no-ops and a
  // single merged save after them; that preserves the device event sequence.
  await supersedeQueuedNoteOperations(operation.note_id, operation.client_sequence);
  await removePendingOperationIfIdentityMatches(operation.id, operation);
  await queueOperation({type: 'note.save', note_id: mergedLocal.id, base_revision: remote.revision, note: mergedLocal});
  updateOpenNote(mergedLocal);
  return true;
}

async function preserveConflictCopy(operation, local, remote) {
  if (remote) await putLocalNote({...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
  else await removeLocalNote(operation.note_id);
  if (local && operation.type === 'note.save') {
    const conflictID = newLocalNoteID();
    const now = new Date().toISOString();
    const conflict = {
      id: conflictID,
      title: `${local.title || 'Untitled'} (conflict copy)`,
      filename: `${conflictID}.md`,
      tags: local.tags || '',
      content: local.content || '',
      base_content: '',
      created_at: now,
      updated_at: now,
      revision: 0,
      base_revision: 0,
      base_title: '',
      base_tags: '',
      pending: true,
    };
    await putLocalNote(conflict);
    await queueOperation({type: 'note.save', note_id: conflictID, base_revision: 0, note: conflict});
    if (currentNoteId === operation.note_id) {
      currentNoteId = conflictID;
      updateOpenNote(conflict);
    }
  }
  await supersedeQueuedNoteOperations(operation.note_id, operation.client_sequence);
  await removePendingOperationIfIdentityMatches(operation.id, operation);
}

function conflictBase(local, operation) {
  return {
    title: local.base_title ?? operation.note?.base_title ?? operation.note?.title ?? '',
    tags: local.base_tags ?? operation.note?.base_tags ?? operation.note?.tags ?? '',
    content: local.base_content ?? operation.note?.base_content ?? '',
  };
}

async function createRemoteDeletionConflict(operation, local) {
  const preserved = {
    ...local,
    id: operation.note_id,
    title: local.title || 'Untitled',
    tags: local.tags || '',
    content: local.content || '',
  };
  const conflict = {
    kind: 'remote-deleted',
    note_id: operation.note_id,
    created_at: new Date().toISOString(),
    base: conflictBase(preserved, operation),
    local: preserved,
    remote: null,
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) {
      throw new Error('conflicting sync operation changed before deletion resolution');
    }
    await requestValue(stores.notes.put({...preserved, pending: false}));
    await requestValue(stores.state.put({key: unresolvedConflictKey(operation.note_id), value: conflict}));
    const laterOperations = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    for (const later of laterOperations) {
      if (later.id !== operation.id && later.client_sequence > operation.client_sequence && !later.attempted_at) {
        later.type = 'noop';
        await requestValue(stores.queue.put(later));
      }
    }
    await requestValue(stores.queue.delete(operation.id));
  });
}

function renderConflictDiff(target, base, version, changedClass) {
  const baseLines = String(base || '').split('\n');
  const versionLines = String(version || '').split('\n');
  let prefix = 0;
  while (prefix < baseLines.length && prefix < versionLines.length && baseLines[prefix] === versionLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < baseLines.length - prefix && suffix < versionLines.length - prefix && baseLines[baseLines.length - suffix - 1] === versionLines[versionLines.length - suffix - 1]) suffix++;
  target.replaceChildren();
  const append = (text, changed) => {
    const node = document.createElement(changed ? 'mark' : 'span');
    if (changed) node.className = `conflict-line ${changedClass}`;
    node.textContent = text;
    target.append(node);
  };
  if (prefix) append(`${versionLines.slice(0, prefix).join('\n')}\n`, false);
  const changed = versionLines.slice(prefix, versionLines.length - suffix).join('\n');
  if (changed || versionLines.length !== baseLines.length) append(`${changed || '∅'}\n`, true);
  if (suffix) append(versionLines.slice(versionLines.length - suffix).join('\n'), false);
}

let activeConflictID = null;
let activeConflictSelection = 'local';
let activeConflictKind = 'edit';

function closeConflictResolver() {
  activeConflictID = null;
  activeConflictSelection = 'local';
  activeConflictKind = 'edit';
  closeModal($('#conflict-modal'));
}

function closePreferences() {
  if (isAppPreferencesRoute()) {
    // Preferences is a real overlay history entry. Pop it instead of replacing
    // it with its parent route, which would leave duplicate note entries and
    // make the next Back appear unresponsive.
    history.back();
    return;
  }
  closeModal($('#prefs-modal'));
}

function openModal(modal) {
  if (modal.__closeTimer) {
    window.clearTimeout(modal.__closeTimer);
    modal.__closeTimer = null;
  }
  if (!modal.__keyboardBound) {
    modal.addEventListener('keydown', handleModalKeydown);
    modal.__keyboardBound = true;
  }
  modal.__opener = document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : null;
  modal.classList.remove('hidden', 'is-closing');
  modal.setAttribute('aria-hidden', 'false');
  const initialFocus = modal.querySelector('[autofocus]') || modal.querySelector('.modal-close') || modalFocusableElements(modal)[0] || modal.querySelector('[role="dialog"]');
  if (initialFocus) initialFocus.focus();
}

function modalFocusableElements(modal) {
  return [...modal.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(element => {
    if (element.disabled || element.hidden || element.closest('.hidden, [hidden]')) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function handleModalKeydown(event) {
  const modal = event.currentTarget;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (modal.id === 'conflict-modal') closeConflictResolver();
    else if (modal.id === 'prefs-modal') closePreferences();
    else closeModal(modal);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = modalFocusableElements(modal);
  if (!focusable.length) {
    event.preventDefault();
    modal.querySelector('[role="dialog"]')?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeModal(modal) {
  if (modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;
  modal.classList.add('is-closing');
  const opener = modal.__opener;
  const finish = () => {
    modal.classList.remove('is-closing');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    modal.__opener = null;
    if (opener?.isConnected) opener.focus();
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
  } else {
    modal.__closeTimer = window.setTimeout(() => {
      modal.__closeTimer = null;
      finish();
    }, 190);
  }
}

function setConflictSelection(selection) {
  activeConflictSelection = selection;
  const localSelected = selection === 'local';
  const remoteSelected = selection === 'remote';
  $('.conflict-version-local').classList.toggle('is-selected', localSelected);
  $('.conflict-version-remote').classList.toggle('is-selected', remoteSelected);
  $('#conflict-use-local').setAttribute('aria-pressed', String(localSelected));
  $('#conflict-use-remote').setAttribute('aria-pressed', String(remoteSelected));
  $('#conflict-selection-status').textContent = selection === 'local'
    ? 'Selected: this device. You can edit the result below.'
    : selection === 'remote'
      ? 'Selected: other device. You can edit the result below.'
      : 'Custom result. You can continue editing it below.';
}

function showConflictResolver(conflict) {
  activeConflictKind = 'edit';
  activeConflictID = conflict.note_id;
  $('#conflict-title').textContent = 'Resolve conflicting edits';
  $('.conflict-intro').textContent = 'This note changed on another device while you were editing it. Review both versions, then save the result you want to keep.';
  $('#conflict-deleted-details').classList.add('hidden');
  $$('.conflict-fields, .conflict-metadata-compare, .conflict-compare, #conflict-selection-status, .conflict-result, .conflict-base:not(#conflict-deleted-details)').forEach(element => element.classList.remove('hidden'));
  $('#conflict-copy').className = 'btn-text';
  $('#conflict-copy').textContent = 'Keep as copy';
  $('#conflict-save').className = 'btn-primary';
  $('#conflict-save').textContent = 'Save resolution';
  $('#conflict-note-title').value = conflict.local.title || '';
  $('#conflict-note-tags').value = conflict.local.tags || '';
  $('#conflict-note-content').value = conflict.local.content || '';
  $('#conflict-local-metadata').textContent = `Title: ${conflict.local.title || 'Untitled'}\nTags: ${conflict.local.tags || 'None'}`;
  $('#conflict-remote-metadata').textContent = `Title: ${conflict.remote.title || 'Untitled'}\nTags: ${conflict.remote.tags || 'None'}`;
  renderConflictDiff($('#conflict-local-diff'), conflict.base.content, conflict.local.content, 'conflict-line-local');
  renderConflictDiff($('#conflict-remote-diff'), conflict.base.content, conflict.remote.content, 'conflict-line-remote');
  $('#conflict-base-content').textContent = conflict.base.content || '(empty note)';
  setConflictSelection('local');
  openModal($('#conflict-modal'));
  $('#conflict-note-content').focus();
}

function showDeletedConflict(conflict) {
  activeConflictKind = 'remote-deleted';
  activeConflictID = conflict.note_id;
  $('#conflict-title').textContent = 'Note deleted on another device';
  $('.conflict-intro').textContent = 'Your changes are saved on this device. Choose whether to keep them as a new note or accept the deletion.';
  $$('.conflict-fields, .conflict-metadata-compare, .conflict-compare, #conflict-selection-status, .conflict-result, .conflict-base').forEach(element => element.classList.add('hidden'));
  $('#conflict-deleted-details').classList.remove('hidden');
  $('#conflict-deleted-content').textContent = [
    `Title: ${conflict.local.title || 'Untitled'}`,
    `Tags: ${conflict.local.tags || 'None'}`,
    '',
    conflict.local.content || '(empty note)',
  ].join('\n');
  $('#conflict-copy').className = 'btn-primary';
  $('#conflict-copy').textContent = 'Keep as new note';
  $('#conflict-save').className = 'btn-text danger';
  $('#conflict-save').textContent = 'Accept deletion';
  openModal($('#conflict-modal'));
}

async function showConflictResolverFor(noteID) {
  const conflict = await getUnresolvedConflict(noteID);
  if (!conflict) return false;
  if (conflict.kind === 'remote-deleted') showDeletedConflict(conflict);
  else showConflictResolver(conflict);
  return true;
}

function fillConflictResolution(version, selection) {
  $('#conflict-note-title').value = version.title || '';
  $('#conflict-note-tags').value = version.tags || '';
  $('#conflict-note-content').value = version.content || '';
  setConflictSelection(selection);
}

async function createConflictResolution(operation, remote) {
  // Always capture fresh keystrokes before replacing the cached note. This is
  // especially important for notification-driven sync, which can arrive while
  // the 250ms local-save timer is still pending.
  if (currentNoteId === operation.note_id && isDirty) await saveCurrentNote(false);
  const local = await getLocalNote(operation.note_id);
  if (!remote && operation.type === 'note.save' && (local || operation.note)) {
    await createRemoteDeletionConflict(operation, local || operation.note);
    return 'remote-deleted';
  }
  if (!local || !remote || operation.type !== 'note.save') {
    await preserveConflictCopy(operation, local, remote);
    return false;
  }

  const queued = await pendingOperationsForNote(operation.note_id);
  const laterPin = latestLaterOperation(queued, operation, 'note.pin');
  const resolvedRemote = laterPin ? {
    ...remote,
    pinned: Boolean(laterPin.pinned),
    pin_order: laterPin.pinned ? (local.pin_order || 0) : 0,
  } : remote;

  const conflict = {
    note_id: operation.note_id,
    created_at: new Date().toISOString(),
    base: conflictBase(local, operation),
    local: {title: local.title || '', tags: local.tags || '', content: local.content || ''},
    remote: {...resolvedRemote, title: remote.title || '', tags: remote.tags || '', content: remote.content || '', revision: remote.revision || 0, filename: remote.filename || ''},
  };
  // Persist the user's version before acknowledging the conflict locally. If
  // the browser closes now, reopening the note resumes this resolver.
  await setUnresolvedConflict(conflict);
  await putLocalNote({...resolvedRemote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
  await supersedeQueuedNoteOperations(operation.note_id, operation.client_sequence);
  await removePendingOperationIfIdentityMatches(operation.id, operation);
  // Bring the authoritative version into the normal editor before opening the
  // resolver, even if the conflict was discovered after navigating away. Any
  // note the user began editing during the request is saved locally first.
  if (isDirty) await saveCurrentNote(false);
  showNoteInEditor(remote);
  setNoteRoute(remote.id);
  showConflictResolver(conflict);
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  return true;
}

async function saveConflictResolution() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict) return;
  const now = new Date().toISOString();
  const resolved = {
    ...conflict.remote,
    id: noteID,
    title: $('#conflict-note-title').value.trim() || 'Untitled',
    tags: $('#conflict-note-tags').value.trim(),
    content: $('#conflict-note-content').value,
    updated_at: now,
    pending: true,
    base_revision: conflict.remote.revision,
    base_title: conflict.remote.title || '',
    base_tags: conflict.remote.tags || '',
    base_content: conflict.remote.content || '',
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(resolved));
    await queueOperationInStores(stores, {type: 'note.save', note_id: noteID, base_revision: resolved.base_revision, note: resolved});
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  currentNoteId = noteID;
  isDirty = false;
  updateOpenNote(resolved);
  closeConflictResolver();
  showToast('Conflict resolution saved.', 'success');
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  scheduleSync();
}

async function keepConflictAsCopy() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict) return;
  const conflictID = newLocalNoteID();
  const now = new Date().toISOString();
  const copy = {
    id: conflictID,
    title: `${conflict.local.title || 'Untitled'} (conflict copy)`,
    filename: `${conflictID}.md`,
    tags: conflict.local.tags || '',
    content: conflict.local.content || '',
    created_at: now,
    updated_at: now,
    revision: 0,
    base_revision: 0,
    base_title: '',
    base_tags: '',
    base_content: '',
    pending: true,
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(copy));
    await queueOperationInStores(stores, {type: 'note.save', note_id: copy.id, base_revision: 0, note: copy});
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  currentNoteId = copy.id;
  isDirty = false;
  updateOpenNote(copy);
  setNoteRoute(copy.id);
  closeConflictResolver();
  showToast('Your version was saved as a separate note.', 'success');
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  scheduleSync();
}

async function keepDeletedConflictAsCopy() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict || conflict.kind !== 'remote-deleted') return;
  const conflictID = newLocalNoteID();
  const now = new Date().toISOString();
  const copy = {
    ...conflict.local,
    id: conflictID,
    title: `${conflict.local.title || 'Untitled'} (conflict copy)`,
    filename: `${conflictID}.md`,
    created_at: conflict.local.created_at || now,
    updated_at: now,
    revision: 0,
    base_revision: 0,
    base_title: '',
    base_tags: '',
    base_content: '',
    pending: true,
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(copy));
    await queueOperationInStores(stores, {type: 'note.save', note_id: conflictID, base_revision: 0, note: copy});
    await requestValue(stores.notes.delete(noteID));
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  currentNoteId = conflictID;
  isDirty = false;
  updateOpenNote(copy);
  setNoteRoute(conflictID);
  closeConflictResolver();
  showToast('Your changes were saved as a new note.', 'success');
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  scheduleSync();
}

async function acceptDeletedConflict() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict || conflict.kind !== 'remote-deleted') return;
  await withOfflineStore(['notes', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(noteID));
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  if (currentNoteId === noteID) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
  closeConflictResolver();
  showToast('The remote deletion was accepted.', 'success');
  scheduleSync();
}

$('#conflict-use-local').addEventListener('click', async () => {
  const conflict = activeConflictID && await getUnresolvedConflict(activeConflictID);
  if (conflict) fillConflictResolution(conflict.local, 'local');
});

$('#conflict-use-remote').addEventListener('click', async () => {
  const conflict = activeConflictID && await getUnresolvedConflict(activeConflictID);
  if (conflict) fillConflictResolution(conflict.remote, 'remote');
});

['#conflict-note-title', '#conflict-note-tags', '#conflict-note-content'].forEach(selector => {
  $(selector).addEventListener('input', () => {
    if (activeConflictID && activeConflictSelection !== 'custom') setConflictSelection('custom');
  });
});

$('#conflict-save').addEventListener('click', () => { void (activeConflictKind === 'remote-deleted' ? acceptDeletedConflict() : saveConflictResolution()); });
$('#conflict-copy').addEventListener('click', () => { void (activeConflictKind === 'remote-deleted' ? keepDeletedConflictAsCopy() : keepConflictAsCopy()); });
$('#conflict-later').addEventListener('click', closeConflictResolver);
$('#conflict-close').addEventListener('click', closeConflictResolver);
$('#conflict-modal .modal-backdrop').addEventListener('click', closeConflictResolver);

async function reconcileCompactedOperationLocally(operation, remote) {
  return withOfflineStore(['notes', 'queue'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) {
      throw new Error('compacted sync operation changed before local reconciliation');
    }

    const operations = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    let hasLater = false;
    for (const later of operations) {
      if (later.id === operation.id || later.client_sequence < 1 || later.attempted_at) continue;
      if (later.type !== 'note.save' && later.type !== 'note.delete' && later.type !== 'note.pin') continue;
      if (remote) {
        later.base_revision = remote.revision;
        if (later.note) {
          later.note.base_revision = remote.revision;
          later.note.base_content = remote.content;
          later.note.base_title = remote.title;
          later.note.base_tags = remote.tags;
        }
        await requestValue(stores.queue.put(later));
      }
      hasLater = true;
    }

    const local = await requestValue(stores.notes.get(operation.note_id));
    if (remote && !hasLater) {
      await requestValue(stores.notes.put({...local, ...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null}));
    } else if (remote && hasLater) {
      await requestValue(stores.notes.put({...remote, ...local, revision: remote.revision, pending: true, base_revision: remote.revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags}));
    } else if (!remote && !hasLater) {
      await requestValue(stores.notes.delete(operation.note_id));
    }
    await requestValue(stores.queue.delete(operation.id));
    return hasLater;
  });
}

async function acknowledgeCompactedOperation(operation) {
  if (operation.type !== 'note.save' && operation.type !== 'note.delete' && operation.type !== 'note.pin') {
    const removed = await removePendingOperationIfIdentityMatches(operation.id, operation);
    if (!removed) throw new Error('compacted sync operation changed before acknowledgement');
    return;
  }

  let remote = null;
  try {
    remote = await api(`/api/notes/${encodeURIComponent(operation.note_id)}`, {syncRequest: true, throwOnError: true});
  } catch (error) {
    // Only an explicit 404 proves that the note is absent. Timeouts, server
    // errors, authentication failures, and other errors must leave the queue
    // entry intact so the next sync can retry reconciliation.
    if (error?.responseStatus !== 404) throw error;
  }

  const hasLater = await reconcileCompactedOperationLocally(operation, remote);
  if (!hasLater && remote) updateOpenNote(remote);
  if (!hasLater && !remote && currentNoteId === operation.note_id && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}

const syncPushBatchLimit = 100;
const syncPushBatchByteLimit = 3 * 1024 * 1024;

function outgoingSyncOperation(operation) {
  const outgoing = {
    client_sequence: operation.client_sequence,
    op_id: operation.op_id,
    type: operation.type,
    note_id: operation.note_id,
    base_revision: operation.base_revision,
  };
  if (operation.type === 'note.save') {
    outgoing.title = operation.note.title;
    outgoing.tags = operation.note.tags;
    outgoing.content = operation.note.content;
    outgoing.base_content = operation.note.base_content || '';
    outgoing.pinned = Boolean(operation.note.pinned);
  } else if (operation.type === 'note.pin') {
    outgoing.pinned = Boolean(operation.pinned);
  } else if (operation.type === 'prefs.save') {
    outgoing.prefs = operation.prefs;
  }
  return outgoing;
}

function encodedByteLength(value) {
  const encoded = JSON.stringify(value);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(encoded).byteLength : encoded.length;
}

function claimPendingOperationBatch(deviceID, maxOperations, maxBytes) {
  return withOfflineStore(['queue'], 'readwrite', stores => new Promise((resolve, reject) => {
    const batch = [];
    const revisionNoteIDs = new Set();
    const request = stores.queue.index('client_sequence').openCursor();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(batch);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || batch.length >= maxOperations) {
        finish();
        return;
      }
      const operation = cursor.value;
      const isRevisionOperation = ['note.save', 'note.delete', 'note.pin'].includes(operation.type) && operation.note_id;
      if (isRevisionOperation && revisionNoteIDs.has(operation.note_id)) {
        finish();
        return;
      }
      const candidate = [...batch.map(item => outgoingSyncOperation(item)), outgoingSyncOperation(operation)];
      const requestBytes = encodedByteLength({device_id: deviceID, operations: candidate});
      if (batch.length && requestBytes > maxBytes) {
        finish();
        return;
      }
      if (!operation.attempted_at) {
        operation.attempted_at = new Date().toISOString();
        cursor.update(operation);
      }
      batch.push(operation);
      if (isRevisionOperation) revisionNoteIDs.add(operation.note_id);
      if (batch.length >= maxOperations) finish();
      else cursor.continue();
    };
  }));
}

async function applySyncAcknowledgement(operation, acknowledgement) {
  if (acknowledgement.status === 'compacted') {
    await acknowledgeCompactedOperation(operation);
    return;
  }
  if (acknowledgement.status === 'conflict') {
    if (operation.type === 'prefs.save') {
      await resolvePreferenceConflict(operation);
      return;
    }
    if (operation.type === 'note.pin') {
      const remote = await loadConflictRemoteNote(operation.note_id);
      if (!remote) {
        await removeLocalNote(operation.note_id);
        await removePendingOperationIfIdentityMatches(operation.id, operation);
        return;
      }
      const queued = await pendingOperationsForNote(operation.note_id);
      const hasLaterSave = Boolean(latestLaterOperation(queued, operation, 'note.save'));
      const laterPin = latestLaterOperation(queued, operation, 'note.pin');
      const desiredPinned = laterPin ? Boolean(laterPin.pinned) : Boolean(operation.pinned);
      // A later save was authored against the pin's older base. Let that save
      // conflict normally so its content is three-way merged with the remote
      // edit; rebasing it here would make the stale snapshot look current and
      // allow it to overwrite the remote change.
      if (!hasLaterSave) await rebaseQueuedNoteOperations(operation.note_id, operation.id, remote.revision, remote);
      await removePendingOperationIfIdentityMatches(operation.id, operation);
      const local = await getLocalNote(operation.note_id);
      const preserveLocalContent = hasLaterSave || (currentNoteId === operation.note_id && isDirty);
      const next = {
        ...remote,
        ...(preserveLocalContent ? local : {}),
        pinned: desiredPinned,
        pin_order: desiredPinned ? (local?.pin_order || 0) : 0,
        revision: remote.revision,
        pending: true,
        base_revision: remote.revision,
      };
      await putLocalNote(next);
      if (!laterPin) {
        await queueOperation({type: 'note.pin', note_id: operation.note_id, base_revision: remote.revision, pinned: desiredPinned, pin_order: next.pin_order});
      }
      updateOpenNote(next);
      await refreshDashboard();
      return;
    }
    const remote = await loadConflictRemoteNote(operation.note_id);
    if (await mergeConflictedNote(operation, remote)) {
      showToast('Merged your non-overlapping changes.', 'success');
    } else {
      const resolverReady = await createConflictResolution(operation, remote);
      if (resolverReady === 'remote-deleted') {
        await showConflictResolverFor(operation.note_id);
      } else if (resolverReady) showToast('Conflicting edits need your review.', 'warning');
      else showToast('A conflict copy was created so your changes are safe.', 'warning');
    }
    return;
  }
  if (acknowledgement.status !== 'applied') throw new Error('unknown sync acknowledgement');
  if (operation.type === 'prefs.save') {
    prefs = normalizePrefs({...prefs, revision: acknowledgement.revision || prefs.revision});
    localStorage.setItem('vylk-prefs', JSON.stringify(prefs));
    applyPrefs();
  }
  if (operation.type === 'note.save') {
    const acknowledgedNote = operation.note;
    const queued = await pendingOperationsForNote(operation.note_id);
    const laterPin = latestLaterOperation(queued, operation, 'note.pin');
    const hasLater = await rebaseQueuedNoteOperations(operation.note_id, operation.id, acknowledgement.revision, acknowledgedNote);
    const local = await getLocalNote(operation.note_id);
    if (local) {
      const pinOrder = laterPin ? local.pin_order : (acknowledgedNote.pinned ? (acknowledgement.pin_order || local.pin_order || 0) : 0);
      await putLocalNote({...local, revision: acknowledgement.revision, pin_order: pinOrder, pending: hasLater, base_revision: hasLater ? acknowledgement.revision : null, base_content: hasLater ? acknowledgedNote.content : null, base_title: hasLater ? acknowledgedNote.title : null, base_tags: hasLater ? acknowledgedNote.tags : null});
    }
    if (currentNoteId === operation.note_id) {
      currentRevision = acknowledgement.revision || 0;
      currentBaseRevision = hasLater ? acknowledgement.revision : null;
    }
  }
  if (operation.type === 'note.pin') {
    const local = await getLocalNote(operation.note_id);
    if (local) {
      const queued = await pendingOperationsForNote(operation.note_id);
      const laterPin = latestLaterOperation(queued, operation, 'note.pin');
      const hasLater = await rebaseQueuedNoteOperations(operation.note_id, operation.id, acknowledgement.revision, local);
      const pinned = laterPin ? Boolean(local.pinned) : Boolean(operation.pinned);
      const pinOrder = laterPin ? local.pin_order : (pinned ? (acknowledgement.pin_order || local.pin_order || 0) : 0);
      const remainsPending = hasLater || Boolean(laterPin);
      await putLocalNote({...local, revision: acknowledgement.revision, pinned, pin_order: pinOrder, pending: remainsPending, base_revision: remainsPending ? acknowledgement.revision : null});
      await refreshDashboard();
    }
  }
  await removePendingOperationIfIdentityMatches(operation.id, operation);
}

async function flushPendingChanges() {
  let pushed = false;
  let maxOperations = syncPushBatchLimit;
  for (;;) {
    const deviceID = await syncDeviceID();
    const operations = await claimPendingOperationBatch(deviceID, maxOperations, syncPushBatchByteLimit);
    if (!operations.length) return pushed;
    const result = await syncFetch('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({device_id: deviceID, operations: operations.map(outgoingSyncOperation)}),
    });
    pushed = true;
    if (result.response.status === 401) {
      requireAuthentication();
      throw apiErrorFromPayload(result.data, 401, 'Unauthorized');
    }
    if (result.response.status === 409) {
      const expected = Number(result.data?.expected_sequence);
      if (await repairSyncSequenceGap(expected)) {
        showToast('Recovered a local sync gap. Retrying your changes.', 'warning');
        continue;
      }
      throw new APIError(expected ? `sync sequence gap; expected ${expected}` : 'sync sequence conflict', {
        status: 409,
        code: 'sync_sequence_conflict',
        retryable: false,
      });
    }
    if (!result.response.ok) {
      const permanent = result.response.status === 400 || result.response.status === 413 || result.data?.permanent === true;
      if (permanent) {
        if (operations.length > 1) {
          maxOperations = result.response.status === 413 ? Math.max(1, Math.floor(maxOperations / 2)) : 1;
          continue;
        }
        if (await quarantineQueueOperation(operations[0], typeof result.data === 'string' ? result.data : result.data?.error)) {
          showToast('A local change needs attention before it can sync.', 'warning');
          continue;
        }
      }
      throw apiErrorFromPayload(result.data, result.response.status, result.response.statusText);
    }
    for (const operation of operations) {
      const acknowledgement = result.data?.acknowledged?.find(item => item.op_id === operation.op_id);
      if (!acknowledgement) throw new Error('sync acknowledgement missing');
      await applySyncAcknowledgement(operation, acknowledgement);
    }
  }
}

function preferenceValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeNestedPreferencePatch(current, base, desired) {
  if (!current || typeof current !== 'object' || !base || typeof base !== 'object' || !desired || typeof desired !== 'object') return null;
  const merged = {...current};
  let conflict = false;
  let changed = false;
  new Set([...Object.keys(base), ...Object.keys(desired)]).forEach(key => {
    const currentValue = Object.hasOwn(current, key) ? current[key] : undefined;
    const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
    const desiredValue = Object.hasOwn(desired, key) ? desired[key] : undefined;
    if (preferenceValuesEqual(baseValue, desiredValue)) return;
    if (!preferenceValuesEqual(currentValue, baseValue) && !preferenceValuesEqual(currentValue, desiredValue)) {
      conflict = true;
      return;
    }
    changed = true;
    if (desiredValue === undefined) delete merged[key];
    else merged[key] = desiredValue;
  });
  return {value:merged, conflict, changed};
}

async function resolvePreferenceConflict(operation) {
  const remote = await api('/api/prefs', {syncRequest: true});
  const payload = operation.prefs || {};
  const patch = payload._sync_patch || {};
  const base = payload._sync_base || {};
  const safePatch = {};
  const conflicts = [];
  Object.entries(patch).forEach(([key, desired]) => {
    const current = remote[key];
    if (key === 'keyboardShortcuts' || key === 'shortcutConfirmationSkips') {
      const merged = mergeNestedPreferencePatch(current, base[key], desired);
      if (!merged) {
        conflicts.push(key);
      } else {
        if (merged.conflict) conflicts.push(key);
        if (merged.changed) safePatch[key] = merged.value;
      }
      return;
    }
    if (!(key in base) || (!preferenceValuesEqual(current, base[key]) && !preferenceValuesEqual(current, desired))) {
      conflicts.push(key);
    } else if (!preferenceValuesEqual(current, desired)) {
      safePatch[key] = desired;
    }
  });

  const next = normalizePrefs({...remote, ...safePatch});
  await withOfflineStore(['queue', 'state'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) {
      throw new Error('preference operation changed before conflict resolution');
    }
    await requestValue(stores.queue.delete(operation.id));
    if (Object.keys(safePatch).length) {
      const safeBase = Object.fromEntries(Object.keys(safePatch).map(key => [key, remote[key]]));
      await queueOperationInStores(stores, {
        type: 'prefs.save',
        note_id: '__prefs__',
        base_revision: remote.revision,
        prefs: {...next, _sync_patch: safePatch, _sync_base: safeBase},
      });
    }
  });
  prefs = next;
  localStorage.setItem('vylk-prefs', JSON.stringify(prefs));
  applyPrefs();
  renderShortcutPreferences();
  if (conflicts.length) {
    showToast('Some preferences changed on another device. Those settings were kept.', 'warning');
  }
  scheduleSync();
}

function mergeSyncScheduleOptions(options = {}) {
  syncScheduleOptions = {
    ...syncScheduleOptions,
    ...options,
    reconcile: Boolean(syncScheduleOptions.reconcile || options.reconcile),
  };
}

async function acquireSyncLease() {
  const now = Date.now();
  return withOfflineStore(['state'], 'readwrite', async stores => {
    const current = await requestValue(stores.state.get(syncLeaseKey));
    const lease = current?.value;
    if (lease && lease.owner !== syncTabID && Number(lease.expiresAt) > now) return false;
    await requestValue(stores.state.put({
      key: syncLeaseKey,
      value: {owner: syncTabID, expiresAt: now + syncLeaseDurationMs},
    }));
    return true;
  });
}

async function renewSyncLease() {
  const now = Date.now();
  try {
    await withOfflineStore(['state'], 'readwrite', async stores => {
      const current = await requestValue(stores.state.get(syncLeaseKey));
      if (current?.value?.owner !== syncTabID) return;
      await requestValue(stores.state.put({
        key: syncLeaseKey,
        value: {owner: syncTabID, expiresAt: now + syncLeaseDurationMs},
      }));
    });
  } catch (error) {
    console.warn('could not renew sync lease', error);
  }
}

async function releaseSyncLease() {
  if (syncLeaseRenewTimer) {
    clearInterval(syncLeaseRenewTimer);
    syncLeaseRenewTimer = null;
  }
  await withOfflineStore(['state'], 'readwrite', async stores => {
    const current = await requestValue(stores.state.get(syncLeaseKey));
    if (current?.value?.owner === syncTabID) await requestValue(stores.state.delete(syncLeaseKey));
  });
}

async function withSyncLeadership(work) {
  if (navigator.locks && typeof navigator.locks.request === 'function') {
    let acquired = false;
    let result;
    try {
      await navigator.locks.request('vylk-sync', {ifAvailable: true}, async lock => {
        if (!lock) return;
        acquired = true;
        result = await work();
      });
      if (acquired) return result;
      // A normal null result means another tab owns the Web Lock. That owner
      // does not also hold the IndexedDB fallback lease, so falling through
      // would allow both tabs to synchronize concurrently.
      scheduleSync({}, 500);
      return false;
    } catch (error) {
      if (acquired) throw error;
      console.warn('Web Locks unavailable; using IndexedDB sync lease', error);
    }
  }

  if (!await acquireSyncLease()) {
    scheduleSync({}, 500);
    return false;
  }
  syncLeaseRenewTimer = setInterval(() => { void renewSyncLease(); }, syncLeaseDurationMs / 3);
  try {
    return await work();
  } finally {
    await releaseSyncLease();
  }
}

function scheduleSync(options = {}, delayMs = 75) {
  mergeSyncScheduleOptions(options);
  if (syncInFlight) {
    syncPendingWhileInFlight = true;
    return;
  }
  if (document.visibilityState === 'hidden') return;
  if (syncScheduleTimer) return;
  const delay = Math.max(delayMs, syncRetryDelayMs);
  syncScheduleTimer = setTimeout(async () => {
    syncScheduleTimer = null;
    if (document.visibilityState === 'hidden') {
      return;
    }
    const requested = syncScheduleOptions;
    syncScheduleOptions = {};
    if (syncInFlight) {
      syncScheduleOptions = {...syncScheduleOptions, ...requested};
      syncPendingWhileInFlight = true;
      return;
    }
    const synced = await syncNow(requested);
    if (synced) {
      syncRetryDelayMs = 0;
      return;
    }
    if (syncFailed) {
      const index = syncRetryDelaysMs.indexOf(syncRetryDelayMs);
      syncRetryDelayMs = syncRetryDelaysMs[index + 1] || syncRetryDelaysMs[syncRetryDelaysMs.length - 1];
      scheduleSync(requested, syncRetryDelayMs);
    }
  }, delay);
}

function takePendingSyncIntent() {
  const options = {...syncScheduleOptions};
  syncPendingWhileInFlight = false;
  syncScheduleOptions = {};
  return options;
}

async function syncWorkRemains(options = {}) {
  if (options.reconcile) return true;
  if ((await pendingOperations()).length) return true;
  const cursor = Number(await getOfflineState('syncSequence') || 0);
  if (serverChangePendingSequence && serverChangePendingSequence <= cursor) {
    serverChangePendingSequence = 0;
  }
  return serverChangePendingSequence > cursor;
}

async function performSync(options = {}) {
  const preserveSnackbar = Boolean(options.preserveSnackbar);
  let reconcile = Boolean(options.reconcile);
  if (syncScheduleTimer) {
    clearTimeout(syncScheduleTimer);
    syncScheduleTimer = null;
    reconcile = Boolean(reconcile || syncScheduleOptions.reconcile);
  }
  // Network requests and the authenticated SSE heartbeat are authoritative.
  // navigator.onLine is only an unreliable browser hint, particularly in an
  // installed mobile PWA, so it must never prevent a requested sync.
  if (syncInFlight) return false;
  syncInFlight = true;
  syncPendingWhileInFlight = false;
  syncScheduleOptions = {};
  beginSyncStatusPresentation();
  const wasOffline = syncFailed;
  try {
    for (;;) {
      // Save the visible editor locally before pulling. This never waits on the
      // network, but ensures a remote notification cannot overwrite the common
      // base needed to merge the user's newest keystrokes.
      if (!screens.editor.classList.contains('hidden') && isDirty) await saveCurrentNote(false);
      await pullRemoteChanges();
      if (reconcile) await reconcileLocalNotes();
      const pushed = await flushPendingChanges();
      if (pushed) await pullRemoteChanges();

      const pendingOptions = takePendingSyncIntent();
      if (!await syncWorkRemains(pendingOptions)) break;
      reconcile = Boolean(pendingOptions.reconcile);
    }

    localStorage.setItem('vylk-offline-ready', '1');
    clearSyncDiagnostic();
    syncFailed = false;
    lastSuccessfulSyncAt = Date.now();
    syncRetryDelayMs = 0;
    dashboardHydrationState = 'ready';
    if (!screens.dashboard.classList.contains('hidden')) await refreshDashboard();
    finishSyncStatusPresentation('online');
    if (!serverEvents) connectServerEvents();
    notifySyncCompleted();
    if (!preserveSnackbar) hideOfflineNotice();
    if (wasOffline && !preserveSnackbar) showToast('Back online. Changes synced.');
    return true;
  } catch (error) {
    console.warn('sync failed', error);
    if (dashboardHydrationState === 'loading') {
      dashboardHydrationState = 'offline-empty';
      if (!screens.dashboard.classList.contains('hidden')) await refreshDashboard();
    }
    if (isAbortError(error) && syncCancellationRequested) {
      syncCancellationRequested = false;
      return false;
    }
    if (!lastSyncDiagnostic) setSyncDiagnostic(error?.message || 'unknown sync error', error?.responseStatus);
    if (authenticationRequired) {
      // An expired or unavailable session is actionable, and is distinct from
      // losing network access. In particular, do not mask it with an offline
      // screen just because this browser has an offline cache.
      syncFailed = false;
      finishSyncStatusPresentation('online');
      hideOfflineNotice();
      requireAuthentication();
      $('#login-error').textContent = 'Your session expired. Sign in again.';
      return false;
    }
    // A 4xx response proves that this server is reachable. Keeping the UI in
    // Offline in that case hides the actionable problem and makes retrying
    // misleading. Network failures and unavailable servers still use Offline.
    const responseStatus = error?.responseStatus || lastSyncResponseStatus;
    if (responseStatus >= 400 && responseStatus < 500) {
      syncFailed = false;
      finishSyncStatusPresentation('online');
      hideOfflineNotice();
      const message = `Sync needs attention: ${error.message}`;
      if (lastSyncProblem !== message) {
        lastSyncProblem = message;
        showToast(message, 'warning');
      }
      return false;
    }
    lastSyncProblem = '';
    markServerOffline();
    finishSyncStatusPresentation('offline');
    return false;
  } finally {
    syncInFlight = false;
    if (syncStatusRevealTimer) {
      clearTimeout(syncStatusRevealTimer);
      syncStatusRevealTimer = null;
    }
    // Work can arrive after the loop's final check but before the cycle has
    // finished refreshing the UI. Carry that intent into a new cycle instead
    // of leaving it dormant until the periodic fallback runs.
    if (syncPendingWhileInFlight) scheduleSync(takePendingSyncIntent(), 0);
  }
}

async function syncNow(options = {}) {
  if (syncInFlight) {
    mergeSyncScheduleOptions(options);
    syncPendingWhileInFlight = true;
    return false;
  }
  const lifecycle = withSyncLeadership(() => performSync(options));
  syncLifecyclePromise = lifecycle;
  try {
    return await lifecycle;
  } finally {
    if (syncLifecyclePromise === lifecycle) syncLifecyclePromise = null;
  }
}

const sseStaleAfterMs = 70000;
let serverEvents = null;
let serverHeartbeatAt = 0;
let serverEventsWatchdog = null;
let serverChangeTimer = null;
let serverChangePending = false;
let serverChangePendingSequence = 0;

function isServerEventsHealthy() {
  return Boolean(serverEvents && serverHeartbeatAt > 0 && Date.now() - serverHeartbeatAt <= sseStaleAfterMs);
}

function markServerOffline() {
  const shouldToast = !syncFailed;
  syncFailed = true;
  if (dashboardHydrationState === 'loading') {
    dashboardHydrationState = 'offline-empty';
    void refreshDashboard().catch(error => console.warn('could not render offline empty state', error));
  }
  setSyncStatus('offline');
  showOfflineNotice();
  if (shouldToast) showToast('Working offline. Your changes are saved on this device.', 'warning');
}

async function handleServerHeartbeat() {
  serverHeartbeatAt = Date.now();
  if (!syncFailed) {
    if (!syncInFlight) setIdleSyncStatus();
    return;
  }
  scheduleSync({reconcile: true});
}

function scheduleServerChangeSync() {
  serverChangePending = true;
  if (serverChangeTimer || syncInFlight) return;
  serverChangeTimer = setTimeout(async () => {
    serverChangeTimer = null;
    if (syncInFlight) return;
    serverChangePending = false;
    scheduleSync();
    if (serverChangePending) scheduleServerChangeSync();
  }, 75);
}

async function handleServerChangeEvent(change = {}) {
  const type = change?.type || 'notes';
  if (type === 'preferences') {
    const revision = Number(change.revision || 0);
    if (revision > 0 && revision <= Number(prefs.revision || 0)) return false;
    void loadPrefs();
    return true;
  }
  if (type !== 'notes') {
    scheduleServerChangeSync();
    return true;
  }

  const sequence = Number(change.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    scheduleServerChangeSync();
    return true;
  }
  serverChangePendingSequence = Math.max(serverChangePendingSequence, sequence);
  let cursor = 0;
  try {
    cursor = Number(await getOfflineState('syncSequence') || 0);
  } catch (_) {
    scheduleServerChangeSync();
    return true;
  }
  if (sequence <= cursor) {
    if (serverChangePendingSequence <= cursor) serverChangePendingSequence = 0;
    return false;
  }
  if (syncInFlight) scheduleSync();
  else scheduleServerChangeSync();
  return true;
}

function connectServerEvents() {
  if (!('EventSource' in window) || serverEvents) return;
  serverHeartbeatAt = Date.now();
  const events = new EventSource('/api/events');
  serverEvents = events;
  events.addEventListener('server', event => {
    try { cacheAppVersion(JSON.parse(event.data)); } catch (_) {}
  });
  events.addEventListener('change', event => {
    serverHeartbeatAt = Date.now();
    try {
      void handleServerChangeEvent(JSON.parse(event.data)).catch(() => scheduleServerChangeSync());
    } catch (_) {
      scheduleServerChangeSync();
    }
  });
  events.addEventListener('heartbeat', () => { void handleServerHeartbeat(); });
  events.onopen = () => { void handleServerHeartbeat(); };
  events.onerror = () => {
    // EventSource emits error for its normal reconnect cycle too, especially
    // when Android briefly backgrounds a tab. It is not enough evidence to
    // label the whole app offline; regular HTTP sync remains authoritative.
    if (serverEvents === events) serverHeartbeatAt = 0;
  };
  if (!serverEventsWatchdog) {
    serverEventsWatchdog = setInterval(() => {
      if (!serverEvents || Date.now() - serverHeartbeatAt <= sseStaleAfterMs) return;
      serverEvents.close();
      serverEvents = null;
      // A missing heartbeat is a prompt to verify with real authenticated
      // HTTP, not an offline verdict by itself.
      void syncNow({reconcile: true}).then(synced => {
        if (synced) connectServerEvents();
      });
    }, 5000);
  }
}

function disconnectServerEvents() {
  if (serverEvents) serverEvents.close();
  serverEvents = null;
  serverHeartbeatAt = 0;
  if (serverEventsWatchdog) clearInterval(serverEventsWatchdog);
  serverEventsWatchdog = null;
  if (serverChangeTimer) clearTimeout(serverChangeTimer);
  serverChangeTimer = null;
  serverChangePending = false;
  serverChangePendingSequence = 0;
}

// --- Auth ---
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  authenticationRequired = false;
  clearSyncDiagnostic();
  const pw = e.target.password.value;
  try {
    const res = await api('/api/login', {method:'POST', body:JSON.stringify({password:pw})});
    $('#login-error').textContent = '';
    cacheAppVersion(res);
    await loadPrefs();
    await restoreRoute();
    connectServerEvents();
    scheduleSync({reconcile: true});
  } catch (error) {
    $('#login-error').textContent = error.code === 'invalid_credentials' ? 'Wrong password' : error.code === 'login_rate_limited' ? 'Too many attempts. Please try again later.' : 'Could not sign in. Please try again.';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  cancelActiveSyncRequests();
  disconnectServerEvents();
  try {
    await api('/api/logout', {method:'POST'});
  } catch (error) {
    console.warn('server logout failed; clearing local session data', error);
  }
  try {
    await clearOfflineData();
  } catch (error) {
    console.error('could not clear local data during logout', error);
    showToast('Close other app tabs, then try signing out again.', 'warning');
    return;
  }
  localStorage.removeItem('vylk-offline-ready');
  localStorage.removeItem('vylk-prefs');
  show(screens.login);
  $('#login-form input').focus();
});

// --- Dashboard ---
let dashboardNotes = [];
let dashboardRenderGeneration = 0;

async function unresolvedConflictIDs() {
  const records = await withOfflineStore(['state'], 'readonly', stores => requestValue(stores.state.getAll()));
  return new Set(records
    .filter(record => record.key.startsWith('unresolvedConflict:') && record.value?.note_id)
    .map(record => record.value.note_id));
}

function renderDashboard(notes, conflicts) {
  const tags = [...new Set(notes.flatMap(note => (note.tags || '').split(',').map(tag => tag.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b));
  if (currentTag && !tags.includes(currentTag)) currentTag = null;
  const bar = $('#tag-bar');
  let html = '<button type="button" class="tag'+(currentTag?'':' active')+'" data-tag="" aria-pressed="'+(currentTag ? 'false' : 'true')+'">All</button>';
  tags.forEach(t => {
    const active = t === currentTag ? ' active' : '';
    html += `<button type="button" class="tag${active}" data-tag="${esc(t)}" aria-pressed="${active ? 'true' : 'false'}">${esc(t)}</button>`;
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.tag').forEach(el => {
    el.addEventListener('click', () => {
      currentTag = el.dataset.tag;
      renderDashboard(dashboardNotes, conflicts);
    });
  });
  if (currentTag) notes = notes.filter(note => noteHasTag(note, currentTag));
  const list = $('#note-list');
  if (notes.length === 0) {
    const message = dashboardHydrationState === 'loading'
      ? 'Loading notes…'
      : dashboardHydrationState === 'offline-empty'
        ? 'No notes are available on this device yet.'
        : 'No notes yet';
    list.innerHTML = `<li class="note-empty">${message}</li>`;
    return;
  }
  list.innerHTML = notes.map(n => `
    <li class="note-item-row">
      <button type="button" class="note-item" data-id="${esc(n.id)}">
        <div class="note-title">${esc(n.title || 'Untitled')}${conflicts.has(n.id) ? '<span class="note-conflict">Conflict</span>' : ''}</div>
        <div class="note-meta">${esc(formatDate(n.updated_at))}</div>
        ${n.tags ? '<div class="note-tags">'+n.tags.split(',').map(t=>`<span class="tag">${esc(t.trim())}</span>`).join('')+'</div>' : ''}
      </button>
      <button type="button" class="note-pin" data-id="${esc(n.id)}" aria-pressed="${Boolean(n.pinned)}" aria-label="${n.pinned ? 'Unpin' : 'Pin'} note" title="${n.pinned ? 'Unpin' : 'Pin'} note"><svg class="icon pin-icon" aria-hidden="true"><use href="#icon-${n.pinned ? 'pinned' : 'pin'}"></use></svg><svg class="icon unpin-icon" aria-hidden="true"><use href="#icon-pinned-off"></use></svg></button>
    </li>
  `).join('');
  list.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => openNote(el.dataset.id));
  });
  list.querySelectorAll('.note-pin').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      void toggleNotePin(el.dataset.id);
    });
  });
}

function noteHasTag(note, tag) {
  return (note.tags || '').split(',').some(noteTag => noteTag.trim() === tag);
}

async function refreshDashboard() {
  const generation = ++dashboardRenderGeneration;
  const [notes, conflicts] = await Promise.all([getLocalNotes(), unresolvedConflictIDs()]);
  if (generation !== dashboardRenderGeneration) return;
  dashboardNotes = notes;
  renderDashboard(notes, conflicts);
}

async function refreshLocalStateFromStorage() {
  if (!screens.dashboard.classList.contains('hidden')) await refreshDashboard();
  if (!screens.editor.classList.contains('hidden') && currentNoteId && !isDirty) {
    const note = await getLocalNote(currentNoteId);
    if (note) updateOpenNote(note);
  }
  setIdleSyncStatus();
}

async function syncDashboardInBackground() {
  scheduleSync();
}

async function loadDashboard({sync = true} = {}) {
  show(screens.dashboard);
  await refreshDashboard();
  if (sync) void syncDashboardInBackground();
}

function applyEditorPrefs() {
  const collapsed = Boolean(prefs.collapseDetails);
  $('.meta-pane').classList.toggle('collapsed', collapsed);
  $('.meta-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#editor').classList.toggle('header-hidden', panelState === 'zen');
  document.documentElement.dataset.statusDisplay = prefs.statusDisplay;
  $('#editor').classList.toggle('hide-save-button', Boolean(prefs.hideSaveButton && prefs.autoSave));
  updateZenOverlays();
  placeSaveButton();
  if (prefs.hideToolbar) {
    $('.fmt-bar').classList.add('hidden');
  } else {
    $('.fmt-bar').classList.remove('hidden');
  }
  const interactiveModeChanged = syncInteractivePreviewMode();
  scheduleEditorCaretCue();
  if (interactiveModeChanged && isPreviewVisible()) updatePreview();
}

function interactivePreviewEnabledForCurrentMode() {
  return panelState === 'zen' ? prefs.zenInteractivePreview : prefs.interactivePreview;
}

function syncInteractivePreviewMode() {
  let interactiveModeChanged = false;
  if (interactivePreviewEnabledForCurrentMode() && !interactivePreviewActive) {
    interactivePreviewActive = true;
    interactiveHistory = [];
    renderedPreviewSource = null;
    renderedPreviewMetadata = null;
    interactiveModeChanged = true;
  } else if (!interactivePreviewEnabledForCurrentMode() && interactivePreviewActive) {
    cancelPreviewDrag({animateReturn:false});
    interactivePreviewActive = false;
    interactiveHistory = [];
    renderedPreviewSource = null;
    renderedPreviewMetadata = null;
    interactiveModeChanged = true;
  }
  syncInteractivePreviewUI();
  return interactiveModeChanged;
}

function applyContentWidth() {
  document.documentElement.dataset.contentWidth = prefs.contentWidth;
}

function startPanelState() {
  return {editor:'editor', preview:'preview', split:'both', zen:'zen'}[prefs.startView] || 'both';
}

function placeSaveButton() {
  const saveButton = $('#save-btn');
  const headerSlot = $('#header-save-slot');
  const panelSlot = $('#panel-save-slot');
  const previewSlot = $('#preview-save-slot');
  const panelActions = $('#editor-panel .panel-header-actions');
  if (!saveButton || !headerSlot || !panelSlot || !previewSlot || !panelActions) return;
  const previewOnly = panelState === 'preview';
  saveButton.disabled = previewOnly;
  saveButton.setAttribute('aria-disabled', String(previewOnly));
  if (prefs.saveButtonLocation === 'header') {
    headerSlot.append(saveButton);
    return;
  }
  (previewOnly ? previewSlot : panelSlot).append(saveButton);
  if (!previewOnly) panelActions.append(panelSlot);
}

// --- Editor ---
function startNewNote(title = '') {
  if (saveTimer) clearTimeout(saveTimer);
  if (localSaveTimer) clearTimeout(localSaveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  const initialPanelState = startPanelState();
  setPanelState(initialPanelState);
  resetInteractivePreviewSession();
  editorSessionGeneration++;
  currentNoteId = newLocalNoteID();
  currentRevision = 0;
  currentBaseRevision = null;
  isDirty = false;
  savedSnapshot = { title: '', tags: '', content: '' };
  $('#note-title').value = title;
  $('#note-tags').value = '';
  $('#note-content').value = '';
  $('#preview').innerHTML = '';
  renderedPreviewSource = null;
  setIdleSyncStatus();
  cachePreviewBlocks();
  applyEditorPrefs();
  show(screens.editor);
  scheduleEditorCaretCue();
  if (initialPanelState === 'zen') $('#note-content').focus();
  else if (initialPanelState === 'preview') focusPreview();
  else $('#note-title').focus();
}

$('#new-note-btn').addEventListener('click', () => startNewNote());

$('#back-btn').addEventListener('click', async () => {
  if (backNavigationInFlight) return;
  backNavigationInFlight = true;
  try {
    if (saveTimer) clearTimeout(saveTimer);
    if (localSaveTimer) clearTimeout(localSaveTimer);
    cancelPendingPreviewRender();
    // Navigation waits only for the durable local save. Network replay then runs
    // after the cached dashboard is visible, rather than making Back feel slow.
    await saveCurrentNote(false);
    clearCurrentNote();
    const schedulePendingSync = () => {
      void pendingOperations()
        .then(operations => { if (operations.length) scheduleSync(); })
        .catch(error => console.warn('could not inspect pending sync operations', error));
    };
    if (isAppNoteRoute()) {
      // The note entry already has the dashboard entry beneath it. Consume the
      // note entry so browser Back and the in-app button have the same result.
      const restored = new Promise(resolve => pendingHistoryRestoreResolvers.push(resolve));
      history.back();
      schedulePendingSync();
      await restored;
      return;
    }
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
    schedulePendingSync();
  } finally {
    backNavigationInFlight = false;
  }
});

$('#back-btn').addEventListener('pointerdown', cancelPendingPreviewRender, {passive:true});

function showNoteInEditor(data) {
  setPanelState(startPanelState());
  resetInteractivePreviewSession();
  editorSessionGeneration++;
  currentNoteId = data.id;
  currentRevision = data.revision || 0;
  currentBaseRevision = data.base_revision ?? null;
  isDirty = false;
  savedSnapshot = { title: data.title || '', tags: data.tags || '', content: data.content || '' };
  $('#note-title').value = data.title || '';
  $('#note-tags').value = data.tags || '';
  $('#note-content').value = data.content || '';
  $('#preview').replaceChildren();
  renderedPreviewSource = null;
  renderedPreviewMetadata = null;
  setIdleSyncStatus();
  applyEditorPrefs();
  show(screens.editor);
  scheduleEditorCaretCue();
  requestPreviewRender();
}

async function openNote(id, {route = 'push'} = {}) {
  if (saveTimer) clearTimeout(saveTimer);
  if (localSaveTimer) clearTimeout(localSaveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  if (!screens.editor.classList.contains('hidden') && currentNoteId !== id && (isDirty || localSavePromise)) {
    const saved = await saveCurrentNote(false);
    if (saved === false) return;
  }
  const data = await getLocalNote(id);
  if (!data) return;
  showNoteInEditor(data);
  if (route === 'push') setNoteRoute(id);
  else if (route === 'replace') setNoteRoute(id, {replace: true});
  await showConflictResolverFor(id);
  // The note is already usable from IndexedDB. Sync is driven by the central
  // scheduler, server events, and pending local work rather than navigation.
}

function normalizeWikiTitle(title) {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

async function followWikiLink(title) {
  title = title.trim().replace(/\s+/g, ' ');
  if (!title) return;
  if (isDirty) await saveCurrentNote(false);
  const existing = (await getLocalNotes()).find(note => normalizeWikiTitle(note.title || '') === normalizeWikiTitle(title));
  if (existing) {
    await openNote(existing.id, {route: 'replace'});
    return;
  }
  startNewNote(title);
  await saveCurrentNote(false);
  showToast(`Created “${title}”.`, 'success');
  scheduleSync();
}

async function restoreRoute({fetchRemote = false} = {}) {
  if (!isAppPreferencesRoute() && !$('#prefs-modal').classList.contains('hidden')) {
    closeModal($('#prefs-modal'));
    // Preferences is an overlay route. When the underlying screen is already
    // rendered, rebuilding it here would compete with the modal's exit frame.
    if (isAppDashboardRoute() && !screens.dashboard.classList.contains('hidden')) return;
    if (isAppNoteRoute() && !screens.editor.classList.contains('hidden') && currentNoteId === history.state.noteID) {
      if (isDirty) await saveCurrentNote(false);
      return;
    }
  }
  if (isAppPreferencesRoute()) {
    const returnRoute = history.state?.returnRoute;
    const noteID = returnRoute?.screen === 'note' ? returnRoute.noteID : null;
    if (noteID && await getLocalNote(noteID)) {
      await openNote(noteID, {route: 'none'});
      openPreferences({route: 'none'});
      return;
    }
    if (noteID && fetchRemote && !await hasPendingOperation(noteID) && !await getUnresolvedConflict(noteID)) {
      try {
        const remote = await api(`/api/notes/${encodeURIComponent(noteID)}`, {syncRequest: true, throwOnError: true});
        await putLocalNote({...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
        await openNote(noteID, {route: 'none'});
        openPreferences({route: 'none'});
        return;
      } catch (error) {
        if (error?.responseStatus !== 404) return;
      }
    }
    if (noteID) setDashboardRoute({replace: true});
    clearCurrentNote();
    await loadDashboard({sync: false});
    if (!noteID) openPreferences({route: 'none'});
    return;
  }
  const noteID = noteIDFromLocation();
  if (!screens.editor.classList.contains('hidden') && isDirty) await saveCurrentNote(false);
  if (noteID && await getLocalNote(noteID)) {
    await openNote(noteID, {route: 'none'});
    return;
  }
  if (noteID && fetchRemote && !await hasPendingOperation(noteID) && !await getUnresolvedConflict(noteID)) {
    try {
      const remote = await api(`/api/notes/${encodeURIComponent(noteID)}`, {syncRequest: true, throwOnError: true});
      await putLocalNote({...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
      await openNote(noteID, {route: 'none'});
      return;
    } catch (error) {
      if (error?.responseStatus !== 404) return;
    }
  }
  if (noteID) {
    setDashboardRoute({replace: true});
    showToast('That note is no longer available.', 'warning');
  }
  clearCurrentNote();
  await loadDashboard({sync: false});
}

async function restoreCachedStartup() {
  const noteID = noteIDFromLocation();
  if (noteID && await getLocalNote(noteID)) {
    await openNote(noteID, {route: 'none'});
    return;
  }
  dashboardHydrationState = (await getLocalNotes()).length ? 'ready' : 'loading';
  await loadDashboard({sync: false});
  const conflicts = await unresolvedConflictIDs();
  for (const conflictID of conflicts) {
    if (await getLocalNote(conflictID) && await showConflictResolverFor(conflictID)) break;
  }
}

// --- Autosave ---
function markDirty() {
  if (!isDirty) {
    isDirty = true;
  }
}

function readEditorSnapshot() {
  return {
    title: $('#note-title').value.trim() || 'Untitled',
    tags: $('#note-tags').value.trim(),
    content: $('#note-content').value,
  };
}

function editorSnapshotIsCurrent(snapshot) {
  return editorSessionGeneration === snapshot.sessionGeneration &&
    currentNoteId === snapshot.noteID &&
    readEditorSnapshot().title === snapshot.title &&
    readEditorSnapshot().tags === snapshot.tags &&
    readEditorSnapshot().content === snapshot.content;
}

async function persistEditorSnapshot(snapshot) {
  if (editorSnapshotIsCurrent(snapshot) &&
      snapshot.title === savedSnapshot.title &&
      snapshot.tags === savedSnapshot.tags &&
      snapshot.content === savedSnapshot.content) {
    isDirty = false;
    return true;
  }

  const existing = await getLocalNote(snapshot.noteID);
  const baseRevision = existing?.pending ? existing.base_revision : (snapshot.baseRevision ?? 0);
  const baseContent = existing?.pending ? (existing.base_content ?? '') : (existing?.content || '');
  const baseTitle = existing?.pending ? (existing.base_title ?? existing.title ?? '') : (existing?.title || '');
  const baseTags = existing?.pending ? (existing.base_tags ?? existing.tags ?? '') : (existing?.tags || '');
  const now = new Date().toISOString();
  const local = {
    ...existing,
    title: snapshot.title,
    tags: snapshot.tags,
    content: snapshot.content,
    id: snapshot.noteID,
    filename: existing?.filename || `${snapshot.noteID}.md`,
    revision: existing?.revision ?? snapshot.revision ?? 0,
    base_revision: baseRevision,
    base_content: baseContent,
    base_title: baseTitle,
    base_tags: baseTags,
    pending: true,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  const unresolved = await getUnresolvedConflict(snapshot.noteID);
  if (unresolved?.kind === 'remote-deleted') {
    const conflictLocal = {...local, pending: false};
    try {
      await withOfflineStore(['notes', 'state'], 'readwrite', async stores => {
        await requestValue(stores.notes.put(conflictLocal));
        await requestValue(stores.state.put({
          key: unresolvedConflictKey(snapshot.noteID),
          value: {...unresolved, local: conflictLocal},
        }));
      });
    } catch (error) {
      console.error('local conflict update failed', error);
      showToast('Could not save locally. Free browser storage and try again.', 'warning');
      return false;
    }
    if (editorSnapshotIsCurrent(snapshot)) {
      currentBaseRevision = null;
      savedSnapshot = {title: snapshot.title, tags: snapshot.tags, content: snapshot.content};
      isDirty = false;
      if (!restoringHistoryRoute && noteIDFromLocation() !== snapshot.noteID) setNoteRoute(snapshot.noteID);
      setIdleSyncStatus();
    }
    return true;
  }
  try {
    await saveLocalNoteAndQueue(local, {type: 'note.save', note_id: snapshot.noteID, base_revision: baseRevision, note: local});
  } catch (error) {
    console.error('local save failed', error);
    showToast('Could not save locally. Free browser storage and try again.', 'warning');
    return false;
  }

  // The IndexedDB write may have completed after another editor session was
  // opened or after more text was entered. Only this exact session/snapshot
  // may update the live editor state.
  if (editorSnapshotIsCurrent(snapshot)) {
    currentBaseRevision = baseRevision;
    savedSnapshot = {title: snapshot.title, tags: snapshot.tags, content: snapshot.content};
    isDirty = false;
    if (!restoringHistoryRoute && noteIDFromLocation() !== snapshot.noteID) setNoteRoute(snapshot.noteID);
    setIdleSyncStatus();
  }
  return true;
}

function saveCurrentNote(trySync = true) {
  localSaveRequested = true;
  if (!localSavePromise) {
    localSavePromise = (async () => {
      let result = true;
      while (localSaveRequested) {
        localSaveRequested = false;
        const noteID = currentNoteId || newLocalNoteID();
        if (!currentNoteId) currentNoteId = noteID;
        const data = readEditorSnapshot();
        const snapshot = {
          ...data,
          noteID,
          revision: currentRevision,
          baseRevision: currentBaseRevision ?? currentRevision ?? 0,
          sessionGeneration: editorSessionGeneration,
        };
        result = await persistEditorSnapshot(snapshot);
      }
      return result;
    })().finally(() => {
      localSavePromise = null;
    });
  }
  const currentLocalSavePromise = localSavePromise;

  // Local persistence is the navigation boundary. Network sync is chained
  // separately so a caller such as Back can leave immediately after the
  // queued operation is durable, even when another sync is slow.
  if (!trySync) return currentLocalSavePromise;
  syncCompletionPromise = syncCompletionPromise
    .catch(error => {
      console.warn('previous sync request failed', error);
      return false;
    })
    .then(() => currentLocalSavePromise)
    .then(saved => saved ? syncNow() : false);
  return syncCompletionPromise;
}

async function toggleNotePin(noteID) {
  const local = await getLocalNote(noteID);
  if (!local) return false;
  const pinned = !Boolean(local.pinned);
  const baseRevision = local.pending ? (local.base_revision ?? local.revision ?? 0) : (local.revision ?? 0);
  const next = {...local, pinned, pin_order: pinned ? await nextLocalPinOrder() : 0, pending: true, base_revision: baseRevision};
  await saveLocalNoteAndQueue(next, {type: 'note.pin', note_id: noteID, base_revision: baseRevision, pinned, pin_order: next.pin_order});
  await refreshDashboard();
  scheduleSync();
  return true;
}

let saveTimer = null;
let localSaveTimer = null;
let previewTimer = null;
let localSavePromise = null;
let syncCompletionPromise = Promise.resolve(true);
let localSaveRequested = false;

function scheduleSave() {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    if (isDirty) void saveCurrentNote(false);
  }, 250);
  if (!prefs.autoSave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // The 250ms timer may already have durably saved this edit to IndexedDB
    // and cleared isDirty. Still call saveCurrentNote: its unchanged-note path
    // replays the queued operation, which is the intended 2s idle sync.
    if (!screens.editor.classList.contains('hidden')) void saveCurrentNote();
  }, 2000);
}

$('#save-btn').addEventListener('click', () => executeShortcutCommand('note.save', {source:'button'}));
$('#note-title').addEventListener('input', () => { markDirty(); scheduleSave(); updateZenTitle(); });
$('#note-tags').addEventListener('input', () => { markDirty(); scheduleSave(); });

// --- Formatting toolbar ---
const tablePicker = document.createElement('div');
tablePicker.id = 'table-picker';
tablePicker.className = 'table-picker hidden';
tablePicker.setAttribute('role', 'dialog');
tablePicker.setAttribute('aria-label', 'Choose table size');
tablePicker.innerHTML = '<div class="table-picker-label" aria-live="polite">Table</div><div class="table-grid" role="group" aria-label="Table size options"></div>';
document.body.append(tablePicker);

const tableGrid = tablePicker.querySelector('.table-grid');
const tablePickerLabel = tablePicker.querySelector('.table-picker-label');
const tablePickerRows = 6;
const tablePickerColumns = 8;

for (let row = 1; row <= tablePickerRows; row++) {
  for (let column = 1; column <= tablePickerColumns; column++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'table-grid-cell';
    cell.dataset.rows = String(row);
    cell.dataset.columns = String(column);
    cell.setAttribute('aria-label', `${column} columns by ${row} rows`);
    tableGrid.append(cell);
  }
}

function setTableGridHighlight(rows = 0, columns = 0) {
  tablePickerLabel.textContent = rows && columns ? `${columns} × ${rows} table` : 'Table';
  tableGrid.querySelectorAll('.table-grid-cell').forEach(cell => {
    cell.classList.toggle('active', Number(cell.dataset.rows) <= rows && Number(cell.dataset.columns) <= columns);
  });
}

function hideTablePicker() {
  tablePicker.classList.add('hidden');
  $('.fmt-bar [data-fmt="table"]').setAttribute('aria-expanded', 'false');
  setTableGridHighlight();
}

function showTablePicker(trigger) {
  tablePicker.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  const rect = trigger.getBoundingClientRect();
  const gutter = 8;
  const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - tablePicker.offsetWidth - gutter);
  const top = Math.min(rect.bottom + gutter, window.innerHeight - tablePicker.offsetHeight - gutter);
  tablePicker.style.left = `${left}px`;
  tablePicker.style.top = `${top}px`;
}

function insertTable(rows, columns) {
  const ta = $('#note-content');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const header = Array.from({length: columns}, (_, index) => `Column ${index + 1}`);
  const divider = Array.from({length: columns}, () => '---');
  const body = Array.from({length: Math.max(0, rows - 1)}, () => Array(columns).fill(''));
  const markdownRows = [header, divider, ...body].map(row => `| ${row.join(' | ')} |`);
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
  const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
  const table = markdownRows.join('\n');
  const insertion = prefix + table + suffix;
  const firstCell = start + prefix.length + markdownRows[0].length + 1 + markdownRows[1].length + 3;

  ta.setRangeText(insertion, start, end, 'end');
  ta.focus();
  ta.selectionStart = ta.selectionEnd = firstCell;
  ta.dispatchEvent(new Event('input'));
}

tableGrid.addEventListener('pointerover', e => {
  const cell = e.target.closest('.table-grid-cell');
  if (cell) setTableGridHighlight(Number(cell.dataset.rows), Number(cell.dataset.columns));
});

tableGrid.addEventListener('focusin', e => {
  const cell = e.target.closest('.table-grid-cell');
  if (cell) setTableGridHighlight(Number(cell.dataset.rows), Number(cell.dataset.columns));
});

tableGrid.addEventListener('click', e => {
  const cell = e.target.closest('.table-grid-cell');
  if (!cell) return;
  insertTable(Number(cell.dataset.rows), Number(cell.dataset.columns));
  hideTablePicker();
});

document.addEventListener('pointerdown', e => {
  if (!tablePicker.classList.contains('hidden') && !e.target.closest('#table-picker, [data-fmt="table"]')) hideTablePicker();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !tablePicker.classList.contains('hidden')) hideTablePicker();
});

window.addEventListener('resize', hideTablePicker);

function insertFmt(type) {
  if (interactiveSourceLocked) return;
  const ta = $('#note-content');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.slice(start, end);
  const line = ta.value.slice(0, start).split('\n').pop();
  const lineStart = start - line.length;

  const fmts = {
    bold:       ['**', '**'],
    italic:     ['*', '*'],
    strike:     ['~~', '~~'],
    code:       ['`', '`'],
    link:       ['[', '](url)'],
    image:      ['![', '](url)'],
    h1:         ['# ', '\n'],
    h2:         ['## ', '\n'],
    h3:         ['### ', '\n'],
    h4:         ['#### ', '\n'],
    h5:         ['##### ', '\n'],
    h6:         ['###### ', '\n'],
    ul:         ['- ', '\n'],
    ol:         ['1. ', '\n'],
    task:       ['- [ ] ', '\n'],
    blockquote: ['> ', '\n'],
    hr:         ['\n---\n', ''],
  };

  const f = fmts[type];
  if (!f) return;

  let inserted;
  let cursor;
  let clean = false;

  const headings = ['h1','h2','h3','h4','h5','h6'];
  const toggles = ['ul','ol','task','blockquote'];

  if (headings.includes(type)) {
    const prefix = f[0];
    const re = new RegExp('^#{1,6}\\s');
    if (line.trim().match(re)) {
      const stripped = line.trim().replace(re, '');
      ta.value = ta.value.slice(0, lineStart) + stripped + ta.value.slice(start);
      cursor = lineStart + stripped.length;
      clean = true;
    } else {
      inserted = prefix + line.trimStart();
      ta.value = ta.value.slice(0, lineStart) + inserted + ta.value.slice(start);
      cursor = lineStart + inserted.length;
    }
  } else if (toggles.includes(type)) {
    const prefix = f[0];
    const lines = sel ? sel.split('\n') : [line.trim() || 'item'];
    const toggled = lines.map(l => l.startsWith(prefix) ? l.slice(prefix.length) : prefix + l).join('\n');
    ta.value = ta.value.slice(0, start) + toggled + ta.value.slice(end);
    cursor = start + toggled.length;
    clean = !sel;
  } else if (type === 'hr') {
    inserted = '\n---\n';
    ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
    cursor = start + inserted.length;
  } else if (type === 'codeblock') {
    if (sel) {
      inserted = '```\n' + sel + '\n```';
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + inserted.length;
    } else {
      inserted = '```\n\n```';
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + 4;
    }
  } else if (type === 'table') {
    inserted = '\n| col1 | col2 |\n|------|------|\n|  |  |\n';
    ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
    cursor = start + inserted.length;
  } else {
    // inline: bold, italic, strike, code, link, image
    if (sel) {
      inserted = f[0] + sel + f[1];
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + inserted.length;
    } else {
      inserted = f[0] + f[1];
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + f[0].length;
    }
  }

  ta.focus();
  ta.selectionStart = ta.selectionEnd = clean ? cursor : cursor;
  ta.dispatchEvent(new Event('input'));
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  updatePreview();
}

document.querySelector('.fmt-bar')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-fmt]');
  if (btn) {
    e.preventDefault();
    if (btn.dataset.fmt === 'table') {
      if (tablePicker.classList.contains('hidden')) showTablePicker(btn);
      else hideTablePicker();
      return;
    }
    insertFmt(btn.dataset.fmt);
  }
});

// --- Meta pane toggle ---
$('.meta-toggle')?.addEventListener('click', () => {
  const pane = $('.meta-pane');
  const collapsed = pane.classList.toggle('collapsed');
  $('.meta-toggle').setAttribute('aria-expanded', String(!collapsed));
});

// --- Panel toggle ---
function placeViewControls() {
  const controls = $('#view-controls');
  const editorActions = $('#editor-panel .panel-header-actions');
  const previewActions = $('#preview-view-controls-slot');
  if (!controls || !editorActions || !previewActions) return;
  (panelState === 'preview' ? previewActions : editorActions).prepend(controls);
}

function setPanelState(state) {
  // Panel transitions must never preserve a half-finished drag. A hidden
  // source element or placeholder would otherwise leak into the next layout.
  if (activePreviewDrag) cancelPreviewDrag({animateReturn:false});
  if (state === 'zen' && panelState !== 'zen') {
    zenModeReturnState = panelState === 'preview' ? 'editor' : panelState;
    zenViewState = 'editor';
  }
  panelState = state;
  const visibleState = state === 'zen' ? zenViewState : state;
  const wrap = $('#editor-panels');
  const ed = $('.panel-editor');
  const pv = $('.panel-preview');
  wrap.classList.remove('panels-single');
  ed.classList.remove('panel-hidden');
  pv.classList.remove('panel-hidden');
  if (visibleState === 'editor') {
    pv.classList.add('panel-hidden');
    wrap.classList.add('panels-single');
  } else if (visibleState === 'preview') {
    ed.classList.add('panel-hidden');
    wrap.classList.add('panels-single');
  }
  $('#editor').classList.toggle('zen-mode', state === 'zen');
  $('#editor').classList.toggle('header-hidden', state === 'zen');
  const interactiveModeChanged = syncInteractivePreviewMode();
  placeViewControls();
  placeSaveButton();
  document.querySelectorAll('.view-control').forEach(button => {
    const active = state === button.dataset.panel || (state === 'zen' && button.dataset.panel === 'zen');
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.zen-controls [data-zen-action="editor"], .zen-controls [data-zen-action="preview"]').forEach(button => {
    button.setAttribute('aria-pressed', String(state === 'zen' && button.dataset.zenAction === zenViewState));
  });
  if (state === 'zen') updateZenOverlays();
  else {
    cancelScheduledZenCaretCenter();
    cancelScheduledZenWordCount();
  }
  applyPanelRatio();
  scheduleEditorCaretCue();
  if (visibleState !== 'editor') {
    if (state === 'zen') requestPreviewRender({announceBusy:true});
    else if (interactiveModeChanged) updatePreview();
    else schedulePreviewCheck();
  }
}

$('#editor-panels').addEventListener('click', e => {
  const btn = e.target.closest('.view-control');
  if (!btn) return;
  const commandID = {editor:'view.write', both:'view.split', preview:'view.preview', zen:'view.zen'}[btn.dataset.panel];
  void executeShortcutCommand(commandID, {source:'button'});
});

$('.zen-controls').addEventListener('click', e => {
  const action = e.target.closest('[data-zen-action]')?.dataset.zenAction;
  if (!action) return;
  if (action === 'exit') {
    setPanelState(zenModeReturnState);
    $('#note-content').focus({preventScroll:true});
  } else {
    zenViewState = action;
    setPanelState('zen');
  }
  if (action === 'editor') $('#note-content').focus({preventScroll:true});
  else if (action === 'preview') focusPreview();
});

function applyPanelRatio() {
  $('#editor-panels').style.setProperty('--editor-panel-width', `${Math.round(panelRatio * 1000) / 10}%`);
  $('#panel-resizer').setAttribute('aria-valuenow', String(Math.round(panelRatio * 100)));
}

function setPanelRatio(ratio) {
  panelRatio = Math.min(.8, Math.max(.2, ratio));
  localStorage.setItem('vylk-panel-ratio', String(panelRatio));
  applyPanelRatio();
}

const panelResizer = $('#panel-resizer');
panelResizer.addEventListener('pointerdown', event => {
  if (panelState !== 'both' || window.matchMedia('(max-width: 640px)').matches) return;
  event.preventDefault();
  panelResizer.setPointerCapture(event.pointerId);
  $('#editor-panels').classList.add('resizing');
});
panelResizer.addEventListener('pointermove', event => {
  if (!panelResizer.hasPointerCapture(event.pointerId)) return;
  const bounds = $('#editor-panels').getBoundingClientRect();
  setPanelRatio((event.clientX - bounds.left) / bounds.width);
});
function finishPanelResize(event) {
  if (panelResizer.hasPointerCapture(event.pointerId)) panelResizer.releasePointerCapture(event.pointerId);
  $('#editor-panels').classList.remove('resizing');
}
panelResizer.addEventListener('pointerup', finishPanelResize);
panelResizer.addEventListener('pointercancel', finishPanelResize);
panelResizer.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') { event.preventDefault(); setPanelRatio(panelRatio - .05); }
  if (event.key === 'ArrowRight') { event.preventDefault(); setPanelRatio(panelRatio + .05); }
  if (event.key === 'Home') { event.preventDefault(); setPanelRatio(.2); }
  if (event.key === 'End') { event.preventDefault(); setPanelRatio(.8); }
});
applyPanelRatio();

// --- Cursor preview highlight ---
let previewBlocks = [];
let previewBlockRanges = [];
let previewRangeSource = null;
function resetInteractivePreviewSession() {
  cancelPreviewDrag({animateReturn:false});
  disconnectPreviewDecorationObserver();
  renderedPreviewMetadata = null;
  suppressNextPreviewAlignment = false;
  previewHighlightPending = false;
  interactivePreviewActive = false;
  interactiveSourceLocked = false;
  interactiveHistory = [];
  interactiveListItems = [];
  interactiveBlockItems = [];
  syncInteractivePreviewUI();
}

function syncInteractivePreviewUI() {
  const textarea = $('#note-content');
  const preview = $('#preview');
  if (!textarea || !preview) return;
  textarea.readOnly = interactiveSourceLocked;
  textarea.setAttribute('aria-label', interactiveSourceLocked ? 'Markdown source, read-only during drag' : 'Markdown note content');
  preview.classList.toggle('interactive-preview-active', interactivePreviewActive);
  $('.fmt-bar')?.classList.toggle('interactive-preview-locked', interactiveSourceLocked);
}

function createPreviewDragHandle() {
  const handle = document.createElement('span');
  handle.className = 'preview-drag-handle';
  handle.dataset.previewDragIndicator = 'true';
  handle.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('viewBox', '0 0 12 18');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-drag-indicator');
  svg.append(use);
  handle.append(svg);
  return handle;
}

function createPreviewEditButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'preview-edit-button';
  button.title = 'Edit';
  button.setAttribute('aria-label', 'Edit this block in source');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-edit');
  svg.append(use);
  button.append(svg);
  return button;
}

function orderedListItemNumber(item) {
  const list = item.parentElement;
  if (!list || list.tagName !== 'OL') return null;
  const siblings = [...list.children].filter(child => child.tagName === 'LI');
  const reversed = list.hasAttribute('reversed');
  const startAttribute = list.getAttribute('start');
  const explicitStart = startAttribute === null ? NaN : Number(startAttribute);
  let number = Number.isInteger(explicitStart) ? explicitStart : reversed ? siblings.length : 1;
  const step = reversed ? -1 : 1;
  for (const sibling of siblings) {
    const valueAttribute = sibling.getAttribute('value');
    const explicitValue = valueAttribute === null ? NaN : Number(valueAttribute);
    if (Number.isInteger(explicitValue)) number = explicitValue;
    if (sibling === item) return number;
    number += step;
  }
  return null;
}

function createPreviewListMarker(item, taskItem) {
  if (taskItem && item.parentElement?.tagName !== 'OL') return null;
  const marker = document.createElement('span');
  marker.className = 'preview-list-marker';
  marker.setAttribute('aria-hidden', 'true');
  const number = orderedListItemNumber(item);
  if (number === null) {
    marker.dataset.kind = 'bullet';
  } else {
    marker.textContent = `${number}.`;
  }
  return marker;
}

function decoratePreviewListItem(entry) {
  if (entry.card?.isConnected) return;
  const item = entry.element;
  const nestedLists = [];
  const body = document.createElement('div');
  body.className = 'preview-list-item-body';
  for (const node of [...item.childNodes]) {
    if (node.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes(node.tagName)) nestedLists.push(node);
    else body.append(node);
  }

  const taskItem = Boolean(body.querySelector('input[type="checkbox"]'));
  const card = document.createElement('div');
  card.className = `interactive-preview-card interactive-preview-list-card${taskItem ? ' is-task' : ''}`;
  const content = document.createElement('div');
  content.className = 'preview-drag-content preview-list-content';
  const marker = createPreviewListMarker(item, taskItem);
  if (marker) {
    card.classList.add('has-marker');
    content.append(marker);
  }
  content.append(body);
  card.append(createPreviewDragHandle(), content, createPreviewEditButton());
  item.classList.add('interactive-preview-list-item');
  item.prepend(card);
  nestedLists.forEach(list => item.append(list));
  entry.card = card;
  entry.visualElement = item;
  interactiveEntryByElement.set(card, entry);
  interactiveEntryByElement.set(item, entry);
}

function decoratePreviewBlock(entry) {
  if (entry.card?.isConnected) return;
  const block = entry.element;
  const card = document.createElement('div');
  card.className = 'interactive-preview-card interactive-preview-block-card';
  if (block.tagName === 'HR') card.classList.add('interactive-preview-rule-card');
  card.dataset.interactiveStart = '';
  card.dataset.interactiveScope = entry.scope;
  const content = document.createElement('div');
  content.className = 'preview-drag-content preview-block-content';
  block.before(card);
  block.removeAttribute('data-interactive-start');
  block.removeAttribute('data-interactive-scope');
  content.append(block);
  card.append(createPreviewDragHandle(), content, createPreviewEditButton());
  entry.element = card;
  entry.card = card;
  entry.visualElement = card;
  entry.contentElement = block;
  interactiveEntryByElement.set(card, entry);
  interactiveEntryByElement.set(block, entry);
}

function undecoratePreviewListItem(entry, {force = false} = {}) {
  const card = entry.card;
  if (!card?.isConnected || !force && (card.contains(document.activeElement) || card.classList.contains('highlight', 'is-selected'))) return;
  const body = card.querySelector(':scope > .preview-list-content > .preview-list-item-body');
  if (!body) return;
  while (body.firstChild) card.before(body.firstChild);
  card.remove();
  entry.element.classList.remove('interactive-preview-list-item');
  entry.card = null;
  entry.visualElement = entry.element;
}

function undecoratePreviewBlock(entry, {force = false} = {}) {
  const card = entry.card;
  const block = entry.contentElement;
  if (!card?.isConnected || !block || !force && (card.contains(document.activeElement) || card.classList.contains('highlight', 'is-selected'))) return;
  card.before(block);
  card.remove();
  block.dataset.interactiveStart = '';
  block.dataset.interactiveScope = entry.scope;
  entry.element = block;
  entry.card = null;
  entry.visualElement = block;
  entry.contentElement = null;
  interactiveEntryByElement.set(block, entry);
}

function decoratePreviewEntry(entry) {
  if (!entry || entry.card?.isConnected) return;
  if (entry.kind === 'list-item') decoratePreviewListItem(entry);
  else decoratePreviewBlock(entry);
}

function undecoratePreviewEntry(entry, options) {
  if (!entry || activePreviewDrag?.sourceStart === entry.start && activePreviewDrag?.scope === entry.scope) return;
  if (entry.kind === 'list-item') undecoratePreviewListItem(entry, options);
  else undecoratePreviewBlock(entry, options);
}

function disconnectPreviewDecorationObserver() {
  previewDecorationObserver?.disconnect();
  previewDecorationObserver = null;
  previewDecorationEntryByElement = new WeakMap();
  previewObservedElements = new Set();
}

function previewEntryObservationElement(entry) {
  return entry?.kind === 'block' ? entry.contentElement || entry.element : entry?.element;
}

function decorateInteractivePreview() {
  if (!interactivePreviewActive) {
    disconnectPreviewDecorationObserver();
    return;
  }
  const entries = [...interactiveBlockItems, ...interactiveListItems];
  if (typeof IntersectionObserver !== 'function') {
    entries.forEach(decoratePreviewEntry);
    return;
  }
  if (!previewDecorationObserver) {
    previewDecorationObserver = new IntersectionObserver(records => {
      const entering = [];
      const leaving = [];
      for (const record of records) {
        const entry = previewDecorationEntryByElement.get(record.target);
        if (!entry) continue;
        (record.isIntersecting ? entering : leaving).push(entry);
      }
      entering.sort((left, right) => left.start - right.start || left.indent - right.indent).forEach(decoratePreviewEntry);
      leaving.sort((left, right) => right.indent - left.indent || right.start - left.start).forEach(undecoratePreviewEntry);
    }, {root:$('#preview'), rootMargin:'600px 0px'});
  }
  const nextObservedElements = new Set(entries.map(previewEntryObservationElement).filter(Boolean));
  for (const element of previewObservedElements) {
    if (nextObservedElements.has(element)) continue;
    previewDecorationObserver.unobserve(element);
    previewObservedElements.delete(element);
  }
  entries.forEach(entry => {
    const element = previewEntryObservationElement(entry);
    if (!element) return;
    previewDecorationEntryByElement.set(element, entry);
    if (previewObservedElements.has(element)) return;
    previewObservedElements.add(element);
    previewDecorationObserver.observe(element);
  });
}

function setInteractiveSourceLocked(locked) {
  interactiveSourceLocked = Boolean(locked && interactivePreviewActive);
  syncInteractivePreviewUI();
}

function updatePreviewPreservingViewport() {
  const preview = $('#preview');
  const scrollTop = preview?.scrollTop || 0;
  suppressNextPreviewAlignment = true;
  updatePreview();
  if (preview) preview.scrollTop = scrollTop;
}

function applyInteractiveSource(nextSource, transaction, {preservePreview = false} = {}) {
  const textarea = $('#note-content');
  const before = textarea.value;
  if (!transaction || !nextSource || nextSource === before) return false;
  const preserveRenderedPreview = preservePreview &&
    nextSource.length === before.length &&
    isPreviewVisible() &&
    renderedPreviewSource === before &&
    previewRangeSource === before;
  const preservedBlockRanges = preserveRenderedPreview ? previewBlockRanges : null;
  interactiveHistory.push({...transaction, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd});
  if (interactiveHistory.length > 50) interactiveHistory.shift();
  interactiveSourceMutation = true;
  textarea.value = nextSource;
  textarea.dispatchEvent(new Event('input', {bubbles:true}));
  interactiveSourceMutation = false;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (preserveRenderedPreview) {
    // A task toggle changes only [ ]/[x], so block structure and every source
    // range remain valid. Keep the rendered DOM and update the input locally;
    // the next normal source edit will rebuild metadata for the new source.
    renderedPreviewSource = nextSource;
    renderedPreviewMetadata = null;
    previewRangeSource = nextSource;
    previewBlockRanges = preservedBlockRanges;
    suppressNextPreviewAlignment = true;
    scheduleHighlight();
    return true;
  }
  updatePreviewPreservingViewport();
  return true;
}

function undoInteractivePreview() {
  const transaction = interactiveHistory.pop();
  const textarea = $('#note-content');
  if (!transaction || !textarea) return false;
  const current = textarea.value;
  if (current.slice(transaction.start, transaction.start + transaction.inserted.length) !== transaction.inserted) {
    interactiveHistory = [];
    return false;
  }
  const restored = current.slice(0, transaction.start) + transaction.removed + current.slice(transaction.start + transaction.inserted.length);
  interactiveSourceMutation = true;
  textarea.value = restored;
  textarea.selectionStart = transaction.selectionStart;
  textarea.selectionEnd = transaction.selectionEnd;
  textarea.dispatchEvent(new Event('input', {bubbles:true}));
  interactiveSourceMutation = false;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  updatePreviewPreservingViewport();
  return true;
}
function isPreviewVisible() {
  return !screens.editor.classList.contains('hidden') && (panelState === 'both' || panelState === 'preview' || (panelState === 'zen' && zenViewState === 'preview'));
}
function schedulePreviewCheck() {
  if (previewCheckFrame !== null) return;
  previewCheckFrame = requestAnimationFrame(() => {
    previewCheckFrame = null;
    updatePreview();
  });
}
function scheduleHighlight() {
  if (highlightFrame !== null) return;
  highlightFrame = requestAnimationFrame(() => {
    highlightFrame = null;
    highlightBlock();
  });
}
function previewTokenTag(token) {
  switch (token.type) {
    case 'blockquote': return 'BLOCKQUOTE';
    case 'code': return 'PRE';
    case 'heading': {
      const match = (token.raw || '').match(/^\s*(#+)/);
      if (match) return `H${match[1].length}`;
      return Number.isInteger(token.depth) && token.depth >= 1 && token.depth <= 6 ? `H${token.depth}` : null;
    }
    case 'hr': return 'HR';
    case 'list': return token.ordered ? 'OL' : 'UL';
    case 'paragraph': return 'P';
    case 'table': return 'TABLE';
    default: return null;
  }
}

function previewGapDoesNotRender(source) {
  if (!source) return true;
  return marked.lexer(source, markdownRenderOptions()).every(token => token.type === 'space');
}

function clearPreviewHighlight() {
  const current = $('#preview').querySelector('.highlight');
  if (current) current.classList.remove('highlight');
}

function calculatePreviewScrollAdjustment({previewTop, previewHeight, previewScrollTop, previewScrollHeight, anchorTop, caretTop, margin, deadband}) {
  const safeTop = previewTop + margin;
  const safeBottom = previewTop + Math.max(margin, previewHeight - margin);
  const targetCaretTop = Math.min(safeBottom, Math.max(safeTop, caretTop));
  const delta = anchorTop - targetCaretTop;
  if (Math.abs(delta) <= deadband) return 0;
  const maxScroll = Math.max(0, previewScrollHeight - previewHeight);
  return Math.max(-previewScrollTop, Math.min(maxScroll - previewScrollTop, delta));
}

function measureEditorCaret() {
  const ta = editorSourceTextarea;
  if (!ta) return null;
  const taRect = ta.getBoundingClientRect();
  if (!taRect.width || !taRect.height) return null;
  const computed = getComputedStyle(ta);
  const source = ta.value;
  const position = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
  const safePosition = Math.min(position, source.length);
  const metricsKey = [ta.clientWidth, computed.font, computed.letterSpacing, computed.lineHeight, computed.padding, computed.border,
    computed.whiteSpace, computed.overflowWrap, computed.wordBreak, computed.tabSize, computed.textIndent,
    computed.direction, computed.unicodeBidi, computed.wordSpacing].join('\u0000');
  if (editorCaretMeasurementCache?.source === source && editorCaretMeasurementCache.position === position && editorCaretMeasurementCache.metricsKey === metricsKey) {
    return {
      top: taRect.top + editorCaretMeasurementCache.offsetTop - ta.scrollTop,
      height: editorCaretMeasurementCache.height,
      lineHeight: editorCaretMeasurementCache.lineHeight,
    };
  }
  if (!editorCaretMirror || !editorCaretRange || !editorCaretMirrorText || editorCaretMirrorKey !== `${source}\u0000${metricsKey}`) {
    if (!editorCaretMirror) {
      if (!editorSourceWrap) return null;
      editorCaretMirror = document.createElement('div');
      editorCaretMirror.className = 'editor-caret-measure';
      editorCaretMirror.setAttribute('aria-hidden', 'true');
      editorSourceWrap.append(editorCaretMirror);
      editorCaretRange = document.createRange();
    }
    editorCaretMirror.style.width = `${ta.clientWidth}px`;
    editorCaretMirror.style.boxSizing = 'border-box';
    editorCaretMirror.style.border = computed.border;
    editorCaretMirror.style.padding = computed.padding;
    editorCaretMirror.style.font = computed.font;
    editorCaretMirror.style.letterSpacing = computed.letterSpacing;
    editorCaretMirror.style.lineHeight = computed.lineHeight;
    editorCaretMirror.style.tabSize = computed.tabSize;
    editorCaretMirror.style.whiteSpace = computed.whiteSpace;
    editorCaretMirror.style.overflowWrap = computed.overflowWrap;
    editorCaretMirror.style.wordBreak = computed.wordBreak;
    editorCaretMirror.style.textIndent = computed.textIndent;
    editorCaretMirror.style.direction = computed.direction;
    editorCaretMirror.style.unicodeBidi = computed.unicodeBidi;
    editorCaretMirror.style.wordSpacing = computed.wordSpacing;
    editorCaretMirror.textContent = source || '\u200b';
    editorCaretMirrorText = editorCaretMirror.firstChild;
    editorCaretMarker = null;
    editorCaretMirrorKey = `${source}\u0000${metricsKey}`;
  }
  const lineStart = safePosition === 0 || source[safePosition - 1] === '\n';
  let caretRect;
  if (lineStart) {
    if (!editorCaretMarker) {
      const before = document.createTextNode('');
      editorCaretMarker = document.createElement('span');
      editorCaretMarker.textContent = '\u200b';
      const after = document.createTextNode('');
      editorCaretMirror.replaceChildren(before, editorCaretMarker, after);
      editorCaretMirrorText = null;
    }
    const children = editorCaretMirror.childNodes;
    children[0].data = source.slice(0, safePosition);
    children[2].data = source.slice(safePosition);
    caretRect = editorCaretMarker.getBoundingClientRect();
  } else {
    if (editorCaretMarker) {
      editorCaretMirror.textContent = source || '\u200b';
      editorCaretMirrorText = editorCaretMirror.firstChild;
      editorCaretMarker = null;
    }
    editorCaretRange.setStart(editorCaretMirrorText, safePosition);
    editorCaretRange.collapse(true);
    caretRect = editorCaretRange.getBoundingClientRect();
    if (safePosition < source.length && source[safePosition] !== '\n') {
      editorCaretRange.setEnd(editorCaretMirrorText, safePosition + 1);
      const characterRect = editorCaretRange.getBoundingClientRect();
      if (characterRect.height && Math.abs(characterRect.top - caretRect.top) > 0.5) caretRect = characterRect;
      editorCaretRange.collapse(true);
    }
    if (!caretRect.height && safePosition > 0) {
      editorCaretRange.setStart(editorCaretMirrorText, safePosition - 1);
      editorCaretRange.setEnd(editorCaretMirrorText, safePosition);
      caretRect = editorCaretRange.getBoundingClientRect();
    }
  }
  const mirrorRect = editorCaretMirror.getBoundingClientRect();
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.5 || 24;
  const offsetTop = caretRect.top - mirrorRect.top;
  editorCaretMeasurementCache = {source, position, metricsKey, offsetTop, height:caretRect.height || lineHeight, lineHeight};
  return {
    top: taRect.top + offsetTop - ta.scrollTop,
    height: caretRect.height || lineHeight,
    lineHeight,
  };
}

function updateEditorCaretCue() {
  editorCaretFrame = null;
  const textarea = editorSourceTextarea;
  const wrap = editorSourceWrap;
  const line = editorCurrentLine;
  if (!textarea || !wrap || !line) return;
  const focused = panelState !== 'zen' && document.activeElement === textarea && !textarea.readOnly;
  wrap.classList.toggle('is-caret-visible', focused);
  if (!focused) return;
  const caret = measureEditorCaret();
  if (!caret) return;
  const textareaRect = textarea.getBoundingClientRect();
  wrap.style.setProperty('--editor-caret-top', `${Math.max(0, caret.top - textareaRect.top)}px`);
  wrap.style.setProperty('--editor-caret-height', `${Math.max(1, caret.height)}px`);
}

function scheduleEditorCaretCue() {
  if (panelState === 'zen') {
    editorSourceWrap?.classList.remove('is-caret-visible');
    if (editorCaretFrame !== null) cancelAnimationFrame(editorCaretFrame);
    editorCaretFrame = null;
    return;
  }
  if (editorCaretFrame !== null) return;
  editorCaretFrame = requestAnimationFrame(updateEditorCaretCue);
}

function centerEditorCaretInView(targetRatio = .38, {defer = true} = {}) {
  const textarea = editorSourceTextarea;
  if (!textarea) return;
  const center = () => {
    const caret = measureEditorCaret();
    if (!caret) return;
    const textareaRect = textarea.getBoundingClientRect();
    const caretOffset = caret.top - textareaRect.top + textarea.scrollTop + caret.height / 2;
    const targetOffset = textarea.clientHeight * targetRatio;
    const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, caretOffset - targetOffset));
    if (Math.abs(textarea.scrollTop - nextScrollTop) > 2) textarea.scrollTop = nextScrollTop;
  };
  if (defer) requestAnimationFrame(center);
  else center();
}

function cancelScheduledZenCaretCenter() {
  if (zenCaretFrame === null) return;
  cancelAnimationFrame(zenCaretFrame);
  zenCaretFrame = null;
}

function centerZenCaretNow({defer = true} = {}) {
  if (panelState !== 'zen' || document.activeElement !== editorSourceTextarea) return;
  const center = () => {
    zenCaretFrame = null;
    if (panelState === 'zen' && document.activeElement === editorSourceTextarea) {
      centerEditorCaretInView(.48, {defer:false});
    }
  };
  if (!defer) {
    cancelScheduledZenCaretCenter();
    center();
    return;
  }
  if (zenCaretFrame !== null) return;
  zenCaretFrame = requestAnimationFrame(center);
}

function wordCount(source = editorSourceTextarea?.value || '') {
  const matcher = /\S+/g;
  let count = 0;
  while (matcher.exec(source)) count++;
  return count;
}

function cancelScheduledZenWordCount() {
  if (!zenWordCountHandle) return;
  if (zenWordCountHandle.idle) window.cancelIdleCallback(zenWordCountHandle.id);
  else clearTimeout(zenWordCountHandle.id);
  zenWordCountHandle = null;
}

function updateZenWordCount() {
  zenWordCountHandle = null;
  const count = $('#zen-word-count');
  if (!count) return;
  count.hidden = !prefs.zenWordCount;
  if (!prefs.zenWordCount) return;
  const source = editorSourceTextarea?.value || '';
  if (source !== zenWordCountSource) {
    zenWordCountSource = source;
    zenWordCountValue = wordCount(source);
  }
  const label = `${zenWordCountValue} ${zenWordCountValue === 1 ? 'word' : 'words'}`;
  if (count.textContent !== label) count.textContent = label;
}

function scheduleZenWordCount() {
  cancelScheduledZenWordCount();
  if (!prefs.zenWordCount || panelState !== 'zen') return;
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(updateZenWordCount, {timeout:400});
    zenWordCountHandle = {id, idle:true};
  } else {
    const id = setTimeout(updateZenWordCount, 120);
    zenWordCountHandle = {id, idle:false};
  }
}

function updateZenTitle() {
  const title = $('#zen-note-title');
  if (!title) return;
  const label = $('#note-title')?.value.trim() || 'Untitled note';
  if (title.textContent !== label) title.textContent = label;
  title.hidden = !prefs.zenShowTitle;
}

function updateZenOverlays() {
  const title = $('#zen-note-title');
  const count = $('#zen-word-count');
  const controls = $('.zen-controls');
  if (!title || !count || !controls) return;
  updateZenTitle();
  cancelScheduledZenWordCount();
  updateZenWordCount();
  controls.classList.toggle('is-minimal', !prefs.zenShowControls);
  $('#zen-exit-icon')?.setAttribute('href', prefs.zenShowControls ? '#icon-minimize' : '#icon-x');
}

function previewBlockIndexAtPosition(position) {
  let low = 0;
  let high = previewBlockRanges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (previewBlockRanges[middle].start <= position) low = middle + 1;
    else high = middle;
  }
  const previous = low - 1;
  const next = low < previewBlockRanges.length ? low : -1;
  if (previous >= 0 && position <= previewBlockRanges[previous].end) return previous;
  if (next >= 0 && position === previewBlockRanges[next].start) return next;
  return -1;
}

function previewListItemAtPosition(position, sourceLength) {
  let best = null;
  for (const entry of interactiveListItems) {
    if (entry.start > position) break;
    if (!(position < entry.end || position === sourceLength && entry.end === position)) continue;
    if (!best || entry.indent > best.indent || entry.indent === best.indent && entry.start > best.start ||
      entry.indent === best.indent && entry.start === best.start && entry.end < best.end) best = entry;
  }
  return best;
}

function previewTaskCheckbox(item) {
  const body = item.querySelector(':scope > .interactive-preview-list-card > .preview-list-content > .preview-list-item-body');
  return item.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]')
    || body?.querySelector('input[type="checkbox"]')
    || null;
}

function syncPreviewTaskCheckbox(item) {
  const checkbox = previewTaskCheckbox(item);
  if (!checkbox) return;
  checkbox.disabled = !interactivePreviewActive;
  checkbox.setAttribute('aria-label', checkbox.checked ? 'Mark task incomplete' : 'Mark task complete');
}

function alignPreviewWithCaret(block, range) {
  const preview = $('#preview');
  const caret = measureEditorCaret();
  if (!caret || !preview.clientHeight || !preview.scrollHeight) return;
  const previewRect = preview.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const sourceLength = Math.max(1, range.end - range.start);
  const sourceProgress = Math.min(1, Math.max(0, ($('#note-content').selectionStart - range.start) / sourceLength));
  const anchorTop = blockRect.top + blockRect.height * sourceProgress;
  const caretTop = caret.top + caret.height / 2;
  const margin = Math.max(caret.lineHeight * 2, Math.min(96, preview.clientHeight * .18));
  const deadband = caret.lineHeight * 2;
  const adjustment = calculatePreviewScrollAdjustment({
    previewTop: previewRect.top,
    previewHeight: preview.clientHeight,
    previewScrollTop: preview.scrollTop,
    previewScrollHeight: preview.scrollHeight,
    anchorTop,
    caretTop,
    margin,
    deadband,
  });
  if (adjustment) preview.scrollTop += adjustment;
}

function previewBlockDescriptors(source, renderMetadata) {
  if (renderMetadata?.source === source && Array.isArray(renderMetadata.blocks)) return renderMetadata.blocks;
  const descriptors = [];
  let offset = 0;
  for (const token of marked.lexer(source, markdownRenderOptions())) {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    if (!raw) continue;
    const start = source.indexOf(raw, offset);
    if (start < offset || !previewGapDoesNotRender(source.slice(offset, start))) return null;
    offset = start + raw.length;
    const tagName = previewTokenTag(token);
    if (!tagName) continue;
    descriptors.push({
      start,
      end:Math.max(start, start + raw.replace(/[\s\r\n]+$/, '').length),
      tagName,
      type:token.type,
      listItems:token.type === 'list' && window.VylkInteractive?.listItemRanges
        ? window.VylkInteractive.listItemRanges(raw, start, `list:${start}`)
        : [],
    });
  }
  if (!previewGapDoesNotRender(source.slice(offset))) return null;
  return descriptors;
}

function previewContentBlocks(pv, patchedBlocks) {
  if (patchedBlocks) return patchedBlocks;
  return Array.from(pv.children)
    .filter(c => c.tagName && !['STYLE','SCRIPT'].includes(c.tagName) && !c.dataset.previewDragIndicator)
    .map(element => element.matches('.interactive-preview-block-card')
      ? element.querySelector(':scope > .preview-block-content')?.firstElementChild
      : element)
    .filter(Boolean);
}

function createPreviewCacheState(renderMetadata, patchedBlocks) {
  const pv = $('#preview');
  const previousBlockEntries = new Map(interactiveBlockItems.map(entry => [entry.contentElement || entry.element, entry]));
  const previousListEntries = new Map(interactiveListItems.map(entry => [entry.element, entry]));
  const previousListEntriesByBlock = new Map();
  interactiveListItems.forEach(entry => {
    if (!entry.blockElement) return;
    const entries = previousListEntriesByBlock.get(entry.blockElement) || [];
    entries.push(entry);
    previousListEntriesByBlock.set(entry.blockElement, entries);
  });
  const blocks = previewContentBlocks(pv, patchedBlocks);
  const source = $('#note-content').value;
  if (!source || typeof marked === 'undefined' || typeof marked.lexer !== 'function') return null;
  const descriptors = previewBlockDescriptors(source, renderMetadata);
  if (!descriptors || descriptors.length !== blocks.length) return null;
  return {
    source,
    blocks,
    descriptors,
    previousBlockEntries,
    previousListEntries,
    previousListEntriesByBlock,
    ranges:[],
    blockItems:[],
    listItems:[],
    index:0,
  };
}

function processPreviewCacheBlock(state) {
  const blockIndex = state.index++;
  const descriptor = state.descriptors[blockIndex];
  const block = state.blocks[blockIndex];
  if (!block || block.tagName !== descriptor.tagName) throw new Error('preview block metadata did not match rendered output');
  const range = {start:descriptor.start, end:descriptor.end};
  state.ranges.push(range);
  if (descriptor.type !== 'list') {
    const entry = state.previousBlockEntries.get(block) || {};
    Object.assign(entry, range, {indent:0, ordered:false, parent:null, kind:'block', scope:'blocks'});
    if (entry.card?.isConnected) {
      entry.element = entry.card;
      entry.visualElement = entry.card;
      entry.contentElement = block;
    } else {
      entry.element = block;
      entry.visualElement = block;
      entry.contentElement = null;
    }
    if (!entry.element.hasAttribute('data-interactive-start')) entry.element.dataset.interactiveStart = '';
    if (!entry.element.hasAttribute('data-interactive-scope')) entry.element.dataset.interactiveScope = entry.scope;
    interactiveEntryByElement.set(entry.element, entry);
    interactiveEntryByElement.set(block, entry);
    state.blockItems.push(entry);
    return;
  }
  const listEntries = descriptor.listItems || [];
  const previousEntries = state.previousListEntriesByBlock.get(block);
  const listElements = previousEntries?.length === listEntries.length
    ? previousEntries.map(entry => entry.element)
    : [...block.querySelectorAll('li')];
  if (listEntries.length !== listElements.length) return;
  listEntries.forEach((descriptorEntry, index) => {
    const element = listElements[index];
    const entry = state.previousListEntries.get(element) || {};
    Object.assign(entry, descriptorEntry, {element, blockElement:block});
    if (!element.hasAttribute('data-interactive-start')) element.dataset.interactiveStart = '';
    if (!element.hasAttribute('data-interactive-scope')) element.dataset.interactiveScope = entry.scope;
    interactiveEntryByElement.set(element, entry);
    if (entry.card?.isConnected) interactiveEntryByElement.set(entry.card, entry);
    const lineEnd = state.source.indexOf('\n', entry.start);
    const line = state.source.slice(entry.start, lineEnd < 0 ? entry.end : Math.min(entry.end, lineEnd));
    if (/\[[ xX]\]/.test(line)) syncPreviewTaskCheckbox(element);
    state.listItems.push(entry);
  });
}

function commitPreviewCache(state, generation) {
  if (generation !== previewCacheGeneration || state.source !== $('#note-content').value || state.blocks !== previewBlocks) return;
  previewBlockRanges = state.ranges;
  previewRangeSource = state.source;
  interactiveBlockItems = state.blockItems;
  interactiveListItems = state.listItems;
  decorateInteractivePreview();
  syncInteractivePreviewUI();
  scheduleHighlight();
}

function cachePreviewBlocks(renderMetadata = null, patchedBlocks = null, {defer = false} = {}) {
  if (previewCacheHandle !== null) clearTimeout(previewCacheHandle);
  previewCacheHandle = null;
  const generation = ++previewCacheGeneration;
  let state;
  try {
    state = createPreviewCacheState(renderMetadata, patchedBlocks);
  } catch (_) {
    state = null;
  }
  previewBlocks = state?.blocks || previewContentBlocks($('#preview'), patchedBlocks);
  previewBlockRanges = [];
  previewRangeSource = null;
  if (!state) {
    interactiveListItems = [];
    interactiveBlockItems = [];
    decorateInteractivePreview();
    syncInteractivePreviewUI();
    return;
  }
  const process = () => {
    previewCacheHandle = null;
    if (generation !== previewCacheGeneration || state.source !== $('#note-content').value) return;
    const started = performance.now();
    try {
      while (state.index < state.descriptors.length && (!defer || performance.now() - started < 5)) processPreviewCacheBlock(state);
    } catch (_) {
      previewBlockRanges = [];
      return;
    }
    if (state.index < state.descriptors.length) {
      previewCacheHandle = setTimeout(process, 0);
      return;
    }
    commitPreviewCache(state, generation);
  };
  process();
}

function cancelPreviewCache() {
  previewCacheGeneration++;
  if (previewCacheHandle !== null) {
    clearTimeout(previewCacheHandle);
    previewCacheHandle = null;
  }
}
function highlightBlock() {
  if (!isPreviewVisible()) return;
  const skipAlignment = suppressNextPreviewAlignment;
  suppressNextPreviewAlignment = false;
  if (prefs.hideCursorHighlight) {
    clearPreviewHighlight();
    return;
  }
  const ta = $('#note-content');
  const text = ta.value;
  const pos = ta.selectionStart;
  if (!text.trim() || !previewBlocks.length) {
    clearPreviewHighlight();
    previewHighlightPending = false;
    return;
  }
  if (renderedPreviewSource !== text || previewRangeSource !== text) {
    if (!previewHighlightPending) clearPreviewHighlight();
    return;
  }
  previewHighlightPending = false;
  clearPreviewHighlight();
  const idx = previewBlockIndexAtPosition(pos);
  const block = previewBlocks[idx];
  if (!block) return;
  let range = previewBlockRanges[idx];
  if (interactivePreviewActive && !['UL', 'OL'].includes(block.tagName)) {
    decoratePreviewEntry(interactiveBlockItems.find(entry => entry.start === range?.start));
  }
  let highlightTarget = interactivePreviewActive ? block.closest('.interactive-preview-card') || block : block;
  if (['UL', 'OL'].includes(block.tagName)) {
    const listItem = previewListItemAtPosition(pos, text.length);
    if (listItem?.element?.isConnected) {
      if (interactivePreviewActive) decoratePreviewEntry(listItem);
      range = listItem;
      highlightTarget = interactivePreviewActive ? listItem.card || listItem.element : listItem.element;
    }
  }
  highlightTarget.classList.add('highlight');
  if (!skipAlignment) alignPreviewWithCaret(highlightTarget, range);
}

// --- Delete ---
$('#delete-btn').addEventListener('click', async () => {
  if (!currentNoteId) return;
  if (!confirm('Delete this note?')) return;
  const noteID = currentNoteId;
  if (isDirty || localSavePromise) {
    const saved = await saveCurrentNote(false);
    if (saved === false || currentNoteId !== noteID) return;
  }
  const local = await getLocalNote(noteID);
  if (!local) return;
  const pending = await pendingOperationsForNote(noteID);
  const hasAttemptedOperation = pending.some(operation => Boolean(operation.attempted_at));
  if (pending.length && !hasAttemptedOperation && (local.base_revision || 0) === 0) {
    await removeLocalNoteAndSupersede(noteID, 0);
  } else {
    await removeLocalNoteAndQueue(noteID, {type: 'note.delete', note_id: noteID, base_revision: local.base_revision ?? local.revision});
  }
  editorSessionGeneration++;
  currentNoteId = null;
  currentRevision = 0;
  currentBaseRevision = null;
  if (currentTag) {
    const remainingNotes = await getLocalNotes();
    if (!remainingNotes.some(note => noteHasTag(note, currentTag))) currentTag = null;
  }
  setIdleSyncStatus();
  scheduleSync();
  await loadDashboard({sync: false});
  setDashboardRoute({replace: true});
});

// --- Live Preview ---
$('#note-content').addEventListener('input', () => {
  cancelScheduledZenCaretCenter();
  if (!interactiveSourceMutation) interactiveHistory = [];
  if (activePreviewDrag) cancelPreviewDrag({animateReturn:false});
  markDirty();
  scheduleSave();
  previewHighlightPending = true;
  previewRangeSource = null;
  previewBlockRanges = [];
  if (isPreviewVisible()) scheduleHighlight();
  scheduleEditorCaretCue();
  scheduleZenWordCount();
  cancelPendingPreviewRender();
  if (isPreviewVisible()) previewTimer = setTimeout(requestPreviewRender, 500);
});
$('#note-content').addEventListener('click', () => {
  if (isPreviewVisible()) scheduleHighlight();
  scheduleEditorCaretCue();
});
$('#note-content').addEventListener('keyup', event => {
  if (isPreviewVisible()) scheduleHighlight();
  const caretNavigationKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];
  if (caretNavigationKeys.includes(event.key)) scheduleEditorCaretCue();
});
$('#note-content').addEventListener('focus', () => { scheduleEditorCaretCue(); centerZenCaretNow(); });
$('#note-content').addEventListener('blur', scheduleEditorCaretCue);
$('#note-content').addEventListener('select', scheduleEditorCaretCue);
$('#note-content').addEventListener('scroll', scheduleEditorCaretCue, {passive:true});
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorSourceTextarea) scheduleEditorCaretCue();
});
window.addEventListener('resize', scheduleEditorCaretCue, {passive:true});
if (typeof ResizeObserver === 'function' && editorSourceTextarea) {
  new ResizeObserver(scheduleEditorCaretCue).observe(editorSourceTextarea);
}

function linkifyWikiLinks(container) {
  const matcher = /\[\[([^\[\]\n]+)\]\]/g;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!matcher.test(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
      matcher.lastIndex = 0;
      return node.parentElement?.closest('a, code, pre, script, style')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matcher.lastIndex = 0;
    for (let match; (match = matcher.exec(text));) {
      const title = match[1].trim().replace(/\s+/g, ' ');
      if (!title) continue;
      fragment.append(document.createTextNode(text.slice(cursor, match.index)));
      const link = document.createElement('a');
      link.className = 'wiki-link';
      link.href = '/';
      link.dataset.wikiTitle = title;
      link.textContent = title;
      fragment.append(link);
      cursor = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

const previewAllowedElements = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'IMG', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
const previewAllowedAttributes = new Set(['align', 'alt', 'checked', 'class', 'colspan', 'disabled', 'href', 'rowspan', 'src', 'start', 'title', 'type']);

function safePreviewURL(value, allowMailto = false) {
  if (!value || /[\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) || (allowMailto && url.protocol === 'mailto:');
  } catch (_) {
    return false;
  }
}

function sanitizePreview(container) {
  [...container.querySelectorAll('*')].forEach(element => {
    if (!previewAllowedElements.has(element.tagName)) {
      element.remove();
      return;
    }
    const attributeNames = [];
    for (let index = 0; index < element.attributes.length; index++) {
      const attribute = element.attributes.item(index);
      if (attribute?.name) attributeNames.push(attribute.name);
    }
    attributeNames.forEach(attributeName => {
      const name = attributeName.toLowerCase();
      if (!previewAllowedAttributes.has(name) || name.startsWith('on')) element.removeAttribute(attributeName);
    });
    if (element.tagName === 'OL') {
      const start = element.getAttribute('start');
      if (start !== null && !/^[+-]?\d+$/.test(start)) element.removeAttribute('start');
    } else {
      element.removeAttribute('start');
    }
    if (element.tagName === 'A') {
      const href = element.getAttribute('href');
      if (href && !safePreviewURL(href, true)) element.removeAttribute('href');
    }
    if (element.tagName === 'IMG') {
      const src = element.getAttribute('src');
      if (!src || !safePreviewURL(src)) {
        element.remove();
        return;
      }
      element.setAttribute('loading', 'lazy');
      element.setAttribute('decoding', 'async');
    }
    if (element.tagName === 'INPUT' && element.getAttribute('type') !== 'checkbox') element.remove();
  });
}

function markdownRenderOptions() {
  const options = {breaks:true, gfm:true};
  if (typeof marked.Renderer === 'function') {
    const renderer = new marked.Renderer();
    renderer.html = token => esc(token.text ?? token.raw ?? '');
    options.renderer = renderer;
  }
  return options;
}

function interactiveEntryForElement(element) {
  if (!interactivePreviewSourceIsCurrent()) return null;
  const owner = element?.closest('[data-interactive-start]');
  return owner ? interactiveEntryByElement.get(owner) || null : null;
}

function interactivePreviewSourceIsCurrent() {
  const source = $('#note-content').value;
  return renderedPreviewSource === source && previewRangeSource === source;
}

function previewEditPosition(entry, source = $('#note-content').value) {
  if (!entry || typeof source !== 'string') return 0;
  const raw = source.slice(entry.start, entry.end);
  let prefix = '';
  if (entry.kind === 'list-item') {
    prefix = raw.match(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/)?.[0] || '';
  } else {
    prefix = raw.match(/^[ \t]{0,3}#{1,6}[ \t]+/)?.[0]
      || raw.match(/^[ \t]{0,3}>[ \t]?/)?.[0]
      || raw.match(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/)?.[0]
      || '';
  }
  return Math.min(entry.end, entry.start + prefix.length);
}

function editPreviewEntry(entry) {
  const textarea = $('#note-content');
  if (!interactivePreviewActive || !entry || !textarea) return false;
  if (activePreviewDrag) cancelPreviewDrag({animateReturn:false});
  const position = previewEditPosition(entry, textarea.value);
  if (panelState === 'zen' && zenViewState === 'preview') {
    zenViewState = 'editor';
    setPanelState('zen');
  } else if (panelState === 'preview') {
    setPanelState('editor', {preservePanelWide:true});
  }
  textarea.focus({preventScroll:true});
  textarea.setSelectionRange(position, position);
  centerEditorCaretInView();
  scheduleHighlight();
  return true;
}

function selectInteractivePreviewCard(card) {
  $('#preview').querySelectorAll('.interactive-preview-card.is-selected').forEach(current => {
    if (current !== card) current.classList.remove('is-selected');
  });
  card?.classList.add('is-selected');
}

$('#preview').addEventListener('click', event => {
  const editButton = event.target.closest('.preview-edit-button');
  if (interactivePreviewActive && editButton) {
    event.preventDefault();
    editPreviewEntry(interactiveEntryForElement(editButton));
    return;
  }
  const link = event.target.closest('a[data-wiki-title]');
  if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    void followWikiLink(link.dataset.wikiTitle);
    return;
  }
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (interactivePreviewActive && checkbox && !checkbox.disabled && interactivePreviewSourceIsCurrent()) {
    const item = checkbox.closest('li[data-interactive-start]');
    const entry = interactiveEntryByElement.get(item);
    const change = window.VylkInteractive?.toggleTask($('#note-content').value, entry);
    if (!change) return;
    const applied = applyInteractiveSource(change.source, {
      start:change.start,
      removed:$('#note-content').value.slice(change.start, change.end),
      inserted:change.inserted,
    }, {preservePreview:true});
    if (applied) {
      checkbox.setAttribute('aria-label', change.checked ? 'Mark task incomplete' : 'Mark task complete');
    }
    return;
  }
  if (interactivePreviewActive && window.matchMedia('(hover: none), (pointer: coarse)').matches) {
    selectInteractivePreviewCard(event.target.closest('.interactive-preview-card'));
  }
});

document.addEventListener('pointerdown', event => {
  if (!interactivePreviewActive || event.target.closest('#preview .interactive-preview-card')) return;
  selectInteractivePreviewCard(null);
});

function previewDragTarget(clientX, clientY, sourceStart, sourceScope) {
  const preview = $('#preview');
  const previewRect = preview.getBoundingClientRect();
  if (clientX < previewRect.left || clientX > previewRect.right || clientY < previewRect.top || clientY > previewRect.bottom) return null;
  const entries = [...interactiveBlockItems, ...interactiveListItems];
  const source = entries.find(entry => entry.start === sourceStart && entry.scope === sourceScope);
  if (!source) return null;
  let best = null;
  // IntersectionObserver keeps every on-screen and near-screen target
  // decorated. Restrict geometry reads to those cards so dragging remains one
  // frame of work even when the note contains thousands of source blocks.
  for (const entry of entries) {
    if (!entry.card?.isConnected || entry === source || !entry.element?.isConnected || (source.start < entry.end && entry.start < source.end)) continue;
    // Use the visible card as the hit target when it exists. A list item's LI
    // may include nested lists, making its box much taller than the row the
    // pointer is actually crossing and causing an apparent before/after flip.
    const rect = (entry.card || entry.visualElement || entry.element).getBoundingClientRect();
    if (!rect.height) continue;
    const verticalDistance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const horizontalDistance = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const score = verticalDistance * 1000 + horizontalDistance;
    if (!best || score < best.score) best = {entry, rect, score};
  }
  if (!best) return null;
  return {
    element:best.entry.element,
    start:best.entry.start,
    scope:best.entry.scope,
    placement:clientY < best.rect.top + best.rect.height / 2 ? 'before' : 'after',
  };
}

function capturePreviewLayout(parent, excludedElement) {
  if (!parent) return new Map();
  return new Map([...parent.children]
    .filter(element => element !== excludedElement && !element.classList.contains('preview-drag-placeholder'))
    .map(element => [element, element.getBoundingClientRect()]));
}

function animatePreviewReflow(before) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const [element, first] of before) {
    if (!element.isConnected || typeof element.animate !== 'function') continue;
    element.getAnimations?.().filter(animation => animation.id === 'preview-reflow').forEach(animation => animation.cancel());
    const last = element.getBoundingClientRect();
    const deltaX = first.left - last.left;
    const deltaY = first.top - last.top;
    if (Math.abs(deltaX) < .5 && Math.abs(deltaY) < .5) continue;
    const animation = element.animate([
      {transform:`translate3d(${deltaX}px,${deltaY}px,0)`},
      {transform:'translate3d(0,0,0)'},
    ], {duration:180, easing:'cubic-bezier(.16,1,.3,1)'});
    animation.id = 'preview-reflow';
  }
}

function createPreviewPlaceholder(drag, parent) {
  const tagName = ['UL', 'OL'].includes(parent?.tagName) ? 'li' : 'div';
  if (drag.placeholder?.tagName === tagName.toUpperCase()) return drag.placeholder;
  drag.placeholder?.remove();
  const placeholder = document.createElement(tagName);
  placeholder.className = 'preview-drag-placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.style.width = `${drag.placeholderWidth}px`;
  placeholder.style.height = `${drag.placeholderHeight}px`;
  drag.placeholder = placeholder;
  return placeholder;
}

function previewAutoScrollDelta(preview, clientY, elapsedMilliseconds = 16.67) {
  const rect = preview.getBoundingClientRect();
  const edgeSize = Math.min(72, Math.max(44, rect.height * .18));
  let intensity = 0;
  if (clientY < rect.top + edgeSize) intensity = -Math.min(1, (rect.top + edgeSize - clientY) / edgeSize);
  else if (clientY > rect.bottom - edgeSize) intensity = Math.min(1, (clientY - (rect.bottom - edgeSize)) / edgeSize);
  const maxScrollTop = Math.max(0, preview.scrollHeight - preview.clientHeight);
  if (!intensity || (intensity < 0 && preview.scrollTop <= 0) || (intensity > 0 && preview.scrollTop >= maxScrollTop - 1)) return 0;
  return Math.sign(intensity) * Math.max(1, .75 * Math.min(32, elapsedMilliseconds) * intensity * intensity);
}

function renderPreviewDrag(frameTime = performance.now()) {
  const drag = activePreviewDrag;
  if (!drag) return;
  drag.frame = null;
  if (!drag.armed) return;
  drag.ghost.style.transform = `translate3d(${drag.x - drag.startX}px,${drag.y - drag.startY}px,0)`;
  const preview = $('#preview');
  const previewRect = preview.getBoundingClientRect();
  const outsidePreview = drag.x < previewRect.left || drag.x > previewRect.right || drag.y < previewRect.top || drag.y > previewRect.bottom;
  document.documentElement.classList.toggle('preview-drag-outside', outsidePreview);
  const elapsed = drag.lastFrameAt ? frameTime - drag.lastFrameAt : 16.67;
  drag.lastFrameAt = frameTime;
  const scrollDelta = outsidePreview ? 0 : previewAutoScrollDelta(preview, drag.y, elapsed);
  const previousScrollTop = preview.scrollTop;
  if (scrollDelta) preview.scrollTop += scrollDelta;
  const didScroll = Math.abs(preview.scrollTop - previousScrollTop) > .1;
  const nextTarget = previewDragTarget(drag.x, drag.y, drag.sourceStart, drag.scope);
  const previous = drag.target;
  if (previous?.element !== nextTarget?.element || previous?.placement !== nextTarget?.placement) {
    if (previous) previous.element.removeAttribute('data-preview-drop');
    if (nextTarget) nextTarget.element.dataset.previewDrop = nextTarget.placement;
    drag.target = nextTarget;
    if (nextTarget) {
      const parent = nextTarget.element.parentNode;
      const placeholder = createPreviewPlaceholder(drag, parent);
      const insertionPoint = nextTarget.placement === 'before' ? nextTarget.element : nextTarget.element.nextSibling;
      if (insertionPoint !== placeholder) {
        const before = capturePreviewLayout(parent, drag.sourceElement);
        parent.insertBefore(placeholder, insertionPoint);
        animatePreviewReflow(before);
      }
    }
  }
  if (didScroll && drag.frame === null) drag.frame = requestAnimationFrame(renderPreviewDrag);
}

function cancelPreviewDrag({animateReturn = true} = {}) {
  const drag = activePreviewDrag;
  if (!drag) return;
  if (drag.frame !== null) cancelAnimationFrame(drag.frame);
  const returnLayout = drag.armed && animateReturn ? capturePreviewLayout(drag.placeholder?.parentNode, drag.sourceElement) : null;
  if (drag.armed) {
    drag.sourceElement?.classList.remove('preview-dragging');
    drag.visualElement?.classList.remove('preview-dragging');
    if (drag.sourceElement) drag.sourceElement.style.display = drag.sourceDisplay;
  }
  drag.target?.element?.removeAttribute('data-preview-drop');
  drag.placeholder?.remove();
  if (returnLayout) animatePreviewReflow(returnLayout);
  drag.portal?.remove();
  drag.ghost?.remove();
  document.documentElement.classList.remove('preview-drag-active', 'preview-drag-outside');
  activePreviewDrag = null;
  if (drag.armed) setInteractiveSourceLocked(false);
}

$('#preview').addEventListener('pointerdown', event => {
  if (!interactivePreviewActive || !interactivePreviewSourceIsCurrent() || event.button !== 0 || event.isPrimary === false) return;
  const startedOnHandle = Boolean(event.target.closest('.preview-drag-handle'));
  if (event.pointerType === 'touch' && !startedOnHandle) return;
  const item = event.target.closest('#preview > [data-interactive-start], #preview li[data-interactive-start]');
  if (!item || event.target.closest('a,input,button,select,textarea')) return;
  const entry = interactiveEntryByElement.get(item);
  if (!entry) return;
  if (activePreviewDrag) cancelPreviewDrag({animateReturn:false});
  activePreviewDrag = {
    pointerID:event.pointerId,
    sourceStart:entry.start,
    scope:entry.scope,
    sourceElement:entry.element,
    visualElement:entry.visualElement || entry.element,
    startedOnHandle,
    startedAt:performance.now(),
    startX:event.clientX,
    startY:event.clientY,
    x:event.clientX,
    y:event.clientY,
    armed:false,
    frame:null,
    lastFrameAt:null,
    target:null,
  };
});

$('#preview').addEventListener('selectstart', () => {
  if (activePreviewDrag && !activePreviewDrag.armed && !activePreviewDrag.startedOnHandle) activePreviewDrag = null;
});

$('#preview').addEventListener('contextmenu', event => {
  if (event.target.closest('.preview-drag-handle')) event.preventDefault();
});

document.addEventListener('pointermove', event => {
  const drag = activePreviewDrag;
  if (!drag || drag.pointerID !== event.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.armed && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
  if (!drag.armed && event.pointerType === 'touch' && performance.now() - drag.startedAt < 220) return;
  if (!drag.armed) {
    event.preventDefault();
    drag.armed = true;
    window.getSelection()?.removeAllRanges();
    const preview = $('#preview');
    preview.setPointerCapture?.(event.pointerId);
    const sourceRect = drag.sourceElement.getBoundingClientRect();
    const visualRect = drag.visualElement.getBoundingClientRect();
    const ghost = drag.visualElement.cloneNode(true);
    ghost.removeAttribute('data-interactive-start');
    ghost.removeAttribute('data-interactive-scope');
    ghost.classList.add('preview-drag-ghost');
    ghost.style.width = `${visualRect.width}px`;
    ghost.style.height = `${visualRect.height}px`;
    ghost.style.left = `${visualRect.left}px`;
    ghost.style.top = `${visualRect.top}px`;
    drag.sourceDisplay = drag.sourceElement.style.display;
    drag.placeholderWidth = sourceRect.width;
    drag.placeholderHeight = sourceRect.height;
    drag.placeholder = null;
    const placeholder = createPreviewPlaceholder(drag, drag.sourceElement.parentNode);
    drag.sourceElement.style.display = 'none';
    drag.sourceElement.before(placeholder);
    setInteractiveSourceLocked(true);
    drag.ghost = ghost;
    const portal = document.createElement('div');
    portal.className = 'preview preview-drag-portal interactive-preview-active';
    portal.setAttribute('aria-hidden', 'true');
    portal.append(ghost);
    drag.portal = portal;
    document.body.append(portal);
    drag.sourceElement.classList.add('preview-dragging');
    drag.visualElement.classList.add('preview-dragging');
    document.documentElement.classList.add('preview-drag-active');
  }
  if (drag.frame === null) drag.frame = requestAnimationFrame(renderPreviewDrag);
});

function finishPreviewDrag(event) {
  const drag = activePreviewDrag;
  if (!drag || drag.pointerID !== event.pointerId) return;
  if (event.type === 'pointerup' && drag.armed && drag.target) {
    if (!interactivePreviewSourceIsCurrent()) {
      cancelPreviewDrag({animateReturn:false});
      if ($('#preview').hasPointerCapture?.(event.pointerId)) $('#preview').releasePointerCapture(event.pointerId);
      return;
    }
    const source = $('#note-content').value;
    const entries = [...interactiveBlockItems, ...interactiveListItems];
    const change = window.VylkInteractive?.moveMarkdownUnit(source, entries, drag.sourceStart, drag.scope, drag.target.start, drag.target.scope, drag.target.placement);
    cancelPreviewDrag({animateReturn:false});
    if ($('#preview').hasPointerCapture?.(event.pointerId)) $('#preview').releasePointerCapture(event.pointerId);
    if (change) applyInteractiveSource(change.source, {start:change.start, removed:source.slice(change.start, change.end), inserted:change.inserted});
    return;
  }
  cancelPreviewDrag();
  if ($('#preview').hasPointerCapture?.(event.pointerId)) $('#preview').releasePointerCapture(event.pointerId);
}

document.addEventListener('pointerup', finishPreviewDrag);
document.addEventListener('pointercancel', finishPreviewDrag);
$('#preview').addEventListener('lostpointercapture', event => {
  if (activePreviewDrag?.pointerID === event.pointerId) cancelPreviewDrag();
});

window.addEventListener('blur', () => cancelPreviewDrag());

function targetUsesNativeUndo(target) {
  const editable = target?.closest?.('textarea, input, [contenteditable="true"]');
  if (!editable || editable === $('#note-content')) return false;
  if (editable.matches('textarea, [contenteditable="true"]')) return true;
  return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(editable.type);
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && activePreviewDrag) {
    event.preventDefault();
    cancelPreviewDrag();
    return;
  }
  if (!interactivePreviewActive || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') return;
  if (targetUsesNativeUndo(event.target)) return;
  if (undoInteractivePreview()) event.preventDefault();
});

function cancelPreviewApply() {
  if (!previewApplyHandle) return;
  if (previewApplyHandle.idle) window.cancelIdleCallback(previewApplyHandle.id);
  else clearTimeout(previewApplyHandle.id);
  previewApplyHandle = null;
}

function cancelPreviewDOMRender() {
  if (previewDOMHandle !== null) {
    clearTimeout(previewDOMHandle);
    previewDOMHandle = null;
  }
  $('#preview')?.removeAttribute('aria-busy');
}

function setPreviewBusy(busy) {
  $('#preview')?.toggleAttribute('aria-busy', busy);
}

function cancelPendingPreviewRender() {
  previewRenderGeneration++;
  previewRenderRequest = null;
  cancelPreviewCache();
  cancelPreviewDOMRender();
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
  cancelPreviewApply();
}

function schedulePreviewApply(callback) {
  cancelPreviewApply();
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => {
      previewApplyHandle = null;
      callback();
    }, {timeout:200});
    previewApplyHandle = {id, idle:true};
    return;
  }
  const id = setTimeout(() => {
    previewApplyHandle = null;
    callback();
  }, 0);
  previewApplyHandle = {id, idle:false};
}

function previewElementFromHTML(block) {
  if (!block?.html || !block.tagName) return null;
  const template = document.createElement('template');
  template.innerHTML = block.html;
  sanitizePreview(template.content);
  linkifyWikiLinks(template.content);
  if ([...template.content.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) return null;
  const elements = [...template.content.children];
  return elements.length === 1 && elements[0].tagName === block.tagName ? elements[0] : null;
}

function previewTopLevelElement(element) {
  const card = element?.closest?.('.interactive-preview-block-card');
  return card?.parentElement === $('#preview') ? card : element;
}

function syncPreviewAttributes(current, replacement) {
  const preservedAttributes = [...current.attributes]
    .filter(attribute => attribute.name.startsWith('data-interactive-'))
    .map(attribute => [attribute.name, attribute.value]);
  [...current.attributes]
    .filter(attribute => !attribute.name.startsWith('data-interactive-'))
    .forEach(attribute => current.removeAttribute(attribute.name));
  [...replacement.attributes].forEach(attribute => current.setAttribute(attribute.name, attribute.value));
  preservedAttributes.forEach(([name, value]) => current.setAttribute(name, value));
}

function canUpdatePreviewElementInPlace(current, replacement) {
  if (!current || !replacement || current.tagName !== replacement.tagName) return false;
  if (['UL', 'OL'].includes(current.tagName)) {
    const currentItems = [...current.children];
    const replacementItems = [...replacement.children];
    return currentItems.length === replacementItems.length &&
      currentItems.every((item, index) => item.tagName === 'LI' && replacementItems[index]?.tagName === 'LI' &&
        !item.querySelector('ul,ol') && !replacementItems[index].querySelector('ul,ol'));
  }
  return !current.querySelector('ul,ol') && !replacement.querySelector('ul,ol');
}

function updatePreviewElementInPlace(current, replacement) {
  syncPreviewAttributes(current, replacement);
  current.replaceChildren(...[...replacement.childNodes]);
}

function updatePreviewListInPlace(current, replacement) {
  syncPreviewAttributes(current, replacement);
  const currentItems = [...current.children];
  const replacementItems = [...replacement.children];
  currentItems.forEach((item, index) => {
    const replacementItem = replacementItems[index];
    const body = item.querySelector(':scope > .interactive-preview-list-card > .preview-list-content > .preview-list-item-body');
    if (!body) {
      if (item.innerHTML === replacementItem.innerHTML) return;
      updatePreviewElementInPlace(item, replacementItem);
      return;
    }
    if (body.innerHTML === replacementItem.innerHTML) return;
    body.replaceChildren(...[...replacementItem.childNodes]);
    item.querySelector(':scope > .interactive-preview-list-card')?.classList.toggle('is-task', Boolean(body.querySelector('input[type="checkbox"]')));
    syncPreviewTaskCheckbox(item);
  });
  return current;
}

function renderPreviewBlocksProgressively(md, renderMetadata) {
  const preview = $('#preview');
  const generation = previewRenderGeneration;
  const elements = [];
  let index = 0;
  disconnectPreviewDecorationObserver();
  preview.replaceChildren();
  preview.setAttribute('aria-busy', 'true');
  previewBlocks = [];
  previewBlockRanges = [];
  previewRangeSource = null;
  interactiveBlockItems = [];
  interactiveListItems = [];

  const process = () => {
    previewDOMHandle = null;
    if (generation !== previewRenderGeneration || $('#note-content').value !== md || !isPreviewVisible()) {
      preview.removeAttribute('aria-busy');
      return;
    }
    const fragment = document.createDocumentFragment();
    const started = performance.now();
    let batchSize = 0;
    while (index < renderMetadata.blocks.length && batchSize < 12 && performance.now() - started < 5) {
      const element = previewElementFromHTML(renderMetadata.blocks[index++]);
      if (!element) {
        preview.removeAttribute('aria-busy');
        renderPreviewHTML(md, renderMetadata.blocks.map(block => block.html || '').join(''), {...renderMetadata, incrementalSafe:false});
        return;
      }
      elements.push(element);
      fragment.append(element);
      batchSize++;
    }
    preview.append(fragment);
    if (index < renderMetadata.blocks.length) {
      previewDOMHandle = setTimeout(process, 0);
      return;
    }
    preview.removeAttribute('aria-busy');
    renderedPreviewSource = md;
    renderedPreviewMetadata = renderMetadata;
    previewHighlightPending = false;
    cachePreviewBlocks(renderMetadata, elements, {defer:true});
  };
  process();
}

function patchPreviewBlocks(renderMetadata) {
  const previous = renderedPreviewMetadata;
  if (!previous?.incrementalSafe || !renderMetadata?.incrementalSafe || previous.source !== renderedPreviewSource) return null;
  if (!previous.blocks?.every(block => typeof block.html === 'string') || !renderMetadata.blocks?.every(block => typeof block.html === 'string')) return null;

  const preview = $('#preview');
  const current = previewBlocks.filter(element => element?.isConnected);
  if (current.length !== previous.blocks.length) return null;
  let prefix = 0;
  while (prefix < current.length && prefix < renderMetadata.blocks.length &&
    previous.blocks[prefix].tagName === renderMetadata.blocks[prefix].tagName &&
    previous.blocks[prefix].html === renderMetadata.blocks[prefix].html) prefix++;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < renderMetadata.blocks.length - prefix &&
    previous.blocks[previous.blocks.length - suffix - 1].tagName === renderMetadata.blocks[renderMetadata.blocks.length - suffix - 1].tagName &&
    previous.blocks[previous.blocks.length - suffix - 1].html === renderMetadata.blocks[renderMetadata.blocks.length - suffix - 1].html) suffix++;

  const replacements = renderMetadata.blocks
    .slice(prefix, renderMetadata.blocks.length - suffix)
    .map(previewElementFromHTML);
  if (replacements.some(element => !element)) return null;
  const currentMiddle = current.slice(prefix, current.length - suffix);
  if (currentMiddle.length === replacements.length && currentMiddle.every((element, index) => {
    const replacement = replacements[index];
    return canUpdatePreviewElementInPlace(element, replacement);
  })) {
    currentMiddle.forEach((element, index) => {
      const replacement = replacements[index];
      if (['UL', 'OL'].includes(element.tagName)) updatePreviewListInPlace(element, replacement);
      else updatePreviewElementInPlace(element, replacement);
    });
    return current;
  }
  const anchor = suffix ? previewTopLevelElement(current[current.length - suffix]) : null;
  currentMiddle.forEach(element => previewTopLevelElement(element).remove());
  const fragment = document.createDocumentFragment();
  replacements.forEach(element => fragment.append(element));
  preview.insertBefore(fragment, anchor);
  return [
    ...current.slice(0, prefix),
    ...replacements,
    ...(suffix ? current.slice(current.length - suffix) : []),
  ];
}

function renderPreviewHTML(md, html, renderMetadata = null) {
  if (!isPreviewVisible() || $('#note-content').value !== md) return;
  const patchedBlocks = patchPreviewBlocks(renderMetadata);
  if (patchedBlocks === null && renderMetadata?.incrementalSafe && renderMetadata.blocks.length > 80) {
    renderPreviewBlocksProgressively(md, renderMetadata);
    return;
  }
  cancelPreviewDOMRender();
  if (patchedBlocks === null) {
    disconnectPreviewDecorationObserver();
    const fragment = document.createElement('template');
    fragment.innerHTML = typeof html === 'string' ? html : renderMetadata?.blocks?.map(block => block.html || '').join('') || '';
    sanitizePreview(fragment.content);
    linkifyWikiLinks(fragment.content);
    $('#preview').replaceChildren(fragment.content);
  }
  renderedPreviewSource = md;
  cachePreviewBlocks(renderMetadata, patchedBlocks, {defer:Boolean(renderMetadata)});
  renderedPreviewMetadata = renderMetadata?.source === md ? renderMetadata : null;
  previewHighlightPending = false;
  scheduleHighlight();
}

function ensurePreviewRenderWorker() {
  if (previewRenderWorker || previewWorkerUnavailable || typeof Worker !== 'function') return previewRenderWorker;
  try {
    previewRenderWorker = new Worker('/preview-worker.js');
    previewRenderWorker.addEventListener('message', event => {
      const result = event.data || {};
      const request = previewRenderRequest;
      if (!request || result.id !== request.id || result.id !== previewRenderGeneration) return;
      if (request.source !== $('#note-content').value || !isPreviewVisible()) {
        previewRenderRequest = null;
        setPreviewBusy(false);
        return;
      }
      previewRenderRequest = null;
      const incrementalSafe = Boolean(result.incrementalSafe && Array.isArray(result.blocks));
      const html = incrementalSafe ? null : result.html;
      if (result.error || !incrementalSafe && typeof html !== 'string') {
        previewWorkerUnavailable = true;
        previewRenderWorker?.terminate();
        previewRenderWorker = null;
        schedulePreviewApply(() => updatePreview());
        return;
      }
      const metadata = {source:request.source, blocks:result.blocks, incrementalSafe};
      if (request.source === renderedPreviewSource && previewRangeSource === request.source) {
        renderedPreviewMetadata = metadata;
        setPreviewBusy(false);
        return;
      }
      schedulePreviewApply(() => {
        if (result.id !== previewRenderGeneration) return;
        renderPreviewHTML(request.source, html, metadata);
      });
    });
    previewRenderWorker.addEventListener('error', () => {
      const generation = previewRenderGeneration;
      previewWorkerUnavailable = true;
      previewRenderWorker?.terminate();
      previewRenderWorker = null;
      schedulePreviewApply(() => {
        if (generation === previewRenderGeneration) updatePreview();
      });
    });
  } catch (_) {
    previewWorkerUnavailable = true;
    previewRenderWorker = null;
  }
  return previewRenderWorker;
}

function primePreviewMetadata(md) {
  const worker = ensurePreviewRenderWorker();
  if (!worker || !md) return;
  const id = ++previewRenderGeneration;
  previewRenderRequest = {id, source:md};
  worker.postMessage({id, source:md});
}

function requestPreviewRender({announceBusy = false} = {}) {
  previewTimer = null;
  if (!isPreviewVisible()) return;
  const md = $('#note-content').value;
  if (md === renderedPreviewSource) {
    setPreviewBusy(false);
    scheduleHighlight();
    return;
  }
  const worker = ensurePreviewRenderWorker();
  if (!worker) {
    updatePreview();
    return;
  }
  if (announceBusy) setPreviewBusy(true);
  if (previewRenderRequest?.source === md) return;
  const id = ++previewRenderGeneration;
  previewRenderRequest = {id, source:md};
  worker.postMessage({id, source:md});
}

function updatePreview() {
  if (!isPreviewVisible()) return;
  const md = $('#note-content').value;
  if (md === renderedPreviewSource) {
    scheduleHighlight();
    return;
  }
  cancelPendingPreviewRender();
  if (typeof marked !== 'undefined' && marked.parse) {
    renderPreviewHTML(md, marked.parse(md, markdownRenderOptions()));
    primePreviewMetadata(md);
  } else {
    $('#preview').innerHTML = '<p><em>loading parser...</em></p>';
    renderedPreviewSource = md;
    previewHighlightPending = false;
  }
}

// --- Utils ---
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

// --- Theme and appearance ---
const themeDefinitions = Array.isArray(window.VylkThemes) ? window.VylkThemes : [];
const themeByID = new Map(themeDefinitions.map(theme => [theme.id, theme]));

function kebabCase(value) {
  return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function validAccentColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '';
}

function validFontValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return Boolean(normalized) && normalized.length <= 120 && !/[\u0000-\u001f\u007f"\\;,]/.test(normalized);
}

function normalizeFontValue(value, key) {
  if (value === 'system') return ['editorFontFamily', 'zenFontFamily'].includes(key) ? 'system-monospace' : 'system-sans';
  return validFontValue(value) ? value.trim() : DEFAULT_PREFS[key];
}

function validFontSizeValue(value) {
  if (typeof value !== 'string') return false;
  return FONT_SIZE_VALUES.includes(value.trim());
}

function normalizeFontSizeValue(value, key) {
  return validFontSizeValue(value) ? value.trim() : DEFAULT_PREFS[key];
}

function legacyThemeID() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') return 'default-dark';
  if (saved === 'light') return 'default-light';
  return window.matchMedia('(prefers-color-scheme:dark)').matches ? 'default-dark' : 'default-light';
}

function normalizeShortcutOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(0, 64).flatMap(([id, binding]) => {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(id)) return [];
    if (binding === null) return [[id, null]];
    const normalized = window.VylkShortcuts?.normalizeBinding(binding);
    return normalized ? [[id, normalized]] : [];
  });
  return Object.fromEntries(entries);
}

function normalizeShortcutPrefix(value) {
  const binding = window.VylkShortcuts?.normalizeBinding(value);
  if (!window.VylkShortcuts?.isAllowedPrefix(binding)) return {steps:[{key:'/', modifiers:['Mod']}]};
  return binding;
}

function normalizeShortcutConfirmationSkips(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 64).filter(([id, skip]) => /^[a-z][a-z0-9.-]{0,63}$/.test(id) && skip === true));
}

function normalizePrefs(value = {}, fallback = {}) {
  const merged = {...DEFAULT_PREFS, ...fallback, ...value};
  merged.revision = Number.isSafeInteger(Number(merged.revision)) && Number(merged.revision) > 0 ? Number(merged.revision) : 1;
  if (!['normal', 'compact', 'off'].includes(merged.statusDisplay)) merged.statusDisplay = DEFAULT_PREFS.statusDisplay;
  if (!CONTENT_WIDTH_VALUES.includes(merged.contentWidth)) merged.contentWidth = DEFAULT_PREFS.contentWidth;
  const savedStartView = value.startView ?? fallback.startView;
  if (['editor', 'preview', 'split', 'zen'].includes(savedStartView)) merged.startView = savedStartView;
  else merged.startView = (value.hidePreview ?? fallback.hidePreview) ? 'editor' : DEFAULT_PREFS.startView;
  if (!['panel', 'header'].includes(merged.saveButtonLocation)) merged.saveButtonLocation = DEFAULT_PREFS.saveButtonLocation;
  if (!value.theme && !fallback.theme) merged.theme = legacyThemeID();
  if (!themeByID.has(merged.theme)) merged.theme = legacyThemeID();
  if (!validAccentColor(merged.accentColor)) merged.accentColor = '';
  ['fontFamily', 'editorFontFamily', 'previewFontFamily', 'zenFontFamily'].forEach(key => {
    merged[key] = normalizeFontValue(merged[key], key);
  });
  ['fontSize', 'editorFontSize', 'previewFontSize', 'zenFontSize'].forEach(key => {
    merged[key] = normalizeFontSizeValue(merged[key], key);
  });
  merged.shortcutPrefix = normalizeShortcutPrefix(merged.shortcutPrefix);
  merged.keyboardShortcuts = normalizeShortcutOverrides(merged.keyboardShortcuts);
  merged.shortcutConfirmationSkips = normalizeShortcutConfirmationSkips(merged.shortcutConfirmationSkips);
  merged.zenWordCount = Boolean(merged.zenWordCount);
  merged.zenShowTitle = Boolean(merged.zenShowTitle);
  merged.zenShowControls = Boolean(merged.zenShowControls);
  merged.zenInteractivePreview = Boolean(merged.zenInteractivePreview);
  delete merged.hidePreview;
  delete merged.hideHeaderOnFullscreen;
  return merged;
}

function applyTheme(themeID = prefs.theme) {
  const theme = themeByID.get(themeID) || themeByID.get('default-light');
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle('dark', Boolean(theme.dark));
  Object.entries(theme.vars).forEach(([name, value]) => root.style.setProperty(`--${kebabCase(name)}`, value));
  if (prefs.accentColor) {
    root.style.setProperty('--accent', prefs.accentColor);
    root.style.setProperty('--accent-hover', 'color-mix(in srgb,var(--accent) 82%,#000)');
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.vars.bg);
}

function fontCSSURL(fontFamily) {
  const family = encodeURIComponent(fontFamily).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
}

function isSystemFont(fontFamily) {
  return ['system-sans', 'system-serif', 'system-monospace'].includes(fontFamily);
}

function systemFontStack(fontFamily) {
  if (fontFamily === 'system-serif') return SYSTEM_SERIF_STACK;
  if (fontFamily === 'system-monospace') return SYSTEM_MONO_STACK;
  return SYSTEM_FONT_STACK;
}

async function clearFontCache() {
  if ('caches' in window) await caches.delete(FONT_CACHE_NAME).catch(() => {});
}

const FONT_SLOTS = [
  {preference:'fontFamily', fetchPreference:'fontFamilyGoogle', sizePreference:'fontSize', variable:'--font', sizeVariable:'--font-size', input:'#pref-font', sizeInput:'#pref-font-size', fetch:'#pref-font-google', error:'#pref-font-error', fallback:SYSTEM_FONT_STACK},
  {preference:'editorFontFamily', fetchPreference:'editorFontFamilyGoogle', sizePreference:'editorFontSize', variable:'--editor-font', sizeVariable:'--editor-font-size', input:'#pref-editor-font', sizeInput:'#pref-editor-font-size', fetch:'#pref-editor-font-google', error:'#pref-editor-font-error', fallback:SYSTEM_MONO_STACK},
  {preference:'previewFontFamily', fetchPreference:'previewFontFamilyGoogle', sizePreference:'previewFontSize', variable:'--preview-font', sizeVariable:'--preview-font-size', input:'#pref-preview-font', sizeInput:'#pref-preview-font-size', fetch:'#pref-preview-font-google', error:'#pref-preview-font-error', fallback:SYSTEM_FONT_STACK},
  {preference:'zenFontFamily', fetchPreference:'zenFontFamilyGoogle', sizePreference:'zenFontSize', variable:'--zen-font', sizeVariable:'--zen-font-size', input:'#pref-zen-font', sizeInput:'#pref-zen-font-size', fetch:'#pref-zen-font-google', error:'#pref-zen-font-error', fallback:SYSTEM_MONO_STACK},
];

function fontCSSValue(fontFamily, fallback) {
  if (isSystemFont(fontFamily)) return systemFontStack(fontFamily);
  return `"${fontFamily}",${fallback}`;
}

function setFontError(slot, message = '') {
  const error = $(slot.error);
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
  const input = $(slot.input);
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function shouldFetchGoogleFont(slot) {
  return prefs[slot.fetchPreference] === true;
}

function removeLoadedFonts() {
  document.querySelectorAll('[data-vylk-font]').forEach(link => link.remove());
  FONT_SLOTS.forEach(slot => {
    document.documentElement.style.setProperty(slot.variable, fontCSSValue(prefs[slot.preference], slot.fallback));
    if (validFontValue($(slot.input)?.value)) setFontError(slot);
  });
}

async function applyFontsNow(clearCache = false) {
  const generation = ++fontLoadGeneration;
  if (clearCache) await clearFontCache();
  removeLoadedFonts();
  const families = [...new Set(FONT_SLOTS.filter(shouldFetchGoogleFont).map(slot => prefs[slot.preference]).filter(font => font && !isSystemFont(font)))];
  const loaded = new Map();
  const failed = new Set();
  await Promise.all(families.map(async fontFamily => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.vylkFont = fontFamily;
    link.href = fontCSSURL(fontFamily);
    document.head.append(link);
    try {
      await new Promise((resolve, reject) => {
        link.addEventListener('load', resolve, {once:true});
        link.addEventListener('error', reject, {once:true});
        setTimeout(() => reject(new Error('font load timed out')), 5000);
      });
      const loadedFaces = await document.fonts.load(`1rem "${fontFamily}"`);
      if (!loadedFaces || loadedFaces.length === 0) throw new Error('font face unavailable');
      loaded.set(fontFamily, true);
    } catch (error) {
      link.remove();
      failed.add(fontFamily);
      console.warn(`font unavailable: ${fontFamily}`, error);
    }
  }));
  if (generation !== fontLoadGeneration) return;
  FONT_SLOTS.forEach(slot => {
    const fontFamily = prefs[slot.preference];
    document.documentElement.style.setProperty(slot.variable, fontCSSValue(fontFamily, slot.fallback));
    if (shouldFetchGoogleFont(slot) && !isSystemFont(fontFamily) && failed.has(fontFamily) && !loaded.has(fontFamily)) setFontError(slot, 'Font not available from Google Fonts.');
  });
  scheduleEditorCaretCue();
}

function applyFonts(clearCache = false) {
  const run = fontApplyQueue.then(() => applyFontsNow(clearCache));
  fontApplyQueue = run.catch(() => {});
  return run;
}

function applyFontSizes() {
  FONT_SLOTS.forEach(slot => {
    document.documentElement.style.setProperty(slot.sizeVariable, prefs[slot.sizePreference]);
  });
  scheduleEditorCaretCue();
}

function renderThemeOptions() {
  const select = $('#pref-theme');
  select.innerHTML = themeDefinitions.map(theme => `<option value="${esc(theme.id)}">${esc(theme.name)}</option>`).join('');
}

function renderFontOptions() {
  FONT_SLOTS.forEach(slot => {
    const input = $(slot.input);
    if (input) input.value = prefs[slot.preference];
    const sizeSelect = $(slot.sizeInput);
    if (sizeSelect) {
      sizeSelect.innerHTML = FONT_SIZE_OPTIONS.map(option => `<option value="${option.value}">${option.label}</option>`).join('');
      sizeSelect.value = prefs[slot.sizePreference];
    }
    const fetchToggle = slot.fetch ? $(slot.fetch) : null;
    if (fetchToggle) fetchToggle.checked = Boolean(prefs[slot.fetchPreference]);
  });
}

function applyPrefs() {
  applyTheme(prefs.theme);
  void applyFonts();
  applyFontSizes();
  renderFontOptions();
  applyContentWidth();
  applyEditorPrefs();
}

renderThemeOptions();
renderFontOptions();
applyPrefs();

// Apply cached preferences immediately, then the server's preferences later.
try {
  const cached = JSON.parse(localStorage.getItem('vylk-prefs') || '{}');
  prefs = normalizePrefs(cached);
  applyPrefs();
} catch (_) {
  prefs = normalizePrefs();
  applyPrefs();
}

function openPreferences({route = 'push'} = {}) {
  $('#pref-autosave').checked = prefs.autoSave;
  $('#pref-start-view').value = prefs.startView;
  $('#pref-hidetoolbar').checked = !prefs.hideToolbar;
  updateManualSavePreferenceControl();
  $('#pref-save-location').value = prefs.saveButtonLocation;
  $('#pref-collapse').checked = prefs.collapseDetails;
  $('#pref-hidecursor').checked = prefs.hideCursorHighlight;
  $('#pref-interactive-preview').checked = prefs.interactivePreview;
  $('#pref-status').value = prefs.statusDisplay;
  $('#pref-content-width').value = prefs.contentWidth;
  $('#pref-theme').value = prefs.theme;
  $('#pref-accent').value = prefs.accentColor || themeByID.get(prefs.theme)?.vars.accent || '#ae2448';
  $('#pref-accent-mode').value = prefs.accentColor ? 'custom' : 'theme';
  $('#pref-accent').hidden = !prefs.accentColor;
  $('#pref-zen-word-count').checked = prefs.zenWordCount;
  $('#pref-zen-show-title').checked = prefs.zenShowTitle;
  $('#pref-zen-show-controls').checked = prefs.zenShowControls;
  $('#pref-zen-interactive-preview').checked = prefs.zenInteractivePreview;
  renderFontOptions();
  renderShortcutPreferences();
  if (route === 'push') setPreferencesRoute();
  openModal($('#prefs-modal'));
}

$('#prefs-btn').addEventListener('click', openPreferences);
$('#editor-prefs-btn').addEventListener('click', openPreferences);

$('#prefs-close').addEventListener('click', closePreferences);

$('#prefs-modal .modal-backdrop').addEventListener('click', closePreferences);

async function savePref(key, value) {
  const previous = {...prefs};
  prefs = normalizePrefs({...prefs, [key]: value});
  localStorage.setItem('vylk-prefs', JSON.stringify(prefs));
  await queueOperation({
    type: 'prefs.save',
    note_id: '__prefs__',
    base_revision: previous.revision || 1,
    prefs: {
      ...prefs,
      _sync_patch: {[key]: prefs[key]},
      _sync_base: {[key]: previous[key]},
    },
  });
  if (key === 'theme' || key === 'accentColor') applyTheme(prefs.theme);
  if (['fontFamily', 'fontFamilyGoogle', 'editorFontFamily', 'editorFontFamilyGoogle', 'previewFontFamily', 'previewFontFamilyGoogle', 'zenFontFamily', 'zenFontFamilyGoogle'].includes(key)) void applyFonts(true);
  applyFontSizes();
  applyContentWidth();
  applyEditorPrefs();
  if (key === 'autoSave' || key === 'hideSaveButton') updateManualSavePreferenceControl();
  if (key === 'shortcutPrefix' || key === 'keyboardShortcuts' || key === 'shortcutConfirmationSkips') renderShortcutPreferences();
  scheduleSync();
}

function updateManualSavePreferenceControl() {
  const control = $('#pref-hidesave');
  const copy = $('#pref-manual-save-copy');
  if (!control || !copy) return;
  control.checked = prefs.autoSave ? !prefs.hideSaveButton : true;
  control.disabled = !prefs.autoSave;
  copy.textContent = prefs.autoSave
    ? 'Show a control for syncing changes now.'
    : 'Manual Save stays available while automatic sync is off.';
}

$('#pref-autosave').addEventListener('change', function () {
  void savePref('autoSave', this.checked).then(updateManualSavePreferenceControl);
});
$('#pref-start-view').addEventListener('change', function () { void savePref('startView', this.value); });
$('#pref-hidetoolbar').addEventListener('change', function () {
  savePref('hideToolbar', !this.checked);
});
$('#pref-hidesave').addEventListener('change', function () {
  savePref('hideSaveButton', !this.checked);
});
$('#pref-save-location').addEventListener('change', function () { void savePref('saveButtonLocation', this.value); });
$('#pref-collapse').addEventListener('change', function () {
  savePref('collapseDetails', this.checked);
});
$('#pref-hidecursor').addEventListener('change', function () {
  savePref('hideCursorHighlight', this.checked);
});
$('#pref-interactive-preview').addEventListener('change', function () {
  savePref('interactivePreview', this.checked);
});
$('#pref-zen-word-count').addEventListener('change', function () { void savePref('zenWordCount', this.checked); });
$('#pref-zen-show-title').addEventListener('change', function () { void savePref('zenShowTitle', this.checked); });
$('#pref-zen-show-controls').addEventListener('change', function () { void savePref('zenShowControls', this.checked); });
$('#pref-zen-interactive-preview').addEventListener('change', function () { void savePref('zenInteractivePreview', this.checked); });
$('#pref-theme').addEventListener('change', function () { void savePref('theme', this.value); });
$('#pref-accent').addEventListener('change', function () { void savePref('accentColor', this.value); });
$('#pref-accent-mode').addEventListener('change', function () {
  if (this.value === 'theme') {
    void savePref('accentColor', '');
    $('#pref-accent').hidden = true;
    return;
  }
  const color = $('#pref-accent');
  color.hidden = false;
  void savePref('accentColor', color.value);
});
FONT_SLOTS.forEach(slot => {
  const input = $(slot.input);
  input.addEventListener('input', function () {
    if (!$(slot.error)?.hidden) setFontError(slot, validFontValue(this.value) ? '' : 'Enter a valid font name without quotes, backslashes, semicolons, or commas.');
  });
  input.addEventListener('change', function () {
    if (!validFontValue(this.value)) {
      setFontError(slot, 'Enter a valid font name without quotes, backslashes, semicolons, or commas.');
      return;
    }
    this.value = this.value.trim();
    setFontError(slot);
    void savePref(slot.preference, this.value);
  });
  const fetchToggle = slot.fetch ? $(slot.fetch) : null;
  fetchToggle?.addEventListener('change', function () {
    void savePref(slot.fetchPreference, this.checked);
  });
  const sizeSelect = $(slot.sizeInput);
  sizeSelect.addEventListener('change', function () {
    void savePref(slot.sizePreference, this.value);
  });
});
$('#pref-status').addEventListener('change', function () { void savePref('statusDisplay', this.value); });
$('#pref-content-width').addEventListener('change', function () { void savePref('contentWidth', this.value); });

$$('.prefs-nav').forEach(button => button.addEventListener('click', () => {
  const section = button.dataset.prefSection;
  $$('.prefs-nav').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
    item.tabIndex = active ? 0 : -1;
  });
  $$('.prefs-section').forEach(panel => {
    const active = panel.dataset.prefPanel === section;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  $('#prefs-title').textContent = button.textContent;
}));

$$('.prefs-nav').forEach(button => button.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...$$('.prefs-nav')];
  const current = tabs.indexOf(button);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}));

async function loadPrefs() {
  let p = null;
  try {
    p = await api('/api/prefs');
  } catch (error) {
    console.warn('preferences unavailable; using cached preferences', error);
  }
  if (p && !await hasPendingOperation('__prefs__')) {
    let cached = {};
    try { cached = JSON.parse(localStorage.getItem('vylk-prefs') || '{}'); } catch (_) {}
    prefs = normalizePrefs(p, cached);
    localStorage.setItem('vylk-prefs', JSON.stringify(prefs));
    applyPrefs();
    renderShortcutPreferences();
    return;
  }
  try {
    const cached = localStorage.getItem('vylk-prefs');
    if (cached) prefs = normalizePrefs(JSON.parse(cached));
  } catch (_) {}
  applyPrefs();
  renderShortcutPreferences();
}

// --- Commands and keyboard shortcuts ---
const directShortcut = (key, shift = false) => ({steps:[{key, modifiers:shift ? ['Mod', 'Shift'] : ['Mod']}]});
const sequenceShortcut = key => ({steps:[{key:'/', modifiers:['Mod']}, {key, modifiers:[]}]});
const shortcutCommands = [];
const shortcutCommandsByID = new Map();

function registerShortcutCommand(command) {
  shortcutCommands.push(command);
  shortcutCommandsByID.set(command.id, command);
}

function editorIsVisible() {
  return !screens.editor.classList.contains('hidden');
}

function setDetailsExpanded(expanded) {
  $('.meta-pane').classList.toggle('collapsed', !expanded);
  $('.meta-toggle').setAttribute('aria-expanded', String(expanded));
}

function focusPreview() {
  $('#preview').focus({preventScroll:true});
}

function focusSourceEditor() {
  if (panelState === 'zen' && zenViewState === 'preview') {
    zenViewState = 'editor';
    setPanelState('zen');
  } else if (panelState === 'preview') setPanelState('editor');
  $('#note-content').focus({preventScroll:true});
}

function setWritingView(view) {
  if (panelState === 'zen') {
    zenViewState = view;
    setPanelState('zen');
    if (view === 'preview') focusPreview();
    else $('#note-content').focus({preventScroll:true});
    return;
  }
  setPanelState(view);
  if (view === 'preview') focusPreview();
  else $('#note-content').focus({preventScroll:true});
}

function switchEditorPreview() {
  if (panelState === 'zen') {
    zenViewState = zenViewState === 'preview' ? 'editor' : 'preview';
    setPanelState('zen');
    if (zenViewState === 'preview') focusPreview();
    else $('#note-content').focus({preventScroll:true});
    return;
  }
  if (panelState === 'editor') {
    setPanelState('preview');
    focusPreview();
    return;
  }
  if (panelState === 'preview') {
    setPanelState('editor');
    $('#note-content').focus({preventScroll:true});
    return;
  }
  if (document.activeElement?.closest?.('#preview-panel')) $('#note-content').focus({preventScroll:true});
  else focusPreview();
}

async function createNewNoteFromShortcut() {
  if (!editorIsVisible()) {
    startNewNote();
    return;
  }
  if (prefs.shortcutConfirmationSkips['note.new']) {
    const saved = await saveCurrentNote(false);
    if (saved) startNewNote();
    return;
  }
  $('#shortcut-confirm-skip').checked = false;
  openModal($('#shortcut-confirm-modal'));
  $('#shortcut-confirm-continue').focus();
}

registerShortcutCommand({id:'note.new', group:'General', label:'New note', description:'Create a new blank note.', defaultBinding:sequenceShortcut('n'), scope:'global', intrusive:true, run:createNewNoteFromShortcut});
registerShortcutCommand({id:'note.save', group:'General', label:'Save note', description:'Save the current note now.', defaultBinding:directShortcut('s'), scope:'editor', run:() => { if (saveTimer) clearTimeout(saveTimer); return saveCurrentNote(); }});
registerShortcutCommand({id:'preferences.open', group:'General', label:'Open preferences', description:'Open application preferences.', defaultBinding:sequenceShortcut('p'), scope:'global', run:() => openPreferences()});
registerShortcutCommand({id:'editor.title', group:'Editor', label:'Edit title', description:'Show Details and replace the title.', defaultBinding:sequenceShortcut('t'), scope:'editor', run:() => { setDetailsExpanded(true); $('#note-title').focus({preventScroll:true}); $('#note-title').select(); }});
registerShortcutCommand({id:'editor.tags', group:'Editor', label:'Edit tags', description:'Show Details and add or change tags.', defaultBinding:sequenceShortcut('g'), scope:'editor', run:() => { setDetailsExpanded(true); const tags = $('#note-tags'); tags.focus({preventScroll:true}); tags.selectionStart = tags.selectionEnd = tags.value.length; }});
registerShortcutCommand({id:'editor.focus', group:'Editor', label:'Focus editor', description:'Move focus to the Markdown editor.', defaultBinding:sequenceShortcut('e'), scope:'editor', run:focusSourceEditor});
registerShortcutCommand({id:'view.write', group:'View', label:'Write view', description:'Show only the Markdown editor.', defaultBinding:sequenceShortcut('1'), scope:'editor', run:() => setWritingView('editor')});
registerShortcutCommand({id:'view.preview', group:'View', label:'Preview view', description:'Show only the rendered preview.', defaultBinding:sequenceShortcut('2'), scope:'editor', run:() => setWritingView('preview')});
registerShortcutCommand({id:'view.split', group:'View', label:'Split view', description:'Show editor and preview together.', defaultBinding:sequenceShortcut('3'), scope:'editor', run:() => { setPanelState('both'); $('#note-content').focus({preventScroll:true}); }});
registerShortcutCommand({id:'view.zen', group:'View', label:'Zen mode', description:'Write without app chrome. Press Escape to return.', scope:'editor', run:() => { setPanelState('zen'); $('#note-content').focus({preventScroll:true}); }});
registerShortcutCommand({id:'view.switch', group:'View', label:'Switch editor and preview', description:'Move to the other pane.', defaultBinding:sequenceShortcut('4'), scope:'editor', run:switchEditorPreview});
[
  ['format.bold', 'Bold', 'Make selected text bold.', 'bold', directShortcut('b')],
  ['format.italic', 'Italic', 'Make selected text italic.', 'italic', directShortcut('i')],
  ['format.strike', 'Strikethrough', 'Strike through selected text.', 'strike'],
  ['format.code', 'Inline code', 'Format selected text as code.', 'code'],
  ['format.link', 'Link', 'Insert or format a link.', 'link'],
  ['format.ul', 'Bulleted list', 'Turn text into a bulleted list.', 'ul'],
  ['format.ol', 'Numbered list', 'Turn text into a numbered list.', 'ol'],
  ['format.task', 'Task list', 'Turn text into a task list.', 'task'],
  ['format.blockquote', 'Blockquote', 'Turn text into a quote.', 'blockquote'],
].forEach(([id, label, description, format, defaultBinding = null]) => {
  registerShortcutCommand({id, group:'Formatting', label, description, defaultBinding, scope:'source', run:() => insertFmt(format)});
});

function shortcutPrefixBinding() {
  return prefs.shortcutPrefix;
}

function materializeShortcutBinding(binding) {
  if (!binding || binding.steps.length !== 2) return binding;
  return {steps:[shortcutPrefixBinding().steps[0], binding.steps[1]]};
}

function shortcutBindingFor(command) {
  const binding = Object.hasOwn(prefs.keyboardShortcuts, command.id) ? prefs.keyboardShortcuts[command.id] : command.defaultBinding || null;
  return materializeShortcutBinding(binding);
}

function shortcutPreferenceLabel(binding) {
  if (!binding) return 'Not set';
  if (binding.steps.length === 2) return `Prefix, ${binding.steps[1].key.toUpperCase()}`;
  return window.VylkShortcuts.displayBinding(binding);
}

function commandCanRun(command) {
  if (command.scope === 'global') return !screens.dashboard.classList.contains('hidden') || editorIsVisible();
  if (command.scope === 'editor') return editorIsVisible();
  return editorIsVisible() && !interactiveSourceLocked;
}

function commandForBinding(binding, {sequence = false} = {}) {
  return shortcutCommands.find(command => {
    const current = shortcutBindingFor(command);
    return current && current.steps.length === (sequence ? 2 : 1) && window.VylkShortcuts.sameBinding(current, binding);
  });
}

function updateShortcutAffordances() {
  shortcutCommands.forEach(command => {
    const binding = shortcutBindingFor(command);
    const aria = binding ? window.VylkShortcuts.ariaBinding(binding) : '';
    const suffix = binding ? ` (${window.VylkShortcuts.displayBinding(binding)})` : '';
    const selector = command.id === 'note.save' ? '#save-btn'
      : command.id.startsWith('view.') ? `.view-control[data-panel="${command.id === 'view.write' ? 'editor' : command.id === 'view.split' ? 'both' : command.id === 'view.preview' ? 'preview' : ''}"]`
        : command.id.startsWith('format.') ? `.fmt-bar [data-fmt="${command.id.slice('format.'.length)}"]` : '';
    if (!selector) return;
    $$(selector).forEach(button => {
      button.title = `${command.label}${suffix}`;
      if (aria) button.setAttribute('aria-keyshortcuts', aria);
      else button.removeAttribute('aria-keyshortcuts');
    });
  });
}

function renderShortcutPreferences() {
  const prefix = $('#shortcut-prefix');
  if (prefix) {
    const recording = activeShortcutRecording?.type === 'prefix';
    prefix.classList.toggle('is-recording', recording);
    prefix.textContent = recording ? 'Press prefix…' : window.VylkShortcuts.displayBinding(shortcutPrefixBinding());
    prefix.setAttribute('aria-label', recording ? 'Recording shortcut prefix' : `Record shortcut prefix, currently ${window.VylkShortcuts.ariaBinding(shortcutPrefixBinding())}`);
  }
  const groups = $('#shortcut-groups');
  if (!groups) return;
  groups.replaceChildren();
  const byGroup = new Map();
  shortcutCommands.forEach(command => {
    if (!byGroup.has(command.group)) byGroup.set(command.group, []);
    byGroup.get(command.group).push(command);
  });
  byGroup.forEach((commands, group) => {
    const section = document.createElement('section');
    section.className = 'shortcut-group';
    const title = document.createElement('h3');
    title.className = 'shortcut-group-title';
    title.textContent = group;
    section.append(title);
    commands.forEach(command => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const copy = document.createElement('span');
      copy.className = 'shortcut-copy';
      copy.innerHTML = `<strong>${esc(command.label)}</strong><small>${esc(command.description)}</small>`;
      const actions = document.createElement('div');
      actions.className = 'shortcut-row-actions';
      actions.setAttribute('role', 'group');
      actions.setAttribute('aria-label', `Shortcut controls for ${command.label}`);
      const record = document.createElement('button');
      record.type = 'button';
      record.className = 'shortcut-binding';
      record.dataset.shortcutCommand = command.id;
      const binding = shortcutBindingFor(command);
      const recording = activeShortcutRecording?.type === 'command' && activeShortcutRecording.id === command.id;
      record.textContent = recording ? (activeShortcutRecording.awaitingSequenceKey ? 'Prefix,' : 'Press shortcut…') : shortcutPreferenceLabel(binding);
      record.setAttribute('aria-label', `Record shortcut for ${command.label}. Press Backspace or Delete to clear it.`);
      actions.append(record);
      row.append(copy, actions);
      section.append(row);
    });
    groups.append(section);
  });
  updateShortcutAffordances();
}

function setShortcutRecorderStatus(message = '', error = false) {
  const status = $('#shortcut-recorder-status');
  status.textContent = message;
  status.classList.toggle('is-error', error);
}

function stopShortcutRecording({render = true} = {}) {
  activeShortcutRecording = null;
  if (render) renderShortcutPreferences();
}

function shortcutBindingConflict(commandID, binding) {
  return shortcutCommands.find(command => command.id !== commandID && window.VylkShortcuts.sameBinding(shortcutBindingFor(command), binding));
}

async function setShortcutOverride(commandID, binding) {
  const command = shortcutCommandsByID.get(commandID);
  if (!command) return;
  const next = {...prefs.keyboardShortcuts};
  const defaultBinding = materializeShortcutBinding(command.defaultBinding);
  if (binding && defaultBinding && window.VylkShortcuts.sameBinding(binding, defaultBinding)) delete next[commandID];
  else next[commandID] = binding;
  const saved = savePref('keyboardShortcuts', next);
  renderShortcutPreferences();
  await saved;
}

function startShortcutRecording(commandID) {
  const command = shortcutCommandsByID.get(commandID);
  if (!command) return;
  activeShortcutRecording = {type:'command', id:commandID, awaitingSequenceKey:false};
  setShortcutRecorderStatus('Press a shortcut, or press Prefix then a key for a sequence. Press Escape to cancel.');
  renderShortcutPreferences();
}

function startShortcutPrefixRecording() {
  activeShortcutRecording = {type:'prefix'};
  setShortcutRecorderStatus('Press Ctrl/Command and a key. Press Escape to cancel.');
  renderShortcutPreferences();
}

function startShortcutSequence() {
  pendingShortcutSequence = {};
  const hint = $('#shortcut-sequence-hint');
  const available = shortcutCommands.filter(item => commandCanRun(item) && shortcutBindingFor(item)?.steps.length === 2);
  const title = document.createElement('strong');
  title.className = 'shortcut-sequence-title';
  title.textContent = 'Keyboard shortcuts';
  const subtitle = document.createElement('span');
  subtitle.className = 'shortcut-sequence-subtitle';
  subtitle.textContent = 'Choose a key, or press Escape to cancel.';
  const options = document.createElement('div');
  options.className = 'shortcut-sequence-options';
  available.forEach(command => {
    const option = document.createElement('span');
    option.className = 'shortcut-sequence-option';
    const key = document.createElement('kbd');
    key.textContent = shortcutBindingFor(command).steps[1].key.toUpperCase();
    const label = document.createElement('span');
    label.textContent = command.label;
    option.append(key, label);
    options.append(option);
  });
  hint.replaceChildren(title, subtitle, options);
  hint.classList.remove('hidden');
}

function cancelShortcutSequence() {
  pendingShortcutSequence = null;
  $('#shortcut-sequence-hint')?.classList.add('hidden');
}

async function executeShortcutCommand(commandID, {source = 'shortcut'} = {}) {
  const command = shortcutCommandsByID.get(commandID);
  if (!command || !commandCanRun(command)) return false;
  if (command.intrusive && source === 'shortcut') {
    await createNewNoteFromShortcut();
    return true;
  }
  await command.run();
  return true;
}

function hasOpenModal() {
  return [...$$('.modal')].some(modal => !modal.classList.contains('hidden'));
}

document.addEventListener('keydown', event => {
  if (activeShortcutRecording) {
    if (event.key === 'Escape') {
      event.preventDefault();
      stopShortcutRecording();
      setShortcutRecorderStatus('Shortcut recording cancelled.');
      return;
    }
    if (activeShortcutRecording.type === 'command' && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault();
      const id = activeShortcutRecording.id;
      stopShortcutRecording({render:false});
      void setShortcutOverride(id, null);
      setShortcutRecorderStatus('Shortcut cleared.');
      return;
    }
    if (activeShortcutRecording.type === 'prefix') {
      const binding = window.VylkShortcuts.bindingFromEvent(event);
      if (!binding) return;
      event.preventDefault();
      if (!window.VylkShortcuts.isAllowedPrefix(binding)) {
        setShortcutRecorderStatus('Use Ctrl/Command and a supported key for the prefix.', true);
        return;
      }
      const conflict = shortcutBindingConflict(null, binding);
      if (conflict) {
        setShortcutRecorderStatus(`Already used by ${conflict.label}.`, true);
        return;
      }
      stopShortcutRecording({render:false});
      void savePref('shortcutPrefix', binding);
      setShortcutRecorderStatus('Prefix updated.');
      return;
    }
    if (activeShortcutRecording.awaitingSequenceKey) {
      const second = window.VylkShortcuts.capturedSequenceStep(event);
      if (!second) return;
      event.preventDefault();
      const binding = {steps:[shortcutPrefixBinding().steps[0], second]};
      const conflict = shortcutBindingConflict(activeShortcutRecording.id, binding);
      if (conflict) {
        setShortcutRecorderStatus(`Already used by ${conflict.label}.`, true);
        stopShortcutRecording({render:true});
        return;
      }
      const id = activeShortcutRecording.id;
      stopShortcutRecording({render:false});
      void setShortcutOverride(id, binding);
      setShortcutRecorderStatus('Shortcut updated.');
      return;
    }
    const binding = window.VylkShortcuts.bindingFromEvent(event);
    if (!binding) return;
    event.preventDefault();
    if (window.VylkShortcuts.sameBinding(binding, shortcutPrefixBinding())) {
      activeShortcutRecording.awaitingSequenceKey = true;
      setShortcutRecorderStatus('Prefix registered. Press the next key, or Escape to cancel.');
      renderShortcutPreferences();
      return;
    }
    if (window.VylkShortcuts.isReservedBinding(binding)) {
      setShortcutRecorderStatus('That shortcut belongs to your browser or operating system.', true);
      return;
    }
    const conflict = shortcutBindingConflict(activeShortcutRecording.id, binding);
    if (conflict) {
      setShortcutRecorderStatus(`Already used by ${conflict.label}.`, true);
      return;
    }
    const id = activeShortcutRecording.id;
    stopShortcutRecording({render:false});
    void setShortcutOverride(id, binding);
    setShortcutRecorderStatus('Shortcut updated.');
    return;
  }
  if (pendingShortcutSequence) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelShortcutSequence();
      return;
    }
    const second = window.VylkShortcuts.capturedSequenceStep(event);
    if (!second) return;
    const binding = {steps:[shortcutPrefixBinding().steps[0], second]};
    const command = commandForBinding(binding, {sequence:true});
    cancelShortcutSequence();
    if (!command || !commandCanRun(command)) return;
    event.preventDefault();
    void executeShortcutCommand(command.id);
    return;
  }
  if (event.key === 'Escape' && panelState === 'zen') {
    event.preventDefault();
    setPanelState(zenModeReturnState);
    $('#note-content').focus({preventScroll:true});
    return;
  }
  if (event.defaultPrevented || event.isComposing || event.repeat || hasOpenModal()) return;
  const first = window.VylkShortcuts.bindingFromEvent(event);
  if (!first) return;
  if (window.VylkShortcuts.isLeader(first, shortcutPrefixBinding().steps[0])) {
    const hasSequence = shortcutCommands.some(command => commandCanRun(command) && shortcutBindingFor(command)?.steps.length === 2);
    if (!hasSequence) return;
    event.preventDefault();
    startShortcutSequence();
    return;
  }
  const command = commandForBinding(first);
  if (!command || !commandCanRun(command)) return;
  event.preventDefault();
  void executeShortcutCommand(command.id);
}, true);

$('#shortcut-groups').addEventListener('click', event => {
  const record = event.target.closest('[data-shortcut-command]');
  if (record) startShortcutRecording(record.dataset.shortcutCommand);
});

$('#shortcut-prefix').addEventListener('click', startShortcutPrefixRecording);

$('#shortcut-reset').addEventListener('click', () => {
  setShortcutRecorderStatus('Restoring default shortcuts…');
  void savePref('shortcutPrefix', DEFAULT_PREFS.shortcutPrefix)
    .then(() => savePref('keyboardShortcuts', {}))
    .then(() => setShortcutRecorderStatus('Default shortcuts restored.'));
});

$('#shortcut-confirm-close').addEventListener('click', () => closeModal($('#shortcut-confirm-modal')));
$('#shortcut-confirm-cancel').addEventListener('click', () => closeModal($('#shortcut-confirm-modal')));
$('#shortcut-confirm-modal .modal-backdrop').addEventListener('click', () => closeModal($('#shortcut-confirm-modal')));
$('#shortcut-confirm-continue').addEventListener('click', async () => {
  const skip = $('#shortcut-confirm-skip').checked;
  closeModal($('#shortcut-confirm-modal'));
  if (skip) await savePref('shortcutConfirmationSkips', {...prefs.shortcutConfirmationSkips, 'note.new':true});
  const saved = await saveCurrentNote(false);
  if (saved) startNewNote();
});

renderShortcutPreferences();

// --- Init ---
async function init() {
  let localStartupReady = false;
  try {
    initializeHistoryRoute();
    await restoreCachedStartup();
    localStartupReady = true;
    $('#app').classList.remove('booting');

    const res = await api('/api/check');
    if (res) {
      cacheAppVersion(res);
      // Apply the saved theme and appearance variables before restoring the
      // authenticated screen. Rendering the dashboard first caused a brief
      // fallback-theme paint where borders and surfaces could appear missing.
      await loadPrefs();
      await restoreRoute({fetchRemote: true});
      connectServerEvents();
      scheduleSync({reconcile: true});
    } else if (authenticationRequired) {
      // api() has already displayed the sign-in screen. A cached offline copy
      // must never override that when the server explicitly returned 401.
    } else {
      cacheAppVersion();
      setSyncStatus('offline');
      showOfflineNotice();
    }
  } catch (error) {
    console.error('initialization failed', error);
    if (error?.responseStatus === 401) return;
    if (localStartupReady) {
      markServerOffline();
    } else {
      show(screens.login);
      $('#login-error').textContent = 'Could not start the app. Please reload.';
      $('#login-form input').focus();
    }
  } finally {
    $('#app').classList.remove('booting');
  }
}

init();

$$('.offline-retry').forEach(retry => retry.addEventListener('click', async () => {
  showOfflineNotice(true);
  const ok = await syncNow({preserveSnackbar: true});
  if (ok) showSyncCompleteToast();
}));

// Service worker
function registerServiceWorker(revision = appRevisionAtLoad) {
  if (!('serviceWorker' in navigator)) return;
  const requestedRevision = /^[A-Za-z0-9._-]{1,128}$/.test(revision || '') ? revision : 'legacy';
  if (registeredServiceWorkerRevision === requestedRevision) return;
  registeredServiceWorkerRevision = requestedRevision;
  navigator.serviceWorker.register(`/sw.js?revision=${encodeURIComponent(requestedRevision)}`, {updateViaCache: 'none'}).catch(error => {
    registeredServiceWorkerRevision = null;
    console.warn('service worker registration failed', error);
  });
}

window.addEventListener('popstate', () => {
  restoringHistoryRoute = true;
  void restoreRoute().finally(() => {
    restoringHistoryRoute = false;
    pendingHistoryRestoreResolvers.shift()?.();
  });
});

window.addEventListener('online', async () => {
  connectServerEvents();
  scheduleSync({reconcile: true});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (isDirty) saveCurrentNote(false);
    if (syncScheduleTimer) {
      clearTimeout(syncScheduleTimer);
      syncScheduleTimer = null;
    }
    cancelActiveSyncRequests();
  }
  if (document.visibilityState === 'visible') {
    connectServerEvents();
    scheduleSync();
  }
});

setInterval(async () => {
  if (document.visibilityState !== 'visible' || syncInFlight) return;
  try {
    const pending = (await pendingOperations()).length > 0;
    const sseHealthy = isServerEventsHealthy();
    const fallbackAge = sseHealthy ? healthySseFallbackSyncAgeMs : unhealthySseFallbackSyncAgeMs;
    const stale = !lastSuccessfulSyncAt || Date.now() - lastSuccessfulSyncAt >= fallbackAge;
    if (pending || stale) scheduleSync({reconcile: !sseHealthy});
  } catch (error) {
    console.warn('periodic sync check failed', error);
  }
}, 30000);

})();
