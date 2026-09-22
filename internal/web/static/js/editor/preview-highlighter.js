(function (global) {
  'use strict';

  function create({
    decorateEntry,
    document,
    getPanelState,
    getPreferences,
    getPreviewState,
    getRenderedSource,
    getSelection,
    getSource,
    getZenView,
    isEditorVisible,
    isInteractive,
    measureCaret,
    navigation,
    requestPreviewRender,
    window,
  }) {
    let previewCheckFrame = null;
    let highlightFrame = null;
    let suppressNextAlignment = false;
    let highlightPending = false;

    function isVisible() {
      const panelState = getPanelState();
      return (
        isEditorVisible() &&
        (panelState === 'both' ||
          panelState === 'preview' ||
          (panelState === 'zen' && getZenView() === 'preview'))
      );
    }

    function schedulePreviewCheck() {
      if (previewCheckFrame !== null) return;
      previewCheckFrame = window.requestAnimationFrame(() => {
        previewCheckFrame = null;
        requestPreviewRender();
      });
    }

    function scheduleHighlight() {
      if (highlightFrame !== null) return;
      highlightFrame = window.requestAnimationFrame(() => {
        highlightFrame = null;
        highlight();
      });
    }

    function clear() {
      document
        .querySelector('#preview')
        ?.querySelector('.highlight')
        ?.classList.remove('highlight');
    }

    function taskCheckbox(item) {
      const body = item.querySelector(
        ':scope > .interactive-preview-list-card > .preview-list-content > .preview-list-item-body',
      );
      return (
        item.querySelector(
          ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
        ) ||
        body?.querySelector('input[type="checkbox"]') ||
        null
      );
    }

    function syncTaskCheckbox(item) {
      const checkbox = taskCheckbox(item);
      if (!checkbox) return;
      checkbox.disabled = !isInteractive();
      checkbox.setAttribute(
        'aria-label',
        checkbox.checked ? 'Mark task incomplete' : 'Mark task complete',
      );
    }

    function alignWithCaret(block, range) {
      const preview = document.querySelector('#preview');
      const caret = measureCaret();
      if (!caret || !preview.clientHeight || !preview.scrollHeight) return;
      const previewRect = preview.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      const sourceLength = Math.max(1, range.end - range.start);
      const sourceProgress = Math.min(
        1,
        Math.max(0, (getSelection().start - range.start) / sourceLength),
      );
      const adjustment = navigation.scrollAdjustment({
        previewTop: previewRect.top,
        previewHeight: preview.clientHeight,
        previewScrollTop: preview.scrollTop,
        previewScrollHeight: preview.scrollHeight,
        anchorTop: blockRect.top + blockRect.height * sourceProgress,
        caretTop: caret.top + caret.height / 2,
        margin: Math.max(caret.lineHeight * 2, Math.min(96, preview.clientHeight * 0.18)),
        deadband: caret.lineHeight * 2,
      });
      if (adjustment) preview.scrollTop += adjustment;
    }

    function highlight() {
      if (!isVisible()) return;
      const skipAlignment = suppressNextAlignment;
      suppressNextAlignment = false;
      if (getPreferences().hideCursorHighlight) {
        clear();
        return;
      }
      const source = getSource();
      const position = getSelection().start;
      const state = getPreviewState();
      if (!source || !/\S/.test(source) || !state.blocks.length) {
        clear();
        highlightPending = false;
        return;
      }
      if (getRenderedSource() !== source || state.source !== source) {
        if (!highlightPending) clear();
        return;
      }
      highlightPending = false;
      clear();
      const index = navigation.blockIndexAtPosition(state.ranges, position);
      const block = state.blocks[index];
      if (!block) return;
      let range = state.ranges[index];
      if (isInteractive() && !['UL', 'OL'].includes(block.tagName)) {
        decorateEntry(state.blockItems.find((entry) => entry.start === range?.start));
      }
      let target = isInteractive() ? block.closest('.interactive-preview-card') || block : block;
      if (['UL', 'OL'].includes(block.tagName)) {
        const listItem = navigation.listItemAtPosition(state.listItems, position, source.length);
        if (listItem?.element?.isConnected) {
          if (isInteractive()) decorateEntry(listItem);
          range = listItem;
          target = isInteractive() ? listItem.card || listItem.element : listItem.element;
        }
      }
      target.classList.add('highlight');
      if (!skipAlignment) alignWithCaret(target, range);
    }

    return {
      highlight,
      isVisible,
      scheduleHighlight,
      schedulePreviewCheck,
      setPending: (pending) => {
        highlightPending = pending;
      },
      suppressNextAlignment: () => {
        suppressNextAlignment = true;
      },
      syncTaskCheckbox,
    };
  }

  global.VylkPreviewHighlighter = {create};
})(typeof window !== 'undefined' ? window : globalThis);
