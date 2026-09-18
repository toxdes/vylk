'use strict';

importScripts('/marked.min.js', '/interactive-preview.js');

function escapeHTML(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownOptions() {
  const options = {breaks:true, gfm:true};
  if (typeof marked.Renderer === 'function') {
    const renderer = new marked.Renderer();
    renderer.html = token => escapeHTML(token.text ?? token.raw ?? '');
    options.renderer = renderer;
  }
  return options;
}

function tokenTag(token) {
  switch (token.type) {
    case 'blockquote': return 'BLOCKQUOTE';
    case 'code': return 'PRE';
    case 'heading': {
      const match = (token.raw || '').match(/^\s*(#+)/);
      if (match) return `H${match[1].length}`;
      return Number.isInteger(token.depth) && token.depth >= 1 && token.depth <= 6 ? `H${token.depth}` : null;
    }
    case 'hr': return 'HR';
    case 'list': return token.ordered ? 'OL' : 'UL';
    case 'paragraph': return 'P';
    case 'table': return 'TABLE';
    default: return null;
  }
}

function gapDoesNotRender(source, options) {
  if (!source) return true;
  return marked.lexer(source, options).every(token => token.type === 'space');
}

function describeBlocks(source, options, tokens) {
  const blocks = [];
  const htmlChunks = [];
  let incrementalSafe = true;
  let offset = 0;
  for (const token of tokens) {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    if (!raw) continue;
    const start = source.indexOf(raw, offset);
    if (start < offset || !gapDoesNotRender(source.slice(offset, start), options)) return [];
    offset = start + raw.length;
    const tagName = tokenTag(token);
    const tokenList = [token];
    tokenList.links = tokens.links;
    const blockHTML = marked.parser(tokenList, options);
    if (blockHTML) htmlChunks.push(blockHTML);
    if (!tagName) {
      if (token.type !== 'space' && blockHTML.trim()) incrementalSafe = false;
      continue;
    }
    blocks.push({
      start,
      end:Math.max(start, start + raw.replace(/[\s\r\n]+$/, '').length),
      tagName,
      type:token.type,
      html:blockHTML,
      listItems:token.type === 'list'
        ? globalThis.VylkInteractive.listItemRanges(raw, start, `list:${start}`)
        : [],
    });
  }
  return {
    blocks:gapDoesNotRender(source.slice(offset), options) ? blocks : [],
    htmlChunks,
    incrementalSafe,
  };
}

self.addEventListener('message', event => {
  const id = event.data?.id;
  const source = typeof event.data?.source === 'string' ? event.data.source : '';
  try {
    const options = markdownOptions();
    const tokens = marked.lexer(source, options);
    const description = describeBlocks(source, options, tokens);
    let html = null;
    // Keep exact full-document equivalence validation for ordinary notes.
    // Large notes avoid the duplicate parse; their token stream still has to
    // consist entirely of independently renderable top-level blocks.
    if (description.incrementalSafe && source.length <= 250_000) {
      html = marked.parse(source, options);
      description.incrementalSafe = description.htmlChunks.join('') === html;
    }
    const {htmlChunks, ...metadata} = description;
    const result = {id, ...metadata};
    // Incrementally safe responses already contain the complete rendered
    // output in their block HTML. Only unsafe token streams need a second,
    // full-document parse and HTML payload.
    if (!description.incrementalSafe) {
      html ||= marked.parse(source, options);
      if (htmlChunks.join('') === html) result.htmlChunks = htmlChunks;
      else result.html = html;
    }
    self.postMessage(result);
  } catch (error) {
    self.postMessage({id, error:error?.message || 'preview rendering failed'});
  }
});
