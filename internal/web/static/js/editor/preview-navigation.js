(function (root) {
  'use strict';

  function blockIndexAtPosition(ranges, position) {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranges[middle].start <= position) low = middle + 1;
      else high = middle;
    }
    const previous = low - 1;
    const next = low < ranges.length ? low : -1;
    if (previous >= 0 && position <= ranges[previous].end) return previous;
    if (next >= 0 && position === ranges[next].start) return next;
    return -1;
  }

  function listItemAtPosition(items, position, sourceLength) {
    let best = null;
    for (const entry of items) {
      if (entry.start > position) break;
      if (!(position < entry.end || (position === sourceLength && entry.end === position)))
        continue;
      if (
        !best ||
        entry.indent > best.indent ||
        (entry.indent === best.indent && entry.start > best.start) ||
        (entry.indent === best.indent && entry.start === best.start && entry.end < best.end)
      )
        best = entry;
    }
    return best;
  }

  function editPosition(entry, source) {
    if (!entry || typeof source !== 'string') return 0;
    const raw = source.slice(entry.start, entry.end);
    let prefix = '';
    if (entry.kind === 'list-item') {
      prefix = raw.match(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/)?.[0] || '';
    } else {
      prefix =
        raw.match(/^[ \t]{0,3}#{1,6}[ \t]+/)?.[0] ||
        raw.match(/^[ \t]{0,3}>[ \t]?/)?.[0] ||
        raw.match(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/)?.[0] ||
        '';
    }
    return Math.min(entry.end, entry.start + prefix.length);
  }

  function scrollAdjustment({
    previewTop,
    previewHeight,
    previewScrollTop,
    previewScrollHeight,
    anchorTop,
    caretTop,
    margin,
    deadband,
  }) {
    const safeTop = previewTop + margin;
    const safeBottom = previewTop + Math.max(margin, previewHeight - margin);
    const targetCaretTop = Math.min(safeBottom, Math.max(safeTop, caretTop));
    const delta = anchorTop - targetCaretTop;
    if (Math.abs(delta) <= deadband) return 0;
    const maxScroll = Math.max(0, previewScrollHeight - previewHeight);
    return Math.max(-previewScrollTop, Math.min(maxScroll - previewScrollTop, delta));
  }

  function tokenTag(token) {
    if (token.type === 'blockquote') return 'BLOCKQUOTE';
    if (token.type === 'code') return 'PRE';
    if (token.type === 'hr') return 'HR';
    if (token.type === 'list') return token.ordered ? 'OL' : 'UL';
    if (token.type === 'paragraph') return 'P';
    if (token.type === 'table') return 'TABLE';
    if (token.type !== 'heading') return null;
    const match = (token.raw || '').match(/^\s*(#+)/);
    if (match) return `H${match[1].length}`;
    return Number.isInteger(token.depth) && token.depth >= 1 && token.depth <= 6
      ? `H${token.depth}`
      : null;
  }

  root.VylkPreviewNavigation = {
    blockIndexAtPosition,
    editPosition,
    listItemAtPosition,
    scrollAdjustment,
    tokenTag,
  };
})(typeof window !== 'undefined' ? window : globalThis);
