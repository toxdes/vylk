import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const staticDirectory = path.join(testDirectory, '..', 'static');

function loadPreviewWorker() {
  const handlers = new Map();
  const messages = [];
  let context;
  const self = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  context = vm.createContext({self, console});
  context.importScripts = (...sources) => {
    for (const source of sources) {
      vm.runInContext(
        fs.readFileSync(path.join(staticDirectory, source.replace(/^\//, '')), 'utf8'),
        context,
      );
    }
  };
  vm.runInContext(
    fs.readFileSync(path.join(staticDirectory, 'js', 'workers', 'preview-worker.js'), 'utf8'),
    context,
  );
  return {handlers, messages, context};
}

test('renders Markdown and source metadata away from the app thread', () => {
  const worker = loadPreviewWorker();
  worker.handlers.get('message')({
    data: {id: 7, source: '# Heading\n\n- [ ] task\n- second\n\n<script>alert(1)</script>'},
  });

  expect(worker.messages).toHaveLength(1);
  expect(worker.messages[0]).toMatchObject({
    id: 7,
    blocks: [
      {tagName: 'H1', type: 'heading'},
      {tagName: 'UL', type: 'list', listItems: [{start: 11}, {start: 22}]},
    ],
  });
  expect(worker.messages[0]).not.toHaveProperty('source');
  const rendered = worker.messages[0].html || worker.messages[0].htmlChunks.join('');
  expect(rendered).toContain('<h1>Heading</h1>');
  expect(rendered).not.toContain('<script>');
  expect(rendered).toContain('&lt;script&gt;');
  expect(worker.messages[0].incrementalSafe).toBe(false);
});

test('produces independently renderable blocks for incremental preview updates', () => {
  const worker = loadPreviewWorker();
  worker.handlers.get('message')({
    data: {id: 8, source: '# Heading\n\nParagraph with **bold** text.\n\n1. first\n2. second'},
  });

  const result = worker.messages[0];
  expect(result.incrementalSafe).toBe(true);
  expect(result).not.toHaveProperty('source');
  expect(result).not.toHaveProperty('html');
  expect(result.blocks.map((block) => block.html).join('')).toContain('<h1>Heading</h1>');
});

test('renders one checkbox per task in loose Markdown lists', () => {
  const worker = loadPreviewWorker();
  worker.handlers.get('message')({
    data: {id: 9, source: '15. [ ] Keyboard thing\n\n16. [ ] Preference'},
  });

  const result = worker.messages[0];
  const rendered = result.html || result.blocks.map((block) => block.html).join('');
  expect(result.incrementalSafe).toBe(true);
  expect(rendered.match(/type="checkbox"/g)).toHaveLength(2);
});

test('incremental block output matches full rendering for supported Markdown structures', () => {
  const sources = [
    '# Heading\n\nParagraph with **bold**, *emphasis*, and [a reference][ref].\n\n[ref]: https://example.com',
    '> A quote\n> over two lines\n\n```js\nconst value = 1;\n```',
    '| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n\n---',
    '1. first\n2. second\n   - nested\n\n- [ ] task\n- [x] complete',
  ];

  sources.forEach((source, index) => {
    const worker = loadPreviewWorker();
    worker.handlers.get('message')({data: {id: index + 20, source}});
    const result = worker.messages[0];
    expect(result.incrementalSafe).toBe(true);
    expect(result.blocks.map((block) => block.html).join('')).toBe(
      worker.context.marked.parse(source, {breaks: true, gfm: true}),
    );
  });
});
