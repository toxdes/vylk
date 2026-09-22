(function (global) {
  'use strict';

  function create({document, getEntries, isActive, isDraggingEntry, preview, window}) {
    let observer = null;
    let handle = null;
    let generation = 0;
    let observedEntry = new WeakMap();
    let entryByElement = new WeakMap();

    function associate(element, entry) {
      if (element) entryByElement.set(element, entry);
    }

    function createDragHandle() {
      const handleElement = document.createElement('button');
      handleElement.className = 'preview-drag-handle';
      handleElement.dataset.previewDragIndicator = 'true';
      handleElement.type = 'button';
      handleElement.setAttribute('aria-label', 'Drag this block');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('icon');
      svg.setAttribute('viewBox', '0 0 12 18');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#icon-drag-indicator');
      svg.append(use);
      handleElement.append(svg);
      return handleElement;
    }

    function createEditButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preview-edit-button';
      button.title = 'Edit';
      button.setAttribute('aria-label', 'Edit this block in source');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('icon');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#icon-edit');
      svg.append(use);
      button.append(svg);
      return button;
    }

    function orderedListItemNumber(item) {
      const list = item.parentElement;
      if (!list || list.tagName !== 'OL') return null;
      const siblings = [...list.children].filter((child) => child.tagName === 'LI');
      const reversed = list.hasAttribute('reversed');
      const startAttribute = list.getAttribute('start');
      const explicitStart = startAttribute === null ? NaN : Number(startAttribute);
      let number = Number.isInteger(explicitStart) ? explicitStart : reversed ? siblings.length : 1;
      const step = reversed ? -1 : 1;
      for (const sibling of siblings) {
        const valueAttribute = sibling.getAttribute('value');
        const explicitValue = valueAttribute === null ? NaN : Number(valueAttribute);
        if (Number.isInteger(explicitValue)) number = explicitValue;
        if (sibling === item) return number;
        number += step;
      }
      return null;
    }

    function createListMarker(item, taskItem) {
      if (taskItem && item.parentElement?.tagName !== 'OL') return null;
      const marker = document.createElement('span');
      marker.className = 'preview-list-marker';
      marker.setAttribute('aria-hidden', 'true');
      const number = orderedListItemNumber(item);
      if (number === null) marker.dataset.kind = 'bullet';
      else marker.textContent = `${number}.`;
      return marker;
    }

    function decorateListItem(entry) {
      if (entry.card?.isConnected) return;
      const item = entry.element;
      const nestedLists = [];
      const body = document.createElement('div');
      body.className = 'preview-list-item-body';
      for (const node of [...item.childNodes]) {
        if (node.nodeType === window.Node.ELEMENT_NODE && ['UL', 'OL'].includes(node.tagName))
          nestedLists.push(node);
        else body.append(node);
      }
      const taskItem = Boolean(body.querySelector('input[type="checkbox"]'));
      const card = document.createElement('div');
      card.className = `interactive-preview-card interactive-preview-list-card${taskItem ? ' is-task' : ''}`;
      const content = document.createElement('div');
      content.className = 'preview-drag-content preview-list-content';
      const marker = createListMarker(item, taskItem);
      if (marker) {
        card.classList.add('has-marker');
        content.append(marker);
      }
      content.append(body);
      card.append(createDragHandle(), content, createEditButton());
      item.classList.add('interactive-preview-list-item');
      item.prepend(card);
      nestedLists.forEach((list) => item.append(list));
      entry.card = card;
      entry.visualElement = item;
      associate(card, entry);
      associate(item, entry);
    }

    function decorateBlock(entry) {
      if (entry.card?.isConnected) return;
      const block = entry.element;
      const card = document.createElement('div');
      card.className = 'interactive-preview-card interactive-preview-block-card';
      if (block.tagName === 'HR') card.classList.add('interactive-preview-rule-card');
      card.dataset.interactiveStart = '';
      card.dataset.interactiveScope = entry.scope;
      const content = document.createElement('div');
      content.className = 'preview-drag-content preview-block-content';
      block.before(card);
      block.removeAttribute('data-interactive-start');
      block.removeAttribute('data-interactive-scope');
      content.append(block);
      card.append(createDragHandle(), content, createEditButton());
      entry.element = card;
      entry.card = card;
      entry.visualElement = card;
      entry.contentElement = block;
      associate(card, entry);
      associate(block, entry);
    }

    function decorateEntry(entry) {
      if (!entry || entry.card?.isConnected) return;
      if (entry.kind === 'list-item') decorateListItem(entry);
      else decorateBlock(entry);
    }

    function undecorateListItem(entry, {force = false} = {}) {
      const card = entry.card;
      if (
        !card?.isConnected ||
        (!force &&
          (card.contains(document.activeElement) ||
            card.classList.contains('highlight', 'is-selected')))
      )
        return;
      const body = card.querySelector(':scope > .preview-list-content > .preview-list-item-body');
      if (!body) return;
      while (body.firstChild) card.before(body.firstChild);
      card.remove();
      entry.element.classList.remove('interactive-preview-list-item');
      entry.card = null;
      entry.visualElement = entry.element;
    }

    function undecorateBlock(entry, {force = false} = {}) {
      const card = entry.card;
      const block = entry.contentElement;
      if (
        !card?.isConnected ||
        !block ||
        (!force &&
          (card.contains(document.activeElement) ||
            card.classList.contains('highlight', 'is-selected')))
      )
        return;
      card.before(block);
      card.remove();
      block.dataset.interactiveStart = '';
      block.dataset.interactiveScope = entry.scope;
      entry.element = block;
      entry.card = null;
      entry.visualElement = block;
      entry.contentElement = null;
      associate(block, entry);
    }

    function undecorateEntry(entry, options) {
      if (!entry || isDraggingEntry(entry)) return;
      if (entry.kind === 'list-item') undecorateListItem(entry, options);
      else undecorateBlock(entry, options);
    }

    function disconnect() {
      generation++;
      if (handle !== null) window.clearTimeout(handle);
      handle = null;
      observer?.disconnect();
      observer = null;
      observedEntry = new WeakMap();
    }

    function observationElement(entry) {
      return entry?.kind === 'block' ? entry.contentElement || entry.element : entry?.element;
    }

    function decorate() {
      if (!isActive()) {
        disconnect();
        return;
      }
      const entries = getEntries();
      if (typeof window.IntersectionObserver !== 'function') {
        if (entries.length <= 100) entries.forEach(decorateEntry);
        else {
          const activeGeneration = ++generation;
          let index = 0;
          const process = () => {
            handle = null;
            if (activeGeneration !== generation || !isActive()) return;
            const started = window.performance.now();
            while (index < entries.length && window.performance.now() - started < 5)
              decorateEntry(entries[index++]);
            if (index < entries.length) handle = window.setTimeout(process, 0);
          };
          process();
        }
        return;
      }
      disconnect();
      const activeGeneration = generation;
      observer = new window.IntersectionObserver(
        (records) => {
          const entering = [];
          const leaving = [];
          for (const record of records) {
            const entry = observedEntry.get(record.target);
            if (!entry) continue;
            (record.isIntersecting ? entering : leaving).push(entry);
          }
          entering
            .sort((left, right) => left.start - right.start || left.indent - right.indent)
            .forEach(decorateEntry);
          leaving
            .sort((left, right) => right.indent - left.indent || right.start - left.start)
            .forEach(undecorateEntry);
        },
        {root: preview, rootMargin: '600px 0px'},
      );
      const pendingEntries = entries.filter((entry) => observationElement(entry));
      let index = 0;
      const observe = () => {
        handle = null;
        if (activeGeneration !== generation || !observer) return;
        const started = window.performance.now();
        while (index < pendingEntries.length && window.performance.now() - started < 5) {
          const entry = pendingEntries[index++];
          const element = observationElement(entry);
          if (!element) continue;
          observedEntry.set(element, entry);
          observer.observe(element);
        }
        if (index < pendingEntries.length) handle = window.setTimeout(observe, 0);
      };
      observe();
    }

    return {
      associate,
      decorate,
      decorateEntry,
      disconnect,
      entryForElement: (element) => entryByElement.get(element) || null,
      undecorateEntry,
    };
  }

  global.VylkPreviewDecoration = {create};
})(typeof window !== 'undefined' ? window : globalThis);
