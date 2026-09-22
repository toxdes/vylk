(function (global) {
  'use strict';

  function create({
    appearance,
    close,
    closeModal,
    document,
    getPreferences,
    openModal,
    renderShortcuts,
    restoreDefaults,
    save,
    setRoute,
  }) {
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);

    function updateManualSaveControl() {
      const preferences = getPreferences();
      const control = $('#pref-hidesave');
      const copy = $('#pref-manual-save-copy');
      if (!control || !copy) return;
      control.checked = preferences.autoSave ? !preferences.hideSaveButton : true;
      control.disabled = !preferences.autoSave;
      copy.textContent = preferences.autoSave
        ? 'Show a control for syncing changes now.'
        : 'Manual Save stays available while automatic sync is off.';
    }

    function render() {
      const preferences = getPreferences();
      appearance.renderOptions();
      $('#pref-autosave').checked = preferences.autoSave;
      $('#pref-start-view').value = preferences.startView;
      $('#pref-hidetoolbar').checked = !preferences.hideToolbar;
      updateManualSaveControl();
      $('#pref-save-location').value = preferences.saveButtonLocation;
      $('#pref-collapse').checked = preferences.collapseDetails;
      $('#pref-hidecursor').checked = preferences.hideCursorHighlight;
      $('#pref-interactive-preview').checked = preferences.interactivePreview;
      $('#pref-status').value = preferences.statusDisplay;
      $('#pref-content-width').value = preferences.contentWidth;
      $('#pref-zen-page-width').value = preferences.zenPageWidth;
      $('#pref-theme').value = preferences.theme;
      $('#pref-accent').value =
        preferences.accentColor || appearance.themeAccent(preferences.theme) || '#ae2448';
      $('#pref-accent-mode').value = preferences.accentColor ? 'custom' : 'theme';
      $('#pref-accent').hidden = !preferences.accentColor;
      $('#pref-zen-word-count').checked = preferences.zenWordCount;
      $('#pref-zen-show-title').checked = preferences.zenShowTitle;
      $('#pref-zen-show-controls').checked = preferences.zenShowControls;
      renderShortcuts();
    }

    function open({route = 'push'} = {}) {
      render();
      if (route === 'push') setRoute();
      openModal($('#prefs-modal'));
    }

    function closeRestoreDefaults() {
      closeModal($('#restore-defaults-modal'));
    }

    function bindCheckbox(selector, key, invert = false, afterSave = null) {
      $(selector).addEventListener('change', function () {
        const task = save(key, invert ? !this.checked : this.checked);
        if (afterSave) void task.then(afterSave);
      });
    }

    function bindValue(selector, key) {
      $(selector).addEventListener('change', function () {
        void save(key, this.value);
      });
    }

    $('#prefs-btn').addEventListener('click', open);
    $('#editor-prefs-btn').addEventListener('click', open);
    $('#prefs-close').addEventListener('click', close);
    $('#prefs-modal .modal-backdrop').addEventListener('click', close);
    $('#prefs-restore-defaults').addEventListener('click', () =>
      openModal($('#restore-defaults-modal')),
    );
    $('#restore-defaults-close').addEventListener('click', closeRestoreDefaults);
    $('#restore-defaults-cancel').addEventListener('click', closeRestoreDefaults);
    $('#restore-defaults-modal .modal-backdrop').addEventListener('click', closeRestoreDefaults);
    $('#restore-defaults-confirm').addEventListener('click', async function () {
      this.disabled = true;
      try {
        await restoreDefaults();
        render();
        closeRestoreDefaults();
      } finally {
        this.disabled = false;
      }
    });
    bindCheckbox('#pref-autosave', 'autoSave', false, updateManualSaveControl);
    bindValue('#pref-start-view', 'startView');
    bindCheckbox('#pref-hidetoolbar', 'hideToolbar', true);
    bindCheckbox('#pref-hidesave', 'hideSaveButton', true);
    bindValue('#pref-save-location', 'saveButtonLocation');
    bindCheckbox('#pref-collapse', 'collapseDetails');
    bindCheckbox('#pref-hidecursor', 'hideCursorHighlight');
    bindCheckbox('#pref-interactive-preview', 'interactivePreview');
    bindCheckbox('#pref-zen-word-count', 'zenWordCount');
    bindCheckbox('#pref-zen-show-title', 'zenShowTitle');
    bindCheckbox('#pref-zen-show-controls', 'zenShowControls');
    bindValue('#pref-theme', 'theme');
    bindValue('#pref-accent', 'accentColor');
    bindValue('#pref-status', 'statusDisplay');
    bindValue('#pref-content-width', 'contentWidth');
    bindValue('#pref-zen-page-width', 'zenPageWidth');

    $('#pref-accent-mode').addEventListener('change', function () {
      const color = $('#pref-accent');
      if (this.value === 'theme') {
        void save('accentColor', '');
        color.hidden = true;
        return;
      }
      color.hidden = false;
      void save('accentColor', color.value);
    });
    appearance.bindFontControls((key, value) => void save(key, value));

    $$('.prefs-nav').forEach((button) =>
      button.addEventListener('click', () => {
        const section = button.dataset.prefSection;
        $$('.prefs-nav').forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-selected', active ? 'true' : 'false');
          item.tabIndex = active ? 0 : -1;
        });
        $$('.prefs-section').forEach((panel) => {
          const active = panel.dataset.prefPanel === section;
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        });
        $('#prefs-title').textContent = button.textContent;
      }),
    );
    $$('.prefs-nav').forEach((button) =>
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...$$('.prefs-nav')];
        const current = tabs.indexOf(button);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault();
        tabs[next].focus();
        tabs[next].click();
      }),
    );

    return {open, updateManualSaveControl};
  }

  global.VylkPreferencesDialog = {create};
})(typeof window !== 'undefined' ? window : globalThis);
