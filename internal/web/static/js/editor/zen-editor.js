(function (global) {
  'use strict';

  const SHOW_TEXT = global.NodeFilter?.SHOW_TEXT || 4;

  function appendText(parent, value, className = '') {
    if (!value) return;
    const node = className ? document.createElement('span') : document.createTextNode(value);
    if (className) {
      node.className = className;
      node.textContent = value;
    }
    parent.append(node);
  }

  function closingMarker(text, marker, start) {
    let index = start;
    while ((index = text.indexOf(marker, index)) >= 0) {
      if (text[index - 1] !== '\\' && index > start && !/\s/.test(text[index - 1])) return index;
      index += marker.length;
    }
    return -1;
  }

  function nextInlineToken(text, start) {
    for (let index = start; index < text.length; index++) {
      if (text[index] === '\\') {
        index++;
        continue;
      }
      const candidates = text.startsWith('***', index)
        ? [['***', 'zen-md-strong zen-md-em']]
        : text.startsWith('___', index)
          ? [['___', 'zen-md-strong zen-md-em']]
          : text.startsWith('**', index)
            ? [['**', 'zen-md-strong']]
            : text.startsWith('__', index)
              ? [['__', 'zen-md-strong']]
              : text.startsWith('~~', index)
                ? [['~~', 'zen-md-strike']]
                : text[index] === '*'
                  ? [['*', 'zen-md-em']]
                  : text[index] === '_'
                    ? [['_', 'zen-md-em']]
                    : text[index] === '`'
                      ? [['`', 'zen-md-code']]
                      : [];
      for (const [marker, className] of candidates) {
        const contentStart = index + marker.length;
        if (contentStart >= text.length || /\s/.test(text[contentStart])) continue;
        const end = closingMarker(text, marker, contentStart);
        if (end >= 0) return {start: index, end, marker, className};
        if (!/[*_~`]/.test(text[contentStart])) {
          return {start: index, end: text.length, marker, className, provisional: true};
        }
      }
    }
    return null;
  }

  function appendInline(parent, text) {
    let offset = 0;
    while (offset < text.length) {
      const token = nextInlineToken(text, offset);
      if (!token) {
        appendText(parent, text.slice(offset));
        return;
      }
      appendText(parent, text.slice(offset, token.start));
      appendText(parent, token.marker, 'zen-md-marker');
      const content = document.createElement('span');
      content.className = token.className;
      const inner = text.slice(token.start + token.marker.length, token.end);
      if (token.className === 'zen-md-code') content.textContent = inner;
      else appendInline(content, inner);
      parent.append(content);
      if (!token.provisional) appendText(parent, token.marker, 'zen-md-marker');
      offset = token.end + token.marker.length;
    }
  }

  function structuralLineKind(source) {
    const heading = source.match(/^ {0,3}(#{1,6})\s+/);
    if (heading) return `heading-${heading[1].length}`;
    if (/^ {0,3}> ?/.test(source)) return 'quote';
    return 'plain';
  }

  function renderLineContent(element, source) {
    element.className = 'zen-editor-line';
    element.replaceChildren();
    if (!source) {
      element.append(document.createElement('br'));
      return;
    }
    const heading = source.match(/^( {0,3})(#{1,6})(\s+)(.*)$/);
    if (heading) {
      element.classList.add('zen-md-heading', `zen-md-h${heading[2].length}`);
      appendText(element, heading[1]);
      appendText(element, heading[2], 'zen-md-marker zen-md-heading-marker');
      appendText(element, heading[3]);
      appendInline(element, heading[4]);
      return;
    }
    const quote = source.match(/^( {0,3})(>)( ?)(.*)$/);
    if (quote) {
      element.classList.add('zen-md-quote');
      appendText(element, quote[1]);
      appendText(element, quote[2], 'zen-md-marker zen-md-quote-marker');
      appendText(element, quote[3]);
      appendInline(element, quote[4]);
      return;
    }
    if (!/[*_~`]/.test(source)) {
      appendText(element, source);
      return;
    }
    appendInline(element, source);
  }

  class FenwickTree {
    constructor(values) {
      this.values = new Array(values.length).fill(0);
      this.tree = new Array(values.length + 1).fill(0);
      values.forEach((value, index) => this.add(index, value));
    }

    add(index, delta) {
      this.values[index] = (this.values[index] || 0) + delta;
      for (let cursor = index + 1; cursor < this.tree.length; cursor += cursor & -cursor)
        this.tree[cursor] += delta;
    }

    set(index, value) {
      this.add(index, value - this.values[index]);
    }

    prefix(index) {
      let total = 0;
      for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) total += this.tree[cursor];
      return total;
    }

    locate(offset) {
      let index = 0;
      let total = 0;
      let bit = 1;
      while (bit * 2 < this.tree.length) bit *= 2;
      for (; bit; bit >>= 1) {
        const next = index + bit;
        if (next < this.tree.length && total + this.tree[next] <= offset) {
          index = next;
          total += this.tree[next];
        }
      }
      const line = Math.min(index, this.values.length - 1);
      return {line, offset: offset - total};
    }
  }

  class ZenEditor extends EventTarget {
    constructor(element) {
      super();
      this.element = element;
      this.lines = [];
      this.offsets = new FenwickTree([1]);
      this.cachedValue = '';
      this.active = false;
      this.composing = false;
      this.composingLine = null;
      this.history = [];
      this.future = [];
      this.lastSelection = {start: 0, end: 0, direction: 'none'};
      this.activeLine = null;
      this.typingAnchorFrame = null;
      this.smoothTypingAnchorUntil = 0;
      element.contentEditable = 'true';
      element.spellcheck = true;
      element.setAttribute('role', 'textbox');
      element.setAttribute('aria-multiline', 'true');
      element.setAttribute('aria-label', 'Markdown note content');
      element.setAttribute('autocapitalize', 'sentences');
      element.setAttribute('enterkeyhint', 'enter');
      element.addEventListener('beforeinput', (event) => this.onBeforeInput(event));
      element.addEventListener('pointerdown', (event) => {
        if (event.button === 0 && event.isPrimary !== false) this.smoothNextTypingAnchor = true;
      });
      element.addEventListener('keydown', (event) => this.onKeyDown(event));
      element.addEventListener('keyup', (event) => this.onKeyUp(event));
      element.addEventListener('paste', (event) => this.onPaste(event));
      element.addEventListener('copy', (event) => this.onCopy(event));
      element.addEventListener('cut', (event) => this.onCut(event));
      element.addEventListener('compositionstart', () => {
        this.composing = true;
        const selection = global.getSelection?.();
        this.composingLine =
          selection?.focusNode && this.element.contains(selection.focusNode)
            ? (selection.focusNode.nodeType === Node.ELEMENT_NODE
                ? selection.focusNode
                : selection.focusNode.parentElement
              )?.closest?.('.zen-editor-line')
            : null;
      });
      element.addEventListener('compositionend', () => this.finishComposition());
      document.addEventListener('selectionchange', () => this.updateActiveLine());
      this.setValue('');
    }

    get value() {
      if (this.cachedValue === null)
        this.cachedValue = this.lines.map((line) => line.text).join('\n');
      return this.cachedValue;
    }

    get length() {
      return Math.max(0, this.offsets.prefix(this.lines.length) - 1);
    }

    get selectionStart() {
      return this.selection().start;
    }

    get selectionEnd() {
      return this.selection().end;
    }

    setValue(value, selectionStart = 0, selectionEnd = selectionStart) {
      const source = String(value ?? '');
      const fragment = document.createDocumentFragment();
      this.lines = source.split('\n').map((text, index) => {
        const element = document.createElement('div');
        const line = {text, index, element};
        element.__zenLine = line;
        renderLineContent(element, text);
        fragment.append(element);
        return line;
      });
      if (!this.lines.length) {
        const element = document.createElement('div');
        this.lines = [{text: '', index: 0, element}];
        element.__zenLine = this.lines[0];
        renderLineContent(element, '');
        fragment.append(element);
      }
      this.offsets = new FenwickTree(this.lines.map((line) => line.text.length + 1));
      this.cachedValue = source;
      this.history = [];
      this.future = [];
      this.element.replaceChildren(fragment);
      this.element.classList.toggle('is-empty', source.length === 0);
      this.setSelection(selectionStart, selectionEnd);
    }

    focus(options = {preventScroll: true}) {
      this.element.focus(options);
    }

    selection() {
      const selection = global.getSelection?.();
      if (
        !selection?.rangeCount ||
        !this.element.contains(selection.anchorNode) ||
        !this.element.contains(selection.focusNode)
      ) {
        return {...this.lastSelection};
      }
      const anchor = this.pointOffset(selection.anchorNode, selection.anchorOffset);
      const focus = this.pointOffset(selection.focusNode, selection.focusOffset);
      this.lastSelection = {
        start: Math.min(anchor, focus),
        end: Math.max(anchor, focus),
        direction: anchor > focus ? 'backward' : 'forward',
      };
      return {...this.lastSelection};
    }

    pointOffset(node, offset) {
      const lineElement = (
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
      )?.closest?.('.zen-editor-line');
      const line = lineElement?.__zenLine;
      if (!line) return 0;
      const range = document.createRange();
      range.setStart(lineElement, 0);
      try {
        range.setEnd(node, offset);
      } catch (_) {
        range.setEnd(lineElement, lineElement.childNodes.length);
      }
      return Math.min(this.length, this.offsets.prefix(line.index) + range.toString().length);
    }

    domPoint(offset) {
      const location = this.offsets.locate(Math.max(0, Math.min(this.length, offset)));
      const line = this.lines[location.line];
      let remaining = Math.min(line.text.length, location.offset);
      const walker = document.createTreeWalker(line.element, SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (remaining <= node.data.length) return {node, offset: remaining};
        remaining -= node.data.length;
      }
      return {node: line.element, offset: line.element.childNodes.length};
    }

    setSelection(start, end = start, direction = 'forward') {
      const selection = global.getSelection?.();
      if (!selection) return;
      const first = this.domPoint(direction === 'backward' ? end : start);
      const last = this.domPoint(direction === 'backward' ? start : end);
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.collapse(true);
      selection.addRange(range);
      if (typeof selection.extend === 'function') selection.extend(last.node, last.offset);
      else {
        range.setEnd(last.node, last.offset);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.lastSelection = {start: Math.min(start, end), end: Math.max(start, end), direction};
      this.updateActiveLine();
    }

    caretRect() {
      const selection = global.getSelection?.();
      if (!selection?.rangeCount || !this.element.contains(selection.focusNode)) return null;
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(false);
      const lineElement = (
        selection.focusNode.nodeType === Node.ELEMENT_NODE
          ? selection.focusNode
          : selection.focusNode.parentElement
      )?.closest?.('.zen-editor-line');
      return range.getClientRects()[0] || lineElement?.getBoundingClientRect() || null;
    }

    ensureSelectionVisible() {
      if (!this.active || document.activeElement !== this.element) return;
      const caretRect = this.caretRect();
      if (!caretRect) return;
      const editorRect = this.element.getBoundingClientRect();
      const inset = Math.max(8, Number.parseFloat(getComputedStyle(this.element).lineHeight) || 0);
      if (caretRect.top < editorRect.top + inset)
        this.element.scrollTop -= editorRect.top + inset - caretRect.top;
      else if (caretRect.bottom > editorRect.bottom - inset)
        this.element.scrollTop += caretRect.bottom - editorRect.bottom + inset;
    }

    scheduleTypingAnchor({smooth = false} = {}) {
      if (smooth) this.smoothNextTypingAnchor = true;
      if (this.typingAnchorFrame !== null) return;
      this.typingAnchorFrame = global.requestAnimationFrame(() => {
        this.typingAnchorFrame = null;
        if (!this.active || document.activeElement !== this.element) return;
        const now = global.performance?.now?.() || 0;
        if (now < this.smoothTypingAnchorUntil) return;
        const smoothNext = this.smoothNextTypingAnchor;
        this.smoothNextTypingAnchor = false;
        const caretRect = this.caretRect();
        if (!caretRect) return;
        const editorRect = this.element.getBoundingClientRect();
        const caretCenter = caretRect.top + caretRect.height / 2;
        const relativePosition = (caretCenter - editorRect.top) / editorRect.height;
        const comfortTop = 0.3;
        const comfortBottom = 0.6;
        if (relativePosition >= comfortTop && relativePosition <= comfortBottom) return;
        const maxScrollTop = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
        const targetScrollTop = Math.max(
          0,
          Math.min(
            maxScrollTop,
            this.element.scrollTop + caretCenter - (editorRect.top + editorRect.height * 0.42),
          ),
        );
        if (Math.abs(targetScrollTop - this.element.scrollTop) <= 1) return;
        const smooth =
          smoothNext && !global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (smooth && typeof this.element.scrollTo === 'function') {
          this.smoothTypingAnchorUntil = now + 250;
          this.element.scrollTo({top: targetScrollTop, behavior: 'smooth'});
        } else this.element.scrollTop = targetScrollTop;
      });
    }

    textBetween(start, end) {
      if (end <= start) return '';
      const first = this.offsets.locate(start);
      const last = this.offsets.locate(end);
      if (first.line === last.line)
        return this.lines[first.line].text.slice(first.offset, last.offset);
      const parts = [this.lines[first.line].text.slice(first.offset)];
      for (let index = first.line + 1; index < last.line; index++)
        parts.push(this.lines[index].text);
      parts.push(this.lines[last.line].text.slice(0, last.offset));
      return parts.join('\n');
    }

    replaceRange(start, end, inserted, {inputType = 'insertText', record = true} = {}) {
      const safeStart = Math.max(0, Math.min(this.length, start));
      const safeEnd = Math.max(safeStart, Math.min(this.length, end));
      const replacement = String(inserted ?? '');
      const removed = this.textBetween(safeStart, safeEnd);
      const first = this.offsets.locate(safeStart);
      const last = this.offsets.locate(safeEnd);
      const combined =
        this.lines[first.line].text.slice(0, first.offset) +
        replacement +
        this.lines[last.line].text.slice(last.offset);
      const nextTexts = combined.split('\n');
      if (first.line === last.line && nextTexts.length === 1) {
        const line = this.lines[first.line];
        const startPoint = this.domPoint(safeStart);
        const endPoint = this.domPoint(safeEnd);
        const syntaxChanged = /[*_~`#>]/.test(removed + replacement);
        const structuralStyleChanged =
          structuralLineKind(line.text) !== structuralLineKind(nextTexts[0]);
        const marker = line.element.querySelector('.zen-md-marker');
        const inlineStyleStarted =
          !marker && /[*_~`]/.test(nextTexts[0]) && Boolean(nextInlineToken(nextTexts[0], 0));
        if (
          !syntaxChanged &&
          !structuralStyleChanged &&
          !inlineStyleStarted &&
          !marker &&
          startPoint.node === endPoint.node &&
          startPoint.node.nodeType === Node.TEXT_NODE
        ) {
          startPoint.node.data =
            startPoint.node.data.slice(0, startPoint.offset) +
            replacement +
            startPoint.node.data.slice(endPoint.offset);
          line.text = nextTexts[0];
          this.offsets.set(first.line, line.text.length + 1);
          this.cachedValue = null;
          this.element.classList.toggle('is-empty', this.length === 0);
          const selection = global.getSelection?.();
          selection?.collapse(startPoint.node, startPoint.offset + replacement.length);
          this.lastSelection = {
            start: safeStart + replacement.length,
            end: safeStart + replacement.length,
            direction: 'none',
          };
          if (record && (removed || replacement)) {
            this.history.push({start: safeStart, removed, inserted: replacement});
            if (this.history.length > 200) this.history.shift();
            this.future = [];
          }
          this.dispatchEvent(
            new CustomEvent('input', {detail: {inputType, data: replacement, length: this.length}}),
          );
          this.scheduleTypingAnchor();
          return;
        }
        line.text = nextTexts[0];
        renderLineContent(line.element, line.text);
        this.offsets.set(first.line, line.text.length + 1);
        this.cachedValue = null;
        this.element.classList.toggle('is-empty', this.length === 0);
        const caret = safeStart + replacement.length;
        this.setSelection(caret, caret);
        if (record && (removed || replacement)) {
          this.history.push({start: safeStart, removed, inserted: replacement});
          if (this.history.length > 200) this.history.shift();
          this.future = [];
        }
        this.dispatchEvent(
          new CustomEvent('input', {detail: {inputType, data: replacement, length: this.length}}),
        );
        this.scheduleTypingAnchor();
        return;
      }
      const removedLines = this.lines.slice(first.line, last.line + 1);
      const anchor = removedLines.at(-1).element.nextSibling;
      removedLines.forEach((line) => line.element.remove());
      const fragment = document.createDocumentFragment();
      const nextLines = nextTexts.map((text) => {
        const element = document.createElement('div');
        const line = {text, index: 0, element};
        element.__zenLine = line;
        renderLineContent(element, text);
        fragment.append(element);
        return line;
      });
      this.element.insertBefore(fragment, anchor);
      this.lines.splice(first.line, removedLines.length, ...nextLines);
      for (let index = first.line; index < this.lines.length; index++)
        this.lines[index].index = index;
      this.offsets = new FenwickTree(this.lines.map((line) => line.text.length + 1));
      this.cachedValue = null;
      this.element.classList.toggle('is-empty', this.length === 0);
      const caret = safeStart + replacement.length;
      this.setSelection(caret, caret);
      if (record && (removed || replacement)) {
        this.history.push({start: safeStart, removed, inserted: replacement});
        if (this.history.length > 200) this.history.shift();
        this.future = [];
      }
      this.dispatchEvent(
        new CustomEvent('input', {detail: {inputType, data: replacement, length: this.length}}),
      );
      this.scheduleTypingAnchor();
    }

    replaceSelection(inserted, inputType = 'insertText') {
      const selection = this.selection();
      this.replaceRange(selection.start, selection.end, inserted, {inputType});
    }

    deleteBackward(selection, byWord = false) {
      if (selection.start !== selection.end)
        return this.replaceRange(selection.start, selection.end, '', {
          inputType: 'deleteContentBackward',
        });
      if (!selection.start) return;
      let start = selection.start - 1;
      if (byWord) {
        const before = this.value.slice(0, selection.start);
        start = before.search(/\S+\s*$/);
        if (start < 0) start = 0;
      }
      this.replaceRange(start, selection.end, '', {
        inputType: byWord ? 'deleteWordBackward' : 'deleteContentBackward',
      });
    }

    deleteForward(selection, byWord = false) {
      if (selection.start !== selection.end)
        return this.replaceRange(selection.start, selection.end, '', {
          inputType: 'deleteContentForward',
        });
      if (selection.end >= this.length) return;
      let end = selection.end + 1;
      if (byWord) {
        const match = this.value.slice(selection.end).match(/^\s*\S+/);
        end = selection.end + (match?.[0].length || 1);
      }
      this.replaceRange(selection.start, end, '', {
        inputType: byWord ? 'deleteWordForward' : 'deleteContentForward',
      });
    }

    undo() {
      const transaction = this.history.pop();
      if (!transaction) return;
      this.replaceRange(
        transaction.start,
        transaction.start + transaction.inserted.length,
        transaction.removed,
        {inputType: 'historyUndo', record: false},
      );
      this.future.push(transaction);
    }

    redo() {
      const transaction = this.future.pop();
      if (!transaction) return;
      this.replaceRange(
        transaction.start,
        transaction.start + transaction.removed.length,
        transaction.inserted,
        {inputType: 'historyRedo', record: false},
      );
      this.history.push(transaction);
    }

    onBeforeInput(event) {
      if (!this.active || this.composing || event.defaultPrevented) return;
      const selection = this.selection();
      const type = event.inputType || '';
      if (type === 'historyUndo') {
        event.preventDefault();
        this.undo();
      } else if (type === 'historyRedo') {
        event.preventDefault();
        this.redo();
      } else if (type.startsWith('deleteWordBackward')) {
        event.preventDefault();
        this.deleteBackward(selection, true);
      } else if (type.startsWith('deleteWordForward')) {
        event.preventDefault();
        this.deleteForward(selection, true);
      } else if (type.startsWith('deleteContentBackward')) {
        event.preventDefault();
        this.deleteBackward(selection);
      } else if (type.startsWith('deleteContentForward')) {
        event.preventDefault();
        this.deleteForward(selection);
      } else if (type.startsWith('delete')) {
        event.preventDefault();
        this.replaceRange(selection.start, selection.end, '', {inputType: type});
      } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
        event.preventDefault();
        this.replaceRange(selection.start, selection.end, '\n', {inputType: type});
      } else if (type.startsWith('insert') && typeof event.data === 'string') {
        event.preventDefault();
        this.replaceRange(selection.start, selection.end, event.data, {inputType: type});
      }
    }

    onKeyDown(event) {
      if (!this.active) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.replaceSelection('\t', 'insertText');
      }
    }

    onKeyUp(event) {
      if (!this.active) return;
      if ((event.ctrlKey || event.metaKey) && ['Home', 'End'].includes(event.key)) {
        this.ensureSelectionVisible();
      } else if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
        this.scheduleTypingAnchor({smooth: true});
      }
    }

    onPaste(event) {
      if (!this.active) return;
      const text = event.clipboardData?.getData('text/plain');
      if (typeof text !== 'string') return;
      event.preventDefault();
      this.replaceSelection(text.replace(/\r\n?/g, '\n'), 'insertFromPaste');
    }

    onCopy(event) {
      if (!this.active) return;
      const selection = this.selection();
      if (selection.start === selection.end) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', this.textBetween(selection.start, selection.end));
    }

    onCut(event) {
      if (!this.active) return;
      const selection = this.selection();
      if (selection.start === selection.end) return;
      this.onCopy(event);
      this.replaceRange(selection.start, selection.end, '', {inputType: 'deleteByCut'});
    }

    finishComposition() {
      this.composing = false;
      const line = this.composingLine?.__zenLine;
      this.composingLine = null;
      if (!line) return;
      const text = line.element.textContent || '';
      if (text === line.text) return;
      const selection = global.getSelection?.();
      let caretInLine = text.length;
      if (selection?.rangeCount && line.element.contains(selection.focusNode)) {
        const range = document.createRange();
        range.setStart(line.element, 0);
        range.setEnd(selection.focusNode, selection.focusOffset);
        caretInLine = range.toString().length;
      }
      const start = this.offsets.prefix(line.index);
      renderLineContent(line.element, line.text);
      this.replaceRange(start, start + line.text.length, text, {
        inputType: 'insertCompositionText',
      });
      this.setSelection(start + Math.min(text.length, caretInLine));
    }

    updateActiveLine() {
      const selection = global.getSelection?.();
      const lineElement =
        selection?.focusNode && this.element.contains(selection.focusNode)
          ? (selection.focusNode.nodeType === Node.ELEMENT_NODE
              ? selection.focusNode
              : selection.focusNode.parentElement
            )?.closest?.('.zen-editor-line')
          : null;
      if (lineElement === this.activeLine) return;
      this.activeLine?.classList.remove('is-active');
      this.activeLine = lineElement;
      this.activeLine?.classList.add('is-active');
    }
  }

  global.VylkZenEditor = ZenEditor;
  global.VylkZenMarkdown = {renderLineContent};
})(window);
