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
});
