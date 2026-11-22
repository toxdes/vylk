export function create({document, modal}) {
  const lifetime = new AbortController();
  const dialog = document.createElement('div');
  dialog.className = 'modal hidden';
  dialog.id = 'ai-discard-modal';
  dialog.setAttribute('aria-hidden', 'true');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const body = document.createElement('div');
  body.className = 'modal-body modal-body--standard';
  body.setAttribute('role', 'dialog');
  body.setAttribute('aria-modal', 'true');
  body.setAttribute('aria-labelledby', 'ai-discard-title');
  body.setAttribute('aria-describedby', 'ai-discard-message');
  const title = document.createElement('h2');
  title.id = 'ai-discard-title';
  title.textContent = 'Discard AI conversation?';
  const message = document.createElement('p');
  message.id = 'ai-discard-message';
  const actions = document.createElement('div');
  actions.className = 'ai-config-actions';
  let settle = null;
  function finish(value) {
    const resolve = settle;
    settle = null;
    modal.close(dialog);
    resolve?.(value);
  }
  for (const [label, value, className] of [
    ['Keep conversation', false, 'btn-text'],
    ['Discard conversation', true, 'btn-primary danger'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = className;
    button.autofocus = !value;
    button.addEventListener('click', () => finish(value), {signal: lifetime.signal});
    actions.append(button);
  }
  backdrop.addEventListener('click', () => finish(false), {signal: lifetime.signal});
  dialog.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    },
    {capture: true, signal: lifetime.signal},
  );
  body.append(title, message, actions);
  dialog.append(backdrop, body);
  document.body.append(dialog);
  return {
    ask({pending, busy, unsaved, online, queryRetained}) {
      if (settle) return Promise.resolve(false);
      message.textContent = [
        queryRetained
          ? 'This conversation will be lost. Your current query will remain.'
          : 'This conversation and any unsent query will be lost.',
        pending
          ? `${pending} pending ${pending === 1 ? 'suggestion will' : 'suggestions will'} be discarded.`
          : '',
        busy
          ? online
            ? 'The active request will be cancelled.'
            : 'A request already sent may continue on the server while you are offline.'
          : '',
        unsaved
          ? 'A reviewed change has not been saved and will be lost.'
          : 'Changes already saved to the note will remain.',
      ]
        .filter(Boolean)
        .join(' ');
      return new Promise((resolve) => {
        settle = resolve;
        modal.open(dialog);
      });
    },
    destroy() {
      finish(false);
      lifetime.abort();
      dialog.remove();
    },
  };
}
