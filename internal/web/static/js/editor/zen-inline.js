(function (global) {
  'use strict';

  const lines = new WeakMap();
  const classes = {
    strong: 'zen-md-strong',
    em: 'zen-md-em',
    del: 'zen-md-strike',
    codespan: 'zen-md-code',
    link: 'zen-md-link',
  };

  function listPrefix(source) {
    return source.match(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/)?.[0] || '';
  }

  function append(parent, text, className = '') {
    if (!text) return;
    const node = className ? document.createElement('span') : document.createTextNode(text);
    if (className) {
      node.className = className;
      node.textContent = text;
      node.setAttribute('aria-hidden', 'true');
    }
    parent.append(node);
  }

  function tokenSpan(token, offset, state) {
    const link = token.type === 'link' ? state.linkStarts.get(offset) : null;
    const className = classes[token.type];
    if (!className || (token.type === 'link' && !link?.safeHref)) return null;
    const delimiter =
      token.type === 'codespan'
        ? token.raw.match(/^`+/)[0].length
        : token.type === 'strong'
          ? 2
          : token.type === 'del'
            ? token.raw.match(/^~+/)[0].length
            : 1;
    const end = offset + token.raw.length;
    const contentStart = link?.labelStart ?? offset + delimiter;
    const contentEnd = link?.labelEnd ?? end - delimiter;
    return {start: offset, end, contentStart, contentEnd, kind: token.type, link, className};
  }

  // Keep hidden syntax in text nodes: DOM ranges and the source model then
  // share offsets, including nested styles and escaped link destinations.
  function renderTokens(parent, tokens, base, state) {
    let offset = base;
    for (const token of tokens) {
      const span = tokenSpan(token, offset, state);
      if (!span) {
        append(parent, token.raw);
        offset += token.raw.length;
        continue;
      }
      const {end, contentStart, contentEnd, link, className} = span;
      state.spans.push({start: offset, end, contentStart, contentEnd, kind: token.type});
      const syntaxClass = `zen-md-marker zen-md-inline-syntax ${link ? 'zen-md-link-syntax' : 'zen-md-format-syntax'}`;
      append(parent, state.source.slice(offset, contentStart), syntaxClass);
      parent.lastChild.dataset.zenBoundary = 'start';
      const content = document.createElement(link ? 'a' : 'span');
      content.className = className;
      if (link) {
        content.href = link.safeHref;
        content.target = '_blank';
        content.rel = 'noopener noreferrer';
      }
      if (token.tokens) renderTokens(content, token.tokens, contentStart, state);
      else append(content, state.source.slice(contentStart, contentEnd));
      parent.append(content);
      append(parent, state.source.slice(contentEnd, end), syntaxClass);
      parent.lastChild.dataset.zenBoundary = 'end';
      offset = end;
    }
  }

  function render(element, source) {
    element.className = 'zen-editor-line';
    element.replaceChildren();
    const state = {source, links: [], spans: [], bodyStart: 0};
    lines.set(element, state);
    if (!source.trim()) {
      element.classList.add('zen-md-blank');
      if (source) append(element, source);
      else element.append(document.createElement('br'));
      return;
    }
    let base = 0;
    let parent = element;
    const heading = source.match(/^( {0,3})(#{1,6})(\s+)/);
    const quote = !heading && source.match(/^( {0,3})(>)( ?)/);
    const structural = heading || quote;
    if (structural) {
      element.classList.add(
        ...(heading ? ['zen-md-heading', `zen-md-h${heading[2].length}`] : ['zen-md-quote']),
      );
      append(element, structural[1]);
      // Structural Markdown remains visible and editable in Zen.
      const marker = document.createElement('span');
      marker.className = `zen-md-marker zen-md-${heading ? 'heading' : 'quote'}-marker`;
      marker.textContent = structural[2];
      element.append(marker);
      append(element, structural[3]);
      base = structural[0].length;
    } else {
      const prefix = listPrefix(source);
      if (prefix) {
        element.classList.add('zen-md-list');
        const marker = document.createElement('span');
        marker.className = 'zen-md-marker zen-md-list-marker';
        marker.textContent = prefix;
        element.append(marker);
        parent = document.createElement('span');
        parent.className = 'zen-md-list-content';
        element.append(parent);
        base = prefix.length;
      }
    }
    state.bodyStart = base;
    const text = source.slice(base);
    if (!/[*_~`[]/.test(text)) return append(parent, text);
    const tokens = global.marked.Lexer.lexInline(text);
    state.links = global.VylkMarkdownLinks.ranges(text, tokens).map((link) => ({
      ...link,
      start: base + link.start,
      end: base + link.end,
      labelStart: base + link.labelStart,
      labelEnd: base + link.labelEnd,
    }));
    state.linkStarts = new Map(state.links.map((link) => [link.start, link]));
    renderTokens(parent, tokens, base, state);
  }

  function spans(element) {
    return lines.get(element)?.spans || [];
  }

  function links(element) {
    return lines.get(element)?.links || [];
  }

  const formatBits = {strong: 1, em: 2, del: 4};
  const formatMarkers = ['**', '*', '~~'];

  // Work from complete parsed spans, not a re-lexed selection: its missing
  // delimiters cannot tell us which styles are inherited from surrounding text.
  // This allocation and serialization happens only on a formatting command.
  function formatRuns({element, source, start, end, whole = false}) {
    const {spans, bodyStart} = lines.get(element);
    start = Math.max(start, bodyStart);
    end = Math.min(end, source.length);
    if (start >= end) return {source, runs: [], from: start, to: start};
    let from = start;
    let to = end;
    while (from > bodyStart && /\s/.test(source[from - 1])) from--;
    while (to < source.length && /\s/.test(source[to])) to++;
    const include = (span) => {
      if (span.start <= to && span.end >= from) {
        from = Math.min(from, span.start);
        to = Math.max(to, span.end);
      }
    };
    // Include touching neighbors too: reapplying a style beside an existing
    // one must merge their delimiters rather than create a literal **** run.
    for (let index = spans.length - 1; index >= 0; index--) include(spans[index]);
    for (const span of spans) include(span);
    if (whole) {
      from = bodyStart;
      to = source.length;
    }
    const root = {contentStart: from, contentEnd: to, children: []};
    const stack = [root];
    for (const span of spans) {
      if (span.start < from || span.end > to) continue;
      while (stack.length > 1 && span.start >= stack.at(-1).contentEnd) stack.pop();
      const node = {...span, children: []};
      stack.at(-1).children.push(node);
      stack.push(node);
    }
    const runs = [];
    function text(left, right, mask, link) {
      const cuts = [
        left,
        Math.max(left, Math.min(right, start)),
        Math.max(left, Math.min(right, end)),
        right,
      ];
      for (let index = 0; index < cuts.length - 1; index++) {
        const a = cuts[index];
        const b = cuts[index + 1];
        if (b <= a) continue;
        for (const raw of source.slice(a, b).match(/\s+|\S+/g) || [])
          runs.push({raw, mask, link, selected: a >= start && b <= end});
      }
    }
    function visit(node, mask = 0, link = null) {
      mask |= formatBits[node.kind] || 0;
      if (node.kind === 'link') link = node;
      if (node.kind === 'codespan') {
        // Code is an opaque atom: preserve its content, exact delimiter and
        // inherited styles, even when the visual selection clips its label.
        runs.push({
          raw: source.slice(node.start, node.end),
          mask,
          link,
          code: true,
          selected: start < node.contentEnd && end > node.contentStart,
          selectedStart: Math.max(node.contentStart, start) - node.start,
          selectedEnd: Math.min(node.contentEnd, end) - node.start,
        });
        return;
      }
      let cursor = node.contentStart;
      for (const child of node.children) {
        text(cursor, child.start, mask, link);
        visit(child, mask, link);
        cursor = child.end;
      }
      text(cursor, node.contentEnd, mask, link);
    }
    visit(root);
    return {source, runs, from, to};
  }

  function sameFormatting(expected, source, bodyStart) {
    const text = source.slice(bodyStart);
    const tokens = global.marked.Lexer.lexInline(text);
    const links = global.VylkMarkdownLinks.ranges(text, tokens);
    const state = {linkStarts: new Map(links.map((link) => [link.start, link]))};
    const actual = [];
    function visit(tokens, base = 0, mask = 0, link = '') {
      let offset = base;
      for (const token of tokens) {
        const span = tokenSpan(token, offset, state);
        if (!span || token.type === 'codespan')
          actual.push({raw: token.raw, mask, link, code: token.type === 'codespan'});
        else
          visit(
            token.tokens,
            span.contentStart,
            mask | (formatBits[token.type] || 0),
            span.link ? text.slice(span.contentEnd, span.end) : link,
          );
        offset += token.raw.length;
      }
    }
    visit(tokens);
    // Compare rendered content and styles, not delimiter spelling. Ordinary
    // whitespace can move out of wrappers; code and link destinations cannot.
    function signature(runs, original) {
      const result = [];
      for (const run of runs) {
        const link = original
          ? run.link
            ? original.slice(run.link.contentEnd, run.link.end)
            : ''
          : run.link;
        for (const raw of run.code ? [run.raw] : run.raw.match(/\s+|\S+/g) || []) {
          const mask = run.code || /\S/.test(raw) ? run.mask : 0;
          const previous = result.at(-1);
          if (
            previous &&
            !run.code &&
            !previous.code &&
            previous.mask === mask &&
            previous.link === link
          )
            previous.raw += raw;
          else result.push({raw, mask, link, code: !!run.code});
        }
      }
      return result;
    }
    const left = signature(expected.runs, expected.source);
    const right = signature(actual);
    return (
      left.length === right.length &&
      left.every((run, index) => {
        const other = right[index];
        return (
          run.raw === other.raw &&
          run.mask === other.mask &&
          run.link === other.link &&
          run.code === other.code
        );
      })
    );
  }

  function formatSelection(selections, kind) {
    const bit = formatBits[kind];
    const parts = selections.map(formatRuns);
    let seen = false;
    let removing = true;
    for (const {runs} of parts)
      for (const run of runs)
        if (run.selected && !run.code && /\S/.test(run.raw)) {
          seen = true;
          removing &&= !!(run.mask & bit);
        }
    if (!seen) return null;
    let value = '';
    let selectionStart = null;
    let selectionEnd = null;
    function append(raw, selected = false, start = 0, end = raw.length) {
      if (selected) {
        selectionStart ??= value.length + start;
        selectionEnd = value.length + end;
      }
      value += raw;
    }
    function serialize(runs, allowed = 7, following = '') {
      for (let start = 0; start < runs.length;) {
        let flag = 0;
        let end = start;
        let depth = 0;
        // Put the longest shared style outside. A fixed bold/italic order can
        // emit ambiguous adjacent *** runs when one style continues through a
        // partial removal of the other.
        for (let kind = 0; kind < formatMarkers.length; kind++) {
          const bit = 1 << kind;
          if (!(runs[start].mask & allowed & bit) || !/\S/.test(runs[start].raw)) continue;
          let next = start + 1;
          while (next < runs.length && runs[next].mask & bit) next++;
          // Split crossing wrappers before the style that continues farther.
          if (next < runs.length)
            for (let i = start + 1; i < next; i++)
              if (runs[i].mask & runs[next].mask & allowed & ~runs[start].mask & 7) {
                next = i;
                break;
              }
          while (next > start && !/\S/.test(runs[next - 1].raw)) next--;
          if (next > end) {
            flag = bit;
            end = next;
            depth = kind;
          }
        }
        if (!flag) {
          const run = runs[start];
          append(run.raw, run.selected, run.selectedStart, run.selectedEnd);
          start++;
          continue;
        }
        const group = runs.slice(start, end);
        let marker = formatMarkers[depth];
        const next = runs[end];
        const nextMarked = next && /\S/.test(next.raw) && next.mask & allowed & 7;
        const after = next ? (nextMarked ? '*' : next.raw[0]) : following;
        if (
          depth < 2 &&
          (value.endsWith('*') ||
            nextMarked ||
            group.some((run) => run.mask & allowed & (3 ^ flag))) &&
          !/[\p{L}\p{N}]/u.test(value.at(-1) || '') &&
          !/[\p{L}\p{N}]/u.test(after?.[0] || '') &&
          !/[\p{L}\p{N}]\*+$/u.test(value.slice(-8)) &&
          !(end === runs.length && /^\*+[\p{L}\p{N}]/u.test(following))
        )
          marker = '_'.repeat(depth === 0 ? 2 : 1);
        append(marker);
        serialize(group, allowed & ~flag, marker + after);
        append(marker);
        start = end;
      }
    }
    for (const [index, part] of parts.entries()) {
      if (index) append('\n');
      const lineStart = value.length;
      append(part.source.slice(0, part.from));
      for (const run of part.runs)
        if (run.selected && !run.code) run.mask = removing ? run.mask & ~bit : run.mask | bit;
      // A link remains one link. Put formatting inside its label so that a
      // partial change never duplicates anchors or touches their destinations.
      for (let start = 0; start < part.runs.length;) {
        const link = part.runs[start].link;
        let end = start + 1;
        while (end < part.runs.length && part.runs[end].link === link) end++;
        const group = part.runs.slice(start, end);
        for (let i = 0; i < group.length;) {
          if (/\S/.test(group[i].raw)) {
            i++;
            continue;
          }
          let next = i + 1;
          while (next < group.length && !/\S/.test(group[next].raw)) next++;
          const shared = (group[i - 1]?.mask || 0) & (group[next]?.mask || 0);
          for (; i < next; i++) group[i].mask = shared;
        }
        if (link) append(part.source.slice(link.start, link.contentStart));
        serialize(group, 7, link ? ']' : part.source[part.to] || '');
        if (link) append(part.source.slice(link.contentEnd, link.end));
        start = end;
      }
      append(part.source.slice(part.to));
      const next = value.slice(lineStart);
      if (next !== part.source) {
        const expected = formatRuns({...selections[index], whole: true});
        for (const run of expected.runs)
          if (run.selected && !run.code) run.mask = removing ? run.mask & ~bit : run.mask | bit;
        if (!sameFormatting(expected, next, lines.get(selections[index].element).bodyStart))
          return {unsupported: true};
      }
    }
    return {value, start: selectionStart, end: selectionEnd};
  }

  // A clipped styled fragment keeps its original wrappers, including any
  // nested styles. This is used only when an edit crosses hidden boundaries.
  function fragment(read, entries, start, end) {
    if (end <= start) return '';
    let result = '';
    let cursor = start;
    for (const span of entries) {
      if (span.end <= cursor || span.start >= end) continue;
      if (span.start > cursor) result += read(cursor, Math.min(end, span.start));
      if (start <= span.start && end >= span.end) result += read(span.start, span.end);
      else {
        const inner = fragment(
          read,
          entries.filter((child) => child.start > span.start && child.end < span.end),
          Math.max(start, span.contentStart),
          Math.min(end, span.contentEnd),
        );
        if (inner) {
          if (['strong', 'em', 'del'].includes(span.kind)) {
            // A split must not leave emphasis delimiters next to whitespace.
            const leading = inner.length - inner.trimStart().length;
            const trailing = inner.length - inner.trimEnd().length;
            const text = inner.trim();
            const marker = read(span.start, span.contentStart).replaceAll('_', '*');
            result += text
              ? inner.slice(0, leading) +
                marker +
                text +
                marker +
                (trailing ? inner.slice(-trailing) : '')
              : inner;
          } else
            result += read(span.start, span.contentStart) + inner + read(span.contentEnd, span.end);
        }
      }
      cursor = Math.max(cursor, span.end);
    }
    return result + read(Math.min(cursor, end), end);
  }

  function visibleEdit(read, start, end, inserted, entries) {
    let from = start;
    let to = end;
    if (!inserted) {
      // Removing the last visible character removes every now-empty wrapper.
      for (const span of [...entries].reverse()) {
        if (from <= span.contentStart && to >= span.contentEnd && from < to) {
          from = Math.min(from, span.start);
          to = Math.max(to, span.end);
        }
      }
    }
    const multiline = inserted.includes('\n');
    for (const span of entries) {
      if (span.start < from && from <= span.contentEnd && (to > span.contentEnd || multiline))
        from = span.start;
      if (span.contentStart <= to && to < span.end && (from < span.contentStart || multiline))
        to = span.end;
    }
    const prefix = fragment(read, entries, from, start);
    const suffix = fragment(read, entries, end, to);
    return {
      start: from,
      end: to,
      inserted: prefix + inserted + suffix,
      caret: from + prefix.length + inserted.length,
    };
  }

  global.VylkZenInline = {render, spans, links, visibleEdit, listPrefix, formatSelection};
})(window);
