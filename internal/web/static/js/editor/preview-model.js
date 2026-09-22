(function (global) {
  'use strict';

  function create({
    associate,
    decorate,
    document,
    getMarked,
    getRenderOptions,
    getSource,
    listItemRanges,
    preview,
    scheduleHighlight,
    syncTaskCheckbox,
    syncUI,
    tokenTag,
    window,
  }) {
    const state = {blocks: [], ranges: [], source: null, blockItems: [], listItems: []};
    let cacheHandle = null;
    let cacheGeneration = 0;

    function gapDoesNotRender(source) {
      if (!source) return true;
      return getMarked()
        .lexer(source, getRenderOptions())
        .every((token) => token.type === 'space');
    }

    function blockDescriptors(source, metadata) {
      if (metadata?.source === source && Array.isArray(metadata.blocks)) return metadata.blocks;
      const descriptors = [];
      let offset = 0;
      for (const token of getMarked().lexer(source, getRenderOptions())) {
        const raw = typeof token.raw === 'string' ? token.raw : '';
        if (!raw) continue;
        const start = source.indexOf(raw, offset);
        if (start < offset || !gapDoesNotRender(source.slice(offset, start))) return null;
        offset = start + raw.length;
        const tagName = tokenTag(token);
        if (!tagName) continue;
        descriptors.push({
          start,
          end: Math.max(start, start + raw.replace(/[\s\r\n]+$/, '').length),
          tagName,
          type: token.type,
          listItems:
            token.type === 'list' && listItemRanges
              ? listItemRanges(raw, start, `list:${start}`)
              : [],
        });
      }
      if (!gapDoesNotRender(source.slice(offset))) return null;
      return descriptors;
    }

    function contentBlocks(patchedBlocks) {
      if (patchedBlocks) return patchedBlocks;
      return Array.from(preview.children)
        .filter(
          (element) =>
            element.tagName &&
            !['STYLE', 'SCRIPT'].includes(element.tagName) &&
            !element.dataset.previewDragIndicator,
        )
        .map((element) =>
          element.matches('.interactive-preview-block-card')
            ? element.querySelector(':scope > .preview-block-content')?.firstElementChild
            : element,
        )
        .filter(Boolean);
    }

    function createCacheState(metadata, patchedBlocks) {
      const previousBlockEntries = new Map(
        state.blockItems.map((entry) => [entry.contentElement || entry.element, entry]),
      );
      const previousListEntries = new Map(state.listItems.map((entry) => [entry.element, entry]));
      const previousListEntriesByBlock = new Map();
      state.listItems.forEach((entry) => {
        if (!entry.blockElement) return;
        const entries = previousListEntriesByBlock.get(entry.blockElement) || [];
        entries.push(entry);
        previousListEntriesByBlock.set(entry.blockElement, entries);
      });
      const blocks = contentBlocks(patchedBlocks);
      const source = getSource();
      const marked = getMarked();
      if (!source || typeof marked?.lexer !== 'function') return null;
      const descriptors = blockDescriptors(source, metadata);
      if (!descriptors || descriptors.length !== blocks.length) return null;
      return {
        source,
        blocks,
        descriptors,
        previousBlockEntries,
        previousListEntries,
        previousListEntriesByBlock,
        ranges: [],
        blockItems: [],
        listItems: [],
        index: 0,
      };
    }

    function processBlock(cacheState) {
      const blockIndex = cacheState.index++;
      const descriptor = cacheState.descriptors[blockIndex];
      const block = cacheState.blocks[blockIndex];
      if (!block || block.tagName !== descriptor.tagName)
        throw new Error('preview block metadata did not match rendered output');
      const range = {start: descriptor.start, end: descriptor.end};
      cacheState.ranges.push(range);
      if (descriptor.type !== 'list') {
        const entry = cacheState.previousBlockEntries.get(block) || {};
        Object.assign(entry, range, {
          indent: 0,
          ordered: false,
          parent: null,
          kind: 'block',
          scope: 'blocks',
        });
        if (entry.card?.isConnected) {
          entry.element = entry.card;
          entry.visualElement = entry.card;
          entry.contentElement = block;
        } else {
          entry.element = block;
          entry.visualElement = block;
          entry.contentElement = null;
        }
        if (!entry.element.hasAttribute('data-interactive-start'))
          entry.element.dataset.interactiveStart = '';
        if (!entry.element.hasAttribute('data-interactive-scope'))
          entry.element.dataset.interactiveScope = entry.scope;
        associate(entry.element, entry);
        associate(block, entry);
        cacheState.blockItems.push(entry);
        return;
      }
      const listEntries = descriptor.listItems || [];
      const previousEntries = cacheState.previousListEntriesByBlock.get(block);
      const listElements =
        previousEntries?.length === listEntries.length
          ? previousEntries.map((entry) => entry.element)
          : [...block.querySelectorAll('li')];
      if (listEntries.length !== listElements.length) return;
      listEntries.forEach((descriptorEntry, index) => {
        const element = listElements[index];
        const entry = cacheState.previousListEntries.get(element) || {};
        Object.assign(entry, descriptorEntry, {element, blockElement: block});
        if (!element.hasAttribute('data-interactive-start')) element.dataset.interactiveStart = '';
        if (!element.hasAttribute('data-interactive-scope'))
          element.dataset.interactiveScope = entry.scope;
        associate(element, entry);
        if (entry.card?.isConnected) associate(entry.card, entry);
        const lineEnd = cacheState.source.indexOf('\n', entry.start);
        const line = cacheState.source.slice(
          entry.start,
          lineEnd < 0 ? entry.end : Math.min(entry.end, lineEnd),
        );
        if (/\[[ xX]\]/.test(line)) syncTaskCheckbox(element);
        cacheState.listItems.push(entry);
      });
    }

    function commit(cacheState, generation) {
      if (
        generation !== cacheGeneration ||
        cacheState.source !== getSource() ||
        cacheState.blocks !== state.blocks
      )
        return;
      state.ranges = cacheState.ranges;
      state.source = cacheState.source;
      state.blockItems = cacheState.blockItems;
      state.listItems = cacheState.listItems;
      decorate();
      syncUI();
      scheduleHighlight();
    }

    function cache(metadata = null, patchedBlocks = null, {defer = false} = {}) {
      if (cacheHandle !== null) window.clearTimeout(cacheHandle);
      cacheHandle = null;
      const generation = ++cacheGeneration;
      let cacheState;
      try {
        cacheState = createCacheState(metadata, patchedBlocks);
      } catch (_) {
        cacheState = null;
      }
      state.blocks = cacheState?.blocks || contentBlocks(patchedBlocks);
      state.ranges = [];
      state.source = null;
      if (!cacheState) {
        state.listItems = [];
        state.blockItems = [];
        decorate();
        syncUI();
        return;
      }
      const process = () => {
        cacheHandle = null;
        if (generation !== cacheGeneration || cacheState.source !== getSource()) return;
        const started = window.performance.now();
        try {
          while (
            cacheState.index < cacheState.descriptors.length &&
            (!defer || window.performance.now() - started < 5)
          )
            processBlock(cacheState);
        } catch (_) {
          state.ranges = [];
          return;
        }
        if (cacheState.index < cacheState.descriptors.length) {
          cacheHandle = window.setTimeout(process, 0);
          return;
        }
        commit(cacheState, generation);
      };
      process();
    }

    function cancel() {
      cacheGeneration++;
      if (cacheHandle !== null) window.clearTimeout(cacheHandle);
      cacheHandle = null;
    }

    function reset() {
      state.blocks = [];
      state.ranges = [];
      state.source = null;
      state.blockItems = [];
      state.listItems = [];
    }

    return {cache, cancel, reset, state};
  }

  global.VylkPreviewModel = {create};
})(typeof window !== 'undefined' ? window : globalThis);
