(function (global) {
  'use strict';

  function create({
    activateZen,
    cancelDrag,
    cancelZenCaret,
    cancelZenWordCount,
    document,
    focusPreview,
    focusSource,
    getPreferences,
    getPreviewSource,
    getSource,
    localStorage,
    onExecuteCommand,
    onPanelChanged,
    renderPreview,
    scheduleCaret,
    schedulePreviewCheck,
    updateZenOverlays,
    window,
  }) {
    let panelState = 'both';
    let zenReturnState = 'editor';
    let zenView = 'editor';
    let panelRatio = Math.min(
      0.8,
      Math.max(0.2, Number(localStorage.getItem('vylk-panel-ratio')) || 0.5),
    );

    const query = (selector) => document.querySelector(selector);

    function placeViewControls() {
      const controls = query('#view-controls');
      const editorActions = query('#editor-panel .panel-header-actions');
      const previewActions = query('#preview-view-controls-slot');
      if (!controls || !editorActions || !previewActions) return;
      (panelState === 'preview' ? previewActions : editorActions).prepend(controls);
    }

    function placeSaveButton() {
      const preferences = getPreferences();
      const saveButton = query('#save-btn');
      const headerSlot = query('#header-save-slot');
      const panelSlot = query('#panel-save-slot');
      const previewSlot = query('#preview-save-slot');
      const panelActions = query('#editor-panel .panel-header-actions');
      if (!saveButton || !headerSlot || !panelSlot || !previewSlot || !panelActions) return;
      const previewOnly = panelState === 'preview';
      saveButton.disabled = previewOnly;
      saveButton.setAttribute('aria-disabled', String(previewOnly));
      if (preferences.saveButtonLocation === 'header') {
        headerSlot.append(saveButton);
        return;
      }
      (previewOnly ? previewSlot : panelSlot).append(saveButton);
      if (!previewOnly) panelActions.append(panelSlot);
    }

    function applyRatio() {
      query('#editor-panels').style.setProperty(
        '--editor-panel-width',
        `${Math.round(panelRatio * 1000) / 10}%`,
      );
      query('#panel-resizer').setAttribute('aria-valuenow', String(Math.round(panelRatio * 100)));
    }

    function setRatio(ratio) {
      panelRatio = Math.min(0.8, Math.max(0.2, ratio));
      localStorage.setItem('vylk-panel-ratio', String(panelRatio));
      applyRatio();
    }

    function setState(state) {
      cancelDrag();
      const wasZen = panelState === 'zen';
      if (wasZen && state !== 'zen') activateZen(false);
      if (state === 'zen' && !wasZen) {
        zenReturnState = panelState === 'preview' ? 'editor' : panelState;
        zenView = 'editor';
      }
      panelState = state;
      if (state === 'zen' && !wasZen) activateZen(true);

      const visibleState = state === 'zen' ? zenView : state;
      const wrap = query('#editor-panels');
      const editor = query('.panel-editor');
      const preview = query('.panel-preview');
      wrap.classList.remove('panels-single');
      editor.classList.remove('panel-hidden');
      preview.classList.remove('panel-hidden');
      if (visibleState === 'editor') {
        preview.classList.add('panel-hidden');
        wrap.classList.add('panels-single');
      } else if (visibleState === 'preview') {
        editor.classList.add('panel-hidden');
        wrap.classList.add('panels-single');
      }
      query('#editor').classList.toggle('zen-mode', state === 'zen');
      query('#editor').classList.toggle('header-hidden', state === 'zen');
      const interactiveModeChanged = onPanelChanged();
      placeViewControls();
      placeSaveButton();
      document.querySelectorAll('.view-control').forEach((button) => {
        const active =
          state === button.dataset.panel || (state === 'zen' && button.dataset.panel === 'zen');
        button.setAttribute('aria-pressed', String(active));
      });
      document
        .querySelectorAll(
          '.zen-controls [data-zen-action="editor"], .zen-controls [data-zen-action="preview"]',
        )
        .forEach((button) => {
          button.setAttribute(
            'aria-pressed',
            String(state === 'zen' && button.dataset.zenAction === zenView),
          );
        });
      if (state === 'zen') updateZenOverlays();
      else {
        cancelZenCaret();
        cancelZenWordCount();
      }
      applyRatio();
      scheduleCaret();
      if (visibleState !== 'editor') {
        if (state === 'zen' || interactiveModeChanged || getSource() !== getPreviewSource()) {
          renderPreview();
        } else schedulePreviewCheck();
      }
    }

    query('#editor-panels').addEventListener('click', (event) => {
      const button = event.target.closest('.view-control');
      if (!button) return;
      const commandID = {
        editor: 'view.write',
        both: 'view.split',
        preview: 'view.preview',
        zen: 'view.zen',
      }[button.dataset.panel];
      void onExecuteCommand(commandID);
    });

    query('.zen-controls').addEventListener('click', (event) => {
      const action = event.target.closest('[data-zen-action]')?.dataset.zenAction;
      if (!action) return;
      if (action === 'exit') {
        setState(zenReturnState);
        focusSource();
      } else {
        zenView = action;
        setState('zen');
      }
      if (action === 'editor') focusSource();
      else if (action === 'preview') focusPreview();
    });

    const resizer = query('#panel-resizer');
    resizer.addEventListener('pointerdown', (event) => {
      if (panelState !== 'both' || window.matchMedia('(max-width: 640px)').matches) return;
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      query('#editor-panels').classList.add('resizing');
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      const bounds = query('#editor-panels').getBoundingClientRect();
      setRatio((event.clientX - bounds.left) / bounds.width);
    });
    const finishResize = (event) => {
      if (resizer.hasPointerCapture(event.pointerId))
        resizer.releasePointerCapture(event.pointerId);
      query('#editor-panels').classList.remove('resizing');
    };
    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);
    resizer.addEventListener('keydown', (event) => {
      const ratios = {
        ArrowLeft: panelRatio - 0.05,
        ArrowRight: panelRatio + 0.05,
        Home: 0.2,
        End: 0.8,
      };
      if (!(event.key in ratios)) return;
      event.preventDefault();
      setRatio(ratios[event.key]);
    });
    applyRatio();

    return {
      placeSaveButton,
      returnState: () => zenReturnState,
      setState,
      setZenView: (view) => {
        zenView = view;
      },
      state: () => panelState,
      zenView: () => zenView,
    };
  }

  global.VylkPanelController = {create};
})(typeof window !== 'undefined' ? window : globalThis);
