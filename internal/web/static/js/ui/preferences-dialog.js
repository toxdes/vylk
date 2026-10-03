(function (global) {
  'use strict';

  function create({
    appearance,
    beforeOpen,
    close,
    closeEncryptionDetail,
    closeModal,
    document,
    getPreferences,
    openModal,
    openEncryptionDetail,
    renderShortcuts,
    restoreDefaults,
    save,
    setRoute,
  }) {
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);
    const vaultDetails = new Set(['setup', 'passphrase', 'recovery']);
    let suppressSectionRoute = false;

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
      $('#pref-reduce-motion').value = preferences.reduceMotion;
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

    function selectSection(section) {
      const tab = $(`#prefs-tab-${section}`);
      if (tab) tab.click();
    }

    function selectDetail(detail, {push = false, updateRoute = true} = {}) {
      if (!vaultDetails.has(detail)) detail = null;
      if (updateRoute) setRoute({section: 'encryption', detail, push, replace: !push});
      if (detail) openEncryptionDetail(detail);
      else closeEncryptionDetail();
    }

    function open({route = 'push', section, detail = null} = {}) {
      if (route === 'push') {
        const ready = beforeOpen();
        if (ready?.then) {
          return ready.then((allowed) => {
            if (allowed) show({route, section, detail});
          });
        }
        if (!ready) return;
      }
      show({route, section, detail});
    }

    function show({route, section, detail}) {
      render();
      section ||= 'appearance';
      if (route === 'push') setRoute({section, detail});
      else if (route === 'replace') setRoute({section, detail, replace: true});
      const modal = $('#prefs-modal');
      const wasHidden = modal.classList.contains('hidden');
      if (wasHidden) openModal(modal);
      suppressSectionRoute = true;
      selectSection(section);
      suppressSectionRoute = false;
      if (section === 'encryption') selectDetail(detail, {updateRoute: false});
      if (wasHidden && !detail) $('#prefs-title').focus({preventScroll: true});
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
    bindValue('#pref-reduce-motion', 'reduceMotion');
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
        const tabs = [...$$('.prefs-nav')];
        const previous = tabs.findIndex((item) => item.classList.contains('active'));
        const returning = tabs.indexOf(button) < previous;
        $$('.prefs-nav').forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-selected', active ? 'true' : 'false');
          item.tabIndex = active ? 0 : -1;
        });
        $$('.prefs-section').forEach((panel) => {
          const active = panel.dataset.prefPanel === section;
          panel.classList.toggle('returning', active && returning);
          panel.classList.toggle('active', active);
          panel.hidden = !active;
          if (active && section === 'encryption') panel.scrollTop = 0;
        });
        $('#prefs-title').textContent = button.textContent;
        if (!suppressSectionRoute) closeEncryptionDetail();
        if (!suppressSectionRoute) setRoute({section, detail: null, replace: true});
        button.scrollIntoView?.({block: 'nearest', inline: 'center'});
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

    $('#vault-open-setup').addEventListener('click', () => selectDetail('setup', {push: true}));
    $('#vault-open-passphrase').addEventListener('click', () =>
      selectDetail('passphrase', {push: true}),
    );
    $('#vault-open-recovery').addEventListener('click', () =>
      selectDetail('recovery', {push: true}),
    );

    return {open, selectDetail, selectSection, updateManualSaveControl};
  }

  global.VylkPreferencesDialog = {create};
})(typeof window !== 'undefined' ? window : globalThis);
