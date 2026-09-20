(function (global) {
  'use strict';

  function create({
    getSource,
    hasRenderedRanges,
    isVisible,
    onFallback,
    onMetadata,
    onRender,
    setBusy,
    window,
  }) {
    let worker = null;
    let unavailable = false;
    let generation = 0;
    let request = null;
    let postFrame = null;
    let applyHandle = null;

    function cancelApply() {
      if (!applyHandle) return;
      if (applyHandle.idle) window.cancelIdleCallback(applyHandle.id);
      else window.clearTimeout(applyHandle.id);
      applyHandle = null;
    }

    function scheduleApply(callback) {
      cancelApply();
      if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(
          () => {
            applyHandle = null;
            callback();
          },
          {timeout: 200},
        );
        applyHandle = {id, idle: true};
        return;
      }
      const id = window.setTimeout(() => {
        applyHandle = null;
        callback();
      }, 0);
      applyHandle = {id, idle: false};
    }

    function fail() {
      unavailable = true;
      worker?.terminate();
      worker = null;
    }

    function ensureWorker() {
      if (worker || unavailable || typeof window.Worker !== 'function') return worker;
      try {
        worker = new window.Worker('/js/workers/preview-worker.js');
        worker.addEventListener('message', (event) => {
          const result = event.data || {};
          const activeRequest = request;
          if (!activeRequest || result.id !== activeRequest.id || result.id !== generation) return;
          if (activeRequest.source !== getSource() || !isVisible()) {
            request = null;
            setBusy(false);
            return;
          }
          request = null;
          const incrementalSafe = Boolean(result.incrementalSafe && Array.isArray(result.blocks));
          const html = incrementalSafe ? null : result.html;
          const htmlChunks = Array.isArray(result.htmlChunks) ? result.htmlChunks : null;
          if (result.error || (!incrementalSafe && typeof html !== 'string' && !htmlChunks)) {
            fail();
            scheduleApply(onFallback);
            return;
          }
          const metadata = {
            source: activeRequest.source,
            blocks: result.blocks,
            incrementalSafe,
            htmlChunks,
          };
          if (hasRenderedRanges(activeRequest.source)) {
            onMetadata(metadata);
            setBusy(false);
            return;
          }
          scheduleApply(() => {
            if (result.id === generation) onRender(activeRequest.source, html, metadata);
          });
        });
        worker.addEventListener('error', () => {
          const failedGeneration = generation;
          fail();
          scheduleApply(() => {
            if (failedGeneration === generation) onFallback();
          });
        });
      } catch (_) {
        fail();
      }
      return worker;
    }

    function cancel() {
      generation++;
      request = null;
      if (postFrame !== null) window.cancelAnimationFrame(postFrame);
      postFrame = null;
      cancelApply();
    }

    function prime(source) {
      const renderWorker = ensureWorker();
      if (!renderWorker || !source) return;
      const id = ++generation;
      request = {id, source};
      renderWorker.postMessage({id, source});
    }

    function render(source, {announceBusy = false} = {}) {
      const renderWorker = ensureWorker();
      if (!renderWorker) {
        onFallback();
        return;
      }
      if (announceBusy) setBusy(true);
      if (request?.source === source) return;
      const id = ++generation;
      request = {id, source};
      const post = () => {
        postFrame = null;
        if (request?.id !== id) return;
        if (getSource() !== source || !isVisible()) {
          request = null;
          setBusy(false);
          return;
        }
        renderWorker.postMessage({id, source});
      };
      if (announceBusy) postFrame = window.requestAnimationFrame(post);
      else post();
    }

    return {cancel, generation: () => generation, prime, render};
  }

  global.VylkPreviewWorkerClient = {create};
})(typeof window !== 'undefined' ? window : globalThis);
