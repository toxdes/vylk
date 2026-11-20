(function (global) {
  'use strict';

  function create({document, onInput, onLengthChange, window}) {
    const textarea = document.querySelector('#note-content');
    const zenElement = document.querySelector('#zen-source-editor');
    let zenEditor = null;
    let writingPosition = null;
    let restoredScroll = false;

    function ensureZenEditor() {
      if (!zenEditor && zenElement && window.VylkZenEditor) {
        zenEditor = new window.VylkZenEditor(zenElement);
        zenEditor.setValue(textarea.value, textarea.selectionStart, textarea.selectionEnd);
        zenEditor.addEventListener('input', (event) => {
          // Synchronizing the inactive editor on a view change is not a new
          // user edit; its textarea change has already been saved/queued.
          if (!zenEditor.active) return;
          onInput({
            inputType: event.detail?.inputType || '',
            data: event.detail?.data ?? null,
            length: event.detail?.length ?? zenEditor.length,
          });
        });
      }
      return zenEditor;
    }

    function zenActive() {
      return Boolean(zenEditor?.active);
    }

    function value() {
      return zenActive() ? zenEditor.value : textarea?.value || '';
    }

    function selection() {
      if (zenActive()) return zenEditor.selection();
      return {
        start: textarea?.selectionStart || 0,
        end: textarea?.selectionEnd || 0,
        direction: textarea?.selectionDirection || 'none',
      };
    }

    function setValue(nextValue, selectionStart = 0, selectionEnd = selectionStart) {
      writingPosition = null;
      restoredScroll = false;
      const source = String(nextValue ?? '');
      textarea.value = source;
      textarea.setSelectionRange(selectionStart, selectionEnd);
      // Setting a note snapshot is a document boundary, including while Zen is
      // inactive. Never carry one note's undo history into another note.
      if (zenEditor) {
        zenEditor.setValue(source, selectionStart, selectionEnd);
        zenElement.scrollTop = 0;
      }
      onLengthChange(source.length);
    }

    function activateZen() {
      const editor = ensureZenEditor();
      if (!editor || editor.active) return;
      if (
        editor.value !== textarea.value ||
        writingPosition?.selection.start !== textarea.selectionStart ||
        writingPosition?.selection.end !== textarea.selectionEnd ||
        (textarea.selectionStart !== textarea.selectionEnd &&
          writingPosition?.selection.direction !== textarea.selectionDirection)
      )
        writingPosition = null;
      editor.applyValue(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.selectionDirection,
      );
      const visibleOffset = (offset) => {
        const link = editor.linkAt(offset);
        return link?.safeHref && offset > link.labelEnd ? link.end : offset;
      };
      const start = visibleOffset(textarea.selectionStart);
      const end = visibleOffset(textarea.selectionEnd);
      if (start !== textarea.selectionStart || end !== textarea.selectionEnd)
        editor.setSelection(start, end, textarea.selectionDirection);
      editor.cancelTypingAnchor();
      editor.active = true;
    }

    function suspendZenWriting() {
      if (!zenActive() || writingPosition) return;
      if (zenEditor.composing) zenEditor.finishComposition();
      const selection = zenEditor.selection();
      writingPosition = {selection, scrollTop: zenElement.scrollTop};
      zenEditor.clearEditingState();
    }

    function resumeZenWriting() {
      if (!zenActive() || !writingPosition) return;
      const {selection, scrollTop} = writingPosition;
      writingPosition = null;
      zenEditor.setSelection(selection.start, selection.end, selection.direction);
      zenElement.scrollTop = scrollTop;
      restoredScroll = true;
      window.requestAnimationFrame(() => {
        restoredScroll = false;
      });
    }

    function resetZenSession() {
      writingPosition = null;
      restoredScroll = false;
      zenEditor?.resetSession();
    }

    function deactivateZen() {
      if (!zenActive()) return;
      suspendZenWriting();
      const currentSelection = writingPosition.selection;
      textarea.value = zenEditor.value;
      textarea.setSelectionRange(
        currentSelection.start,
        currentSelection.end,
        currentSelection.direction,
      );
      zenEditor.active = false;
    }

    function focus() {
      if (zenActive()) {
        zenEditor.focus({preventScroll: true});
        if (!restoredScroll)
          window.requestAnimationFrame(() => zenEditor?.ensureSelectionVisible());
      } else textarea?.focus({preventScroll: true});
    }

    return {
      activateZen,
      deactivateZen,
      suspendZenWriting,
      resumeZenWriting,
      resetZenSession,
      focus,
      selection,
      setValue,
      textarea,
      value,
      zenActive,
      zenEditor: () => zenEditor,
    };
  }

  global.VylkEditorSource = {create};
})(typeof window !== 'undefined' ? window : globalThis);
