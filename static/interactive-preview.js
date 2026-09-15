(function () {
'use strict';

// Markdown remains the source of truth. These helpers only calculate small,
// reversible source replacements; rendering and persistence stay in app.js.
function listItemRanges(source, offset = 0, scope = '') {
  const matches = [];
  const pattern = /^([ \t]*)([-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm;
  let match;
  while ((match = pattern.exec(source))) {
    matches.push({
      start: offset + match.index,
      marker: match[2],
      indent: match[1].replace(/\t/g, '    ').length,
      ordered: /^\d/.test(match[2]),
      kind: 'list-item',
      scope,
    });
  }
  const parents = [];
  return matches.map((item, index) => {
    while (parents.length && parents[parents.length - 1].indent >= item.indent) parents.pop();
    const parent = parents[parents.length - 1];
    let end = offset + source.length;
    for (let next = index + 1; next < matches.length; next++) {
      if (matches[next].indent <= item.indent) {
        end = matches[next].start;
        break;
      }
    }
    const range = {...item, end, parent: parent ? parent.start : null};
    parents.push(range);
    return range;
  });
}

function listSiblings(entries, entry) {
  return entries.filter(candidate => candidate.scope === entry.scope && candidate.parent === entry.parent && candidate.indent === entry.indent && candidate.ordered === entry.ordered)
    .sort((a, b) => a.start - b.start);
}

function reorderListItems(source, entries, movingStart, targetStart, placement = 'before') {
  const moving = entries.find(entry => entry.start === movingStart);
  const target = entries.find(entry => entry.start === targetStart);
  if (!moving || !target || moving === target) return null;
  const siblings = listSiblings(entries, moving);
  if (!siblings.some(entry => entry.start === target.start)) return null;
  const movingIndex = siblings.findIndex(entry => entry.start === moving.start);
  const targetIndex = siblings.findIndex(entry => entry.start === target.start);
  let insertionIndex = targetIndex + (placement === 'after' ? 1 : 0);
  if (movingIndex < insertionIndex) insertionIndex--;
  if (insertionIndex === movingIndex) return null;

  const start = siblings[0].start;
  const end = siblings[siblings.length - 1].end;
  const chunks = siblings.map((entry, index) => source.slice(entry.start, index + 1 < siblings.length ? siblings[index + 1].start : end));
  const [chunk] = chunks.splice(movingIndex, 1);
  chunks.splice(insertionIndex, 0, chunk);
  const trailingNewline = source.slice(start, end).endsWith('\n');
  for (let index = 0; index < chunks.length - 1; index++) {
    if (!chunks[index].endsWith('\n')) chunks[index] += '\n';
  }
  if (!trailingNewline) chunks[chunks.length - 1] = chunks[chunks.length - 1].replace(/\n$/, '');
  if (moving.ordered) {
    const firstNumber = Number((siblings[0].marker.match(/^\d+/) || ['1'])[0]);
    for (let index = 0; index < chunks.length; index++) {
      chunks[index] = chunks[index].replace(/^([ \t]*)\d+([.)])/, `$1${firstNumber + index}$2`);
    }
  }
  const inserted = chunks.join('');
  if (source.slice(start, end) === inserted) return null;
  return {source: source.slice(0, start) + inserted + source.slice(end), start, end, inserted};
}

function markdownJoin(left, right) {
  const before = left.replace(/[ \t]*(?:\r?\n)+$/, '');
  const after = right.replace(/^(?:[ \t]*\r?\n)+/, '');
  if (!before) return after;
  if (!after) return before;
  return `${before}\n\n${after}`;
}

function reindentListChunk(chunk, fromIndent, toIndent) {
  const difference = toIndent - fromIndent;
  if (!difference) return chunk;
  return chunk.split('\n').map(line => {
    if (!line.trim()) return line;
    if (difference > 0) return `${' '.repeat(difference)}${line}`;
    let remaining = -difference;
    let index = 0;
    while (index < line.length && remaining > 0) {
      if (line[index] === ' ') {
        index++;
        remaining--;
      } else if (line[index] === '\t') {
        index++;
        remaining -= Math.min(4, remaining);
      } else {
        break;
      }
    }
    return line.slice(index);
  }).join('\n');
}

function moveMarkdownUnit(source, entries, movingStart, movingScope, targetStart, targetScope, placement = 'before') {
  const moving = entries.find(entry => entry.start === movingStart && entry.scope === movingScope);
  const target = entries.find(entry => entry.start === targetStart && entry.scope === targetScope);
  if (!moving || !target || moving === target) return null;
  if (moving.start < target.end && target.start < moving.end) return null;

  if (moving.kind === 'list-item' && target.kind === 'list-item') {
    const siblings = listSiblings(entries, moving);
    if (siblings.some(entry => entry.start === target.start && entry.scope === target.scope)) {
      return reorderListItems(source, entries, movingStart, targetStart, placement);
    }
  }

  let chunk = source.slice(moving.start, moving.end).replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '');
  if (!chunk) return null;
  if (moving.kind === 'list-item') {
    const targetIndent = target.kind === 'list-item' ? target.indent : 0;
    chunk = reindentListChunk(chunk, moving.indent, targetIndent);
  }

  const marker = `\u0000vylk-preview-drop-${Date.now()}-${Math.random()}\u0000`;
  const insertion = placement === 'after' ? target.end : target.start;
  if (moving.start <= insertion && insertion <= moving.end) return null;
  const marked = source.slice(0, insertion) + marker + source.slice(insertion);
  const markerLength = marker.length;
  const adjustedStart = moving.start + (insertion <= moving.start ? markerLength : 0);
  const adjustedEnd = moving.end + (insertion <= moving.start ? markerLength : 0);
  const withoutMoving = markdownJoin(marked.slice(0, adjustedStart), marked.slice(adjustedEnd));
  const markerIndex = withoutMoving.indexOf(marker);
  if (markerIndex < 0) return null;
  const inserted = markdownJoin(markdownJoin(withoutMoving.slice(0, markerIndex), chunk), withoutMoving.slice(markerIndex + markerLength));
  const normalized = source.endsWith('\n') && inserted ? `${inserted.replace(/\n+$/, '')}\n` : inserted;
  if (!normalized || normalized === source) return null;
  return {source: normalized, start: 0, end: source.length, inserted: normalized};
}

function toggleTask(source, entry) {
  if (!entry) return null;
  const lineEnd = source.indexOf('\n', entry.start);
  const end = lineEnd < 0 ? entry.end : Math.min(entry.end, lineEnd);
  const line = source.slice(entry.start, end);
  const match = /\[([ xX])\]/.exec(line);
  if (!match) return null;
  const wasChecked = match[1].toLowerCase() === 'x';
  const markerStart = entry.start + match.index;
  const inserted = wasChecked ? '[ ]' : '[x]';
  return {
    source: source.slice(0, markerStart) + inserted + source.slice(markerStart + match[0].length),
    start: markerStart,
    end: markerStart + match[0].length,
    inserted,
    checked: !wasChecked,
  };
}

window.VylkInteractive = {listItemRanges, listSiblings, reorderListItems, moveMarkdownUnit, toggleTask};
}());
