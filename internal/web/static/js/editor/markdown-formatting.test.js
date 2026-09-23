import {describe, expect, test} from 'bun:test';

await import('./markdown-formatting.js');

const {format, table} = globalThis.VylkMarkdownFormatting;

describe('Markdown formatting', () => {
  test('wraps selected inline text and places the cursor after it', () => {
    expect(format('some text here', 5, 9, 'bold')).toEqual({
      value: 'some **text** here',
      cursor: 13,
    });
  });

  test('toggles headings and line prefixes', () => {
    expect(format('Heading', 7, 7, 'h2')).toEqual({value: '## Heading', cursor: 10});
    expect(format('## Heading', 10, 10, 'h1')).toEqual({value: '# Heading', cursor: 9});
    expect(format('## Heading', 10, 10, 'h2')).toEqual({value: 'Heading', cursor: 7});
    expect(format('## Heading', 10, 10, 'h5')).toEqual({value: '##### Heading', cursor: 13});
    expect(format('one\ntwo', 0, 7, 'ul')).toEqual({value: '- one\n- two', cursor: 11});
  });

  test('creates tables with the original cursor position', () => {
    expect(table('beforeafter', 6, 6, 2, 2)).toEqual({
      value: 'before\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nafter',
      cursor: 48,
    });
  });

  test('ignores unknown formats', () => {
    expect(format('unchanged', 0, 0, 'missing')).toBeNull();
    expect(format('unchanged', 0, 0, 'codeblock')).toBeNull();
  });
});
