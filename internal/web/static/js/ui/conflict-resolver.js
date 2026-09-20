(function (root) {
  'use strict';

  function create({
    closeModal,
    document,
    getConflict,
    onAcceptDeletion,
    onKeepCopy,
    onKeepDeletedCopy,
    onSaveResolution,
    openModal,
  }) {
    const select = (selector) => document.querySelector(selector);
    const selectAll = (selector) => document.querySelectorAll(selector);
    let activeID = null;
    let selection = 'local';
    let kind = 'edit';

    function renderDiff(target, base, version, changedClass) {
      const baseLines = String(base || '').split('\n');
      const versionLines = String(version || '').split('\n');
      let prefix = 0;
      while (
        prefix < baseLines.length &&
        prefix < versionLines.length &&
        baseLines[prefix] === versionLines[prefix]
      )
        prefix++;
      let suffix = 0;
      while (
        suffix < baseLines.length - prefix &&
        suffix < versionLines.length - prefix &&
        baseLines[baseLines.length - suffix - 1] === versionLines[versionLines.length - suffix - 1]
      )
        suffix++;
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

    function close() {
      activeID = null;
      selection = 'local';
      kind = 'edit';
      closeModal(select('#conflict-modal'));
    }

    function setSelection(next) {
      selection = next;
      const localSelected = next === 'local';
      const remoteSelected = next === 'remote';
      select('.conflict-version-local').classList.toggle('is-selected', localSelected);
      select('.conflict-version-remote').classList.toggle('is-selected', remoteSelected);
      select('#conflict-use-local').setAttribute('aria-pressed', String(localSelected));
      select('#conflict-use-remote').setAttribute('aria-pressed', String(remoteSelected));
      select('#conflict-selection-status').textContent =
        next === 'local'
          ? 'Selected: this device. You can edit the result below.'
          : next === 'remote'
            ? 'Selected: other device. You can edit the result below.'
            : 'Custom result. You can continue editing it below.';
    }

    function fill(version, nextSelection) {
      select('#conflict-note-title').value = version.title || '';
      select('#conflict-note-tags').value = version.tags || '';
      select('#conflict-note-content').value = version.content || '';
      setSelection(nextSelection);
    }

    function showEdit(conflict) {
      kind = 'edit';
      activeID = conflict.note_id;
      select('#conflict-title').textContent = 'Resolve conflicting edits';
      select('.conflict-intro').textContent =
        'This note changed on another device while you were editing it. Review both versions, then save the result you want to keep.';
      select('#conflict-deleted-details').classList.add('hidden');
      selectAll(
        '.conflict-fields, .conflict-metadata-compare, .conflict-compare, #conflict-selection-status, .conflict-result, .conflict-base:not(#conflict-deleted-details)',
      ).forEach((element) => element.classList.remove('hidden'));
      select('#conflict-copy').className = 'btn-text';
      select('#conflict-copy').textContent = 'Keep as copy';
      select('#conflict-save').className = 'btn-primary';
      select('#conflict-save').textContent = 'Save resolution';
      fill(conflict.local, 'local');
      select('#conflict-local-metadata').textContent =
        `Title: ${conflict.local.title || 'Untitled'}\nTags: ${conflict.local.tags || 'None'}`;
      select('#conflict-remote-metadata').textContent =
        `Title: ${conflict.remote.title || 'Untitled'}\nTags: ${conflict.remote.tags || 'None'}`;
      renderDiff(
        select('#conflict-local-diff'),
        conflict.base.content,
        conflict.local.content,
        'conflict-line-local',
      );
      renderDiff(
        select('#conflict-remote-diff'),
        conflict.base.content,
        conflict.remote.content,
        'conflict-line-remote',
      );
      select('#conflict-base-content').textContent = conflict.base.content || '(empty note)';
      openModal(select('#conflict-modal'));
      select('#conflict-note-content').focus();
    }

    function showDeleted(conflict) {
      kind = 'remote-deleted';
      activeID = conflict.note_id;
      select('#conflict-title').textContent = 'Note deleted on another device';
      select('.conflict-intro').textContent =
        'Your changes are saved on this device. Choose whether to keep them as a new note or accept the deletion.';
      selectAll(
        '.conflict-fields, .conflict-metadata-compare, .conflict-compare, #conflict-selection-status, .conflict-result, .conflict-base',
      ).forEach((element) => element.classList.add('hidden'));
      select('#conflict-deleted-details').classList.remove('hidden');
      select('#conflict-deleted-content').textContent = [
        `Title: ${conflict.local.title || 'Untitled'}`,
        `Tags: ${conflict.local.tags || 'None'}`,
        '',
        conflict.local.content || '(empty note)',
      ].join('\n');
      select('#conflict-copy').className = 'btn-primary';
      select('#conflict-copy').textContent = 'Keep as new note';
      select('#conflict-save').className = 'btn-text danger';
      select('#conflict-save').textContent = 'Accept deletion';
      openModal(select('#conflict-modal'));
    }

    async function showFor(noteID) {
      const conflict = await getConflict(noteID);
      if (!conflict) return false;
      if (conflict.kind === 'remote-deleted') showDeleted(conflict);
      else showEdit(conflict);
      return true;
    }

    async function selectVersion(versionName) {
      const conflict = activeID && (await getConflict(activeID));
      if (conflict) fill(conflict[versionName], versionName);
    }

    select('#conflict-use-local').addEventListener('click', () => void selectVersion('local'));
    select('#conflict-use-remote').addEventListener('click', () => void selectVersion('remote'));
    ['#conflict-note-title', '#conflict-note-tags', '#conflict-note-content'].forEach(
      (selector) => {
        select(selector).addEventListener('input', () => {
          if (activeID && selection !== 'custom') setSelection('custom');
        });
      },
    );
    select('#conflict-save').addEventListener('click', () => {
      if (!activeID) return;
      if (kind === 'remote-deleted') {
        void onAcceptDeletion(activeID);
        return;
      }
      void onSaveResolution(activeID, {
        title: select('#conflict-note-title').value,
        tags: select('#conflict-note-tags').value,
        content: select('#conflict-note-content').value,
      });
    });
    select('#conflict-copy').addEventListener('click', () => {
      if (!activeID) return;
      void (kind === 'remote-deleted' ? onKeepDeletedCopy(activeID) : onKeepCopy(activeID));
    });
    select('#conflict-later').addEventListener('click', close);
    select('#conflict-close').addEventListener('click', close);
    select('#conflict-modal .modal-backdrop').addEventListener('click', close);

    return {close, showDeleted, showEdit, showFor};
  }

  root.VylkConflictResolver = {create};
})(typeof window !== 'undefined' ? window : globalThis);
