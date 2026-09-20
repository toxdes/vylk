(function (global) {
  'use strict';

  function create({
    applySource,
    decoration,
    document,
    getEntries,
    getSource,
    interactive,
    isActive,
    isCurrent,
    layout,
    preview,
    setLocked,
    window,
  }) {
    let activeDrag = null;

    function dragTarget(drag) {
      return layout.target(preview, getEntries(), drag.x, drag.y, drag.sourceStart, drag.scope);
    }

    function render(frameTime = window.performance.now()) {
      const drag = activeDrag;
      if (!drag) return;
      drag.frame = null;
      if (!drag.armed) return;
      drag.ghost.style.transform = `translate3d(${drag.x - drag.startX}px,${drag.y - drag.startY}px,0)`;
      if (!drag.hasMoved) return;
      const previewRect = preview.getBoundingClientRect();
      const outsidePreview =
        drag.x < previewRect.left ||
        drag.x > previewRect.right ||
        drag.y < previewRect.top ||
        drag.y > previewRect.bottom;
      document.documentElement.classList.toggle('preview-drag-outside', outsidePreview);
      const elapsed = drag.lastFrameAt ? frameTime - drag.lastFrameAt : 16.67;
      drag.lastFrameAt = frameTime;
      const scrollDelta = outsidePreview ? 0 : layout.autoScrollDelta(preview, drag.y, elapsed);
      const previousScrollTop = preview.scrollTop;
      if (scrollDelta) preview.scrollTop += scrollDelta;
      const didScroll = Math.abs(preview.scrollTop - previousScrollTop) > 0.1;
      const nextTarget = dragTarget(drag);
      const previous = drag.target;
      if (
        previous?.element !== nextTarget?.element ||
        previous?.placement !== nextTarget?.placement
      ) {
        if (previous) previous.element.removeAttribute('data-preview-drop');
        if (nextTarget) nextTarget.element.dataset.previewDrop = nextTarget.placement;
        drag.target = nextTarget;
        if (nextTarget) {
          const parent = nextTarget.element.parentNode;
          const placeholder = layout.placeholder(document, drag, parent);
          const insertionPoint =
            nextTarget.placement === 'before' ? nextTarget.element : nextTarget.element.nextSibling;
          if (insertionPoint !== placeholder) {
            const before = layout.capture(parent, drag.sourceElement);
            parent.insertBefore(placeholder, insertionPoint);
            layout.animate(window, before);
          }
        }
      }
      if (didScroll && drag.frame === null) drag.frame = window.requestAnimationFrame(render);
    }

    function cancel({animateReturn = true} = {}) {
      const drag = activeDrag;
      if (!drag) return;
      if (drag.holdTimer !== null) window.clearTimeout(drag.holdTimer);
      if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
      drag.pendingElement?.classList.remove('is-drag-pending');
      const returnLayout =
        drag.armed && animateReturn
          ? layout.capture(drag.placeholder?.parentNode, drag.sourceElement)
          : null;
      if (drag.armed) {
        drag.sourceElement?.classList.remove('preview-dragging');
        drag.visualElement?.classList.remove('preview-dragging');
        if (drag.sourceElement) drag.sourceElement.style.display = drag.sourceDisplay;
      }
      drag.target?.element?.removeAttribute('data-preview-drop');
      drag.placeholder?.remove();
      if (returnLayout) layout.animate(window, returnLayout);
      drag.portal?.remove();
      drag.ghost?.remove();
      document.documentElement.classList.remove('preview-drag-active', 'preview-drag-outside');
      activeDrag = null;
      if (drag.armed) setLocked(false);
    }

    function arm(drag = activeDrag) {
      if (!drag || drag !== activeDrag || drag.armed) return false;
      if (!isCurrent() || !drag.sourceElement?.isConnected || !drag.visualElement?.isConnected) {
        cancel({animateReturn: false});
        return false;
      }
      if (drag.holdTimer !== null) window.clearTimeout(drag.holdTimer);
      drag.holdTimer = null;
      drag.pendingElement?.classList.remove('is-drag-pending');
      drag.armed = true;
      window.getSelection()?.removeAllRanges();
      try {
        preview.setPointerCapture?.(drag.pointerID);
      } catch {
        // The pointer may have been cancelled between the hold timer and this frame.
      }
      const sourceRect = drag.sourceElement.getBoundingClientRect();
      const visualRect = drag.visualElement.getBoundingClientRect();
      const ghost = drag.visualElement.cloneNode(true);
      ghost.removeAttribute('data-interactive-start');
      ghost.removeAttribute('data-interactive-scope');
      ghost.classList.add('preview-drag-ghost');
      ghost.style.width = `${visualRect.width}px`;
      ghost.style.height = `${visualRect.height}px`;
      ghost.style.left = `${visualRect.left}px`;
      ghost.style.top = `${visualRect.top}px`;
      drag.sourceDisplay = drag.sourceElement.style.display;
      drag.placeholderWidth = sourceRect.width;
      drag.placeholderHeight = sourceRect.height;
      drag.placeholder = null;
      const placeholder = layout.placeholder(document, drag, drag.sourceElement.parentNode);
      drag.sourceElement.style.display = 'none';
      drag.sourceElement.before(placeholder);
      setLocked(true);
      drag.ghost = ghost;
      const portal = document.createElement('div');
      portal.className = 'preview preview-drag-portal interactive-preview-active';
      portal.setAttribute('aria-hidden', 'true');
      portal.append(ghost);
      drag.portal = portal;
      document.body.append(portal);
      drag.sourceElement.classList.add('preview-dragging');
      drag.visualElement.classList.add('preview-dragging');
      document.documentElement.classList.add('preview-drag-active');
      if (drag.frame === null) drag.frame = window.requestAnimationFrame(render);
      return true;
    }

    preview.addEventListener('pointerdown', (event) => {
      if (!isActive() || !isCurrent() || event.button !== 0 || event.isPrimary === false) return;
      if (!event.target.closest('.preview-drag-handle')) return;
      const item = event.target.closest(
        '#preview > [data-interactive-start], #preview li[data-interactive-start]',
      );
      if (!item || event.target.closest('a,input,button,select,textarea')) return;
      const entry = decoration.entryForElement(item);
      if (!entry) return;
      if (activeDrag) cancel({animateReturn: false});
      const pointerType = event.pointerType || 'mouse';
      const pendingElement = entry.card || entry.visualElement || entry.element;
      const drag = {
        pointerID: event.pointerId,
        pointerType,
        sourceStart: entry.start,
        scope: entry.scope,
        sourceElement: entry.element,
        visualElement: entry.visualElement || entry.element,
        pendingElement,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        hasMoved: false,
        armed: false,
        holdTimer: null,
        frame: null,
        lastFrameAt: null,
        target: null,
      };
      activeDrag = drag;
      if (pointerType === 'touch') {
        event.preventDefault();
        pendingElement.classList.add('is-drag-pending');
        try {
          preview.setPointerCapture?.(event.pointerId);
        } catch {
          // Synthetic and already-cancelled pointers cannot be captured.
        }
        drag.holdTimer = window.setTimeout(() => arm(drag), 220);
      }
    });

    preview.addEventListener(
      'touchstart',
      (event) => {
        if (event.target.closest('.preview-drag-handle')) event.preventDefault();
      },
      {passive: false},
    );
    for (const type of ['selectstart', 'contextmenu', 'dragstart']) {
      preview.addEventListener(type, (event) => {
        if (event.target.closest('.preview-drag-handle')) event.preventDefault();
      });
    }
    document.addEventListener('pointermove', (event) => {
      const drag = activeDrag;
      if (!drag || drag.pointerID !== event.pointerId) return;
      if (drag.pointerType === 'touch') event.preventDefault();
      drag.x = event.clientX;
      drag.y = event.clientY;
      const moved = Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6;
      if (moved) drag.hasMoved = true;
      if (!drag.armed) {
        if (drag.pointerType === 'touch' || !moved) return;
        event.preventDefault();
        if (!arm(drag)) return;
      }
      if (drag.frame === null) drag.frame = window.requestAnimationFrame(render);
    });

    function finish(event) {
      const drag = activeDrag;
      if (!drag || drag.pointerID !== event.pointerId) return;
      if (event.type === 'pointerup' && drag.armed && drag.target) {
        if (!isCurrent()) {
          cancel({animateReturn: false});
          if (preview.hasPointerCapture?.(event.pointerId))
            preview.releasePointerCapture(event.pointerId);
          return;
        }
        const source = getSource();
        const change = interactive.moveMarkdownUnit(
          source,
          getEntries(),
          drag.sourceStart,
          drag.scope,
          drag.target.start,
          drag.target.scope,
          drag.target.placement,
        );
        cancel({animateReturn: false});
        if (preview.hasPointerCapture?.(event.pointerId))
          preview.releasePointerCapture(event.pointerId);
        if (change)
          applySource(change.source, {
            start: change.start,
            removed: source.slice(change.start, change.end),
            inserted: change.inserted,
          });
        return;
      }
      cancel();
      if (preview.hasPointerCapture?.(event.pointerId))
        preview.releasePointerCapture(event.pointerId);
    }

    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    preview.addEventListener('lostpointercapture', (event) => {
      if (activeDrag?.pointerID === event.pointerId) cancel();
    });
    window.addEventListener('blur', () => cancel());

    return {
      active: () => activeDrag,
      cancel,
      isDraggingEntry: (entry) =>
        activeDrag?.sourceStart === entry.start && activeDrag?.scope === entry.scope,
    };
  }

  global.VylkPreviewDragController = {create};
})(typeof window !== 'undefined' ? window : globalThis);
