(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const {APIError, errorFromPayload: apiErrorFromPayload} = window.VylkHTTP;
  const editorSourceTextarea = $('#note-content');
  const editorSourceWrap = $('.editor-source-wrap');
  const editorCurrentLine = $('.editor-current-line');
  const editorSource = window.VylkEditorSource.create({
    document,
    onInput: handleEditorSourceInput,
    onLengthChange: (length) => {
      editorDocumentLength = length;
    },
    window,
  });
  const activateZenSourceEditor = editorSource.activateZen;
  const deactivateZenSourceEditor = editorSource.deactivateZen;
  const editorSourceSelection = editorSource.selection;
  const editorSourceValue = editorSource.value;
  const focusCurrentSourceEditor = editorSource.focus;
  const setEditorSourceValue = editorSource.setValue;
  const zenSourceIsActive = editorSource.zenActive;

  const bootScreen = $('#boot-screen');
  if (bootScreen) bootScreen.hidden = false;

  const screens = {
    login: $('#login-screen'),
    dashboard: $('#dashboard'),
    editor: $('#editor'),
  };

  let currentNoteId = null;
  let isDirty = false;
  let panelController = null;
  let noteSaver = null;
  let navigationController = null;
  let savedSnapshot = {title: '', tags: '', content: ''};
  let editorSessionGeneration = 0;
  const {
    defaults: DEFAULT_PREFS,
    fontSizeOptions: FONT_SIZE_OPTIONS,
    mergeNestedPatch: mergeNestedPreferencePatch,
    normalize: normalizePrefs,
    validFontValue,
    valuesEqual: preferenceValuesEqual,
  } = window.VylkPreferences;
  let prefs = {...DEFAULT_PREFS};
  let previewRenderer = null;
  let previewHighlighter = null;
  let editorDocumentLength = 0;
  let pendingEditorInputRange = null;
  let previewWorkerClient = null;
  let previewDecoration = null;
  let interactivePreviewSession = null;
  let previewDrag = null;
  let currentRevision = 0;
  let currentBaseRevision = null;
  let syncNetworkRequestsInFlight = 0;
  let offlineStorageFailureReported = false;
  let authenticationRequired = false;
  const syncTabID = `tab_${newLocalNoteID()}`;
  let syncCoordinationChannel = null;
  let syncCoordinator = null;
  let serverEventClient = null;
  let registeredServiceWorkerRevision = null;
  let dashboardHydrationState = 'ready';

  const healthySseFallbackSyncAgeMs = 5 * 60 * 1000;
  const unhealthySseFallbackSyncAgeMs = 30 * 1000;

  const routes = window.VylkRoutes.create(window);
  const noteIDFromLocation = routes.noteID;
  const isAppPreferencesRoute = routes.isPreferences;
  const initializeHistoryRoute = routes.initialize;
  const setNoteRoute = routes.setNote;
  const setDashboardRoute = routes.setDashboard;
  const setPreferencesRoute = routes.setPreferences;

  function newLocalNoteID() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function reportOfflineStorageFailure(error) {
    setSyncDiagnostic(`local storage unavailable: ${error?.message || 'unknown error'}`);
    if (offlineStorageFailureReported) return;
    offlineStorageFailureReported = true;
    showToast('Local storage is unavailable. Your changes may not be saved.', 'warning');
  }

  const offlineStore = window.VylkOfflineStore.create({
    createID: newLocalNoteID,
    onBlocked: () => showToast('Close other app tabs to update local storage.', 'warning'),
    onFailure: reportOfflineStorageFailure,
    onSyncRequested: notifySyncRequested,
    beforeClear: () => {
      try {
        syncCoordinationChannel?.postMessage({type: 'logout', sender: syncTabID});
      } catch (_) {}
    },
  });
  const {
    claimQueueOperation,
    clearOfflineData,
    closeOfflineDatabaseConnection,
    getAllLocalNotes,
    getLocalNote,
    getLocalNotes,
    getOfflineDatabaseInfo,
    getOfflineState,
    getUnresolvedConflict,
    hasPendingOperation,
    latestLaterOperation,
    nextLocalPinOrder,
    pendingOperations,
    pendingOperationsForNote,
    putLocalNote,
    quarantineQueueOperation,
    queueOperation,
    queueOperationInStores,
    queueOperationPayload,
    rebaseQueuedNoteOperations,
    rejectedSyncKey,
    removeLocalNote,
    removeLocalNoteAndQueue,
    removeLocalNoteAndSupersede,
    removePendingOperationIfIdentityMatches,
    repairSyncSequenceGap,
    saveLocalNoteAndQueue,
    setOfflineState,
    setUnresolvedConflict,
    supersedeQueuedNoteOperations,
    syncDeviceID,
    unresolvedConflictKey,
    withOfflineStore,
  } = offlineStore;
  const {requestValue} = window.VylkIndexedDB;

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      syncCoordinationChannel = new BroadcastChannel('vylk-sync');
      syncCoordinationChannel.addEventListener('message', (event) => {
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

  const feedback = window.VylkFeedback.create({
    document,
    isSyncInFlight: () => syncCoordinator?.inFlight() || false,
    localStorage,
    navigator,
    registerServiceWorker: (revision) => registerServiceWorker(revision),
    requestFrame: (callback) => requestAnimationFrame(callback),
    window,
  });
  const beginSyncStatusPresentation = feedback.beginStatusPresentation;
  const cacheAppVersion = feedback.cacheVersion;
  const clearSyncDiagnostic = feedback.clearDiagnostic;
  const finishSyncStatusPresentation = feedback.finishStatusPresentation;
  const hideOfflineNotice = feedback.hideOfflineNotice;
  const setSyncDiagnostic = feedback.setDiagnostic;
  const setSyncStatus = feedback.setStatus;
  const showOfflineNotice = feedback.showOfflineNotice;
  const showSyncCompleteToast = feedback.showSyncComplete;
  const showToast = feedback.showToast;
  const zenOverlays = window.VylkZenOverlays.create({
    document,
    getPanelState: () => panelController?.state() || 'both',
    getPreferences: () => prefs,
    getSource: editorSourceValue,
    window,
  });
  const cancelScheduledZenWordCount = zenOverlays.cancelWordCount;
  const scheduleZenWordCount = zenOverlays.scheduleWordCount;
  const updateZenOverlays = zenOverlays.update;
  const updateZenTitle = zenOverlays.updateTitle;
  const caretController = window.VylkCaretController.create({
    document,
    getDocumentLength: () => editorDocumentLength,
    getPanelState: () => panelController?.state() || 'both',
    line: editorCurrentLine,
    textarea: editorSourceTextarea,
    window,
    wrap: editorSourceWrap,
  });
  const cancelScheduledZenCaretCenter = caretController.cancelZenCenter;
  const centerEditorCaretInView = caretController.center;
  const centerZenCaretNow = caretController.centerZen;
  const measureEditorCaret = caretController.measure;
  const scheduleEditorCaretCue = caretController.schedule;

  function show(screen) {
    Object.values(screens).forEach((el) => el.classList.add('hidden'));
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

  function beginSyncNetworkRequest() {
    syncNetworkRequestsInFlight++;
    if (!syncCoordinator?.inFlight()) setSyncStatus('syncing');
  }

  async function endSyncNetworkRequest() {
    syncNetworkRequestsInFlight = Math.max(0, syncNetworkRequestsInFlight - 1);
    if (syncNetworkRequestsInFlight === 0 && !syncCoordinator?.inFlight())
      await setIdleSyncStatus();
  }

  const apiClient = window.VylkAPIClient.create({
    fetch: (...args) => fetch(...args),
    http: window.VylkHTTP,
    onAuthenticationRequired: requireAuthentication,
    onDiagnostic: setSyncDiagnostic,
    onSyncRequestEnd: endSyncNetworkRequest,
    onSyncRequestStart: beginSyncNetworkRequest,
  });
  const api = apiClient.request;
  const cancelActiveSyncRequests = apiClient.cancelActiveSyncRequests;
  const syncFetch = apiClient.syncFetch;

  async function setIdleSyncStatus() {
    if (syncNetworkRequestsInFlight > 0 || syncCoordinator?.inFlight()) return;
    const generation = feedback.beginStatusCheck();
    try {
      const operations = await pendingOperations();
      if (
        !feedback.statusCheckIsCurrent(generation) ||
        syncNetworkRequestsInFlight > 0 ||
        syncCoordinator?.inFlight()
      )
        return;
      if (typeof document === 'undefined') return;
      setSyncStatus(syncCoordinator?.failed() ? 'offline' : operations.length ? 'local' : 'online');
    } catch (error) {
      console.warn('could not determine pending sync status', error);
    }
  }

  const remoteNotes = window.VylkRemoteNotes.create({
    api,
    getAllLocalNotes,
    getCurrentNoteID: () => currentNoteId,
    getLocalNote,
    getOfflineState,
    handleActiveDeletion: async () => {
      clearCurrentNote();
      await loadDashboard({sync: false});
      setDashboardRoute({replace: true});
    },
    isDirty: () => isDirty,
    putLocalNote,
    rejectedSyncKey,
    requestValue,
    unresolvedConflictKey,
    updateOpenNote,
    withOfflineStore,
  });
  const applyRemoteDeletion = remoteNotes.applyDeletion;
  const applyRemoteChangePage = remoteNotes.applyChangePage;
  const applyRemoteSnapshot = remoteNotes.applySnapshot;
  const cacheRemoteNote = remoteNotes.cache;
  const pullRemoteChanges = remoteNotes.pull;
  const reconcileLocalNotes = remoteNotes.reconcile;

  function updateOpenNote(note) {
    if (currentNoteId !== note.id || isDirty) return;
    const titleChanged = $('#note-title').value !== (note.title || '');
    const tagsChanged = $('#note-tags').value !== (note.tags || '');
    const markdownChanged = editorSourceValue() !== (note.content || '');
    currentRevision = note.revision || 0;
    currentBaseRevision = note.base_revision ?? null;
    savedSnapshot = {title: note.title || '', tags: note.tags || '', content: note.content || ''};
    if (titleChanged) $('#note-title').value = savedSnapshot.title;
    if (tagsChanged) $('#note-tags').value = savedSnapshot.tags;
    if (!markdownChanged) return;
    setEditorSourceValue(savedSnapshot.content);
    previewRenderer?.invalidate();
    requestPreviewRender({announceBusy: true});
  }

  let conflictResolver;
  const conflictActions = window.VylkConflictActions.create({
    clearCurrentNote,
    closeResolver: () => conflictResolver.close(),
    getConflict: getUnresolvedConflict,
    isCurrentNote: (noteID) => currentNoteId === noteID,
    isDashboardVisible: () => !screens.dashboard.classList.contains('hidden'),
    loadDashboard,
    newNoteID: newLocalNoteID,
    queueOperationInStores,
    refreshDashboard,
    requestValue,
    scheduleSync,
    selectNote: (noteID, note) => {
      currentNoteId = noteID;
      isDirty = false;
      updateOpenNote(note);
    },
    setDashboardRoute,
    setNoteRoute,
    showToast,
    unresolvedConflictKey,
    withOfflineStore,
  });
  const modalController = window.VylkModal.create({
    document,
    window,
    onEscape: (modal) => {
      if (modal.id === 'conflict-modal') conflictResolver.close();
      else if (modal.id === 'prefs-modal') closePreferences();
      else modalController.close(modal);
    },
  });
  const openModal = modalController.open;
  const closeModal = modalController.close;
  conflictResolver = window.VylkConflictResolver.create({
    closeModal,
    document,
    getConflict: getUnresolvedConflict,
    onAcceptDeletion: conflictActions.acceptDeletion,
    onKeepCopy: conflictActions.keepCopy,
    onKeepDeletedCopy: conflictActions.keepDeletedCopy,
    onSaveResolution: conflictActions.save,
    openModal,
  });
  const closeConflictResolver = conflictResolver.close;
  const showConflictResolver = conflictResolver.showEdit;
  const showDeletedConflict = conflictResolver.showDeleted;
  const showConflictResolverFor = conflictResolver.showFor;

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

  const conflictWorkflow = window.VylkConflictWorkflow.create({
    api,
    getCurrentNoteID: () => currentNoteId,
    getLocalNote,
    isDashboardVisible: () => !screens.dashboard.classList.contains('hidden'),
    isDirty: () => isDirty,
    latestLaterOperation,
    mergeVersions: window.VylkMerge?.mergeNoteVersions,
    newNoteID: newLocalNoteID,
    pendingOperationsForNote,
    putLocalNote,
    queueOperation,
    queueOperationPayload,
    refreshDashboard,
    removeLocalNote,
    removePendingOperation: removePendingOperationIfIdentityMatches,
    requestValue,
    saveCurrentNote,
    selectNoteID: (noteID) => {
      currentNoteId = noteID;
    },
    setNoteRoute,
    setUnresolvedConflict,
    showNoteInEditor,
    showResolver: showConflictResolver,
    supersedeOperations: supersedeQueuedNoteOperations,
    unresolvedConflictKey,
    updateOpenNote,
    withOfflineStore,
  });
  const createConflictResolution = conflictWorkflow.prepare;
  const loadConflictRemoteNote = conflictWorkflow.loadRemoteNote;
  const mergeConflictedNote = conflictWorkflow.merge;

  const compactedOperations = window.VylkCompactedOperations.create({
    api,
    clearCurrentNote,
    getCurrentNoteID: () => currentNoteId,
    isDirty: () => isDirty,
    loadDashboard,
    queueOperationPayload,
    removePendingOperation: removePendingOperationIfIdentityMatches,
    requestValue,
    setDashboardRoute,
    updateOpenNote,
    withOfflineStore,
  });
  const acknowledgeCompactedOperation = compactedOperations.acknowledge;

  const syncPushBatchLimit = 100;
  const syncPushBatchByteLimit = 3 * 1024 * 1024;
  const syncBatch = window.VylkSyncBatch.create({withOfflineStore});
  const claimPendingOperationBatch = syncBatch.claim;
  const outgoingSyncOperation = window.VylkSyncBatch.serialize;

  const resolvePreferenceConflict = window.VylkPreferenceConflicts.create({
    api,
    applyPreferences: (next) => {
      prefs = next;
      localStorage.setItem('vylk-prefs', JSON.stringify(prefs));
      applyPrefs();
      renderShortcutPreferences();
    },
    mergeNestedPatch: mergeNestedPreferencePatch,
    normalize: normalizePrefs,
    queueOperationInStores,
    queueOperationPayload,
    requestValue,
    scheduleSync,
    showToast,
    valuesEqual: preferenceValuesEqual,
    withOfflineStore,
  });

  const syncAcknowledgements = window.VylkSyncAcknowledgements.create({
    acknowledgeCompacted: acknowledgeCompactedOperation,
    applyPreferencesRevision: (revision) => {
      prefs = normalizePrefs({...prefs, revision: revision || prefs.revision});
      localStorage.setItem('vylk-prefs', JSON.stringify(prefs));
      applyPrefs();
    },
    createConflictResolution,
    getCurrentNoteID: () => currentNoteId,
    getLocalNote,
    isDirty: () => isDirty,
    latestLaterOperation,
    loadConflictRemoteNote,
    mergeConflictedNote,
    pendingOperationsForNote,
    putLocalNote,
    queueOperation,
    rebaseOperations: rebaseQueuedNoteOperations,
    refreshDashboard,
    removeLocalNote,
    removePendingOperation: removePendingOperationIfIdentityMatches,
    resolvePreferenceConflict,
    setCurrentRevision: (revision, baseRevision) => {
      currentRevision = revision;
      currentBaseRevision = baseRevision;
    },
    showConflictResolverFor,
    showToast,
    updateOpenNote,
  });
  const applySyncAcknowledgement = syncAcknowledgements.apply;

  const flushPendingChanges = window.VylkSyncPusher.create({
    APIError,
    apiErrorFromPayload,
    applyAcknowledgement: applySyncAcknowledgement,
    byteLimit: syncPushBatchByteLimit,
    claimBatch: claimPendingOperationBatch,
    getDeviceID: syncDeviceID,
    initialBatchLimit: syncPushBatchLimit,
    quarantine: quarantineQueueOperation,
    repairSequenceGap: repairSyncSequenceGap,
    requireAuthentication,
    serialize: outgoingSyncOperation,
    showToast,
    syncFetch,
  });

  const syncLeadership = window.VylkSyncLeadership.create({
    navigator,
    onUnavailable: () => scheduleSync({}, 500),
    requestValue,
    tabID: syncTabID,
    window,
    withOfflineStore,
  });
  const withSyncLeadership = syncLeadership.run;

  function scheduleSync(options = {}, delayMs = 75) {
    return syncCoordinator.schedule(options, delayMs);
  }

  function syncNow(options = {}) {
    return syncCoordinator.now(options);
  }

  function markServerOffline() {
    syncCoordinator.markOffline();
  }

  syncCoordinator = window.VylkSyncCoordinator.create({
    apiClient,
    authenticationRequired: () => authenticationRequired,
    beforeCompletion: () => globalThis.__vylkDependencies?.beforeSyncCompletion?.(),
    clearDiagnostic: clearSyncDiagnostic,
    connectEvents: () => connectServerEvents(),
    document,
    feedback,
    finishStatus: finishSyncStatusPresentation,
    flush: flushPendingChanges,
    getCursor: () => getOfflineState('syncSequence'),
    getHydrationState: () => dashboardHydrationState,
    getPendingOperations: pendingOperations,
    hideOfflineNotice,
    isDashboardVisible: () => !screens.dashboard.classList.contains('hidden'),
    isEditorDirty: () => isDirty,
    isEditorVisible: () => !screens.editor.classList.contains('hidden'),
    leadership: withSyncLeadership,
    localStorage,
    notifyCompleted: notifySyncCompleted,
    onAuthenticationRequired: () => {
      requireAuthentication();
      $('#login-error').textContent = 'Your session expired. Sign in again.';
    },
    onOffline: (firstFailure) => {
      if (dashboardHydrationState === 'loading') {
        dashboardHydrationState = 'offline-empty';
        void refreshDashboard().catch((error) =>
          console.warn('could not render offline empty state', error),
        );
      }
      setSyncStatus('offline');
      showOfflineNotice();
      if (firstFailure)
        showToast('Working offline. Your changes are saved on this device.', 'warning');
    },
    pull: pullRemoteChanges,
    reconcileLocal: reconcileLocalNotes,
    refreshDashboard,
    saveCurrentNote,
    serverEventsConnected: () => serverEventClient?.connected() || false,
    serverWorkRemains: (cursor) => serverEventClient?.workRemains(cursor) || false,
    setDiagnostic: setSyncDiagnostic,
    setHydrationState: (state) => {
      dashboardHydrationState = state;
    },
    showToast,
    startStatus: beginSyncStatusPresentation,
    window,
  });

  serverEventClient = window.VylkServerEvents.create({
    cacheVersion: cacheAppVersion,
    getOfflineState,
    getPreferenceRevision: () => prefs.revision,
    isSyncInFlight: () => syncCoordinator.inFlight(),
    loadPreferences: loadPrefs,
    onHeartbeat: () => {
      if (!syncCoordinator.failed()) {
        if (!syncCoordinator.inFlight()) void setIdleSyncStatus();
        return;
      }
      scheduleSync({reconcile: true});
    },
    scheduleSync,
    syncNow,
    window,
  });
  const connectServerEvents = serverEventClient.connect;
  const disconnectServerEvents = serverEventClient.disconnect;
  const handleServerChangeEvent = serverEventClient.handleChange;
  const isServerEventsHealthy = serverEventClient.healthy;

  // --- Auth ---
  window.VylkAuth.bind({
    api,
    cacheVersion: cacheAppVersion,
    cancelRequests: cancelActiveSyncRequests,
    closeModal,
    clearDiagnostic: clearSyncDiagnostic,
    clearOfflineData,
    connectEvents: connectServerEvents,
    disconnectEvents: disconnectServerEvents,
    document,
    loadPreferences: (...args) => loadPrefs(...args),
    localStorage,
    openModal,
    restoreRoute: (...args) => restoreRoute(...args),
    scheduleSync,
    setAuthenticationRequired: (required) => {
      authenticationRequired = required;
    },
    showLogin: () => {
      clearCurrentNote();
      setDashboardRoute({replace: true});
      closeModal($('#prefs-modal'));
      closeModal($('#restore-defaults-modal'));
      show(screens.login);
      $('#login-form input').focus();
    },
    showToast,
  });

  // --- Dashboard ---
  async function unresolvedConflictIDs() {
    const records = await withOfflineStore(['state'], 'readonly', (stores) =>
      requestValue(stores.state.getAll()),
    );
    return new Set(
      records
        .filter((record) => record.key.startsWith('unresolvedConflict:') && record.value?.note_id)
        .map((record) => record.value.note_id),
    );
  }

  const dashboardView = window.VylkDashboard.create({
    document,
    emptyState: () => dashboardHydrationState,
    escapeHTML: esc,
    formatDate,
    onOpen: (noteID) => void openNote(noteID),
    onPin: (noteID) => void toggleNotePin(noteID),
  });

  const dashboardController = window.VylkDashboardController.create({
    getConflictIDs: unresolvedConflictIDs,
    getCurrentNoteID: () => currentNoteId,
    getLocalNote,
    getLocalNotes,
    isDashboardVisible: () => !screens.dashboard.classList.contains('hidden'),
    isDirty: () => isDirty,
    isEditorVisible: () => !screens.editor.classList.contains('hidden'),
    scheduleSync,
    setIdleStatus: setIdleSyncStatus,
    showDashboard: () => show(screens.dashboard),
    updateOpenNote,
    view: dashboardView,
  });
  function loadDashboard(options) {
    return dashboardController.load(options);
  }

  function refreshDashboard() {
    return dashboardController.refresh();
  }

  function refreshLocalStateFromStorage() {
    return dashboardController.refreshFromStorage();
  }

  function applyEditorPrefs() {
    const collapsed = Boolean(prefs.collapseDetails);
    $('.meta-pane').classList.toggle('collapsed', collapsed);
    $('.meta-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('#editor').classList.toggle('header-hidden', panelController.state() === 'zen');
    document.documentElement.dataset.statusDisplay = prefs.statusDisplay;
    $('#editor').classList.toggle(
      'hide-save-button',
      Boolean(prefs.hideSaveButton && prefs.autoSave),
    );
    updateZenOverlays();
    panelController.placeSaveButton();
    if (prefs.hideToolbar) {
      $('.fmt-bar').classList.add('hidden');
    } else {
      $('.fmt-bar').classList.remove('hidden');
    }
    const interactiveModeChanged = syncInteractivePreviewMode();
    scheduleEditorCaretCue();
    if (interactiveModeChanged && isPreviewVisible()) requestPreviewRender({announceBusy: true});
  }

  function syncInteractivePreviewMode() {
    return interactivePreviewSession.syncMode();
  }

  function applyContentWidth() {
    document.documentElement.dataset.contentWidth = prefs.contentWidth;
    document.documentElement.dataset.zenPageWidth = prefs.zenPageWidth;
  }

  function startPanelState() {
    return (
      {editor: 'editor', preview: 'preview', split: 'both', zen: 'zen'}[prefs.startView] || 'both'
    );
  }

  // --- Editor ---
  function startNewNote(title = '') {
    noteSaver.cancelScheduled();
    if (previewTimer) clearTimeout(previewTimer);
    const initialPanelState = startPanelState();
    setPanelState(initialPanelState);
    resetInteractivePreviewSession();
    editorSessionGeneration++;
    currentNoteId = newLocalNoteID();
    currentRevision = 0;
    currentBaseRevision = null;
    isDirty = false;
    savedSnapshot = {title: '', tags: '', content: ''};
    $('#note-title').value = title;
    $('#note-tags').value = '';
    setEditorSourceValue('');
    $('#preview').innerHTML = '';
    previewRenderer?.invalidate();
    setIdleSyncStatus();
    cachePreviewBlocks();
    applyEditorPrefs();
    show(screens.editor);
    scheduleEditorCaretCue();
    if (initialPanelState === 'zen') focusCurrentSourceEditor();
    else if (initialPanelState === 'preview') focusPreview();
    else $('#note-title').focus();
  }

  function showNoteInEditor(data) {
    setPanelState(startPanelState());
    resetInteractivePreviewSession();
    editorSessionGeneration++;
    currentNoteId = data.id;
    currentRevision = data.revision || 0;
    currentBaseRevision = data.base_revision ?? null;
    isDirty = false;
    savedSnapshot = {title: data.title || '', tags: data.tags || '', content: data.content || ''};
    $('#note-title').value = data.title || '';
    $('#note-tags').value = data.tags || '';
    setEditorSourceValue(data.content || '');
    $('#preview').replaceChildren();
    previewRenderer?.invalidate({metadata: true});
    setIdleSyncStatus();
    applyEditorPrefs();
    show(screens.editor);
    scheduleEditorCaretCue();
    requestPreviewRender();
  }

  async function openNote(id, {route = 'push'} = {}) {
    return navigationController.openNote(id, {route});
  }

  function followWikiLink(title) {
    return navigationController.followWikiLink(title);
  }

  function restoreRoute(options) {
    return navigationController.restoreRoute(options);
  }

  function restoreCachedStartup() {
    return navigationController.restoreCachedStartup();
  }

  // --- Autosave ---
  function markDirty() {
    if (!isDirty) {
      isDirty = true;
    }
  }

  function saveCurrentNote(trySync = true) {
    return noteSaver.save(trySync);
  }

  async function toggleNotePin(noteID) {
    const local = await getLocalNote(noteID);
    if (!local) return false;
    const pinned = !Boolean(local.pinned);
    const baseRevision = local.pending
      ? (local.base_revision ?? local.revision ?? 0)
      : (local.revision ?? 0);
    const next = {
      ...local,
      pinned,
      pin_order: pinned ? await nextLocalPinOrder() : 0,
      pending: true,
      base_revision: baseRevision,
    };
    await saveLocalNoteAndQueue(next, {
      type: 'note.pin',
      note_id: noteID,
      base_revision: baseRevision,
      pinned,
      pin_order: next.pin_order,
    });
    await refreshDashboard();
    scheduleSync();
    return true;
  }

  let previewTimer = null;

  function scheduleSave() {
    noteSaver.schedule();
  }

  noteSaver = window.VylkNoteSaver.create({
    autoSaveEnabled: () => prefs.autoSave,
    editorVisible: () => !screens.editor.classList.contains('hidden'),
    getConflict: getUnresolvedConflict,
    getLocalNote,
    getSession: () => ({
      baseRevision: currentBaseRevision,
      generation: editorSessionGeneration,
      isDirty,
      noteID: currentNoteId,
      revision: currentRevision,
      savedSnapshot,
    }),
    isRestoringRoute: () => navigationController?.restoring() || false,
    newNoteID: newLocalNoteID,
    noteIDFromLocation,
    persistConflict: (noteID, unresolved, local) =>
      withOfflineStore(['notes', 'state'], 'readwrite', async (stores) => {
        await requestValue(stores.notes.put(local));
        await requestValue(
          stores.state.put({
            key: unresolvedConflictKey(noteID),
            value: {...unresolved, local},
          }),
        );
      }),
    persistLocalNote: (local, operation) => {
      const persist = globalThis.__vylkDependencies?.saveLocalNoteAndQueue || saveLocalNoteAndQueue;
      return persist(local, operation);
    },
    readEditor: () => ({
      title: $('#note-title').value.trim() || 'Untitled',
      tags: $('#note-tags').value.trim(),
      content: editorSourceValue(),
    }),
    setIdleStatus: setIdleSyncStatus,
    setNoteID: (noteID) => {
      currentNoteId = noteID;
    },
    setNoteRoute,
    setPersistedState: (state) => {
      if (Object.hasOwn(state, 'baseRevision')) currentBaseRevision = state.baseRevision;
      savedSnapshot = state.savedSnapshot;
      isDirty = false;
    },
    showToast,
    syncNow,
    window,
  });

  navigationController = window.VylkNavigationController.create({
    api,
    cancelPreviewDelay: () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = null;
    },
    cancelPreviewRender: cancelPendingPreviewRender,
    clearCurrentNote,
    closeModal,
    document,
    getCurrentNoteID: () => currentNoteId,
    getLocalNote,
    getLocalNotes,
    getUnresolvedConflict,
    hasPendingOperation,
    isDashboardVisible: () => !screens.dashboard.classList.contains('hidden'),
    isDirty: () => isDirty,
    isEditorVisible: () => !screens.editor.classList.contains('hidden'),
    loadDashboard,
    noteSaver,
    openPreferences,
    pendingOperations,
    putLocalNote,
    routes,
    saveCurrentNote,
    scheduleSync,
    setDashboardHydrationState: (state) => {
      dashboardHydrationState = state;
    },
    showConflictResolverFor,
    showNoteInEditor,
    showToast,
    startNewNote,
    unresolvedConflictIDs,
    window,
  });

  $('#save-btn').addEventListener('click', () =>
    executeShortcutCommand('note.save', {source: 'button'}),
  );
  $('#note-title').addEventListener('input', () => {
    markDirty();
    scheduleSave();
    updateZenTitle();
  });
  $('#note-tags').addEventListener('input', () => {
    markDirty();
    scheduleSave();
  });

  // --- Formatting toolbar ---
  const formattingToolbar = window.VylkFormattingToolbar.create({
    document,
    window,
    formatting: window.VylkMarkdownFormatting,
    isLocked: () => interactivePreviewSession.locked(),
    readSource: () => {
      const textarea = document.querySelector('#note-content');
      if (zenSourceIsActive()) {
        const zenEditor = editorSource.zenEditor();
        const selection = zenEditor.selection();
        textarea.value = zenEditor.value;
        textarea.setSelectionRange(selection.start, selection.end, selection.direction);
      }
      return {
        value: textarea.value,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
    },
    writeSource: (value, cursor) => {
      const textarea = document.querySelector('#note-content');
      textarea.value = value;
      textarea.selectionStart = textarea.selectionEnd = cursor;
      if (zenSourceIsActive()) editorSource.zenEditor().setValue(value, cursor, cursor);
      textarea.dispatchEvent(new Event('input'));
      focusCurrentSourceEditor();
    },
    onFormatted: ({immediate}) => {
      if (!immediate) return;
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      requestPreviewRender({announceBusy: true});
    },
  });
  const insertFmt = formattingToolbar.format;

  // --- Meta pane toggle ---
  $('.meta-toggle')?.addEventListener('click', () => {
    const pane = $('.meta-pane');
    const collapsed = pane.classList.toggle('collapsed');
    $('.meta-toggle').setAttribute('aria-expanded', String(!collapsed));
  });

  // --- Panel toggle ---
  function setPanelState(state) {
    panelController.setState(state);
  }

  panelController = window.VylkPanelController.create({
    activateZen: (active) => {
      if (active) activateZenSourceEditor();
      else deactivateZenSourceEditor();
    },
    cancelDrag: () => {
      if (previewDrag?.active()) cancelPreviewDrag({animateReturn: false});
    },
    cancelZenCaret: cancelScheduledZenCaretCenter,
    cancelZenWordCount: cancelScheduledZenWordCount,
    document,
    focusPreview,
    focusSource: focusCurrentSourceEditor,
    getPreferences: () => prefs,
    getPreviewSource: () => previewRenderer?.source(),
    getSource: editorSourceValue,
    localStorage,
    onExecuteCommand: (commandID) => executeShortcutCommand(commandID, {source: 'button'}),
    onPanelChanged: syncInteractivePreviewMode,
    renderPreview: () => requestPreviewRender({announceBusy: true}),
    scheduleCaret: scheduleEditorCaretCue,
    schedulePreviewCheck,
    updateZenOverlays,
    window,
  });

  // --- Cursor preview highlight ---
  let previewModel = null;
  let previewState = {blocks: [], ranges: [], source: null, blockItems: [], listItems: []};
  function resetInteractivePreviewSession() {
    interactivePreviewSession.reset();
  }

  function syncInteractivePreviewUI() {
    interactivePreviewSession.syncUI();
  }

  previewDecoration = window.VylkPreviewDecoration.create({
    document,
    getEntries: () => [...previewState.blockItems, ...previewState.listItems],
    isActive: () => interactivePreviewSession.active(),
    isDraggingEntry: (entry) => previewDrag?.isDraggingEntry(entry),
    preview: $('#preview'),
    window,
  });
  const decorateInteractivePreview = previewDecoration.decorate;
  const decoratePreviewEntry = previewDecoration.decorateEntry;
  const disconnectPreviewDecorationObserver = previewDecoration.disconnect;
  const undecoratePreviewEntry = previewDecoration.undecorateEntry;

  function setInteractiveSourceLocked(locked) {
    interactivePreviewSession.setLocked(locked);
  }

  function applyInteractiveSource(nextSource, transaction, {preservePreview = false} = {}) {
    return interactivePreviewSession.applySource(nextSource, transaction, {preservePreview});
  }

  function undoInteractivePreview() {
    return interactivePreviewSession.undo();
  }
  const previewNavigation = window.VylkPreviewNavigation;
  const calculatePreviewScrollAdjustment = previewNavigation.scrollAdjustment;
  const previewEditPosition = (entry, source = editorSourceValue()) =>
    previewNavigation.editPosition(entry, source);
  const previewTokenTag = previewNavigation.tokenTag;

  function isPreviewVisible() {
    return previewHighlighter.isVisible();
  }

  function schedulePreviewCheck() {
    previewHighlighter.schedulePreviewCheck();
  }

  function scheduleHighlight() {
    previewHighlighter.scheduleHighlight();
  }

  function highlightBlock() {
    previewHighlighter.highlight();
  }

  function syncPreviewTaskCheckbox(item) {
    previewHighlighter.syncTaskCheckbox(item);
  }

  previewHighlighter = window.VylkPreviewHighlighter.create({
    decorateEntry: decoratePreviewEntry,
    document,
    getPanelState: () => panelController.state(),
    getPreferences: () => prefs,
    getPreviewState: () => previewState,
    getRenderedSource: () => previewRenderer?.source(),
    getSelection: editorSourceSelection,
    getSource: editorSourceValue,
    getZenView: () => panelController.zenView(),
    isEditorVisible: () => !screens.editor.classList.contains('hidden'),
    isInteractive: () => interactivePreviewSession.active(),
    measureCaret: measureEditorCaret,
    navigation: previewNavigation,
    requestPreviewRender: () => requestPreviewRender({announceBusy: true}),
    window,
  });

  interactivePreviewSession = window.VylkInteractivePreviewSession.create({
    cancelDecorations: disconnectPreviewDecorationObserver,
    cancelDrag: () => {
      if (previewDrag?.active()) cancelPreviewDrag({animateReturn: false});
    },
    cancelRenderDelay: () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = null;
    },
    document,
    getPanelState: () => panelController.state(),
    getPreferences: () => prefs,
    getPreviewState: () => previewState,
    getRenderer: () => previewRenderer,
    highlighter: previewHighlighter,
    isPreviewVisible,
    requestRender: () => requestPreviewRender({announceBusy: true}),
    window,
  });

  // --- Delete ---
  $('#delete-btn').addEventListener('click', async () => {
    if (!currentNoteId) return;
    if (!confirm('Delete this note?')) return;
    const noteID = currentNoteId;
    if (isDirty || noteSaver.hasPendingSave()) {
      const saved = await saveCurrentNote(false);
      if (saved === false || currentNoteId !== noteID) return;
    }
    const local = await getLocalNote(noteID);
    if (!local) return;
    const pending = await pendingOperationsForNote(noteID);
    const hasAttemptedOperation = pending.some((operation) => Boolean(operation.attempted_at));
    if (pending.length && !hasAttemptedOperation && (local.base_revision || 0) === 0) {
      await removeLocalNoteAndSupersede(noteID, 0);
    } else {
      await removeLocalNoteAndQueue(noteID, {
        type: 'note.delete',
        note_id: noteID,
        base_revision: local.base_revision ?? local.revision,
      });
    }
    editorSessionGeneration++;
    currentNoteId = null;
    currentRevision = 0;
    currentBaseRevision = null;
    dashboardView.clearMissingActiveTag(await getLocalNotes());
    setIdleSyncStatus();
    scheduleSync();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  });

  // --- Live Preview ---
  $('#note-content').addEventListener('beforeinput', (event) => {
    pendingEditorInputRange = {
      length: editorDocumentLength,
      start: event.target.selectionStart,
      end: event.target.selectionEnd,
    };
  });
  function handleEditorSourceInput({length}) {
    editorDocumentLength = length;
    cancelScheduledZenCaretCenter();
    if (!interactivePreviewSession.mutating()) interactivePreviewSession.clearHistory();
    if (previewDrag?.active()) cancelPreviewDrag({animateReturn: false});
    markDirty();
    scheduleSave();
    previewHighlighter.setPending(true);
    previewState.source = null;
    previewState.ranges = [];
    if (isPreviewVisible()) scheduleHighlight();
    scheduleEditorCaretCue({afterTyping: true});
    scheduleZenWordCount();
    cancelPendingPreviewRender();
    if (isPreviewVisible()) previewTimer = setTimeout(requestPreviewRender, 500);
  }

  $('#note-content').addEventListener('input', (event) => {
    const pending = pendingEditorInputRange;
    pendingEditorInputRange = null;
    const insertedLength =
      typeof event.data === 'string'
        ? event.data.length
        : ['insertLineBreak', 'insertParagraph'].includes(event.inputType)
          ? 1
          : event.inputType?.startsWith('delete')
            ? 0
            : null;
    const length =
      pending && insertedLength !== null
        ? pending.length - Math.max(0, pending.end - pending.start) + insertedLength
        : event.target.value.length;
    handleEditorSourceInput({length});
  });
  $('#note-content').addEventListener('click', () => {
    if (isPreviewVisible()) scheduleHighlight();
    scheduleEditorCaretCue();
  });
  $('#note-content').addEventListener('keyup', (event) => {
    if (isPreviewVisible()) scheduleHighlight();
    const caretNavigationKeys = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Home',
      'End',
    ];
    if (caretNavigationKeys.includes(event.key)) scheduleEditorCaretCue();
  });
  $('#note-content').addEventListener('focus', () => {
    scheduleEditorCaretCue();
    centerZenCaretNow();
  });
  $('#note-content').addEventListener('blur', scheduleEditorCaretCue);
  $('#note-content').addEventListener('select', () => scheduleEditorCaretCue({afterTyping: true}));
  $('#note-content').addEventListener('scroll', () => scheduleEditorCaretCue({afterTyping: true}), {
    passive: true,
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editorSourceTextarea)
      scheduleEditorCaretCue({afterTyping: true});
  });
  window.addEventListener('resize', scheduleEditorCaretCue, {passive: true});
  if (typeof ResizeObserver === 'function' && editorSourceTextarea) {
    new ResizeObserver(scheduleEditorCaretCue).observe(editorSourceTextarea);
  }

  const previewContent = window.VylkPreviewContent.create({
    document,
    escapeHTML: esc,
    getMarked: () => window.marked,
    location: window.location,
  });
  const markdownRenderOptions = previewContent.markdownRenderOptions;
  const previewDOM = window.VylkPreviewDOM.create({
    contentPolicy: previewContent,
    document,
    preview: $('#preview'),
    syncTaskCheckbox: syncPreviewTaskCheckbox,
  });
  previewModel = window.VylkPreviewModel.create({
    associate: (element, entry) => previewDecoration.associate(element, entry),
    decorate: decorateInteractivePreview,
    document,
    getMarked: () => window.marked,
    getRenderOptions: markdownRenderOptions,
    getSource: editorSourceValue,
    listItemRanges: window.VylkInteractive?.listItemRanges,
    preview: $('#preview'),
    scheduleHighlight,
    syncTaskCheckbox: syncPreviewTaskCheckbox,
    syncUI: syncInteractivePreviewUI,
    tokenTag: previewTokenTag,
    window,
  });
  previewState = previewModel.state;
  const cachePreviewBlocks = previewModel.cache;
  const cancelPreviewCache = previewModel.cancel;

  function interactiveEntryForElement(element) {
    if (!interactivePreviewSourceIsCurrent()) return null;
    const owner = element?.closest('[data-interactive-start]');
    return owner ? previewDecoration.entryForElement(owner) : null;
  }

  function interactivePreviewSourceIsCurrent() {
    const source = editorSourceValue();
    return previewRenderer?.source() === source && previewState.source === source;
  }

  function editPreviewEntry(entry) {
    const textarea = $('#note-content');
    if (!interactivePreviewSession.active() || !entry || !textarea) return false;
    if (previewDrag?.active()) cancelPreviewDrag({animateReturn: false});
    const position = previewEditPosition(entry, textarea.value);
    if (panelController.state() === 'zen' && panelController.zenView() === 'preview') {
      panelController.setZenView('editor');
      setPanelState('zen');
    } else if (panelController.state() === 'preview') {
      setPanelState('editor', {preservePanelWide: true});
    }
    textarea.setSelectionRange(position, position);
    textarea.focus({preventScroll: true});
    centerEditorCaretInView();
    scheduleHighlight();
    return true;
  }

  let previewActionPositionFrame = null;

  function updateInteractivePreviewActionPosition() {
    previewActionPositionFrame = null;
    const preview = $('#preview');
    const panel = $('#preview-panel');
    const selected = preview?.querySelector('.interactive-preview-card.is-selected');
    if (!preview || !panel || !selected || !window.matchMedia('(max-width: 640px)').matches) return;
    const panelRect = panel.getBoundingClientRect();
    const cardRect = selected.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    if (cardRect.bottom < previewRect.top || cardRect.top > previewRect.bottom) {
      if (!previewDrag?.active()) selectInteractivePreviewCard(null);
      return;
    }
    const trayWidth = 88;
    const trayHeight = 44;
    // The visible frame is inset 5px inside the touch targets.
    const frameInset = 5;
    const gap = 6;
    const rightEdge = Math.min(panelRect.right - 1, window.innerWidth);
    const leftEdge = Math.max(panelRect.left + 1, 0);
    const beside = cardRect.right + gap - frameInset + trayWidth <= rightEdge;
    const trayLeft = beside
      ? cardRect.right + gap - frameInset
      : Math.max(leftEdge, Math.min(cardRect.left - frameInset, rightEdge - trayWidth));
    const desiredTop = beside
      ? cardRect.top + (cardRect.height - trayHeight) / 2
      : cardRect.bottom + gap - frameInset;
    const trayTop = Math.max(
      previewRect.top,
      Math.min(desiredTop, previewRect.bottom - trayHeight),
    );
    preview.style.setProperty('--preview-action-tray-top', `${Math.round(trayTop)}px`);
    preview.style.setProperty('--preview-action-tray-left', `${Math.round(trayLeft)}px`);
  }

  function scheduleInteractivePreviewActionPosition() {
    if (previewActionPositionFrame !== null) return;
    previewActionPositionFrame = window.requestAnimationFrame(
      updateInteractivePreviewActionPosition,
    );
  }

  function selectInteractivePreviewCard(card) {
    $('#preview')
      .querySelectorAll('.interactive-preview-card.is-selected')
      .forEach((current) => {
        if (current !== card) current.classList.remove('is-selected');
      });
    card?.classList.add('is-selected');
    scheduleInteractivePreviewActionPosition();
  }

  window.addEventListener('resize', scheduleInteractivePreviewActionPosition, {passive: true});
  $('#preview').addEventListener('scroll', scheduleInteractivePreviewActionPosition, {
    passive: true,
  });
  if (typeof ResizeObserver === 'function') {
    const previewActionObserver = new ResizeObserver(scheduleInteractivePreviewActionPosition);
    previewActionObserver.observe($('#preview-panel'));
    previewActionObserver.observe($('#preview-panel .panel-header'));
  }

  $('#preview').addEventListener('click', (event) => {
    if (event.target.closest('.preview-drag-handle')) return;
    const editButton = event.target.closest('.preview-edit-button');
    if (interactivePreviewSession.active() && editButton) {
      event.preventDefault();
      event.stopPropagation();
      editPreviewEntry(interactiveEntryForElement(editButton));
      return;
    }
    const link = event.target.closest('a[data-wiki-title]');
    if (
      link &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      void followWikiLink(link.dataset.wikiTitle);
      return;
    }
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (
      interactivePreviewSession.active() &&
      checkbox &&
      !checkbox.disabled &&
      interactivePreviewSourceIsCurrent()
    ) {
      const item = checkbox.closest('li[data-interactive-start]');
      const entry = previewDecoration.entryForElement(item);
      const source = editorSourceValue();
      const change = window.VylkInteractive?.toggleTask(source, entry);
      if (!change) return;
      const applied = applyInteractiveSource(
        change.source,
        {
          start: change.start,
          removed: source.slice(change.start, change.end),
          inserted: change.inserted,
        },
        {preservePreview: true},
      );
      if (applied) {
        checkbox.setAttribute(
          'aria-label',
          change.checked ? 'Mark task incomplete' : 'Mark task complete',
        );
      }
      return;
    }
    if (
      interactivePreviewSession.active() &&
      window.matchMedia('(hover: none), (pointer: coarse)').matches
    ) {
      selectInteractivePreviewCard(event.target.closest('.interactive-preview-card'));
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (
      !interactivePreviewSession.active() ||
      event.target.closest('#preview .interactive-preview-card')
    )
      return;
    selectInteractivePreviewCard(null);
  });

  const previewDragLayout = window.VylkPreviewDragLayout;
  const previewAutoScrollDelta = previewDragLayout.autoScrollDelta;
  previewDrag = window.VylkPreviewDragController.create({
    applySource: applyInteractiveSource,
    decoration: previewDecoration,
    document,
    getEntries: () => [...previewState.blockItems, ...previewState.listItems],
    getSource: editorSourceValue,
    interactive: window.VylkInteractive,
    isActive: () => interactivePreviewSession.active(),
    isCurrent: interactivePreviewSourceIsCurrent,
    layout: previewDragLayout,
    onDrop: () => selectInteractivePreviewCard(null),
    preview: $('#preview'),
    setLocked: setInteractiveSourceLocked,
    window,
  });
  const cancelPreviewDrag = previewDrag.cancel;

  function targetUsesNativeUndo(target) {
    const editable = target?.closest?.('textarea, input, [contenteditable="true"]');
    if (!editable || editable === $('#note-content')) return false;
    if (editable.matches('textarea, [contenteditable="true"]')) return true;
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(editable.type);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && previewDrag.active()) {
      event.preventDefault();
      cancelPreviewDrag();
      return;
    }
    if (
      !interactivePreviewSession.active() ||
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== 'z'
    )
      return;
    if (targetUsesNativeUndo(event.target)) return;
    if (undoInteractivePreview()) event.preventDefault();
  });

  function setPreviewBusy(busy) {
    $('#preview')?.toggleAttribute('aria-busy', busy);
  }

  function cancelPendingPreviewRender() {
    previewWorkerClient?.cancel();
    cancelPreviewCache();
    previewRenderer?.cancelDOMRender();
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
  }

  previewRenderer = window.VylkPreviewRenderer.create({
    cacheBlocks: cachePreviewBlocks,
    contentPolicy: previewContent,
    disconnectDecorations: disconnectPreviewDecorationObserver,
    document,
    dom: previewDOM,
    getGeneration: () => previewWorkerClient?.generation() ?? 0,
    getPreviewBlocks: () => previewState.blocks,
    getSource: editorSourceValue,
    isVisible: isPreviewVisible,
    resetPreviewModel: () => {
      previewModel.reset();
    },
    scheduleHighlight,
    setHighlightPending: previewHighlighter.setPending,
    window,
  });
  const renderPreviewHTML = previewRenderer.render;

  previewWorkerClient = window.VylkPreviewWorkerClient.create({
    getSource: editorSourceValue,
    hasRenderedRanges: (source) =>
      source === previewRenderer?.source() && previewState.source === source,
    isVisible: isPreviewVisible,
    onFallback: updatePreview,
    onMetadata: (metadata) => {
      previewRenderer.setMetadata(metadata);
    },
    onRender: renderPreviewHTML,
    setBusy: setPreviewBusy,
    window,
  });

  function primePreviewMetadata(md) {
    previewWorkerClient.prime(md);
  }

  function requestPreviewRender({announceBusy = false} = {}) {
    previewTimer = null;
    if (!isPreviewVisible()) return;
    const md = editorSourceValue();
    if (md === previewRenderer.source()) {
      setPreviewBusy(false);
      scheduleHighlight();
      return;
    }
    previewWorkerClient.render(md, {announceBusy});
  }

  function updatePreview() {
    if (!isPreviewVisible()) return;
    const md = editorSourceValue();
    if (md === previewRenderer.source()) {
      scheduleHighlight();
      return;
    }
    cancelPendingPreviewRender();
    if (typeof marked !== 'undefined' && marked.parse) {
      renderPreviewHTML(md, marked.parse(md, markdownRenderOptions()));
      primePreviewMetadata(md);
    } else {
      $('#preview').innerHTML = '<p><em>loading parser...</em></p>';
      previewRenderer.setState(md, previewRenderer.metadata());
      previewHighlighter.setPending(false);
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
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // --- Theme and appearance ---
  const appearance = window.VylkAppearance.create({
    document,
    escapeHTML: esc,
    fontSizeOptions: FONT_SIZE_OPTIONS,
    getPrefs: () => prefs,
    onLayoutChange: scheduleEditorCaretCue,
    themes: Array.isArray(window.VylkThemes) ? window.VylkThemes : [],
    validFont: validFontValue,
  });

  function applyPrefs() {
    appearance.applyTheme(prefs.theme);
    void appearance.applyFonts();
    appearance.applyFontSizes();
    appearance.renderOptions();
    applyContentWidth();
    applyEditorPrefs();
  }

  appearance.renderOptions();
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
    preferencesDialog.open({route});
  }

  let preferencesDialog = null;

  const preferencesStore = window.VylkPreferencesStore.create({
    api,
    getPreferences: () => prefs,
    hasPendingOperation,
    localStorage,
    normalize: normalizePrefs,
    onChanged: (keys) => {
      const changed = new Set(keys);
      if (changed.has('theme') || changed.has('accentColor')) appearance.applyTheme(prefs.theme);
      if (
        [
          'fontFamily',
          'fontFamilyGoogle',
          'editorFontFamily',
          'editorFontFamilyGoogle',
          'previewFontFamily',
          'previewFontFamilyGoogle',
          'zenFontFamily',
          'zenFontFamilyGoogle',
        ].some((key) => changed.has(key))
      )
        void appearance.applyFonts(true);
      appearance.applyFontSizes();
      applyContentWidth();
      applyEditorPrefs();
      if (changed.has('autoSave') || changed.has('hideSaveButton'))
        updateManualSavePreferenceControl();
      if (
        changed.has('shortcutPrefix') ||
        changed.has('keyboardShortcuts') ||
        changed.has('shortcutConfirmationSkips')
      )
        renderShortcutPreferences();
    },
    onLoaded: () => {
      applyPrefs();
      renderShortcutPreferences();
    },
    queueOperation,
    scheduleSync,
    setPreferences: (next) => {
      prefs = next;
    },
  });

  function savePref(key, value) {
    return preferencesStore.save(key, value);
  }

  function restoreDefaultPrefs() {
    const defaults = {...DEFAULT_PREFS};
    delete defaults.revision;
    return preferencesStore.saveMany(defaults);
  }

  function updateManualSavePreferenceControl() {
    preferencesDialog?.updateManualSaveControl();
  }

  async function loadPrefs() {
    await preferencesStore.load();
  }

  // --- Commands and keyboard shortcuts ---
  function editorIsVisible() {
    return !screens.editor.classList.contains('hidden');
  }

  function setDetailsExpanded(expanded) {
    $('.meta-pane').classList.toggle('collapsed', !expanded);
    $('.meta-toggle').setAttribute('aria-expanded', String(expanded));
  }

  function focusPreview() {
    $('#preview').focus({preventScroll: true});
  }

  function focusSourceEditor() {
    if (panelController.state() === 'zen' && panelController.zenView() === 'preview') {
      panelController.setZenView('editor');
      setPanelState('zen');
    } else if (panelController.state() === 'preview') setPanelState('editor');
    focusCurrentSourceEditor();
  }

  function setWritingView(view) {
    if (panelController.state() === 'zen') {
      panelController.setZenView(view);
      setPanelState('zen');
      if (view === 'preview') focusPreview();
      else focusCurrentSourceEditor();
      return;
    }
    setPanelState(view);
    if (view === 'preview') focusPreview();
    else focusCurrentSourceEditor();
  }

  function switchEditorPreview() {
    if (panelController.state() === 'zen') {
      panelController.setZenView(panelController.zenView() === 'preview' ? 'editor' : 'preview');
      setPanelState('zen');
      if (panelController.zenView() === 'preview') focusPreview();
      else focusCurrentSourceEditor();
      return;
    }
    if (panelController.state() === 'editor') {
      setPanelState('preview');
      focusPreview();
      return;
    }
    if (panelController.state() === 'preview') {
      setPanelState('editor');
      focusCurrentSourceEditor();
      return;
    }
    if (document.activeElement?.closest?.('#preview-panel')) focusCurrentSourceEditor();
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

  function commandCanRun(command) {
    if (command.scope === 'global')
      return !screens.dashboard.classList.contains('hidden') || editorIsVisible();
    if (command.scope === 'editor') return editorIsVisible();
    return editorIsVisible() && !interactivePreviewSession.locked();
  }

  function hasOpenModal() {
    return [...$$('.modal')].some((modal) => !modal.classList.contains('hidden'));
  }

  const shortcutController = window.VylkShortcutController.create({
    commandCanRun,
    defaultPrefix: DEFAULT_PREFS.shortcutPrefix,
    document,
    escapeHTML: esc,
    getPreferences: () => prefs,
    hasOpenModal,
    onIntrusive: createNewNoteFromShortcut,
    onUnhandledEscape: () => {
      if (panelController.state() !== 'zen') return false;
      setPanelState(panelController.returnState());
      focusCurrentSourceEditor();
      return true;
    },
    savePreference: savePref,
    shortcuts: window.VylkShortcuts,
  });
  const shortcutCommands = shortcutController.commands;
  const shortcutCommandsByID = shortcutController.commandsByID;
  const registerShortcutCommand = shortcutController.register;
  const renderShortcutPreferences = shortcutController.render;
  const shortcutBindingFor = shortcutController.bindingFor;
  const shortcutPrefixBinding = shortcutController.prefixBinding;
  const executeShortcutCommand = shortcutController.execute;

  preferencesDialog = window.VylkPreferencesDialog.create({
    appearance,
    close: closePreferences,
    closeModal,
    document,
    getPreferences: () => prefs,
    openModal,
    renderShortcuts: renderShortcutPreferences,
    restoreDefaults: restoreDefaultPrefs,
    save: savePref,
    setRoute: setPreferencesRoute,
  });

  window.VylkDefaultCommands.create({
    createNote: createNewNoteFromShortcut,
    editTags: () => {
      setDetailsExpanded(true);
      const tags = $('#note-tags');
      tags.focus({preventScroll: true});
      tags.selectionStart = tags.selectionEnd = tags.value.length;
    },
    editTitle: () => {
      setDetailsExpanded(true);
      $('#note-title').focus({preventScroll: true});
      $('#note-title').select();
    },
    focusSource: focusSourceEditor,
    format: insertFmt,
    openPreferences,
    saveNote: () => {
      noteSaver.cancelAutoSave();
      return saveCurrentNote();
    },
    setSplitView: () => {
      setPanelState('both');
      focusCurrentSourceEditor();
    },
    setWritingView,
    switchEditorPreview,
  }).forEach(registerShortcutCommand);

  $('#shortcut-confirm-close').addEventListener('click', () =>
    closeModal($('#shortcut-confirm-modal')),
  );
  $('#shortcut-confirm-cancel').addEventListener('click', () =>
    closeModal($('#shortcut-confirm-modal')),
  );
  $('#shortcut-confirm-modal .modal-backdrop').addEventListener('click', () =>
    closeModal($('#shortcut-confirm-modal')),
  );
  $('#shortcut-confirm-continue').addEventListener('click', async () => {
    const skip = $('#shortcut-confirm-skip').checked;
    closeModal($('#shortcut-confirm-modal'));
    if (skip)
      await savePref('shortcutConfirmationSkips', {
        ...prefs.shortcutConfirmationSkips,
        'note.new': true,
      });
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

  /* __VYLK_TEST_HOOKS__ */
  if (!globalThis.__vylkDisableAutoInit) init();

  $$('.offline-retry').forEach((retry) =>
    retry.addEventListener('click', async () => {
      showOfflineNotice(true);
      const ok = await syncNow({preserveSnackbar: true});
      if (ok) showSyncCompleteToast();
    }),
  );

  // Service worker
  function registerServiceWorker(revision = feedback.currentRevision()) {
    if (!('serviceWorker' in navigator)) return;
    const requestedRevision = /^[A-Za-z0-9._-]{1,128}$/.test(revision || '') ? revision : 'legacy';
    if (registeredServiceWorkerRevision === requestedRevision) return;
    registeredServiceWorkerRevision = requestedRevision;
    navigator.serviceWorker
      .register(`/sw.js?revision=${encodeURIComponent(requestedRevision)}`, {
        updateViaCache: 'none',
      })
      .catch((error) => {
        registeredServiceWorkerRevision = null;
        console.warn('service worker registration failed', error);
      });
  }

  window.addEventListener('online', async () => {
    connectServerEvents();
    scheduleSync({reconcile: true});
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isDirty) saveCurrentNote(false);
      syncCoordinator.cancelScheduled();
      cancelActiveSyncRequests();
    }
    if (document.visibilityState === 'visible') {
      connectServerEvents();
      scheduleSync();
    }
  });

  setInterval(async () => {
    if (document.visibilityState !== 'visible' || syncCoordinator.inFlight()) return;
    try {
      const pending = (await pendingOperations()).length > 0;
      const sseHealthy = isServerEventsHealthy();
      const fallbackAge = sseHealthy ? healthySseFallbackSyncAgeMs : unhealthySseFallbackSyncAgeMs;
      const lastSuccessfulAt = syncCoordinator.lastSuccessfulAt();
      const stale = !lastSuccessfulAt || Date.now() - lastSuccessfulAt >= fallbackAge;
      if (pending || stale) scheduleSync({reconcile: !sseHealthy});
    } catch (error) {
      console.warn('periodic sync check failed', error);
    }
  }, 30000);
})();
