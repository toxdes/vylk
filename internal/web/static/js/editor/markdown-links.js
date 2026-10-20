(function (global) {
  'use strict';

  function safeHref(value) {
    const href = String(value ?? '').trim();
    if (!href || /[\u0000-\u0020<>\u007f]/.test(href)) return null;
    const scheme = href.match(/^([a-z][a-z\d+.-]*):/i);
    if (scheme && !/^(https?|mailto|tel)$/i.test(scheme[1])) return null;
    return href;
  }

  // Source Markdown may contain bare relative filenames. Popup input is more
  // deliberate: require an explicit scheme or relative-reference prefix so
  // arbitrary prose cannot silently become a hyperlink.
  function inputHref(value) {
    const href = safeHref(value);
    if (!href || /[\s\\]/u.test(href)) return null;
    try {
      if (/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(href)) {
        const url = new URL(href);
        return url.hostname ? href : null;
      }
      if (/^mailto:/i.test(href)) {
        const address = decodeURIComponent(new URL(href).pathname);
        return address.split(',').every((part) => /^[^@\s,/?#]+@[^@\s,/?#]+$/.test(part))
          ? href
          : null;
      }
      if (/^tel:/i.test(href))
        return /^tel:(?=[^;]*\d)\+?[\d().-]+(?:;[a-z\d-]+=[a-z\d+().%-]+)*$/i.test(href)
          ? href
          : null;
      if (/^(?:\/|\.{1,2}\/|#|\?)/.test(href)) {
        if (href.startsWith('///')) return null;
        new URL(href, 'https://vylk.invalid/');
        return href;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  // Use the same Markdown grammar as Preview. Only changed lines containing a
  // bracket reach the lexer; code spans, escapes, images and nested labels keep
  // their established meaning rather than being matched with a link regex.
  function ranges(source, tokens) {
    if (!source.includes('[') || typeof global.marked?.Lexer?.lexInline !== 'function') return [];
    const result = [];
    function visit(tokens, base) {
      let offset = base;
      for (const token of tokens) {
        if (token.type === 'link' && token.raw.startsWith('[')) {
          let depth = 1;
          let end = 1;
          for (; end < token.raw.length; end++) {
            if (token.raw[end] === '\\') end++;
            else if (token.raw[end] === '[') depth++;
            else if (token.raw[end] === ']' && --depth === 0) break;
          }
          if (token.raw.slice(end).startsWith(']('))
            result.push({
              start: offset,
              end: offset + token.raw.length,
              labelStart: offset + 1,
              labelEnd: offset + end,
              href: token.href,
              safeHref: safeHref(token.href),
            });
        } else if (['strong', 'em', 'del'].includes(token.type) && token.tokens?.length) {
          visit(token.tokens, offset + token.raw.indexOf(token.tokens[0].raw));
        }
        offset += token.raw.length;
      }
    }
    visit(tokens || global.marked.Lexer.lexInline(source), 0);
    return result;
  }

  function destination(href) {
    return href.replace(/\\/g, '%5C').replace(/[()]/g, '\\$&');
  }

  global.VylkMarkdownLinks = {destination, inputHref, ranges, safeHref};
})(typeof window !== 'undefined' ? window : globalThis);
