import {expect, test} from 'bun:test';

await import('./preview-worker-client.js');

test('preview worker client applies only the current render response', () => {
  const timers = [];
  const workers = [];
  class Worker {
    listeners = new Map();
    messages = [];

    constructor() {
      workers.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    emit(type, data) {
      this.listeners.get(type)?.({data});
    }

    terminate() {}
  }

  let source = 'first';
  const rendered = [];
  const client = globalThis.VylkPreviewWorkerClient.create({
    getSource: () => source,
    hasRenderedRanges: () => false,
    isVisible: () => true,
    onFallback: () => {},
    onMetadata: () => {},
    onRender: (...args) => rendered.push(args),
    setBusy: () => {},
    window: {
      Worker,
      cancelAnimationFrame() {},
      clearTimeout() {},
      requestAnimationFrame(callback) {
        timers.push(callback);
        return timers.length;
      },
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
    },
  });

  client.render(source);
  const firstRequest = workers[0].messages[0];
  workers[0].emit('message', {
    id: firstRequest.id,
    incrementalSafe: false,
    html: '<p>first</p>',
  });
  timers.shift()();
  expect(rendered).toEqual([
    [
      'first',
      '<p>first</p>',
      {source: 'first', blocks: undefined, incrementalSafe: false, htmlChunks: null},
    ],
  ]);

  source = 'second';
  client.render(source);
  const staleRequest = workers[0].messages.at(-1);
  client.cancel();
  workers[0].emit('message', {...staleRequest, html: '<p>stale</p>'});
  expect(rendered).toHaveLength(1);
});
