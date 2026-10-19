(function (global) {
  'use strict';

  const SHOW_TEXT = global.NodeFilter?.SHOW_TEXT || 4;
  const renderLineContent = global.VylkZenInline.render;
  const graphemes = global.Intl?.Segmenter
    ? new global.Intl.Segmenter(undefined, {granularity: 'grapheme'})
    : null;

  function deletionBoundary(text, offset, backward) {
    if (
      backward &&
      text.charCodeAt(offset - 1) < 128 &&
      (offset === text.length || text.charCodeAt(offset) < 128)
    )
      return offset - 1;
    if (
      !backward &&
      text.charCodeAt(offset) < 128 &&
      (offset + 1 === text.length || text.charCodeAt(offset + 1) < 128)
    )
      return offset + 1;
    let index = 0;
    const segments = graphemes
      ? graphemes.segment(text)
      : Array.from(text).map((segment) => {
          const entry = {segment, index};
          index += segment.length;
          return entry;
        });
    for (const part of segments) {
      const end = part.index + part.segment.length;
      if (backward ? end >= offset : end > offset) return backward ? part.index : end;
    }
    return text.length;
  }

  function changedRange(previous, next) {
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start])
      start++;
    let end = previous.length;
    let nextEnd = next.length;
    while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    return {start, end, inserted: next.slice(start, nextEnd)};
  }

  function structuralLineKind(source) {
    const heading = source.match(/^ {0,3}(#{1,6})\s+/);
    if (heading) return `heading-${heading[1].length}`;
    if (/^ {0,3}> ?/.test(source)) return 'quote';
    const list = global.VylkZenInline.listPrefix(source);
    if (list) return `list-${list}`;
    return 'plain';
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
      this.composition = null;
      this.history = [];
      this.future = [];
      this.lastSelection = {start: 0, end: 0, direction: 'none'};
      this.activeLine = null;
      this.typingAnchorFrame = null;
      this.anchorAnimationFrame = null;
      this.anchorAnimation = null;
      element.contentEditable = 'true';
      element.spellcheck = true;
      element.setAttribute('role', 'textbox');
      element.setAttribute('aria-multiline', 'true');
      element.setAttribute('aria-label', 'Markdown note content');
      element.setAttribute('autocapitalize', 'sentences');
      element.setAttribute('enterkeyhint', 'enter');
      element.addEventListener('beforeinput', (event) => this.onBeforeInput(event));
      element.addEventListener('pointerdown', (event) => {
        if (event.button === 0 && event.isPrimary !== false) {
          this.cancelTypingAnchor();
          this.smoothNextTypingAnchor = true;
        }
      });
      element.addEventListener('wheel', () => this.cancelTypingAnchor(), {passive: true});
      element.addEventListener('touchstart', () => this.cancelTypingAnchor(), {passive: true});
      element.addEventListener('blur', () => this.cancelTypingAnchor());
      element.addEventListener('keydown', (event) => this.onKeyDown(event));
      element.addEventListener('keyup', (event) => this.onKeyUp(event));
      element.addEventListener('paste', (event) => this.onPaste(event));
      element.addEventListener('click', (event) => {
        if (event.target.closest?.('.zen-md-link') && !(event.ctrlKey || event.metaKey))
          event.preventDefault();
      });
      element.addEventListener('copy', (event) => this.onCopy(event));
      element.addEventListener('cut', (event) => this.onCut(event));
      element.addEventListener('compositionstart', () => {
        this.composing = true;
        const selection = this.selection();
        const first = this.offsets.locate(selection.start).line;
        const last = this.offsets.locate(selection.end).line;
        this.composition = {
          selection,
          first,
          last,
          before: this.lines[first].element.previousSibling,
          after: this.lines[last].element.nextSibling,
        };
      });
      element.addEventListener('compositionend', () => this.finishComposition());
      document.addEventListener('selectionchange', () => this.updateActiveLine());
      this.setValue('');
      this.selectionController = global.VylkZenSelection?.create({
        editor: this,
        document,
        window: global,
      });
    }

    get value() {
      if (this.cachedValue === null)
        this.cachedValue = this.lines.map((line) => line.text).join('\n');
      return this.cachedValue;
    }

    get active() {
      return this._active;
    }

    set active(value) {
      this._active = Boolean(value);
      if (!this._active) this.cancelTypingAnchor();
      if (!this._active) this.selectionController?.cancel();
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
      this.selectionController?.cancel();
      this.documentRevision = (this.documentRevision || 0) + 1;
      this.cancelTypingAnchor();
      this.composing = false;
      this.composition = null;
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

    applyValue(value, start = 0, end = start, direction = 'forward') {
      const next = String(value ?? '');
      if (next !== this.value) {
        const change = changedRange(this.value, next);
        this.replaceRange(change.start, change.end, change.inserted, {
          inputType: 'insertReplacementText',
        });
      }
      this.setSelection(start, end, direction);
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
      // Native Select All places endpoints on the contenteditable container,
      // rather than inside a line's text. Child offsets are line boundaries.
      if (node === this.element) {
        const line = this.element.childNodes[offset]?.__zenLine;
        return line ? this.offsets.prefix(line.index) : offset <= 0 ? 0 : this.length;
      }
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
        if (remaining <= node.data.length) {
          const syntax = node.parentElement.closest('.zen-md-inline-syntax');
          if (syntax) {
            const prefix = syntax.dataset.zenBoundary === 'start';
            const anchor = prefix ? syntax.nextElementSibling : syntax.previousElementSibling;
            if ((!prefix && remaining === node.data.length) || (prefix && remaining === 0))
              return {
                node: syntax.parentNode,
                offset: [...syntax.parentNode.childNodes].indexOf(syntax) + (prefix ? 0 : 1),
              };
            const texts = document.createTreeWalker(anchor, SHOW_TEXT, {
              acceptNode: (text) => (text.parentElement.closest('.zen-md-inline-syntax') ? 2 : 1),
            });
            let last = texts.nextNode();
            if (prefix) return last ? {node: last, offset: 0} : {node: anchor, offset: 0};
            let next;
            while ((next = texts.nextNode())) last = next;
            return last ? {node: last, offset: last.data.length} : {node: anchor, offset: 0};
          }
          return {node, offset: remaining};
        }
        remaining -= node.data.length;
      }
      return {node: line.element, offset: line.element.childNodes.length};
    }

    linkAt(start, end = start) {
      const first = this.offsets.locate(start);
      if (this.offsets.locate(end).line !== first.line) return null;
      const base = this.offsets.prefix(first.line);
      const link = global.VylkZenInline.links(this.lines[first.line].element)?.find(
        (entry) => first.offset >= entry.start && end - base <= entry.end,
      );
      return link
        ? {
            ...link,
            start: base + link.start,
            end: base + link.end,
            labelStart: base + link.labelStart,
            labelEnd: base + link.labelEnd,
          }
        : null;
    }

    inlineFormatChange(start, end, kind) {
      const first = this.offsets.locate(start).line;
      const last = this.offsets.locate(end).line;
      const selections = [];
      for (let index = first; index <= last; index++) {
        const base = this.offsets.prefix(index);
        selections.push({
          element: this.lines[index].element,
          source: this.lines[index].text,
          start: Math.max(0, start - base),
          end: Math.min(this.lines[index].text.length, end - base),
        });
      }
      const result = global.VylkZenInline.formatSelection(selections, kind);
      if (!result) return null;
      if (result.unsupported) return result;
      const base = this.offsets.prefix(first);
      return {
        start: base,
        end: this.offsets.prefix(last) + this.lines[last].text.length,
        inserted: result.value,
        selection: {start: base + result.start, end: base + result.end},
      };
    }

    inlineSegments(start, end) {
      const pieces = [];
      const first = this.offsets.locate(start).line;
      const last = this.offsets.locate(end).line;
      for (let index = first; index <= last; index++) {
        const line = this.lines[index];
        const base = this.offsets.prefix(index);
        let cursor = base;
        const add = (from, to) => {
          const selectedStart = Math.max(start, from);
          const selectedEnd = Math.min(end, to);
          if (selectedStart < selectedEnd)
            pieces.push({start: selectedStart, end: selectedEnd, boundStart: from, boundEnd: to});
        };
        for (const link of global.VylkZenInline.links(line.element) || []) {
          if (!link.safeHref) continue;
          add(cursor, base + link.start);
          add(base + link.labelStart, base + link.labelEnd);
          cursor = base + link.end;
        }
        add(cursor, base + line.text.length);
      }
      return pieces;
    }

    canLinkSelection(start, end) {
      const first = this.offsets.locate(start).line;
      if (first !== this.offsets.locate(end).line) return false;
      if (this.linkAt(start, end)) return true;
      const base = this.offsets.prefix(first);
      return (
        start !== end &&
        (global.VylkZenInline.links(this.lines[first].element) || []).every(
          (link) => !link.safeHref || end <= base + link.start || start >= base + link.end,
        )
      );
    }

    inlineSpans(start, end = start) {
      const first = this.offsets.locate(start).line;
      const last = this.offsets.locate(end).line;
      const entries = [];
      for (const index of first === last ? [first] : [first, last]) {
        const base = this.offsets.prefix(index);
        for (const span of global.VylkZenInline.spans(this.lines[index].element))
          entries.push({
            ...span,
            start: base + span.start,
            end: base + span.end,
            contentStart: base + span.contentStart,
            contentEnd: base + span.contentEnd,
          });
      }
      return entries;
    }

    replaceVisibleRange(start, end, inserted, options) {
      if (start === end && !inserted.includes('\n'))
        return this.replaceRange(start, end, inserted, options);
      const spans = this.inlineSpans(start, end);
      if (!spans.length) return this.replaceRange(start, end, inserted, options);
      // Read only boundary fragments; backspace must not join the whole note.
      const change = global.VylkZenInline.visibleEdit(
        (from, to) => this.textBetween(from, to),
        start,
        end,
        inserted,
        spans,
      );
      this.replaceRange(change.start, change.end, change.inserted, options);
      this.setSelection(change.caret);
      return change;
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
      const range = document.createRange();
      range.setStart(selection.focusNode, selection.focusOffset);
      range.collapse(true);
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

    cancelTypingAnchor() {
      if (this.typingAnchorFrame != null) global.cancelAnimationFrame(this.typingAnchorFrame);
      if (this.anchorAnimationFrame != null) global.cancelAnimationFrame(this.anchorAnimationFrame);
      this.typingAnchorFrame = null;
      this.anchorAnimationFrame = null;
      this.anchorAnimation = null;
      this.smoothNextTypingAnchor = false;
    }

    animateAnchor(target) {
      if (this.anchorAnimation) {
        this.anchorAnimation.target = target;
        return;
      }
      this.anchorAnimation = {target, time: null};
      const step = (time) => {
        this.anchorAnimationFrame = null;
        const animation = this.anchorAnimation;
        if (!animation || !this.active || document.activeElement !== this.element) {
          this.cancelTypingAnchor();
          return;
        }
        const elapsed =
          animation.time == null ? 16 : Math.max(1, Math.min(64, time - animation.time));
        animation.time = time;
        animation.target = Math.max(
          0,
          Math.min(animation.target, this.element.scrollHeight - this.element.clientHeight),
        );
        const distance = animation.target - this.element.scrollTop;
        // Browsers may quantize scrollTop to CSS/device pixels. Snap before
        // fractional steps round to zero and leave an idle frame loop alive.
        if (Math.abs(distance) <= 2) {
          this.element.scrollTop = animation.target;
          this.anchorAnimation = null;
          // A final measurement catches edits/reflow during the last animation
          // frame. Idle editors never run a polling loop.
          this.scheduleTypingAnchor();
          return;
        }
        this.element.scrollTop += distance * (1 - Math.exp(-elapsed / 45));
        this.anchorAnimationFrame = global.requestAnimationFrame(step);
      };
      this.anchorAnimationFrame = global.requestAnimationFrame(step);
    }

    scheduleTypingAnchor({smooth = true} = {}) {
      if (smooth) this.smoothNextTypingAnchor = true;
      if (this.typingAnchorFrame !== null) return;
      this.typingAnchorFrame = global.requestAnimationFrame(() => {
        this.typingAnchorFrame = null;
        if (!this.active || document.activeElement !== this.element) return;
        const smoothNext = this.smoothNextTypingAnchor;
        this.smoothNextTypingAnchor = false;
        const caretRect = this.caretRect();
        if (!caretRect) return;
        const editorRect = this.element.getBoundingClientRect();
        const caretCenter = caretRect.top + caretRect.height / 2;
        const relativePosition = (caretCenter - editorRect.top) / editorRect.height;
        const comfortTop = 0.3;
        const comfortBottom = 0.6;
        if (relativePosition >= comfortTop && relativePosition <= comfortBottom) {
          if (this.anchorAnimation) this.cancelTypingAnchor();
          return;
        }
        const maxScrollTop = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
        const targetScrollTop = Math.max(
          0,
          Math.min(
            maxScrollTop,
            this.element.scrollTop + caretCenter - (editorRect.top + editorRect.height * 0.42),
          ),
        );
        if (Math.abs(targetScrollTop - this.element.scrollTop) <= 1) return;
        const reducedMotion = global.VylkMotion.reduced(this.element.ownerDocument, global);
        if (!reducedMotion && (smoothNext || this.anchorAnimation))
          this.animateAnchor(targetScrollTop);
        else {
          this.cancelTypingAnchor();
          this.element.scrollTop = targetScrollTop;
        }
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
        const syntaxChanged = /[*_~`#>[\]()]/.test(removed + replacement);
        const structuralStyleChanged =
          structuralLineKind(line.text) !== structuralLineKind(nextTexts[0]);
        const marker = line.element.querySelector('.zen-md-marker');
        const inlineCandidate = /[*_~`[]/.test(nextTexts[0]);
        if (
          !syntaxChanged &&
          !structuralStyleChanged &&
          !inlineCandidate &&
          !marker &&
          startPoint.node === endPoint.node &&
          startPoint.node.nodeType === Node.TEXT_NODE
        ) {
          startPoint.node.data =
            startPoint.node.data.slice(0, startPoint.offset) +
            replacement +
            startPoint.node.data.slice(endPoint.offset);
          line.text = nextTexts[0];
          line.element.classList.toggle('zen-md-blank', !line.text.trim());
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
      this.replaceVisibleRange(selection.start, selection.end, inserted, {inputType});
    }

    deleteInlineBoundary(selection, backward) {
      if (selection.start !== selection.end) return false;
      const spans = this.inlineSpans(selection.start);
      // Innermost style wins when delimiters share a visible boundary.
      for (const span of [...spans].reverse()) {
        if (
          backward ? selection.start === span.contentStart : selection.start === span.contentEnd
        ) {
          const content = this.textBetween(span.contentStart, span.contentEnd);
          this.replaceRange(span.start, span.end, content, {
            inputType: backward ? 'deleteContentBackward' : 'deleteContentForward',
          });
          this.setSelection(backward ? span.start : span.start + content.length);
          return true;
        }
      }
      // From outside a completed token, delete its visible text rather than a
      // hidden delimiter. Nested styles may share this same boundary.
      for (const span of spans) {
        if (backward && selection.start === span.end)
          selection.start = selection.end = span.contentEnd;
        if (!backward && selection.start === span.start)
          selection.start = selection.end = span.contentStart;
      }
      return false;
    }

    deleteVisibleRange(start, end, inputType) {
      this.replaceVisibleRange(start, end, '', {inputType});
    }

    deleteBackward(selection, byWord = false) {
      if (this.deleteInlineBoundary(selection, true)) return;
      if (selection.start !== selection.end)
        return this.replaceVisibleRange(selection.start, selection.end, '', {
          inputType: 'deleteContentBackward',
        });
      if (!selection.start) return;
      let start = selection.start - 1;
      const location = this.offsets.locate(selection.start);
      if (!byWord && location.offset > 0)
        start =
          this.offsets.prefix(location.line) +
          deletionBoundary(this.lines[location.line].text, location.offset, true);
      if (byWord) {
        const before = this.value.slice(0, selection.start);
        start = before.search(/\S+\s*$/);
        if (start < 0) start = 0;
        for (const span of this.inlineSpans(selection.start))
          if (selection.start >= span.contentStart && selection.start <= span.contentEnd)
            start = Math.max(start, span.contentStart);
      }
      this.deleteVisibleRange(
        start,
        selection.end,
        byWord ? 'deleteWordBackward' : 'deleteContentBackward',
      );
    }

    deleteForward(selection, byWord = false) {
      if (this.deleteInlineBoundary(selection, false)) return;
      if (selection.start !== selection.end)
        return this.replaceVisibleRange(selection.start, selection.end, '', {
          inputType: 'deleteContentForward',
        });
      if (selection.end >= this.length) return;
      let end = selection.end + 1;
      const location = this.offsets.locate(selection.end);
      if (!byWord && location.offset < this.lines[location.line].text.length)
        end =
          this.offsets.prefix(location.line) +
          deletionBoundary(this.lines[location.line].text, location.offset, false);
      if (byWord) {
        const match = this.value.slice(selection.end).match(/^\s*\S+/);
        end = selection.end + (match?.[0].length || 1);
        for (const span of this.inlineSpans(selection.end))
          if (selection.end >= span.contentStart && selection.end <= span.contentEnd)
            end = Math.min(end, span.contentEnd);
      }
      this.deleteVisibleRange(
        selection.start,
        end,
        byWord ? 'deleteWordForward' : 'deleteContentForward',
      );
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
        this.replaceVisibleRange(selection.start, selection.end, '', {inputType: type});
      } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
        event.preventDefault();
        this.replaceVisibleRange(selection.start, selection.end, '\n', {inputType: type});
      } else if (type.startsWith('insert') && typeof event.data === 'string') {
        event.preventDefault();
        this.replaceVisibleRange(selection.start, selection.end, event.data, {inputType: type});
      }
    }

    onKeyDown(event) {
      if (!this.active) return;
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      )
        this.cancelTypingAnchor();
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        this.replaceSelection('\t', 'insertText');
      }
    }

    onKeyUp(event) {
      if (!this.active) return;
      if ((event.ctrlKey || event.metaKey) && ['Home', 'End'].includes(event.key)) {
        this.ensureSelectionVisible();
      } else if (!event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
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
      this.replaceVisibleRange(selection.start, selection.end, '', {inputType: 'deleteByCut'});
    }

    finishComposition() {
      this.composing = false;
      const state = this.composition;
      this.composition = null;
      if (!state) return;
      // Native IME replacement can merge/remove multiple line elements. Capture
      // only the affected DOM region before restoring its model-owned structure.
      const nodes = [];
      for (
        let node = state.before ? state.before.nextSibling : this.element.firstChild;
        node && node !== state.after;
        node = node.nextSibling
      )
        nodes.push(node);
      const texts = nodes.map((node) => node.textContent || '');
      const text = texts.join('\n');
      const selection = global.getSelection?.();
      let caret = text.length;
      let preceding = 0;
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (selection?.focusNode && node.contains(selection.focusNode)) {
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(selection.focusNode, selection.focusOffset);
          caret = preceding + range.toString().length;
          break;
        }
        preceding += texts[index].length + 1;
      }
      const original = this.lines.slice(state.first, state.last + 1);
      const previous = original.map((line) => line.text).join('\n');
      nodes.forEach((node) => node.remove());
      const fragment = document.createDocumentFragment();
      for (const line of original) {
        renderLineContent(line.element, line.text);
        fragment.append(line.element);
      }
      this.element.insertBefore(fragment, state.after);
      const start = this.offsets.prefix(state.first);
      if (text !== previous) {
        const change = changedRange(previous, text);
        const normalized = this.replaceVisibleRange(
          start + change.start,
          start + change.end,
          change.inserted,
          {
            inputType: 'insertCompositionText',
          },
        );
        this.setSelection(
          normalized
            ? normalized.caret + caret - change.start - change.inserted.length
            : start + Math.min(text.length, caret),
        );
      } else
        this.setSelection(state.selection.start, state.selection.end, state.selection.direction);
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
})(window);
