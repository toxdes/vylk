// Local panel geometry and selection affordances share the editor's existing
// separator and caret measurement patterns. Nothing here edits note content.
export function create({
  document,
  source,
  mount,
  surface,
  selectButton,
  measureCaret,
  getSelection,
  getState,
  onSelect,
  onSelectionChange,
}) {
  const window = document.defaultView;
  const lifetime = new AbortController();
  const {signal} = lifetime;
  const mobile = window.matchMedia('(max-width: 640px)');
  const divider = document.createElement('div');
  divider.className = 'panel-resizer ai-panel-resizer';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Resize AI sidebar');
  divider.tabIndex = 0;
  mount.insertBefore(divider, surface);
  source.parentElement.append(selectButton);
  let width =
    Number(window.localStorage.getItem('vylk-ai-panel-width')) ||
    Math.min(400, window.innerWidth * 0.3);
  let frame = null;
  let destroyed = false;
  let candidate = null;

  function setWidth(next, persist = false) {
    const maximum = Math.max(240, Math.min(640, mount.clientWidth - 280));
    width = Math.max(240, Math.min(maximum, next));
    surface.style.setProperty('--ai-panel-width', `${width}px`);
    divider.setAttribute('aria-valuemin', '240');
    divider.setAttribute('aria-valuemax', String(Math.round(maximum)));
    divider.setAttribute('aria-valuenow', String(Math.round(width)));
    divider.setAttribute('aria-valuetext', `${Math.round(width)} pixels`);
    if (persist) window.localStorage.setItem('vylk-ai-panel-width', String(width));
  }
  function update() {
    frame = null;
    if (destroyed) return;
    const state = getState();
    const selected = getSelection?.();
    const focused =
      Boolean(selected) ||
      document.activeElement === source ||
      document.activeElement === selectButton;
    const start = selected?.start ?? source.selectionStart;
    const end = selected?.end ?? source.selectionEnd;
    if (focused && (!source.hidden || selected))
      onSelectionChange?.(
        start === end
          ? null
          : {start, end, direction: selected?.direction ?? source.selectionDirection},
      );
    const different = state.scope !== 'selection' || start !== state.start || end !== state.end;
    selectButton.hidden =
      !focused ||
      start === end ||
      !different ||
      (source.hidden && !selected) ||
      (mobile.matches && state.pending);
    selectButton.disabled = state.busy;
    if (selectButton.hidden) {
      candidate = null;
      return;
    }
    candidate = {start, end, direction: selected?.direction ?? source.selectionDirection};
    const rect = selected?.rect ?? source.getBoundingClientRect();
    const caret = selected ? {top: rect.top} : measureCaret?.();
    const top = Math.max(
      rect.top + 4,
      Math.min(rect.bottom - selectButton.offsetHeight - 4, caret?.top ?? rect.top + 12),
    );
    selectButton.style.top = `${Math.round(top)}px`;
    selectButton.style.left = `${Math.round(rect.right - selectButton.offsetWidth - 12)}px`;
  }
  function schedule() {
    if (!destroyed && frame === null) frame = window.requestAnimationFrame(update);
  }
  divider.addEventListener(
    'pointerdown',
    (event) => {
      if (mobile.matches || event.button !== 0) return;
      event.preventDefault();
      divider.setPointerCapture(event.pointerId);
      mount.classList.add('resizing');
    },
    {signal},
  );
  divider.addEventListener(
    'pointermove',
    (event) => {
      if (!divider.hasPointerCapture(event.pointerId)) return;
      setWidth(mount.getBoundingClientRect().right - event.clientX);
      schedule();
    },
    {signal},
  );
  function finish(event) {
    if (divider.hasPointerCapture(event.pointerId)) {
      divider.releasePointerCapture(event.pointerId);
      setWidth(width, true);
    }
    mount.classList.remove('resizing');
  }
  divider.addEventListener('pointerup', finish, {signal});
  divider.addEventListener('pointercancel', finish, {signal});
  divider.addEventListener(
    'keydown',
    (event) => {
      const next = {
        ArrowLeft: width + 24,
        ArrowRight: width - 24,
        Home: 240,
        End: mount.clientWidth,
      };
      if (!(event.key in next)) return;
      event.preventDefault();
      setWidth(next[event.key], true);
      schedule();
    },
    {signal},
  );
  selectButton.addEventListener('pointerdown', (event) => event.preventDefault(), {signal});
  selectButton.addEventListener(
    'click',
    () => {
      if (candidate && !getState().busy) onSelect(candidate);
      schedule();
    },
    {signal},
  );
  for (const name of ['select', 'keyup', 'pointerup', 'scroll'])
    source.addEventListener(name, schedule, {signal, passive: true});
  document.addEventListener('selectionchange', schedule, {signal});
  document.addEventListener('focusin', schedule, {signal});
  window.addEventListener(
    'resize',
    () => {
      setWidth(width);
      schedule();
    },
    {signal},
  );
  const resize = new window.ResizeObserver(schedule);
  resize.observe(source);
  setWidth(width);
  schedule();
  return {
    update: schedule,
    destroy() {
      destroyed = true;
      lifetime.abort();
      resize.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      mount.classList.remove('resizing');
      divider.remove();
      selectButton.remove();
    },
  };
}
