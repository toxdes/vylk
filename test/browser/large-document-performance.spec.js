import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';

const password = 'browser-test-password';
const localFixture = process.env.LARGE_MARKDOWN_FIXTURE;
const syntheticLineCount = Number(process.env.LARGE_DOCUMENT_LINES || 10_000);

function largeMarkdown() {
  if (localFixture) return readFileSync(localFixture, 'utf8');
  const body = 'A substantial Markdown line with **formatting**, a [link](https://example.com), and enough text to wrap on a narrow screen.';
  return Array.from({length:syntheticLineCount}, (_, index) => `${index % 12 === 0 ? '## ' : ''}Line ${index}: ${body}`).join('\n');
}

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('large documents keep editor input and preview transitions responsive', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.CPU_THROTTLE) {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', {rate:Number(process.env.CPU_THROTTLE)});
  }
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__previewWorkerMetrics = [];
    window.__longTasks = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.__isPreviewWorker = String(url).includes('preview-worker');
        if (this.__isPreviewWorker) {
          this.addEventListener('message', event => {
            const metric = window.__previewWorkerMetrics.find(entry => entry.id === event.data?.id);
            if (metric) {
              metric.received = performance.now();
              metric.incrementalSafe = event.data?.incrementalSafe;
              metric.blocks = event.data?.blocks?.length || 0;
              metric.htmlBytes = event.data?.html?.length || 0;
              metric.htmlChunks = event.data?.htmlChunks?.length || 0;
              metric.chunkBytes = event.data?.htmlChunks?.reduce((total, chunk) => total + chunk.length, 0) || 0;
              metric.maxChunkBytes = event.data?.htmlChunks?.reduce((maximum, chunk) => Math.max(maximum, chunk.length), 0) || 0;
            }
          });
        }
      }
      postMessage(message, transfer) {
        if (this.__isPreviewWorker) window.__previewWorkerMetrics.push({id:message?.id, sent:performance.now()});
        return transfer === undefined ? super.postMessage(message) : super.postMessage(message, transfer);
      }
    };
    if (typeof PerformanceObserver === 'function') {
      new PerformanceObserver(list => {
        list.getEntries().forEach(entry => window.__longTasks.push({start:entry.startTime, duration:entry.duration}));
      }).observe({type:'longtask', buffered:true});
    }
  });
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('[data-panel="editor"]').click();

  const source = `${largeMarkdown()}\n\nbenchmark-final-marker`;
  const editor = page.locator('#note-content');
  await editor.evaluate((textarea, value) => {
    textarea.value = value;
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new InputEvent('input', {bubbles:true, data:null, inputType:'insertText'}));
  }, source);
  await page.waitForTimeout(800);

  const editorLatency = await editor.evaluate(async textarea => {
    textarea.focus({preventScroll:true});
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const started = performance.now();
    const inputHandled = new Promise(resolve => textarea.addEventListener('input', () => resolve(performance.now() - started), {once:true}));
    const nextFrame = new Promise(resolve => requestAnimationFrame(() => resolve(performance.now() - started)));
    document.execCommand('insertText', false, 'x');
    return {input:await inputHandled, frame:await nextFrame};
  });

  await page.evaluate(() => {
    window.__previewWorkerMetrics = [];
    window.__longTasks = [];
    window.__mainThreadMarkdownParses = 0;
    const originalMarked = window.marked;
    const parse = originalMarked.parse.bind(originalMarked);
    window.marked = new Proxy(originalMarked, {
      get(target, property, receiver) {
        if (property !== 'parse') return Reflect.get(target, property, receiver);
        return (...args) => {
          window.__mainThreadMarkdownParses++;
          return parse(...args);
        };
      },
    });
    window.__previewTransition = {started:null, handlerComplete:null, firstMutation:null, complete:null};
    const preview = document.querySelector('#preview');
    const observer = new MutationObserver(() => {
      const transition = window.__previewTransition;
      if (transition.started === null) return;
      if (transition.firstMutation === null && preview.childElementCount) transition.firstMutation = performance.now();
      const finalBlockReady = preview.lastElementChild?.textContent.includes('benchmark-final-marker');
      if (!preview.hasAttribute('aria-busy') && finalBlockReady) {
        requestAnimationFrame(() => {
          transition.complete = performance.now();
          observer.disconnect();
        });
      }
    });
    observer.observe(preview, {attributes:true, childList:true, subtree:true});
    document.querySelector('[data-panel="preview"]').addEventListener('click', () => {
      window.__previewTransition.started = performance.now();
    }, {capture:true, once:true});
    document.addEventListener('click', event => {
      if (event.target.closest('[data-panel="preview"]')) window.__previewTransition.handlerComplete = performance.now();
    }, {once:true});
  });
  await page.locator('[data-panel="preview"]').click();
  await expect(page.locator('#preview')).not.toHaveAttribute('aria-busy', 'true', {timeout:90_000});
  await expect(page.locator('#preview')).toContainText('benchmark-final-marker', {timeout:90_000});
  await expect.poll(() => page.evaluate(() => window.__previewTransition.complete), {timeout:90_000}).not.toBeNull();
  const previewMetrics = await page.evaluate(() => ({
    worker:window.__previewWorkerMetrics.at(-1) || null,
    workers:window.__previewWorkerMetrics,
    longTasks:window.__longTasks,
    blocks:document.querySelector('#preview').childElementCount,
    transition:window.__previewTransition,
    mainThreadMarkdownParses:window.__mainThreadMarkdownParses,
  }));
  const previewLatency = previewMetrics.transition.complete - previewMetrics.transition.started;

  console.log(JSON.stringify({bytes:source.length, lines:source.split('\n').length, editorLatency, previewLatency, previewMetrics}));
  expect(previewMetrics.mainThreadMarkdownParses).toBe(0);
  expect(previewMetrics.workers.filter(metric => metric.received)).toHaveLength(1);
});
