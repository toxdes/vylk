(function (root) {
  'use strict';

  function noteTags(tags) {
    return (tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function noteHasTag(note, tag) {
    return noteTags(note.tags).includes(tag);
  }

  function create({document, emptyState, escapeHTML, formatDate, onOpen, onPin}) {
    const list = document.querySelector('#note-list');
    const tagBar = document.querySelector('#tag-bar');
    let activeTag = null;
    let currentNotes = [];
    let currentConflicts = new Set();

    function fingerprint(note) {
      return JSON.stringify([
        note.id,
        note.title || '',
        note.updated_at || '',
        note.tags || '',
        Boolean(note.pinned),
        currentConflicts.has(note.id),
      ]);
    }

    function updateRow(row, note) {
      const nextFingerprint = fingerprint(note);
      if (row.dataset.fingerprint === nextFingerprint) return;
      row.dataset.noteId = note.id;
      row.dataset.fingerprint = nextFingerprint;

      const noteButton = row.querySelector(':scope > .note-item');
      noteButton.dataset.id = note.id;
      const title = noteButton.querySelector('.note-title');
      title.replaceChildren(document.createTextNode(note.title || 'Untitled'));
      if (currentConflicts.has(note.id)) {
        const conflict = document.createElement('span');
        conflict.className = 'note-conflict';
        conflict.textContent = 'Conflict';
        title.append(conflict);
      }
      noteButton.querySelector('.note-meta').textContent = formatDate(note.updated_at);

      const tags = noteTags(note.tags);
      let tagList = noteButton.querySelector('.note-tags');
      if (tags.length) {
        if (!tagList) {
          tagList = document.createElement('div');
          tagList.className = 'note-tags';
          noteButton.append(tagList);
        }
        tagList.replaceChildren(
          ...tags.map((tag) => {
            const label = document.createElement('span');
            label.className = 'tag';
            label.textContent = tag;
            return label;
          }),
        );
      } else {
        tagList?.remove();
      }

      const pin = row.querySelector(':scope > .note-pin');
      const pinned = Boolean(note.pinned);
      pin.dataset.id = note.id;
      pin.setAttribute('aria-pressed', String(pinned));
      pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} note`);
      pin.title = `${pinned ? 'Unpin' : 'Pin'} note`;
      pin.innerHTML = `<svg class="icon pin-icon" aria-hidden="true"><use href="#icon-${pinned ? 'pinned' : 'pin'}"></use></svg><svg class="icon unpin-icon" aria-hidden="true"><use href="#icon-pinned-off"></use></svg>`;
    }

    function createRow(note) {
      const row = document.createElement('li');
      row.className = 'note-item-row';
      row.dataset.noteId = note.id;

      const noteButton = document.createElement('button');
      noteButton.type = 'button';
      noteButton.className = 'note-item';
      noteButton.dataset.id = note.id;

      const title = document.createElement('div');
      title.className = 'note-title';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      noteButton.append(title, meta);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'note-pin';
      row.append(noteButton, pin);
      updateRow(row, note);
      return row;
    }

    function reconcileNotes(notes) {
      if (notes.length === 0) {
        const state = emptyState();
        const message =
          state === 'loading'
            ? 'Loading notes…'
            : state === 'offline-empty'
              ? 'No notes are available on this device yet.'
              : 'No notes yet';
        const existing = list.querySelector(':scope > .note-empty');
        if (list.childElementCount === 1 && existing?.textContent === message) return;
        const item = document.createElement('li');
        item.className = 'note-empty';
        item.textContent = message;
        list.replaceChildren(item);
        return;
      }

      const existing = new Map(
        [...list.querySelectorAll(':scope > .note-item-row')].map((row) => [
          row.dataset.noteId,
          row,
        ]),
      );
      const rows = notes.map((note) => {
        const row = existing.get(note.id) || createRow(note);
        existing.delete(note.id);
        updateRow(row, note);
        return row;
      });
      rows.forEach((row, index) => {
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      });
      const desiredRows = new Set(rows);
      [...list.children].forEach((row) => {
        if (!desiredRows.has(row)) row.remove();
      });
    }

    function renderTags(notes) {
      const tags = [...new Set(notes.flatMap((note) => noteTags(note.tags)))].sort((left, right) =>
        left.localeCompare(right),
      );
      if (activeTag && !tags.includes(activeTag)) activeTag = null;
      let html = `<button type="button" class="tag${activeTag ? '' : ' active'}" data-tag="" aria-pressed="${activeTag ? 'false' : 'true'}">All</button>`;
      tags.forEach((tag) => {
        const active = tag === activeTag ? ' active' : '';
        html += `<button type="button" class="tag${active}" data-tag="${escapeHTML(tag)}" aria-pressed="${active ? 'true' : 'false'}">${escapeHTML(tag)}</button>`;
      });
      tagBar.innerHTML = html;
    }

    function render(notes, conflicts) {
      currentNotes = notes;
      currentConflicts = conflicts;
      renderTags(notes);
      reconcileNotes(activeTag ? notes.filter((note) => noteHasTag(note, activeTag)) : notes);
    }

    function clearMissingActiveTag(notes) {
      if (activeTag && !notes.some((note) => noteHasTag(note, activeTag))) activeTag = null;
    }

    tagBar.addEventListener('click', (event) => {
      const tag = event.target.closest('.tag');
      if (!tag) return;
      activeTag = tag.dataset.tag || null;
      render(currentNotes, currentConflicts);
    });
    list.addEventListener('click', (event) => {
      const pin = event.target.closest('.note-pin');
      if (pin) {
        event.stopPropagation();
        onPin(pin.dataset.id);
        return;
      }
      const note = event.target.closest('.note-item');
      if (note) onOpen(note.dataset.id);
    });

    return {clearMissingActiveTag, render};
  }

  root.VylkDashboard = {create, noteHasTag};
})(typeof window !== 'undefined' ? window : globalThis);
