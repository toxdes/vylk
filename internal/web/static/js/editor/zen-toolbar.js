(function (global) {
  'use strict';

  const actions = [
    ['bold', 'Bold', 'bold'],
    ['italic', 'Italic', 'italic'],
    ['strike', 'Strikethrough', 'strikethrough'],
    ['link', 'Link', 'link'],
    ['code', 'Inline code', 'code'],
  ];
  const kinds = {bold: 'strong', italic: 'em', strike: 'del'};

  function create({document, window, getEditor, isLocked, onUnsupported = () => {}}) {
    const toolbar = document.createElement('div');
    toolbar.id = 'zen-selection-toolbar';
    toolbar.className = 'zen-selection-toolbar';
    toolbar.hidden = true;
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Format selected text');
    toolbar.setAttribute('aria-keyshortcuts', 'Alt+F10');
    for (const [action, label, icon] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.zenFormat = action;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-${icon}"></use></svg>`;
      toolbar.append(button);
    }
    const popup = document.createElement('div');
    popup.id = 'zen-link-popup';
    popup.className = 'zen-link-popup';
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Edit link');
    popup.innerHTML = `<form>
      <label for="zen-link-url" class="sr-only">Link URL</label>
      <div class="zen-link-fields">
      <input id="zen-link-url" type="text" inputmode="url" autocomplete="off"
        spellcheck="false" placeholder="https://example.com" aria-describedby="zen-link-error">
      <button type="submit" aria-label="Apply link" title="Apply link">
        <svg class="icon" aria-hidden="true"><use href="#icon-check"></use></svg>
      </button></div>
      <p id="zen-link-error" role="alert" hidden></p>
      </form>`;
    document.body.append(toolbar, popup);
    const input = popup.querySelector('input');
    const error = popup.querySelector('#zen-link-error');
    const listeners = new window.AbortController();
    const {signal} = listeners;
    let saved = null;
    let anchor = null;
    let frame = null;
    let dismissed = null;

    function available() {
      const editor = getEditor();
      return editor?.active &&
        !editor.composing &&
        !editor.selecting &&
        !isLocked() &&
        !editor.element.closest('.hidden, .panel-hidden')
        ? editor
        : null;
    }

    function hide() {
      toolbar.hidden = popup.hidden = true;
      saved = anchor = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    }

    function place(element, rect) {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const gutter = 8;
      element.style.left = `${Math.max(left + gutter, Math.min(rect.left + rect.width / 2 - element.offsetWidth / 2, left + width - element.offsetWidth - gutter))}px`;
      let y = rect.top - element.offsetHeight - gutter;
      if (y < top + gutter) y = rect.bottom + gutter;
      element.style.top = `${Math.max(top + gutter, Math.min(y, top + height - element.offsetHeight - gutter))}px`;
    }

    function selectedLink(editor, selection) {
      return editor.linkAt?.(selection.start, selection.end) || null;
    }

    function update() {
      frame = null;
      const editor = available();
      if (!editor) return hide();
      if (!popup.hidden || toolbar.contains(document.activeElement)) return;
      const selection = window.getSelection();
      if (
        !selection?.rangeCount ||
        !editor.element.contains(selection.anchorNode) ||
        !editor.element.contains(selection.focusNode)
      )
        return hide();
      const offsets = editor.selection();
      if (
        dismissed?.editor === editor &&
        dismissed.revision === editor.documentRevision &&
        dismissed.start === offsets.start &&
        dismissed.end === offsets.end
      )
        return;
      dismissed = null;
      const link = selectedLink(editor, offsets);
      if (selection.isCollapsed && !link) return hide();
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();
      const rect = offsets.direction === 'backward' ? rects[0] : rects[rects.length - 1];
      anchor = rect || editor.caretRect();
      const bounds = editor.element.getBoundingClientRect();
      if (
        !anchor ||
        document.activeElement !== editor.element ||
        anchor.bottom < bounds.top ||
        anchor.top > bounds.bottom
      )
        return hide();
      toolbar.hidden = false;
      for (const button of toolbar.querySelectorAll('button')) {
        button.disabled = selection.isCollapsed && button.dataset.zenFormat !== 'link';
        if (button.dataset.zenFormat === 'link') {
          button.disabled = !editor.canLinkSelection(offsets.start, offsets.end);
          button.setAttribute('aria-label', link ? 'Edit link' : 'Link');
          button.title = button.disabled
            ? 'Select text on one line without spanning existing links'
            : link
              ? 'Edit link'
              : 'Link';
        }
      }
      place(toolbar, anchor);
    }

    function schedule() {
      if (!available()) return hide();
      if (frame === null) frame = window.requestAnimationFrame(update);
    }

    function restore(editor, selection) {
      editor.focus();
      editor.setSelection(selection.start, selection.end, selection.direction);
    }

    function closeLink() {
      const previous = saved;
      hide();
      if (previous && available() === previous.editor) restore(previous.editor, previous.selection);
    }

    function openLink() {
      const editor = available();
      if (!editor) return;
      const selection = editor.selection();
      if (!editor.canLinkSelection(selection.start, selection.end)) return;
      const link = selectedLink(editor, selection);
      // Insertion is a selection action; an existing link also works at a caret.
      if (!link && selection.start === selection.end) return;
      saved = {editor, selection, link, value: editor.value, revision: editor.documentRevision};
      anchor ||= editor.caretRect();
      toolbar.hidden = true;
      popup.hidden = false;
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      input.value = link?.href || '';
      if (anchor) place(popup, anchor);
      input.focus({preventScroll: true});
      input.select();
    }

    function format(type) {
      if (type === 'link') return openLink();
      const editor = available();
      const kind = kinds[type];
      if (!editor || (!kind && type !== 'code')) return;
      const {start, end, direction} = editor.selection();
      if (start === end) return;
      const change =
        type === 'code'
          ? codeChange(editor, start, end)
          : editor.inlineFormatChange(start, end, kind);
      if (!change) return;
      if (change.unsupported) {
        onUnsupported(
          'Markdown cannot represent this formatting exactly. Select complete words or spans.',
        );
        return;
      }
      hide();
      editor.replaceRange(change.start, change.end, change.inserted, {
        inputType: 'insertReplacementText',
      });
      restore(editor, {...change.selection, direction});
      schedule();
    }

    function codeChange(editor, start, end) {
      const value = editor.value;
      const pieces = editor.inlineSegments(start, end).flatMap((piece) => {
        const text = value.slice(piece.start, piece.end);
        if (!text.trim()) return [];
        let from = piece.start + text.length - text.trimStart().length;
        let to = piece.end - (text.length - text.trimEnd().length);
        let inner = value.slice(from, to);
        let wrapped = false;
        const before = value.slice(piece.boundStart, from);
        const after = value.slice(to, piece.boundEnd);
        const opening = before.match(/(`+) ?$/);
        const closing = after.match(/^ ?(`+)/);
        const marker = opening?.[1] || inner.match(/^(`+)/)?.[1] || '`';
        let prefix = marker;
        let suffix = marker;
        const leftOutside =
          from - marker.length >= piece.boundStart &&
          value.slice(from - marker.length, from) === marker;
        const rightOutside =
          to + marker.length <= piece.boundEnd && value.slice(to, to + marker.length) === marker;
        if (opening && closing && opening[1] === closing[1]) {
          from -= opening[0].length;
          to += closing[0].length;
          prefix = opening[0];
          suffix = closing[0];
          wrapped = true;
        } else if (
          (leftOutside || inner.startsWith(marker)) &&
          (rightOutside || inner.endsWith(marker)) &&
          inner.length > (leftOutside ? 0 : marker.length) + (rightOutside ? 0 : marker.length)
        ) {
          inner = value.slice(
            from + (leftOutside ? 0 : marker.length),
            to - (rightOutside ? 0 : marker.length),
          );
          if (leftOutside) from -= marker.length;
          if (rightOutside) to += marker.length;
          wrapped = true;
        }
        if (!wrapped) {
          const delimiter = inner.includes('`')
            ? '`'.repeat(Math.max(...(inner.match(/`+/g) || []).map((run) => run.length)) + 1)
            : marker;
          const padding = inner.startsWith('`') || inner.endsWith('`') ? ' ' : '';
          prefix = delimiter + padding;
          suffix = padding + delimiter;
        }
        return [{start: from, end: to, inner, wrapped, prefix, suffix}];
      });
      if (!pieces.length) return null;
      const removing = pieces.every((piece) => piece.wrapped);
      const first = pieces[0];
      const last = pieces.at(-1);
      let insertion = value.slice(first.start, last.end);
      for (const piece of [...pieces].reverse()) {
        const replacement = removing ? piece.inner : piece.prefix + piece.inner + piece.suffix;
        insertion =
          insertion.slice(0, piece.start - first.start) +
          replacement +
          insertion.slice(piece.end - first.start);
      }
      return {
        start: first.start,
        end: last.end,
        inserted: insertion,
        selection: {
          start: first.start + (removing ? 0 : first.prefix.length),
          end: first.start + insertion.length - (removing ? 0 : last.suffix.length),
        },
      };
    }

    function applyLink() {
      const state = saved;
      if (
        !state ||
        available() !== state.editor ||
        state.editor.value !== state.value ||
        state.editor.documentRevision !== state.revision
      )
        return hide();
      const unlink = !input.value.trim();
      const href = global.VylkMarkdownLinks.inputHref(input.value);
      if (!unlink && !href) {
        error.textContent = 'Enter a valid web, email, phone, or relative URL.';
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        if (anchor) place(popup, anchor);
        return;
      }
      const {editor, selection, link, value} = state;
      if (unlink && !link) return closeLink();
      const start = link?.start ?? selection.start;
      const end = link?.end ?? selection.end;
      const label = link ? value.slice(link.labelStart, link.labelEnd) : value.slice(start, end);
      const insertion = unlink
        ? label
        : `[${label}](${global.VylkMarkdownLinks.destination(href)})`;
      hide();
      if (insertion !== value.slice(start, end))
        editor.replaceRange(start, end, insertion, {inputType: 'insertReplacementText'});
      restore(editor, {start: start + insertion.length, end: start + insertion.length});
    }

    toolbar.addEventListener('pointerdown', (event) => event.preventDefault(), {signal});
    toolbar.addEventListener(
      'click',
      (event) => {
        const action = event.target.closest('[data-zen-format]')?.dataset.zenFormat;
        if (action) format(action);
      },
      {signal},
    );
    toolbar.addEventListener(
      'keydown',
      (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...toolbar.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      },
      {signal},
    );
    popup.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        applyLink();
      },
      {signal},
    );
    input.addEventListener(
      'input',
      () => {
        if (!input.hasAttribute('aria-invalid')) return;
        if (input.value.trim() && !global.VylkMarkdownLinks.inputHref(input.value)) return;
        input.removeAttribute('aria-invalid');
        error.hidden = true;
        if (anchor) place(popup, anchor);
      },
      {signal},
    );
    popup.addEventListener(
      'focusout',
      (event) => {
        if (!popup.hidden && !popup.contains(event.relatedTarget)) hide();
      },
      {signal},
    );
    document.addEventListener('selectionchange', schedule, {signal});
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!toolbar.contains(event.target) && !popup.contains(event.target)) {
          dismissed = null;
          hide();
        }
      },
      {signal},
    );
    // Capture before the application's Escape handler, so dismissing a popup
    // never also exits Zen mode or triggers a document shortcut in the URL field.
    document.addEventListener(
      'keydown',
      (event) => {
        if (!toolbar.hidden && event.altKey && event.key === 'F10') {
          event.preventDefault();
          event.stopImmediatePropagation();
          toolbar.querySelector('button:not(:disabled)')?.focus();
        } else if ((!popup.hidden || !toolbar.hidden) && event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!popup.hidden) closeLink();
          else {
            const editor = available();
            if (editor)
              dismissed = {...editor.selection(), editor, revision: editor.documentRevision};
            hide();
            editor?.focus();
          }
        } else if (!popup.hidden && popup.contains(event.target) && event.key !== 'Tab') {
          event.stopPropagation();
        }
      },
      {capture: true, signal},
    );
    document.addEventListener(
      'scroll',
      () => {
        if (!popup.hidden && anchor) place(popup, anchor);
        else schedule();
      },
      {capture: true, passive: true, signal},
    );
    window.addEventListener(
      'resize',
      () => {
        // Mobile keyboards may resize the viewport while this input is focused.
        if (!popup.hidden && anchor) place(popup, anchor);
        else hide();
      },
      {signal},
    );
    window.visualViewport?.addEventListener(
      'resize',
      () => {
        if (!popup.hidden && anchor) place(popup, anchor);
        else schedule();
      },
      {signal},
    );

    return {
      format,
      hide,
      destroy() {
        hide();
        listeners.abort();
        toolbar.remove();
        popup.remove();
      },
    };
  }

  global.VylkZenToolbar = {create};
})(typeof window !== 'undefined' ? window : globalThis);
