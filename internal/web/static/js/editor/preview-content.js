(function (root) {
  'use strict';

  const ALLOWED_ELEMENTS = new Set([
    'A',
    'BLOCKQUOTE',
    'BR',
    'CODE',
    'DEL',
    'EM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HR',
    'IMG',
    'INPUT',
    'LI',
    'OL',
    'P',
    'PRE',
    'S',
    'STRONG',
    'SUB',
    'SUP',
    'TABLE',
    'TBODY',
    'TD',
    'TH',
    'THEAD',
    'TR',
    'UL',
  ]);
  const ALLOWED_ATTRIBUTES = new Set([
    'align',
    'alt',
    'checked',
    'class',
    'colspan',
    'disabled',
    'href',
    'rowspan',
    'src',
    'start',
    'title',
    'type',
  ]);

  function create({document, escapeHTML, getMarked, location}) {
    function linkifyWikiLinks(container) {
      const matcher = /\[\[([^\[\]\n]+)\]\]/g;
      const nodeFilter = document.defaultView?.NodeFilter || root.NodeFilter;
      const walker = document.createTreeWalker(container, nodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!matcher.test(node.nodeValue || '')) return nodeFilter.FILTER_REJECT;
          matcher.lastIndex = 0;
          return node.parentElement?.closest('a, code, pre, script, style')
            ? nodeFilter.FILTER_REJECT
            : nodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const text = node.nodeValue || '';
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        matcher.lastIndex = 0;
        for (let match; (match = matcher.exec(text));) {
          const title = match[1].trim().replace(/\s+/g, ' ');
          if (!title) continue;
          fragment.append(document.createTextNode(text.slice(cursor, match.index)));
          const link = document.createElement('a');
          link.className = 'wiki-link';
          link.href = '/';
          link.dataset.wikiTitle = title;
          link.textContent = title;
          fragment.append(link);
          cursor = match.index + match[0].length;
        }
        fragment.append(document.createTextNode(text.slice(cursor)));
        node.replaceWith(fragment);
      }
    }

    function safeURL(value, allowMailto = false) {
      if (!value || /[\u0000-\u001f]/.test(value)) return false;
      try {
        const url = new URL(value, location.href);
        return (
          ['http:', 'https:'].includes(url.protocol) || (allowMailto && url.protocol === 'mailto:')
        );
      } catch (_) {
        return false;
      }
    }

    function sanitize(container) {
      [...container.querySelectorAll('*')].forEach((element) => {
        if (!ALLOWED_ELEMENTS.has(element.tagName)) {
          element.remove();
          return;
        }
        [...element.attributes].forEach((attribute) => {
          const name = attribute.name.toLowerCase();
          if (!ALLOWED_ATTRIBUTES.has(name) || name.startsWith('on'))
            element.removeAttribute(attribute.name);
        });
        if (element.tagName === 'OL') {
          const start = element.getAttribute('start');
          if (start !== null && !/^[+-]?\d+$/.test(start)) element.removeAttribute('start');
        } else {
          element.removeAttribute('start');
        }
        if (element.tagName === 'A') {
          const href = element.getAttribute('href');
          if (href && !safeURL(href, true)) element.removeAttribute('href');
        }
        if (element.tagName === 'IMG') {
          const src = element.getAttribute('src');
          if (!src || !safeURL(src)) {
            element.remove();
            return;
          }
          element.setAttribute('loading', 'lazy');
          element.setAttribute('decoding', 'async');
        }
        if (element.tagName === 'INPUT' && element.getAttribute('type') !== 'checkbox')
          element.remove();
      });
    }

    function markdownRenderOptions() {
      const options = {breaks: true, gfm: true};
      // Resolve lazily so a parser loaded or replaced after startup is still used.
      const marked = getMarked();
      if (typeof marked?.Renderer === 'function') {
        const renderer = new marked.Renderer();
        renderer.html = (token) => escapeHTML(token.text ?? token.raw ?? '');
        options.renderer = renderer;
      }
      return options;
    }

    return {linkifyWikiLinks, markdownRenderOptions, safeURL, sanitize};
  }

  root.VylkPreviewContent = {create};
})(typeof window !== 'undefined' ? window : globalThis);
