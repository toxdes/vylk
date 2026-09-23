(function (root) {
  'use strict';

  const formats = Object.freeze({
    bold: ['**', '**'],
    italic: ['*', '*'],
    strike: ['~~', '~~'],
    code: ['`', '`'],
    link: ['[', '](url)'],
    image: ['![', '](url)'],
    h1: ['# ', '\n'],
    h2: ['## ', '\n'],
    h3: ['### ', '\n'],
    h4: ['#### ', '\n'],
    h5: ['##### ', '\n'],
    h6: ['###### ', '\n'],
    ul: ['- ', '\n'],
    ol: ['1. ', '\n'],
    task: ['- [ ] ', '\n'],
    blockquote: ['> ', '\n'],
    hr: ['\n---\n', ''],
  });
  const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const lineToggles = new Set(['ul', 'ol', 'task', 'blockquote']);

  function format(value, start, end, type) {
    const markers = formats[type];
    if (!markers) return null;

    const selected = value.slice(start, end);
    const line = value.slice(0, start).split('\n').pop();
    const lineStart = start - line.length;
    let insertion;
    let cursor;

    if (headings.has(type)) {
      const heading = /^#{1,6}\s/;
      if (heading.test(line.trim())) {
        const stripped = line.trim().replace(heading, '');
        const insertion = line.trim().startsWith(markers[0]) ? stripped : markers[0] + stripped;
        return {
          value: value.slice(0, lineStart) + insertion + value.slice(start),
          cursor: lineStart + insertion.length,
        };
      }
      insertion = markers[0] + line.trimStart();
      return {
        value: value.slice(0, lineStart) + insertion + value.slice(start),
        cursor: lineStart + insertion.length,
      };
    }

    if (lineToggles.has(type)) {
      const prefix = markers[0];
      insertion = (selected ? selected.split('\n') : [line.trim() || 'item'])
        .map((item) => (item.startsWith(prefix) ? item.slice(prefix.length) : prefix + item))
        .join('\n');
    } else if (type === 'hr') {
      insertion = '\n---\n';
    } else {
      insertion = markers[0] + selected + markers[1];
    }

    cursor = selected ? start + insertion.length : start + markers[0].length;
    if (type === 'hr') cursor = start + insertion.length;
    if (lineToggles.has(type)) cursor = start + insertion.length;

    return {value: value.slice(0, start) + insertion + value.slice(end), cursor};
  }

  function table(value, start, end, rows, columns) {
    const header = Array.from({length: columns}, (_, index) => `Column ${index + 1}`);
    const divider = Array.from({length: columns}, () => '---');
    const body = Array.from({length: Math.max(0, rows - 1)}, () => Array(columns).fill(''));
    const markdownRows = [header, divider, ...body].map((row) => `| ${row.join(' | ')} |`);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
    const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
    const insertion = prefix + markdownRows.join('\n') + suffix;
    const cursor = start + prefix.length + markdownRows[0].length + markdownRows[1].length + 4;
    return {value: before + insertion + after, cursor};
  }

  root.VylkMarkdownFormatting = Object.freeze({format, table});
})(globalThis);
