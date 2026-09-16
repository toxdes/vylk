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
    addEventListener(type, handler) { handlers.set(type, handler); },
    postMessage(message) { messages.push(message); },
  };
  context = vm.createContext({self, console});
  context.importScripts = (...sources) => {
    for (const source of sources) {
      vm.runInContext(fs.readFileSync(path.join(staticDirectory, source.replace(/^\//, '')), 'utf8'), context);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(staticDirectory, 'preview-worker.js'), 'utf8'), context);
  return {handlers, messages};
}

test('renders Markdown and source metadata away from the app thread', () => {
  const worker = loadPreviewWorker();
  worker.handlers.get('message')({data:{id:7, source:'# Heading\n\n- [ ] task\n- second\n\n<script>alert(1)</script>'}});

  expect(worker.messages).toHaveLength(1);
  expect(worker.messages[0]).toMatchObject({
    id:7,
    blocks:[
      {tagName:'H1', type:'heading'},
      {tagName:'UL', type:'list', listItems:[{start:11}, {start:22}]},
    ],
  });
  expect(worker.messages[0].html).toContain('<h1>Heading</h1>');
  expect(worker.messages[0].html).not.toContain('<script>');
  expect(worker.messages[0].html).toContain('&lt;script&gt;');
  expect(worker.messages[0].incrementalSafe).toBe(false);
});

test('produces independently renderable blocks for incremental preview updates', () => {
  const worker = loadPreviewWorker();
  worker.handlers.get('message')({data:{id:8, source:'# Heading\n\nParagraph with **bold** text.\n\n1. first\n2. second'}});

  const result = worker.messages[0];
  expect(result.incrementalSafe).toBe(true);
  expect(result.blocks.map(block => block.html).join('')).toBe(result.html);
});
