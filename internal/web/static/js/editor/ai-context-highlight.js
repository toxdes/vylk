// Keep shared context visible while focus belongs to the AI composer.
export function create({document, source, value}) {
  const window = document.defaultView;
  const lifetime = new window.AbortController();
  const {signal} = lifetime;
  const layer = document.createElement('div');
  layer.className = 'ai-context-mirror';
  layer.setAttribute('aria-hidden', 'true');
  layer.hidden = true;
  source.parentElement.append(layer);
  let start = 0;
  let end = 0;
  let frame = null;
  let destroyed = false;

  function paint() {
    frame = null;
    if (destroyed) return;
    layer.hidden = start === end || source.hidden;
    if (start === end || source.hidden) return;
    const style = window.getComputedStyle(source);
    for (const property of [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'lineHeight',
      'letterSpacing',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'tabSize',
      'textIndent',
      'textTransform',
      'wordSpacing',
      'wordBreak',
      'overflowWrap',
      'direction',
      'textAlign',
      'scrollbarGutter',
    ])
      layer.style[property] = style[property];
    Object.assign(layer.style, {
      left: `${source.offsetLeft}px`,
      top: `${source.offsetTop}px`,
      width: `${source.offsetWidth}px`,
      height: `${source.offsetHeight}px`,
    });
    layer.scrollTop = source.scrollTop;
    layer.scrollLeft = source.scrollLeft;
  }

  function schedule() {
    if (!destroyed && frame === null) frame = window.requestAnimationFrame(paint);
  }

  source.addEventListener(
    'scroll',
    () => {
      layer.scrollTop = source.scrollTop;
      layer.scrollLeft = source.scrollLeft;
    },
    {passive: true, signal},
  );
  window.addEventListener('resize', schedule, {signal});
  document.fonts?.addEventListener('loadingdone', schedule, {signal});
  const resize = new window.ResizeObserver(schedule);
  resize.observe(source);
  const preferences = new window.MutationObserver(schedule);
  preferences.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  return {
    setScope(scope, selectionStart, selectionEnd, nextValue = value) {
      if (destroyed) return;
      const changed = nextValue !== value;
      value = nextValue;
      const nextStart = scope === 'selection' ? selectionStart : 0;
      const nextEnd = scope === 'note' ? value.length : scope === 'selection' ? selectionEnd : 0;
      if (!changed && start === nextStart && end === nextEnd) return;
      start = nextStart;
      end = nextEnd;
      const mark = document.createElement('mark');
      mark.textContent = value.slice(start, end);
      layer.replaceChildren(
        document.createTextNode(value.slice(0, start)),
        mark,
        document.createTextNode(value.slice(end) + '\u200b'),
      );
      if (frame !== null) window.cancelAnimationFrame(frame);
      paint();
    },
    destroy() {
      destroyed = true;
      lifetime.abort();
      resize.disconnect();
      preferences.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      layer.remove();
    },
  };
}
