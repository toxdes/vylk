import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

const root = fileURLToPath(new URL('../frontend/styles/', import.meta.url));
const files = (directory) =>
  readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(name) : name.endsWith('.scss') ? [name] : [];
  });

describe('interface spacing policy', () => {
  test('UI spacing and radii use design tokens rather than raw lengths', () => {
    const failures = [];
    for (const file of files(root)) {
      // Note typography owns its em-based document rhythm independently of UI density.
      if (file.endsWith('/_tokens.scss')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /\b(padding[\w-]*|margin[\w-]*|(?:row-|column-)?gap|border-radius)\s*:\s*([^;{}]+);/g,
      )) {
        const value = match[2];
        // The hidden accessible label uses the standard one-pixel clipping technique.
        if (file.endsWith('/_base.scss') && value === '-0.0625rem') continue;
        if (/(?:\d|\.)+(?:px|rem)\b|var\(--(?:ui-unit|font-size)\)/.test(value)) {
          failures.push(`${file.slice(root.length)}: ${match[0]}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
  test('icon geometry has one owner', () => {
    const failures = [];
    for (const file of files(root)) {
      if (file.endsWith('/_icons.scss')) continue;
      const source = readFileSync(file, 'utf8');
      for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/\.icon\b(?!-)|\.back-chevron\b|\.vault-status-icon\b/.test(block[1])) continue;
        if (/\b(?:width|height|stroke-width):/.test(block[2]))
          failures.push(`${file.slice(root.length)}: ${block[1].trim()}`);
      }
    }
    expect(failures).toEqual([]);
  });
  test('UI font sizes use the type scale', () => {
    const failures = [];
    for (const file of files(root)) {
      // Tokens define the scale; note, preview, and Zen typography follow the user's document sizes.
      if (/\/_(?:tokens|editor-content|editor-overlay|zen-[\w-]+)\.scss$/.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const block of source.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        const selector = block[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (/^(?:html|body)$|\.preview\b|#note-content/.test(selector)) continue;
        for (const [, value] of block[2].matchAll(/(?:^|[;\s])font-size:\s*([^;]+);/g)) {
          if (!/^(?:var\(--text-[\w-]+\)|inherit)$/.test(value.trim()))
            failures.push(`${file.slice(root.length)}: ${selector} { font-size: ${value} }`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
  // Weight, line height, and colour come from tokens; note, preview, and Zen styles are exempt.
  const tokenOnly = [
    ['font-weight', /^(?:var\(--weight-[\w-]+\)|inherit)$/],
    ['line-height', /^(?:var\(--(?:leading-[\w-]+|control-height)\)|inherit|normal)$/],
  ];
  for (const [property, allowed] of tokenOnly) {
    test(`UI ${property} uses tokens`, () => {
      const failures = [];
      for (const file of files(root)) {
        if (/\/_(?:tokens|editor-content|editor-overlay|zen-[\w-]+)\.scss$/.test(file)) continue;
        const source = readFileSync(file, 'utf8');
        for (const [, value] of source.matchAll(
          new RegExp(`(?:^|[;\\s{])${property}:\\s*([^;]+);`, 'g'),
        ))
          if (!allowed.test(value.trim()))
            failures.push(`${file.slice(root.length)}: ${property}: ${value}`);
      }
      expect(failures).toEqual([]);
    });
  }
  test('UI colours come from tokens', () => {
    const failures = [];
    for (const file of files(root)) {
      if (/\/_(?:tokens|editor-content|editor-overlay|zen-[\w-]+)\.scss$/.test(file)) continue;
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [literal] of source.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi))
        failures.push(`${file.slice(root.length)}: ${literal}`);
    }
    expect(failures).toEqual([]);
  });
  test('shared button typography has one owner', () => {
    const failures = [];
    for (const file of files(root)) {
      if (file.endsWith('/_controls.scss')) continue;
      const source = readFileSync(file, 'utf8');
      for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1].replace(/:not\([^)]*\)/g, '');
        if (!/\.btn-(?:primary|secondary|text)\b(?!-)/.test(selector)) continue;
        if (/\bfont(?:-size|-weight)?:/.test(block[2]))
          failures.push(`${file.slice(root.length)}: ${block[1].trim()}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
