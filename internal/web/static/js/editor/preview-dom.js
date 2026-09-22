(function (root) {
  'use strict';

  function create({contentPolicy, document, preview, syncTaskCheckbox}) {
    function elementFromBlock(block) {
      if (!block?.html || !block.tagName) return null;
      const template = document.createElement('template');
      template.innerHTML = block.html;
      contentPolicy.sanitize(template.content);
      contentPolicy.linkifyWikiLinks(template.content);
      const nodeType = document.defaultView?.Node || root.Node;
      if (
        [...template.content.childNodes].some(
          (node) => node.nodeType === nodeType.TEXT_NODE && node.textContent.trim(),
        )
      )
        return null;
      const elements = [...template.content.children];
      return elements.length === 1 && elements[0].tagName === block.tagName ? elements[0] : null;
    }

    function topLevelElement(element) {
      const card = element?.closest?.('.interactive-preview-block-card');
      return card?.parentElement === preview ? card : element;
    }

    function syncAttributes(current, replacement) {
      const preserved = [...current.attributes]
        .filter((attribute) => attribute.name.startsWith('data-interactive-'))
        .map((attribute) => [attribute.name, attribute.value]);
      [...current.attributes]
        .filter((attribute) => !attribute.name.startsWith('data-interactive-'))
        .forEach((attribute) => current.removeAttribute(attribute.name));
      [...replacement.attributes].forEach((attribute) =>
        current.setAttribute(attribute.name, attribute.value),
      );
      preserved.forEach(([name, value]) => current.setAttribute(name, value));
    }

    function canUpdateInPlace(current, replacement) {
      if (!current || !replacement || current.tagName !== replacement.tagName) return false;
      if (['UL', 'OL'].includes(current.tagName)) {
        const currentItems = [...current.children];
        const replacementItems = [...replacement.children];
        return (
          currentItems.length === replacementItems.length &&
          currentItems.every(
            (item, index) =>
              item.tagName === 'LI' &&
              replacementItems[index]?.tagName === 'LI' &&
              !item.querySelector('ul,ol') &&
              !replacementItems[index].querySelector('ul,ol'),
          )
        );
      }
      return !current.querySelector('ul,ol') && !replacement.querySelector('ul,ol');
    }

    function updateElement(current, replacement) {
      syncAttributes(current, replacement);
      current.replaceChildren(...[...replacement.childNodes]);
    }

    function updateList(current, replacement) {
      syncAttributes(current, replacement);
      const currentItems = [...current.children];
      const replacementItems = [...replacement.children];
      currentItems.forEach((item, index) => {
        const replacementItem = replacementItems[index];
        const body = item.querySelector(
          ':scope > .interactive-preview-list-card > .preview-list-content > .preview-list-item-body',
        );
        if (!body) {
          if (item.innerHTML !== replacementItem.innerHTML) updateElement(item, replacementItem);
          return;
        }
        if (body.innerHTML === replacementItem.innerHTML) return;
        body.replaceChildren(...[...replacementItem.childNodes]);
        item
          .querySelector(':scope > .interactive-preview-list-card')
          ?.classList.toggle('is-task', Boolean(body.querySelector('input[type="checkbox"]')));
        syncTaskCheckbox(item);
      });
      return current;
    }

    return {canUpdateInPlace, elementFromBlock, topLevelElement, updateElement, updateList};
  }

  root.VylkPreviewDOM = {create};
})(typeof window !== 'undefined' ? window : globalThis);
