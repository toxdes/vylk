(function (global) {
  'use strict';

  const SHOW_TEXT = global.NodeFilter?.SHOW_TEXT || 4;
  const renderLineContent = global.VylkZenInline.render;
  const graphemes = global.Intl?.Segmenter
    ? new global.Intl.Segmenter(undefined, {granularity: 'grapheme'})
    : null;

  const rightToLeft = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

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

  function fenceState(text, previous) {
    const quote = text.match(/^(?: {0,3}>[ \t]?)+/)?.[0] || '';
    const depth = quote.split('>').length - 1;
    const body = text.slice(quote.length);
    const previousIndents = previous?.depth === depth ? previous.indents : [];
    let indents = previousIndents;
    if (indents.length && body.trim()) {
      const spaces = body.match(/^ */)[0].length;
      while (indents.length && indents.at(-1) > spaces) indents = indents.slice(0, -1);
    }
    let indent = indents.at(-1) || 0;
    if (previous?.marker && previous.depth === depth && previousIndents === indents) {
      const closing = body.slice(indent).match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/)?.[1];
      const closed =
        closing?.[0] === previous.marker[0] && closing.length >= previous.marker.length;
      return {literal: true, next: closed ? (indent ? {depth, indents} : null) : previous};
    }
    let list;
    while ((list = body.slice(indent).match(/^ {0,3}(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/))) {
      indent += list[0].length;
      indents = [...indents, indent];
    }
    const match = body.slice(indent).match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/);
    if (!match || (match[1][0] === '`' && match[2].includes('`')))
      return {literal: false, next: indent ? {depth, indents} : null};
    return {literal: true, next: {depth, indents, marker: match[1]}};
  }

  function sameFence(a, b) {
    return (
      a === b ||
      Boolean(
        a &&
        b &&
        a.depth === b.depth &&
        a.marker === b.marker &&
        a.indents.length === b.indents.length &&
        a.indents.every((indent, index) => indent === b.indents[index]),
      )
    );
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
      this.pendingFormats = null;
      this.history = [];
      this.future = [];
      this.typingGroup = false;
      this.lastSelection = {start: 0, end: 0, direction: 'none'};
      this.activeLine = null;
      this.typingAnchorFrame = null;
      this.anchorAnimationFrame = null;
      this.anchorAnimation = null;
      this.caretLine = null;
      this.caretOffset = null;
      this.pointerSelecting = false;
      element.contentEditable = 'true';
      element.spellcheck = true;
      element.setAttribute('role', 'textbox');
      element.setAttribute('aria-multiline', 'true');
      element.setAttribute('aria-label', 'Markdown note content');
      element.setAttribute('aria-description', 'Tab indents. Shift+Tab moves focus out.');
      element.setAttribute('autocapitalize', 'sentences');
      element.setAttribute('enterkeyhint', 'enter');
      element.addEventListener('beforeinput', (event) => this.onBeforeInput(event));
      element.addEventListener('input', () => {
        if (!this.nativeEdit || this.composing) return;
        this.composition = this.nativeEdit;
        this.nativeEdit = null;
        this.finishComposition();
      });
      element.addEventListener('pointerdown', (event) => {
        if (event.button === 0 && event.isPrimary !== false) {
          // Revealing syntax mid-drag would move text under the pointer.
          global.clearTimeout(this.pointerRevealTimer);
          this.pointerSelecting = true;
          this.typingGroup = false;
          this.cancelTypingAnchor();
          this.smoothNextTypingAnchor = true;
        }
      });
      element.addEventListener('wheel', () => this.cancelTypingAnchor(), {passive: true});
      element.addEventListener('touchstart', () => this.cancelTypingAnchor(), {passive: true});
      element.addEventListener('blur', () => {
        this.pastePlain = false;
        this.cancelTypingAnchor();
      });
      element.addEventListener('keydown', (event) => this.onKeyDown(event));
      element.addEventListener('keyup', (event) => this.onKeyUp(event));
      element.addEventListener('paste', (event) => this.onPaste(event));
      element.addEventListener('dragstart', () => {
        const selection = this.selection();
        this.dragSource =
          selection.start === selection.end
            ? null
            : {...selection, value: this.value, revision: this.documentRevision};
      });
      element.addEventListener('drop', () => {
        this.internalDrop = this.dragSource;
      });
      element.addEventListener('dragend', () => {
        this.dragSource = null;
        this.internalDrop = null;
      });
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
      for (const type of ['pointerup', 'pointercancel'])
        document.addEventListener(type, () => this.finishPointerSelection());
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
      if (!this._active) this.clearEditingState();
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

    clearEditingState() {
      this.pendingFormats = null;
      this.dragSource = null;
      this.internalDrop = null;
      this.nativeEdit = null;
      this.typingGroup = false;
      this.selectionController?.cancel();
      this.cancelTypingAnchor();
    }

    resetSession() {
      if (this.composing) this.finishComposition({commit: false});
      this.caretLine = null;
      this.clearEditingState();
      this.history = [];
      this.future = [];
      this.documentRevision++;
    }

    setValue(value, selectionStart = 0, selectionEnd = selectionStart) {
      this.clearEditingState();
      this.caretLine = null;
      this.documentRevision = (this.documentRevision || 0) + 1;
      this.composing = false;
      this.composition = null;
      const source = String(value ?? '');
      const fragment = document.createDocumentFragment();
      this.lines = source.split('\n').map((text, index) => {
        const element = document.createElement('div');
        const line = {text, index, element};
        element.__zenLine = line;
        fragment.append(element);
        return line;
      });
      this.renderLines(0, this.lines.length);
      this.offsets = new FenwickTree(this.lines.map((line) => line.text.length + 1));
      this.cachedValue = source;
      this.history = [];
      this.future = [];
      this.element.replaceChildren(fragment);
      this.element.classList.toggle('is-empty', source.length === 0);
      this.setSelection(selectionStart, selectionEnd);
    }

    renderLine(line) {
      renderLineContent(line.element, line.text, {
        literal: line.fenced,
        caret: this.caretLine === line ? this.caretOffset : null,
      });
      line.element.classList.toggle('is-active', this.activeLine === line.element);
    }

    renderLines(start, count) {
      let open = this.lines[start - 1]?.fenceAfter || null;
      for (let index = start; index < this.lines.length; index++) {
        const line = this.lines[index];
        const fence = fenceState(line.text, open);
        const unchanged = sameFence(fence.next, line.fenceAfter);
        if (index >= start + count && unchanged && line.fenced === fence.literal) break;
        line.fenceAfter = open = fence.next;
        line.fenced = fence.literal;
        this.renderLine(line);
      }
    }

    // A collapsed caret shows the syntax of spans it touches, so every source
    // offset is reachable and edits there are literal. Range selections keep
    // syntax hidden and edit rendered text. Returns whether a line re-rendered,
    // which invalidates the native selection's DOM points.
    syncReveal(selection) {
      if (this.composing || this.nativeEdit || this.pointerSelecting) return false;
      const location = this.offsets.locate(selection.start);
      const line = selection.start === selection.end ? this.lines[location.line] : null;
      const previous = this.caretLine;
      this.caretLine = line;
      this.caretOffset = location.offset;
      const reveal = global.VylkZenInline.revealKey;
      let changed = false;
      if (previous && previous !== line && this.lines[previous.index] === previous) {
        if (reveal(previous.element)) {
          this.renderLine(previous);
          changed = true;
        }
      }
      if (line && reveal(line.element) !== reveal(line.element, location.offset)) {
        this.renderLine(line);
        changed = true;
      }
      return changed;
    }

    // Wait out a possible double click: revealing syntax between its clicks
    // would move the word under the pointer.
    finishPointerSelection() {
      if (!this.pointerSelecting) return;
      global.clearTimeout(this.pointerRevealTimer);
      this.pointerRevealTimer = global.setTimeout(() => this.flushPointerReveal(), 250);
    }

    flushPointerReveal() {
      if (!this.pointerSelecting) return;
      global.clearTimeout(this.pointerRevealTimer);
      this.pointerSelecting = false;
      this.updateActiveLine();
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
      if (!line.text) return {node: line.element, offset: 0};
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
      const link = global.VylkZenInline.links(this.lines[first.line].element)?.find((entry) =>
        start === end
          ? first.offset > entry.start && first.offset < entry.end
          : first.offset >= entry.start && end - base <= entry.end,
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

    inlineSelections(start, end) {
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
      return selections;
    }

    inlineFormatStates(start, end) {
      if (start !== end)
        return global.VylkZenInline.formatStates(this.inlineSelections(start, end));
      const pending = this.pendingFormats;
      if (pending?.offset === start)
        return Object.fromEntries([...pending.active].map((kind) => [kind, true]));
      return Object.fromEntries(
        this.inlineSpans(start)
          .filter((span) => start > span.contentStart && start < span.contentEnd)
          .map((span) => [span.kind, true]),
      );
    }

    inlineFormatChange(start, end, kind) {
      const first = this.offsets.locate(start).line;
      const last = this.offsets.locate(end).line;
      const selections = this.inlineSelections(start, end);
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

    togglePendingFormat(kind) {
      this.typingGroup = false;
      const selection = this.selection();
      if (selection.start !== selection.end) return;
      if (this.lines[this.offsets.locate(selection.start).line].fenced) return;
      if (!this.pendingFormats || this.pendingFormats.offset !== selection.start) {
        const active = new Set(
          this.inlineSpans(selection.start)
            .filter(
              (span) => selection.start > span.contentStart && selection.start < span.contentEnd,
            )
            .map((span) => span.kind),
        );
        this.pendingFormats = {offset: selection.start, active};
      }
      const active = this.pendingFormats.active;
      if (active.has(kind)) active.delete(kind);
      else active.add(kind);
    }

    insertWithPendingFormats(selection, text, inputType) {
      const pending = this.pendingFormats;
      if (
        !pending ||
        pending.offset !== selection.start ||
        selection.start !== selection.end ||
        text.includes('\n')
      )
        return false;
      const location = this.offsets.locate(selection.start);
      const line = this.lines[location.line];
      const base = this.offsets.prefix(location.line);
      if (!text.trim()) {
        this.replaceRange(selection.start, selection.end, text, {inputType});
        pending.offset = this.selection().start;
        return true;
      }
      const element = document.createElement('div');
      let original = line.text;
      if (text === '*' || text === '_') {
        const span = this.inlineSpans(selection.start).find(
          (entry) =>
            entry.kind === 'strong' &&
            selection.start >= entry.contentStart &&
            selection.start <= entry.contentEnd &&
            this.textBetween(entry.start, entry.contentStart) === text.repeat(2),
        );
        if (span) {
          const marker = text === '*' ? '__' : '**';
          const opening = span.start - base;
          const closing = span.contentEnd - base;
          original =
            original.slice(0, opening) +
            marker +
            original.slice(opening + 2, closing) +
            marker +
            original.slice(closing + 2);
        }
      }
      let source = original.slice(0, location.offset) + text + original.slice(location.offset);
      let start = location.offset;
      let end = start + text.length;
      if (
        (text === '*' || text === '_') &&
        pending.active.has('strong') &&
        !this.inlineSpans(selection.start).some(
          (span) =>
            span.kind === 'strong' &&
            selection.start >= span.contentStart &&
            selection.start <= span.contentEnd,
        )
      ) {
        const marker = text === '*' ? '__' : '**';
        source = original.slice(0, start) + marker + text + marker + original.slice(start);
        start += marker.length;
        end += marker.length;
      }
      for (const kind of ['strong', 'em', 'del']) {
        renderLineContent(element, source);
        const active = global.VylkZenInline.spans(element).some(
          (span) => span.kind === kind && start >= span.contentStart && end <= span.contentEnd,
        );
        if (active === pending.active.has(kind)) continue;
        const change = global.VylkZenInline.formatSelection([{element, source, start, end}], kind);
        if (!change || change.unsupported) {
          const boundary = this.inlineSpans(selection.start).find(
            (span) => selection.start === span.contentEnd && span.kind === kind,
          );
          if (!boundary) return false;
          this.pendingFormats = null;
          this.replaceRange(boundary.end, boundary.end, text, {inputType});
          this.setSelection(boundary.end + text.length);
          this.element.dispatchEvent(new Event('zenformatunsupported', {bubbles: true}));
          return true;
        }
        source = change.value;
        start = change.start;
        end = change.end;
      }
      const change = changedRange(line.text, source);
      this.replaceRange(base + change.start, base + change.end, change.inserted, {inputType});
      this.setSelection(base + end);
      if (this.history.length) this.history.at(-1).selectionAfter = this.selection();
      pending.offset = this.selection().start;
      return true;
    }

    inlineSegments(start, end) {
      const pieces = [];
      const first = this.offsets.locate(start).line;
      const last = this.offsets.locate(end).line;
      for (let index = first; index <= last; index++) {
        const line = this.lines[index];
        if (line.fenced) continue;
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
      if (first !== this.offsets.locate(end).line || this.lines[first].fenced) return false;
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

    // Edits step around syntax the writer cannot see; shown syntax is edited as typed.
    hiddenSpans(start, end = start) {
      return this.inlineSpans(start, end).filter((span) => !span.shown);
    }

    replaceVisibleRange(start, end, inserted, options) {
      if (start === end && /^\s+$/u.test(inserted) && !inserted.includes('\n')) {
        for (const span of [...this.hiddenSpans(start)].reverse())
          if (start === span.contentEnd && ['strong', 'em', 'del'].includes(span.kind))
            start = end = span.end;
      }
      if (start === end && !inserted.includes('\n'))
        return this.replaceRange(start, end, inserted, options);
      // A line break closes and reopens every span it splits, shown or hidden.
      const spans = inserted.includes('\n')
        ? this.inlineSpans(start, end)
        : this.hiddenSpans(start, end);
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
      if (this.history.length) this.history.at(-1).selectionAfter = this.selection();
      return change;
    }

    setSelection(start, end = start, direction = 'forward') {
      this.lastSelection = {start: Math.min(start, end), end: Math.max(start, end), direction};
      this.placeSelection(start, end, direction);
      if (this.syncReveal(this.lastSelection)) this.placeSelection(start, end, direction);
      this.updateActiveLine();
    }

    placeSelection(start, end, direction) {
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

    replaceRange(
      start,
      end,
      inserted,
      {inputType = 'insertText', record = true, group = false} = {},
    ) {
      const selectionBefore = record ? this.selection() : null;
      const safeStart = Math.max(0, Math.min(this.length, start));
      const safeEnd = Math.max(safeStart, Math.min(this.length, end));
      const replacement = String(inserted ?? '');
      const removed = this.textBetween(safeStart, safeEnd);
      const recordChange = () => {
        if (!record || (!removed && !replacement)) return;
        const selectionAfter = this.selection();
        const previous = this.history.at(-1);
        if (
          group &&
          this.typingGroup &&
          !removed &&
          previous &&
          !previous.removed &&
          previous.start + previous.inserted.length === safeStart &&
          previous.selectionAfter.start === selectionBefore.start &&
          previous.selectionAfter.end === selectionBefore.end
        ) {
          previous.inserted += replacement;
          previous.selectionAfter = selectionAfter;
        } else {
          this.history.push({
            start: safeStart,
            removed,
            inserted: replacement,
            selectionBefore,
            selectionAfter,
          });
          if (this.history.length > 200) this.history.shift();
        }
        this.typingGroup = group && !removed;
        this.future = [];
      };
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
        const fence = fenceState(nextTexts[0], this.lines[first.line - 1]?.fenceAfter || null);
        if (
          !syntaxChanged &&
          fence.literal === line.fenced &&
          sameFence(fence.next, line.fenceAfter) &&
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
          recordChange();
          this.dispatchEvent(
            new CustomEvent('input', {detail: {inputType, data: replacement, length: this.length}}),
          );
          this.scheduleTypingAnchor();
          return;
        }
        line.text = nextTexts[0];
        // Render once with the caret where the edit leaves it.
        if (this.caretLine === line) this.caretOffset = first.offset + replacement.length;
        this.renderLines(first.line, 1);
        this.offsets.set(first.line, line.text.length + 1);
        this.cachedValue = null;
        this.element.classList.toggle('is-empty', this.length === 0);
        const caret = safeStart + replacement.length;
        this.setSelection(caret, caret);
        recordChange();
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
        fragment.append(element);
        return line;
      });
      this.element.insertBefore(fragment, anchor);
      this.lines.splice(first.line, removedLines.length, ...nextLines);
      for (let index = first.line; index < this.lines.length; index++)
        this.lines[index].index = index;
      this.renderLines(first.line, nextLines.length);
      this.offsets = new FenwickTree(this.lines.map((line) => line.text.length + 1));
      this.cachedValue = null;
      this.element.classList.toggle('is-empty', this.length === 0);
      const caret = safeStart + replacement.length;
      this.setSelection(caret, caret);
      recordChange();
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
      const spans = this.hiddenSpans(selection.start);
      for (const span of [...spans].reverse()) {
        if (
          backward ? selection.start === span.contentStart : selection.start === span.contentEnd
        ) {
          selection.start = selection.end = backward ? span.start : span.end;
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
      if (this.textBetween(start, end) === '\n') {
        const leftSpans = this.inlineSpans(start);
        const rightSpans = this.inlineSpans(end);
        let leftBoundary = start;
        let rightBoundary = end;
        for (;;) {
          const left = leftSpans.find(
            (span) => span.end === leftBoundary && ['strong', 'em', 'del'].includes(span.kind),
          );
          const right = rightSpans.find(
            (span) => span.start === rightBoundary && span.kind === left?.kind,
          );
          if (!left || !right) break;
          const marker = this.textBetween(left.contentEnd, left.end);
          if (marker !== this.textBetween(right.start, right.contentStart)) break;
          leftBoundary -= marker.length;
          rightBoundary += marker.length;
        }
        if (leftBoundary !== start) {
          this.replaceRange(leftBoundary, rightBoundary, '', {inputType});
          return;
        }
      }
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
      this.pendingFormats = null;
      this.typingGroup = false;
      const transaction = this.history.pop();
      if (!transaction) return;
      this.replaceRange(
        transaction.start,
        transaction.start + transaction.inserted.length,
        transaction.removed,
        {inputType: 'historyUndo', record: false},
      );
      if (transaction.selectionBefore)
        this.setSelection(
          transaction.selectionBefore.start,
          transaction.selectionBefore.end,
          transaction.selectionBefore.direction,
        );
      this.future.push(transaction);
    }

    redo() {
      this.pendingFormats = null;
      this.typingGroup = false;
      const transaction = this.future.pop();
      if (!transaction) return;
      this.replaceRange(
        transaction.start,
        transaction.start + transaction.removed.length,
        transaction.inserted,
        {inputType: 'historyRedo', record: false},
      );
      if (transaction.selectionAfter)
        this.setSelection(
          transaction.selectionAfter.start,
          transaction.selectionAfter.end,
          transaction.selectionAfter.direction,
        );
      this.history.push(transaction);
    }

    rememberNativeEdit(selection, previousSelection, inputType) {
      const first = this.offsets.locate(selection.start).line;
      const last = this.offsets.locate(selection.end).line;
      this.nativeEdit = {
        selection: previousSelection,
        first,
        last,
        inputType,
        before: this.lines[first].element.previousSibling,
        after: this.lines[last].element.nextSibling,
      };
    }

    onBeforeInput(event) {
      if (!this.active || this.composing || event.defaultPrevented) return;
      this.nativeEdit = null;
      const type = event.inputType || '';
      let selection = this.selection();
      const previousSelection = selection;
      if (
        ['insertReplacementText', 'insertFromDictation', 'insertFromDrop', 'deleteByDrag'].includes(
          type,
        ) &&
        typeof event.getTargetRanges === 'function'
      ) {
        const ranges = event.getTargetRanges();
        const range = ranges.length === 1 ? ranges[0] : null;
        if (
          ranges.length &&
          (!range ||
            !this.element.contains(range.startContainer) ||
            !this.element.contains(range.endContainer))
        ) {
          event.preventDefault();
          if (this.internalDrop) this.internalDrop = {cancel: true};
          return;
        }
        if (
          range &&
          this.element.contains(range.startContainer) &&
          this.element.contains(range.endContainer)
        ) {
          const start = this.pointOffset(range.startContainer, range.startOffset);
          const end = this.pointOffset(range.endContainer, range.endOffset);
          selection = {start: Math.min(start, end), end: Math.max(start, end)};
        }
      }
      if (event.cancelable === false && (type.startsWith('insert') || type.startsWith('delete'))) {
        this.rememberNativeEdit(selection, previousSelection, type);
        return;
      }
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
      } else if (type === 'deleteByDrag' && this.internalDrop) {
        event.preventDefault();
        this.internalDrop =
          this.internalDrop.revision === this.documentRevision &&
          this.internalDrop.value === this.value
            ? {...selection, direction: this.internalDrop.direction, move: true}
            : {cancel: true};
      } else if (type.startsWith('delete')) {
        event.preventDefault();
        this.replaceVisibleRange(selection.start, selection.end, '', {inputType: type});
      } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
        event.preventDefault();
        this.replaceVisibleRange(selection.start, selection.end, '\n', {inputType: type});
      } else if (type.startsWith('insert')) {
        if (type === 'insertFromDrop' && this.internalDrop?.cancel) {
          event.preventDefault();
          this.internalDrop = null;
          return;
        }
        if (
          type === 'insertFromDrop' &&
          event.dataTransfer?.types &&
          !Array.from(event.dataTransfer.types).includes('text/plain')
        ) {
          event.preventDefault();
          return;
        }
        const data =
          typeof event.data === 'string' ? event.data : event.dataTransfer?.getData('text/plain');
        if (typeof data !== 'string') {
          if (type === 'insertFromDrop') event.preventDefault();
          else this.rememberNativeEdit(selection, previousSelection, type);
          return;
        }
        event.preventDefault();
        if (type === 'insertFromDrop' && this.internalDrop?.move) {
          this.moveDrop(this.internalDrop, selection.start);
          this.internalDrop = null;
          return;
        }
        if (!this.insertWithPendingFormats(selection, data, type)) {
          this.pendingFormats = null;
          this.replaceVisibleRange(selection.start, selection.end, data, {
            inputType: type,
            group: type === 'insertText',
          });
        }
      }
    }

    moveDrop(source, target) {
      if (target >= source.start && target <= source.end) return;
      const spans = this.inlineSpans(source.start, source.end);
      const removal = global.VylkZenInline.visibleEdit(
        (from, to) => this.textBetween(from, to),
        source.start,
        source.end,
        '',
        spans,
      );
      if (target > removal.start && target < removal.end) {
        this.element.dispatchEvent(new Event('zendropunsupported', {bubbles: true}));
        return;
      }
      const moved = this.copyRange(source.start, source.end);
      const start = Math.min(target, removal.start);
      const end = Math.max(target, removal.end);
      const between = this.textBetween(start, end);
      const without =
        between.slice(0, removal.start - start) +
        removal.inserted +
        between.slice(removal.end - start);
      const insertion =
        target <= removal.start
          ? target - start
          : target - start - (removal.end - removal.start) + removal.inserted.length;
      this.replaceRange(
        start,
        end,
        without.slice(0, insertion) + moved + without.slice(insertion),
        {inputType: 'insertFromDrop'},
      );
      this.setSelection(start + insertion + moved.length);
      const transaction = this.history.at(-1);
      transaction.selectionBefore = source;
      transaction.selectionAfter = this.selection();
    }

    onKeyDown(event) {
      this.flushPointerReveal();
      if (!this.active || this.composing || event.isComposing || event.keyCode === 229) return;
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
      ) {
        this.pendingFormats = null;
        this.typingGroup = false;
        this.cancelTypingAnchor();
        if (this.stepCaret(event)) return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === 'v') this.pastePlain = true;
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

    // Step a collapsed caret one source character. Native movement cannot tell
    // the two sides of hidden syntax apart, so it could skip an offset.
    stepCaret(event) {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
      if (event.key === 'Home' || event.key === 'End') return this.moveToLineEdge(event);
      const backward = event.key === 'ArrowLeft';
      if (!backward && event.key !== 'ArrowRight') return false;
      const selection = this.selection();
      if (selection.start !== selection.end) return false;
      const location = this.offsets.locate(selection.start);
      const text = this.lines[location.line].text;
      if (rightToLeft.test(text)) return false;
      let caret = selection.start + (backward ? -1 : 1);
      if (backward ? location.offset > 0 : location.offset < text.length)
        caret =
          this.offsets.prefix(location.line) + deletionBoundary(text, location.offset, backward);
      if (caret < 0 || caret > this.length) return false;
      event.preventDefault();
      this.setSelection(caret);
      this.ensureSelectionVisible();
      return true;
    }

    // Home and End follow visual (wrapped) lines, then pass hidden syntax at
    // that edge, which the browser may leave on either side.
    moveToLineEdge(event) {
      const native = global.getSelection?.();
      if (typeof native?.modify !== 'function') return false;
      const backward = event.key === 'Home';
      event.preventDefault();
      native.modify('move', backward ? 'backward' : 'forward', 'lineboundary');
      let caret = this.selection().start;
      for (const span of [...this.hiddenSpans(caret)].reverse()) {
        if (backward && caret === span.contentStart) caret = span.start;
        if (!backward && caret === span.contentEnd) caret = span.end;
      }
      this.setSelection(caret);
      this.ensureSelectionVisible();
      return true;
    }

    onKeyUp(event) {
      if (!this.active || this.composing || event.isComposing || event.keyCode === 229) return;
      if (event.key.toLowerCase() === 'v') this.pastePlain = false;
      if ((event.ctrlKey || event.metaKey) && ['Home', 'End'].includes(event.key)) {
        this.ensureSelectionVisible();
      } else if (!event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        this.scheduleTypingAnchor({smooth: true});
      }
    }

    onPaste(event) {
      if (!this.active) return;
      if (
        event.clipboardData?.types &&
        !Array.from(event.clipboardData.types).includes('text/plain')
      ) {
        event.preventDefault();
        return;
      }
      const text = event.clipboardData?.getData('text/plain');
      if (typeof text !== 'string') return;
      event.preventDefault();
      const selection = this.selection();
      const href = this.pastePlain ? null : global.VylkMarkdownLinks.inputHref(text);
      this.pastePlain = false;
      if (
        href &&
        selection.start !== selection.end &&
        this.canLinkSelection(selection.start, selection.end) &&
        !this.linkAt(selection.start, selection.end) &&
        !this.inlineSpans(selection.start, selection.end).some(
          (span) =>
            span.kind === 'codespan' &&
            selection.start < span.contentEnd &&
            selection.end > span.contentStart,
        )
      ) {
        const label = this.copyRange(selection.start, selection.end);
        this.replaceVisibleRange(
          selection.start,
          selection.end,
          `[${label}](${global.VylkMarkdownLinks.destination(href)})`,
          {inputType: 'insertFromPaste'},
        );
        return;
      }
      this.replaceSelection(text.replace(/\r\n?/g, '\n'), 'insertFromPaste');
    }

    copyRange(start, end) {
      const spans = this.inlineSpans(start, end).filter(
        (span) => span.kind !== 'link' || (start <= span.contentStart && end >= span.contentEnd),
      );
      return start === 0 && end === this.length
        ? this.value
        : global.VylkZenInline.fragment(
            (from, to) => this.textBetween(from, to),
            spans,
            start,
            end,
          );
    }

    onCopy(event) {
      if (!this.active) return;
      const selection = this.selection();
      if (selection.start === selection.end) return;
      event.preventDefault();
      const text = this.copyRange(selection.start, selection.end);
      event.clipboardData?.setData('text/plain', text);
    }

    onCut(event) {
      if (!this.active) return;
      const selection = this.selection();
      if (selection.start === selection.end) return;
      this.onCopy(event);
      this.replaceVisibleRange(selection.start, selection.end, '', {inputType: 'deleteByCut'});
    }

    finishComposition({commit = true} = {}) {
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
        this.renderLine(line);
        fragment.append(line.element);
      }
      this.element.insertBefore(fragment, state.after);
      const start = this.offsets.prefix(state.first);
      if (commit && text !== previous) {
        const change = changedRange(previous, text);
        if (
          state.selection.start === state.selection.end &&
          start + change.start === state.selection.start &&
          change.start === change.end &&
          caret === change.start + change.inserted.length &&
          this.insertWithPendingFormats(
            state.selection,
            change.inserted,
            state.inputType || 'insertCompositionText',
          )
        ) {
          this.history.at(-1).selectionBefore = state.selection;
          return;
        }
        this.pendingFormats = null;
        const normalized = this.replaceVisibleRange(
          start + change.start,
          start + change.end,
          change.inserted,
          {
            inputType: state.inputType || 'insertCompositionText',
          },
        );
        this.setSelection(
          normalized
            ? normalized.caret + caret - change.start - change.inserted.length
            : start + Math.min(text.length, caret),
        );
        if (this.history.length) {
          this.history.at(-1).selectionBefore = state.selection;
          this.history.at(-1).selectionAfter = this.selection();
        }
      } else
        this.setSelection(state.selection.start, state.selection.end, state.selection.direction);
    }

    updateActiveLine() {
      const selection = global.getSelection?.();
      if (
        selection?.anchorNode &&
        this.element.contains(selection.anchorNode) &&
        selection.focusNode &&
        this.element.contains(selection.focusNode)
      ) {
        const offsets = this.selection();
        if (this.syncReveal(offsets))
          this.placeSelection(offsets.start, offsets.end, offsets.direction);
      }
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
