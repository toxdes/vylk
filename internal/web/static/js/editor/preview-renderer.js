(function (global) {
  'use strict';

  function create({
    cacheBlocks,
    contentPolicy,
    disconnectDecorations,
    document,
    dom,
    getGeneration,
    getPreviewBlocks,
    getSource,
    isVisible,
    resetPreviewModel,
    scheduleHighlight,
    setHighlightPending,
    window,
  }) {
    const preview = document.querySelector('#preview');
    let domHandle = null;
    let renderedSource = null;
    let renderedMetadata = null;

    function cancelDOMRender() {
      if (domHandle !== null) {
        window.clearTimeout(domHandle);
        domHandle = null;
      }
      preview?.removeAttribute('aria-busy');
    }

    function renderBlocksProgressively(source, metadata) {
      const generation = getGeneration();
      const elements = [];
      let index = 0;
      disconnectDecorations();
      preview.replaceChildren();
      preview.setAttribute('aria-busy', 'true');
      resetPreviewModel();

      const process = () => {
        domHandle = null;
        if (generation !== getGeneration() || getSource() !== source || !isVisible()) {
          preview.removeAttribute('aria-busy');
          return;
        }
        const fragment = document.createDocumentFragment();
        const started = window.performance.now();
        let batchSize = 0;
        while (
          index < metadata.blocks.length &&
          batchSize < 12 &&
          window.performance.now() - started < 5
        ) {
          const element = dom.elementFromBlock(metadata.blocks[index++]);
          if (!element) {
            preview.removeAttribute('aria-busy');
            render(source, metadata.blocks.map((block) => block.html || '').join(''), {
              ...metadata,
              incrementalSafe: false,
            });
            return;
          }
          elements.push(element);
          fragment.append(element);
          batchSize++;
        }
        preview.append(fragment);
        if (index < metadata.blocks.length) {
          domHandle = window.setTimeout(process, 0);
          return;
        }
        preview.removeAttribute('aria-busy');
        renderedSource = source;
        renderedMetadata = metadata;
        setHighlightPending(false);
        cacheBlocks(metadata, elements, {defer: true});
      };
      process();
    }

    function renderChunksProgressively(source, metadata) {
      const generation = getGeneration();
      const chunks = metadata.htmlChunks;
      let index = 0;
      disconnectDecorations();
      preview.replaceChildren();
      preview.setAttribute('aria-busy', 'true');
      resetPreviewModel();

      const process = () => {
        domHandle = null;
        if (generation !== getGeneration() || getSource() !== source || !isVisible()) {
          preview.removeAttribute('aria-busy');
          return;
        }
        const fragment = document.createDocumentFragment();
        const started = window.performance.now();
        while (index < chunks.length && window.performance.now() - started < 5) {
          const template = document.createElement('template');
          template.innerHTML = chunks[index++];
          contentPolicy.sanitize(template.content);
          contentPolicy.linkifyWikiLinks(template.content);
          fragment.append(template.content);
        }
        preview.append(fragment);
        if (index < chunks.length) {
          domHandle = window.setTimeout(process, 0);
          return;
        }
        preview.removeAttribute('aria-busy');
        const cachedMetadata = {...metadata, htmlChunks: null};
        renderedSource = source;
        renderedMetadata = cachedMetadata;
        setHighlightPending(false);
        cacheBlocks(cachedMetadata, null, {defer: true});
      };
      process();
    }

    function patchBlocks(metadata) {
      const previous = renderedMetadata;
      if (
        !previous?.incrementalSafe ||
        !metadata?.incrementalSafe ||
        previous.source !== renderedSource
      )
        return null;
      if (
        !previous.blocks?.every((block) => typeof block.html === 'string') ||
        !metadata.blocks?.every((block) => typeof block.html === 'string')
      )
        return null;

      const current = getPreviewBlocks().filter((element) => element?.isConnected);
      if (current.length !== previous.blocks.length) return null;
      let prefix = 0;
      while (
        prefix < current.length &&
        prefix < metadata.blocks.length &&
        previous.blocks[prefix].tagName === metadata.blocks[prefix].tagName &&
        previous.blocks[prefix].html === metadata.blocks[prefix].html
      )
        prefix++;
      let suffix = 0;
      while (
        suffix < current.length - prefix &&
        suffix < metadata.blocks.length - prefix &&
        previous.blocks[previous.blocks.length - suffix - 1].tagName ===
          metadata.blocks[metadata.blocks.length - suffix - 1].tagName &&
        previous.blocks[previous.blocks.length - suffix - 1].html ===
          metadata.blocks[metadata.blocks.length - suffix - 1].html
      )
        suffix++;

      const replacements = metadata.blocks
        .slice(prefix, metadata.blocks.length - suffix)
        .map(dom.elementFromBlock);
      if (replacements.some((element) => !element)) return null;
      const currentMiddle = current.slice(prefix, current.length - suffix);
      if (
        currentMiddle.length === replacements.length &&
        currentMiddle.every((element, index) => dom.canUpdateInPlace(element, replacements[index]))
      ) {
        currentMiddle.forEach((element, index) => {
          const replacement = replacements[index];
          if (['UL', 'OL'].includes(element.tagName)) dom.updateList(element, replacement);
          else dom.updateElement(element, replacement);
        });
        return current;
      }
      const anchor = suffix ? dom.topLevelElement(current[current.length - suffix]) : null;
      currentMiddle.forEach((element) => dom.topLevelElement(element).remove());
      const fragment = document.createDocumentFragment();
      replacements.forEach((element) => fragment.append(element));
      preview.insertBefore(fragment, anchor);
      return [
        ...current.slice(0, prefix),
        ...replacements,
        ...(suffix ? current.slice(current.length - suffix) : []),
      ];
    }

    function render(source, html, metadata = null) {
      if (!isVisible() || getSource() !== source) return;
      const patchedBlocks = patchBlocks(metadata);
      if (patchedBlocks === null && metadata?.htmlChunks?.length) {
        renderChunksProgressively(source, metadata);
        return;
      }
      if (patchedBlocks === null && metadata?.incrementalSafe && metadata.blocks.length > 80) {
        renderBlocksProgressively(source, metadata);
        return;
      }
      cancelDOMRender();
      if (patchedBlocks === null) {
        disconnectDecorations();
        const fragment = document.createElement('template');
        fragment.innerHTML =
          typeof html === 'string'
            ? html
            : metadata?.blocks?.map((block) => block.html || '').join('') || '';
        contentPolicy.sanitize(fragment.content);
        contentPolicy.linkifyWikiLinks(fragment.content);
        preview.replaceChildren(fragment.content);
      }
      renderedSource = source;
      cacheBlocks(metadata, patchedBlocks, {defer: Boolean(metadata)});
      renderedMetadata = metadata?.source === source ? metadata : null;
      setHighlightPending(false);
      scheduleHighlight();
    }

    function invalidate({metadata = false} = {}) {
      renderedSource = null;
      if (metadata) renderedMetadata = null;
    }

    return {
      cancelDOMRender,
      invalidate,
      metadata: () => renderedMetadata,
      render,
      setMetadata: (metadata) => {
        renderedMetadata = metadata;
      },
      setState: (source, metadata) => {
        renderedSource = source;
        renderedMetadata = metadata;
      },
      source: () => renderedSource,
    };
  }

  global.VylkPreviewRenderer = {create};
})(typeof window !== 'undefined' ? window : globalThis);
