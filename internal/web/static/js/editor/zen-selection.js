(function (global) {
  'use strict';

  const edge = 36;
  const maximumSpeed = 240; // CSS pixels per second, including outside the pane.

  function velocity(y, top, bottom) {
    const zone = Math.min(edge, (bottom - top) / 3);
    if (zone <= 0) return 0;
    if (y < top + zone) return -maximumSpeed * Math.min(1, (top + zone - y) / zone) ** 2;
    if (y > bottom - zone) return maximumSpeed * Math.min(1, (y - bottom + zone) / zone) ** 2;
    return 0;
  }

  function create({editor, document, window}) {
    const element = editor.element;
    const listeners = new window.AbortController();
    const {signal} = listeners;
    let pointerType = 'mouse';
    let drag = null;
    let frame = null;

    function hit(x, y) {
      const rect = element.getBoundingClientRect();
      x = Math.max(rect.left + 1, Math.min(rect.right - 1, x));
      y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, y));
      const position = document.caretPositionFromPoint?.(x, y);
      const range = position ? null : document.caretRangeFromPoint?.(x, y);
      const node = position?.offsetNode || range?.startContainer;
      const offset = position?.offset ?? range?.startOffset;
      if (!node || !element.contains(node)) return null;
      if (node === element) return Math.min(editor.length, editor.offsets.prefix(offset));
      return editor.pointOffset(node, offset);
    }

    function cancel() {
      const wasSelecting = editor.selecting;
      drag = null;
      editor.selecting = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      if (wasSelecting) document.dispatchEvent(new window.Event('selectionchange'));
    }

    function extend() {
      const end = hit(drag.x, drag.y);
      if (end === null) return;
      editor.setSelection(
        Math.min(drag.anchor, end),
        Math.max(drag.anchor, end),
        end < drag.anchor ? 'backward' : 'forward',
      );
    }

    function step(time) {
      frame = null;
      if (!drag || !editor.active || document.hidden) return cancel();
      const rect = element.getBoundingClientRect();
      const speed = velocity(drag.y, rect.top, rect.bottom);
      const elapsed = drag.time === null ? 0 : Math.min(32, Math.max(0, time - drag.time));
      drag.time = time;
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      drag.scroll = Math.max(0, Math.min(maximum, drag.scroll + (speed * elapsed) / 1000));
      element.scrollTop = drag.scroll;
      extend();
      if (speed < 0 ? drag.scroll > 0 : speed > 0 && drag.scroll < maximum)
        frame = window.requestAnimationFrame(step);
    }

    function schedule() {
      if (frame !== null || !drag) return;
      const rect = element.getBoundingClientRect();
      if (!velocity(drag.y, rect.top, rect.bottom)) return;
      drag.time = null;
      drag.scroll = element.scrollTop;
      frame = window.requestAnimationFrame(step);
    }

    element.addEventListener(
      'pointerdown',
      (event) => {
        pointerType = event.pointerType || 'mouse';
      },
      {signal},
    );
    element.addEventListener(
      'mousedown',
      (event) => {
        if (
          !editor.active ||
          editor.composing ||
          pointerType !== 'mouse' ||
          event.button !== 0 ||
          event.detail > 1 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          element.scrollHeight <= element.clientHeight + 1
        )
          return;
        const offset = hit(event.clientX, event.clientY);
        if (offset === null) return;
        const selection = editor.selection();
        const anchor = event.shiftKey
          ? selection.direction === 'backward'
            ? selection.end
            : selection.start
          : offset;
        // Own this mouse gesture from its start. Preventing native mousedown
        // selection also prevents the browser's unbounded edge auto-scroll; a
        // second competing scroll loop cannot accelerate our capped movement.
        event.preventDefault();
        editor.cancelTypingAnchor();
        editor.focus();
        drag = {
          anchor,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          time: null,
        };
        editor.setSelection(
          Math.min(anchor, offset),
          Math.max(anchor, offset),
          offset < anchor ? 'backward' : 'forward',
        );
      },
      {signal},
    );
    window.addEventListener(
      'mousemove',
      (event) => {
        if (!drag) return;
        if (!(event.buttons & 1)) return cancel();
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (!editor.selecting && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 3) return;
        editor.selecting = true;
        event.preventDefault();
        extend();
        schedule();
      },
      {signal},
    );
    window.addEventListener('mouseup', cancel, {signal});
    window.addEventListener('blur', cancel, {signal});
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) cancel();
      },
      {signal},
    );

    return {
      cancel,
      destroy() {
        cancel();
        listeners.abort();
      },
    };
  }

  global.VylkZenSelection = {create, velocity};
})(typeof window !== 'undefined' ? window : globalThis);
