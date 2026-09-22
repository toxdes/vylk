(function (global) {
  'use strict';

  function create({document, onInput, onLengthChange, window}) {
    const textarea = document.querySelector('#note-content');
    const zenElement = document.querySelector('#zen-source-editor');
    let zenEditor = null;

    function ensureZenEditor() {
      if (!zenEditor && zenElement && window.VylkZenEditor) {
        zenEditor = new window.VylkZenEditor(zenElement);
        zenEditor.addEventListener('input', (event) =>
          onInput({
            inputType: event.detail?.inputType || '',
            data: event.detail?.data ?? null,
            length: event.detail?.length ?? zenEditor.length,
          }),
        );
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
      const source = String(nextValue ?? '');
      textarea.value = source;
      textarea.setSelectionRange(selectionStart, selectionEnd);
      if (zenActive()) zenEditor.setValue(source, selectionStart, selectionEnd);
      onLengthChange(source.length);
    }

    function activateZen() {
      const editor = ensureZenEditor();
      if (!editor || editor.active) return;
      editor.setValue(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      editor.active = true;
    }

    function deactivateZen() {
      if (!zenActive()) return;
      const currentSelection = zenEditor.selection();
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
        window.requestAnimationFrame(() => zenEditor?.ensureSelectionVisible());
      } else textarea?.focus({preventScroll: true});
    }

    return {
      activateZen,
      deactivateZen,
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
