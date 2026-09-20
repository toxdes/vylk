(function (global) {
  'use strict';

  function target(preview, entries, clientX, clientY, sourceStart, sourceScope) {
    const previewRect = preview.getBoundingClientRect();
    if (
      clientX < previewRect.left ||
      clientX > previewRect.right ||
      clientY < previewRect.top ||
      clientY > previewRect.bottom
    )
      return null;
    const source = entries.find(
      (entry) => entry.start === sourceStart && entry.scope === sourceScope,
    );
    if (!source) return null;
    let best = null;
    for (const entry of entries) {
      if (
        !entry.card?.isConnected ||
        entry === source ||
        !entry.element?.isConnected ||
        (source.start < entry.end && entry.start < source.end)
      )
        continue;
      const rect = (entry.card || entry.visualElement || entry.element).getBoundingClientRect();
      if (!rect.height) continue;
      const verticalDistance =
        clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const horizontalDistance =
        clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const score = verticalDistance * 1000 + horizontalDistance;
      if (!best || score < best.score) best = {entry, rect, score};
    }
    if (!best) return null;
    return {
      element: best.entry.element,
      start: best.entry.start,
      scope: best.entry.scope,
      placement: clientY < best.rect.top + best.rect.height / 2 ? 'before' : 'after',
    };
  }

  function capture(parent, excludedElement) {
    if (!parent) return new Map();
    return new Map(
      [...parent.children]
        .filter(
          (element) =>
            element !== excludedElement && !element.classList.contains('preview-drag-placeholder'),
        )
        .map((element) => [element, element.getBoundingClientRect()]),
    );
  }

  function animate(window, before) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const [element, first] of before) {
      if (!element.isConnected || typeof element.animate !== 'function') continue;
      element
        .getAnimations?.()
        .filter((animation) => animation.id === 'preview-reflow')
        .forEach((animation) => animation.cancel());
      const last = element.getBoundingClientRect();
      const deltaX = first.left - last.left;
      const deltaY = first.top - last.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      const animation = element.animate(
        [{transform: `translate3d(${deltaX}px,${deltaY}px,0)`}, {transform: 'translate3d(0,0,0)'}],
        {duration: 180, easing: 'cubic-bezier(.16,1,.3,1)'},
      );
      animation.id = 'preview-reflow';
    }
  }

  function placeholder(document, drag, parent) {
    const tagName = ['UL', 'OL'].includes(parent?.tagName) ? 'li' : 'div';
    if (drag.placeholder?.tagName === tagName.toUpperCase()) return drag.placeholder;
    drag.placeholder?.remove();
    const element = document.createElement(tagName);
    element.className = 'preview-drag-placeholder';
    element.setAttribute('aria-hidden', 'true');
    element.style.width = `${drag.placeholderWidth}px`;
    element.style.height = `${drag.placeholderHeight}px`;
    drag.placeholder = element;
    return element;
  }

  function autoScrollDelta(preview, clientY, elapsedMilliseconds = 16.67) {
    const rect = preview.getBoundingClientRect();
    const edgeSize = Math.min(72, Math.max(44, rect.height * 0.18));
    let intensity = 0;
    if (clientY < rect.top + edgeSize)
      intensity = -Math.min(1, (rect.top + edgeSize - clientY) / edgeSize);
    else if (clientY > rect.bottom - edgeSize)
      intensity = Math.min(1, (clientY - (rect.bottom - edgeSize)) / edgeSize);
    const maxScrollTop = Math.max(0, preview.scrollHeight - preview.clientHeight);
    if (
      !intensity ||
      (intensity < 0 && preview.scrollTop <= 0) ||
      (intensity > 0 && preview.scrollTop >= maxScrollTop - 1)
    )
      return 0;
    return (
      Math.sign(intensity) *
      Math.max(1, 0.75 * Math.min(32, elapsedMilliseconds) * intensity * intensity)
    );
  }

  global.VylkPreviewDragLayout = {animate, autoScrollDelta, capture, placeholder, target};
})(typeof window !== 'undefined' ? window : globalThis);
