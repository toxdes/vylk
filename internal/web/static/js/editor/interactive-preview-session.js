(function (global) {
  'use strict';

  function create({
    cancelDecorations,
    cancelDrag,
    cancelRenderDelay,
    document,
    getPanelState,
    getPreferences,
    getPreviewState,
    getRenderer,
    highlighter,
    isPreviewVisible,
    requestRender,
    window,
  }) {
    let active = false;
    let sourceLocked = false;
    let sourceMutation = false;
    let history = [];

    function syncUI() {
      const textarea = document.querySelector('#note-content');
      const preview = document.querySelector('#preview');
      if (!textarea || !preview) return;
      textarea.readOnly = sourceLocked;
      textarea.setAttribute(
        'aria-label',
        sourceLocked ? 'Markdown source, read-only during drag' : 'Markdown note content',
      );
      preview.classList.toggle('interactive-preview-active', active);
      document
        .querySelector('.fmt-bar')
        ?.classList.toggle('interactive-preview-locked', sourceLocked);
    }

    function reset() {
      cancelDrag();
      cancelDecorations();
      getRenderer()?.setMetadata(null);
      highlighter.setPending(false);
      active = false;
      sourceLocked = false;
      history = [];
      const previewState = getPreviewState();
      previewState.listItems = [];
      previewState.blockItems = [];
      syncUI();
    }

    function syncMode() {
      const enabled = getPanelState() !== 'zen' && getPreferences().interactivePreview;
      if (enabled === active) {
        syncUI();
        return false;
      }
      if (!enabled) cancelDrag();
      active = enabled;
      history = [];
      getRenderer()?.invalidate({metadata: true});
      syncUI();
      return true;
    }

    function setLocked(locked) {
      sourceLocked = Boolean(locked && active);
      syncUI();
    }

    function updatePreservingViewport() {
      const preview = document.querySelector('#preview');
      const scrollTop = preview?.scrollTop || 0;
      highlighter.suppressNextAlignment();
      requestRender();
      if (preview) preview.scrollTop = scrollTop;
    }

    function applySource(nextSource, transaction, {preservePreview = false} = {}) {
      const textarea = document.querySelector('#note-content');
      const before = textarea.value;
      if (!transaction || !nextSource || nextSource === before) return false;
      const renderer = getRenderer();
      const previewState = getPreviewState();
      const preserveRenderedPreview =
        preservePreview &&
        nextSource.length === before.length &&
        isPreviewVisible() &&
        renderer?.source() === before &&
        previewState.source === before;
      const preservedBlockRanges = preserveRenderedPreview ? previewState.ranges : null;
      history.push({
        ...transaction,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      });
      if (history.length > 50) history.shift();
      sourceMutation = true;
      textarea.value = nextSource;
      textarea.dispatchEvent(new window.Event('input', {bubbles: true}));
      sourceMutation = false;
      cancelRenderDelay();
      if (preserveRenderedPreview) {
        renderer.setState(nextSource, null);
        previewState.source = nextSource;
        previewState.ranges = preservedBlockRanges;
        highlighter.suppressNextAlignment();
        highlighter.scheduleHighlight();
        return true;
      }
      updatePreservingViewport();
      return true;
    }

    function undo() {
      const transaction = history.pop();
      const textarea = document.querySelector('#note-content');
      if (!transaction || !textarea) return false;
      const current = textarea.value;
      if (
        current.slice(transaction.start, transaction.start + transaction.inserted.length) !==
        transaction.inserted
      ) {
        history = [];
        return false;
      }
      const restored =
        current.slice(0, transaction.start) +
        transaction.removed +
        current.slice(transaction.start + transaction.inserted.length);
      sourceMutation = true;
      textarea.value = restored;
      textarea.selectionStart = transaction.selectionStart;
      textarea.selectionEnd = transaction.selectionEnd;
      textarea.dispatchEvent(new window.Event('input', {bubbles: true}));
      sourceMutation = false;
      cancelRenderDelay();
      updatePreservingViewport();
      return true;
    }

    return {
      active: () => active,
      applySource,
      clearHistory: () => {
        history = [];
      },
      locked: () => sourceLocked,
      mutating: () => sourceMutation,
      reset,
      setLocked,
      syncMode,
      syncUI,
      undo,
    };
  }

  global.VylkInteractivePreviewSession = {create};
})(typeof window !== 'undefined' ? window : globalThis);
