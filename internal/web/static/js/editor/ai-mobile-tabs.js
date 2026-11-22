export function create({
  document,
  mount,
  surface,
  body,
  source,
  review,
  selectButton,
  closeButton,
}) {
  const window = document.defaultView;
  const media = window.matchMedia('(max-width: 640px)');
  const lifetime = new AbortController();
  const {signal} = lifetime;
  const editor = document.querySelector('#editor');
  const notePanel = document.querySelector('#editor-panel');
  const closeParent = closeButton.parentElement;
  const selectionParent = selectButton.parentElement;
  const tabs = document.createElement('div');
  tabs.className = 'ai-mobile-tabs';
  const tablist = document.createElement('div');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Note and AI');
  tabs.append(tablist);
  mount.before(tabs);
  const buttons = {};
  const panels = {note: notePanel, ai: surface};
  const attributes = ['role', 'aria-labelledby', 'aria-hidden', 'inert', 'id'];
  const saved = Object.values(panels).map((panel) => [
    panel,
    attributes.map((name) => [name, panel.getAttribute(name)]),
  ]);
  let active = 'ai';
  let count = 0;
  const scroll = {note: source.scrollTop, review: review.scrollTop, ai: body.scrollTop};

  for (const [name, label] of [
    ['note', 'Note'],
    ['ai', 'AI'],
  ]) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `ai-mobile-tab-${name}`;
    tab.textContent = label;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', name === 'note' ? notePanel.id : 'ai-mobile-panel');
    tab.addEventListener('click', () => show(name), {signal});
    tab.addEventListener(
      'keydown',
      (event) => {
        const next = {
          ArrowLeft: name === 'note' ? 'ai' : 'note',
          ArrowRight: name === 'note' ? 'ai' : 'note',
          Home: 'note',
          End: 'ai',
        }[event.key];
        if (!next) return;
        event.preventDefault();
        show(next);
        buttons[next].focus();
      },
      {signal},
    );
    tablist.append(tab);
    buttons[name] = tab;
  }
  const selectionLabel = document.createElement('span');
  selectionLabel.className = 'ai-mobile-select-label';
  selectionLabel.textContent = 'Ask AI';
  selectButton.append(selectionLabel);

  function viewport() {
    const view = window.visualViewport;
    if (media.matches && view && view.scale === 1)
      editor.style.setProperty('--ai-viewport-height', `${Math.round(view.height)}px`);
    else editor.style.removeProperty('--ai-viewport-height');
  }
  function restoreAttributes() {
    for (const [panel, values] of saved)
      for (const [name, value] of values)
        if (value === null) panel.removeAttribute(name);
        else panel.setAttribute(name, value);
  }
  function sync() {
    editor.classList.toggle('ai-mobile-active', media.matches);
    mount.dataset.aiTab = active;
    tabs.dataset.active = active;
    buttons.note.textContent = count ? `Note (${count})` : 'Note';
    for (const [name, tab] of Object.entries(buttons)) {
      tab.setAttribute('aria-selected', String(name === active));
      tab.tabIndex = name === active ? 0 : -1;
    }
    if (media.matches) {
      surface.id = 'ai-mobile-panel';
      for (const [name, panel] of Object.entries(panels)) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', buttons[name].id);
        panel.setAttribute('aria-hidden', String(name !== active));
        panel.inert = name !== active;
      }
      if (selectButton.parentElement !== tabs) tabs.append(selectButton);
      if (closeButton.parentElement !== tabs) tabs.append(closeButton);
      selectButton.setAttribute('aria-label', 'Ask AI about selected text');
    } else {
      restoreAttributes();
      if (selectButton.parentElement !== selectionParent) selectionParent.append(selectButton);
      if (closeButton.parentElement !== closeParent) closeParent.append(closeButton);
      selectButton.setAttribute('aria-label', 'Select this text');
    }
    viewport();
  }
  function show(next) {
    if (!media.matches || next === active) return;
    if (active === 'note') {
      scroll.note = source.scrollTop;
      scroll.review = review.scrollTop;
    } else scroll.ai = body.scrollTop;
    if (panels[active].contains(document.activeElement)) document.activeElement.blur();
    active = next;
    sync();
    if (next === 'note') {
      source.scrollTop = scroll.note;
      review.scrollTop = scroll.review;
    } else body.scrollTop = scroll.ai;
  }
  media.addEventListener('change', sync, {signal});
  window.visualViewport?.addEventListener('resize', viewport, {signal});
  sync();
  return {
    mobile: () => media.matches,
    active: () => active,
    show,
    update(pending) {
      count = pending;
      sync();
    },
    destroy() {
      lifetime.abort();
      restoreAttributes();
      closeParent.append(closeButton);
      selectionParent.append(selectButton);
      selectButton.setAttribute('aria-label', 'Select this text');
      selectionLabel.remove();
      editor.classList.remove('ai-mobile-active');
      editor.style.removeProperty('--ai-viewport-height');
      delete mount.dataset.aiTab;
      tabs.remove();
    },
  };
}
