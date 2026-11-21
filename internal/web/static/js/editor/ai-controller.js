// Only the chosen scope crosses the API boundary; highlights use the local note snapshot.
import {create as createContextHighlight} from './ai-context-highlight.js';
import {create as createPanelControls} from './ai-panel-controls.js';
import {create as createProviderPicker} from './ai-provider-picker.js';
import {create as createMobileTabs} from './ai-mobile-tabs.js';
import {create as createDiscardGuard} from './ai-discard-guard.js';
import {changedRanges} from './ai-word-diff.js';
import {changedSpan, mapOffset, mergeEdits} from './ai-rebase.js';

export function create({
  document,
  api,
  snapshot,
  apply,
  onClose,
  showToast,
  modal,
  measureCaret,
  countWords,
  online = true,
}) {
  const original = snapshot();
  const source = document.querySelector('#note-content');
  const mount = document.querySelector('#editor-panels') || source.parentElement;
  const lifetime = new AbortController();
  const discardGuard = createDiscardGuard({document, modal});
  const wordDiffs = new Map();
  let request = null;
  let session = null;
  let closed = false;
  let busy = false;
  // A synced edit waits for the running request, then rebases the review.
  let remotePending = false;
  let savePending = false;
  let recovery = null;
  let answeredJob = null;
  let activePlan = null;
  let contextDirty = false;
  let scope = original.start !== original.end ? 'selection' : 'none';
  let selectionCandidate =
    scope === 'selection'
      ? {start: original.start, end: original.end, direction: original.direction}
      : null;
  let entries = [];
  let historyBytes = 0;
  const oldScroll = source.scrollTop;
  const readonly = [
    source,
    document.querySelector('#note-title'),
    document.querySelector('#note-tags'),
  ]
    .filter(Boolean)
    .map((node) => [node, node.readOnly]);
  readonly.forEach(([node]) => (node.readOnly = true));
  let editNoticeAt = -Infinity;
  function showEditNotice() {
    const now = performance.now();
    if (now - editNoticeAt < 3200) return;
    editNoticeAt = now;
    showToast('Close AI to edit the note directly.', 'warning');
  }
  const editEvents = {signal: lifetime.signal};
  for (const [node, wasReadOnly] of readonly) {
    if (wasReadOnly) continue;
    node.addEventListener(
      'keydown',
      (event) => {
        if (event.defaultPrevented || event.isComposing) return;
        const {key, ctrlKey, metaKey} = event;
        const typing =
          Array.from(key).length === 1 &&
          ((!ctrlKey && !metaKey) || event.getModifierState('AltGraph'));
        if (typing || key === 'Backspace' || key === 'Delete' || key === 'Enter') showEditNotice();
      },
      editEvents,
    );
    for (const type of ['beforeinput', 'cut', 'paste', 'drop'])
      node.addEventListener(type, showEditNotice, editEvents);
  }
  const toolbar = document.querySelector('.fmt-bar');
  const wasInert = toolbar?.inert;
  if (toolbar) toolbar.inert = true;
  const surface = document.createElement('section');
  surface.className = 'ai-review';
  surface.setAttribute('aria-label', 'AI review');
  mount.append(surface);
  const contextHighlight = createContextHighlight({document, source, value: original.value});

  function text(tag, value, parent = surface) {
    const node = document.createElement(tag);
    node.textContent = value;
    parent.append(node);
    return node;
  }
  function icon(name, parent) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    parent.append(svg);
    return svg;
  }
  function button(label, run, parent = surface, iconName = null) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'btn-text';
    if (iconName) {
      node.setAttribute('aria-label', label);
      node.title = label;
      icon(iconName, node);
    } else node.textContent = label;
    if (run) node.addEventListener('click', () => void run());
    parent.append(node);
    return node;
  }
  const header = text('div', '');
  header.className = 'ai-review-header';
  const heading = text('strong', '', header);
  icon('sparkles', heading);
  text('span', 'AI', heading);
  const providerControls = document.createElement('div');
  providerControls.className = 'ai-composer-controls';
  let capabilityGeneration = 0;
  const providers = createProviderPicker({
    document,
    parent: providerControls,
    api,
    signal: lifetime.signal,
    onChanged: async () => {
      const generation = ++capabilityGeneration;
      const capabilities = await api('/api/ai/capabilities', {signal: lifetime.signal});
      if (closed || generation !== capabilityGeneration) return;
      thinkingLabel.hidden = capabilities.thinking_controllable !== true;
      if (thinkingLabel.hidden) thinking.checked = false;
    },
    onError: (error) => {
      status.textContent = error.message || 'Could not load AI providers.';
    },
  });
  const closeButton = button('Close AI', requestClose, header, 'x');
  closeButton.className = 'panel-layout';
  const contextBar = text('div', '');
  contextBar.className = 'ai-context-bar';
  const contextChip = text('div', '', contextBar);
  contextChip.className = 'tag ai-context-chip';
  const contextOpen = button('View shared text', openContext, contextChip, 'quote');
  contextOpen.className = 'ai-context-open';
  contextOpen.setAttribute('aria-label', 'View shared text');
  contextOpen.setAttribute('aria-haspopup', 'dialog');
  contextOpen.setAttribute('aria-controls', 'ai-context-dialog');
  const contextLabel = text('span', '', contextOpen);
  contextLabel.className = 'ai-context-prefix';
  const contextCount = text('span', '', contextOpen);
  contextCount.className = 'ai-context-count';
  let countedText = null;
  const contextRemove = button(
    'Remove shared selection',
    () => {
      if (busy || Boolean(recovery) || savePending) return;
      changeScope('none');
      prompt.focus({preventScroll: true});
    },
    contextChip,
    'x',
  );
  contextRemove.className = 'ai-context-remove';
  const contextDialog = document.createElement('div');
  contextDialog.id = 'ai-context-dialog';
  contextDialog.className = 'modal hidden';
  contextDialog.setAttribute('aria-hidden', 'true');
  const contextBackdrop = text('div', '', contextDialog);
  contextBackdrop.className = 'modal-backdrop';
  const contextBody = text('div', '', contextDialog);
  contextBody.className = 'modal-body modal-body--standard ai-context-dialog';
  contextBody.setAttribute('role', 'dialog');
  contextBody.setAttribute('aria-modal', 'true');
  contextBody.setAttribute('aria-labelledby', 'ai-context-title');
  contextBody.tabIndex = -1;
  const contextHeading = text('div', '', contextBody);
  contextHeading.className = 'modal-heading';
  const contextTitle = text('h2', '', contextHeading);
  contextTitle.id = 'ai-context-title';
  const contextDismiss = button(
    'Close shared text',
    () => modal.close(contextDialog),
    contextHeading,
    'x',
  );
  contextDismiss.className = 'modal-close';
  contextDismiss.autofocus = true;
  const contextPreview = text('pre', '', contextBody);
  contextPreview.className = 'ai-context-preview';
  contextPreview.tabIndex = 0;
  contextPreview.setAttribute('role', 'region');
  contextPreview.setAttribute('aria-label', 'Shared text');
  document.body.append(contextDialog);
  contextBackdrop.addEventListener('click', () => modal.close(contextDialog), {
    signal: lifetime.signal,
  });

  function sharedText() {
    return scope === 'note'
      ? original.value
      : scope === 'selection'
        ? original.value.slice(original.start, original.end)
        : '';
  }

  function openContext() {
    if (closed || scope === 'none') return;
    contextPreview.textContent = sharedText();
    modal.open(contextDialog);
  }

  const body = text('div', '');
  body.className = 'ai-review-body';
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', 'AI conversation');
  const offlineNotice = text('p', 'AI is unavailable offline. Your conversation is kept.', body);
  offlineNotice.className = 'ai-offline-notice';
  offlineNotice.setAttribute('role', 'status');
  const emptyState = text('div', '', body);
  emptyState.className = 'ai-empty-state';
  text('p', 'Try a prompt', emptyState);
  const suggestions = [
    ['Fix grammar and typos', 'Fix grammar and typos in the shared text.'],
    ['Break this task into actionable subtasks', 'Break this task down into actionable subtasks.'],
    ['Insert a quote', 'Insert a quote.'],
  ].map(([label, query]) =>
    button(
      label,
      () => {
        prompt.value = query;
        prompt.focus();
        prompt.setSelectionRange(query.length, query.length);
        prompt.dispatchEvent(new document.defaultView.Event('input', {bubbles: true}));
      },
      emptyState,
    ),
  );
  const conversation = text('div', '', body);
  conversation.className = 'ai-conversation';
  const status = text('div', '', body);
  status.className = 'ai-query-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const statusResize = new document.defaultView.ResizeObserver(() => {
    if (busy && !savePending) revealConversation();
  });
  statusResize.observe(body);
  const note = text('div', '', source.parentElement);
  note.className = 'ai-note-review';
  note.hidden = true;
  note.setAttribute('aria-label', 'Suggested changes');
  note.setAttribute('role', 'region');
  const sourceStyle = document.defaultView.getComputedStyle(source);
  note.style.fontFamily = sourceStyle.fontFamily;
  note.style.fontSize = sourceStyle.fontSize;
  note.style.lineHeight = sourceStyle.lineHeight;
  const noteHeader = text('div', '', note);
  noteHeader.className = 'ai-diff-header';
  text('strong', 'Review changes', noteHeader);
  const noteContent = text('div', '', note);
  const composer = document.createElement('form');
  composer.className = 'ai-composer';
  surface.append(composer);
  composer.append(contextBar);
  const inputRow = text('div', '', composer);
  inputRow.className = 'ai-composer-input';
  const prompt = document.createElement('textarea');
  prompt.id = 'ai-prompt';
  prompt.rows = 1;
  prompt.setAttribute('aria-label', 'Message');
  prompt.maxLength = 16384;
  prompt.placeholder = 'Ask AI…';
  inputRow.append(prompt);
  inputRow.append(providerControls);
  const sharing = text('div', '', providerControls);
  sharing.className = 'ai-sharing';
  providerControls.prepend(sharing);
  const scopeLabel = text('label', 'Using:', sharing);
  scopeLabel.className = 'ai-scope-label';
  const scopePicker = document.createElement('select');
  scopePicker.className = 'ai-scope-picker';
  scopePicker.setAttribute('aria-label', 'Shared text');
  for (const [value, label] of [
    ['none', 'No note text'],
    ['note', 'Entire note'],
    ['selection', 'Selected text'],
  ])
    scopePicker.add(new document.defaultView.Option(label, value));
  const selectionOption = scopePicker.options[2];
  scopeLabel.append(scopePicker);
  scopePicker.addEventListener(
    'change',
    async () => {
      const next = scopePicker.value;
      const selection = selectionCandidate;
      scopePicker.value = scope;
      if (next === scope) return;
      if (!mobileTabs.mobile() && !(await confirmDiscard({queryRetained: true}))) return;
      if (closed || !online) return;
      if (next === 'selection' && selection) Object.assign(original, selection);
      await changeScope(next, true);
    },
    {signal: lifetime.signal},
  );
  const thinkingLabel = document.createElement('label');
  thinkingLabel.className = 'checkbox-label';
  thinkingLabel.hidden = true;
  const thinking = document.createElement('input');
  thinking.type = 'checkbox';
  thinkingLabel.append(thinking, document.createTextNode(' Use thinking (slower)'));
  sharing.append(thinkingLabel);
  void providers.refresh();
  const send = button('Send', null, providerControls, 'send');
  send.type = 'submit';
  send.className = 'btn-primary ai-send';
  send.addEventListener(
    'click',
    (event) => {
      if (busy || recovery) {
        event.preventDefault();
        void cancelRequest();
      }
    },
    {signal: lifetime.signal},
  );
  async function cancelRequest() {
    if (!online) {
      showToast('Reconnect to stop or check this request.', 'warning');
      return;
    }
    if (closed || savePending) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    busy = true;
    let outcome = 'cancelled';
    const confirm = async (signal) => {
      let acknowledged = false;
      if (session) {
        try {
          await api(`/api/ai/sessions/${session.id}/cancel`, {method: 'POST', body: '{}', signal});
          acknowledged = true;
        } catch (error) {
          if (signal.aborted) throw error;
        }
        const next = await api(`/api/ai/sessions/${session.id}`, {signal});
        if (closed || signal.aborted) return;
        if (
          next.job?.status === 'running' ||
          (!acknowledged && (!activePlan || next.job?.snapshot_id !== activePlan))
        )
          throw new Error(
            'Cancellation could not be confirmed. Check status or try stopping again.',
          );
        session = next;
        if (activePlan && next.job?.snapshot_id === activePlan) {
          outcome = next.job.status;
          if (outcome === 'completed') recordAnswer(next.job, next);
        }
        await saveDraft();
      }
      recovery = null;
      activePlan = null;
    };
    recovery = confirm;
    status.textContent = 'Stopping…';
    render({content: false});
    try {
      await confirm(controller.signal);
      if (!closed && request === controller)
        status.textContent =
          outcome === 'completed'
            ? 'Request completed.'
            : outcome === 'failed'
              ? 'Request failed.'
              : 'Request cancelled.';
    } catch (error) {
      if (!closed && request === controller) showFailure(error);
    } finally {
      if (request === controller) {
        request = null;
        busy = false;
      }
      if (!closed) render();
    }
  }
  const acceptAll = button('Accept all', () => review('accept_all'), noteHeader);
  const retrySave = button('Retry save', () => operate(saveDraft), composer);
  retrySave.className = 'btn-primary';
  const selectButton = button('Select this text', null, surface, 'quote');
  selectButton.className = 'ai-select-text panel-layout';
  selectButton.hidden = true;
  const panelControls = createPanelControls({
    document,
    source,
    mount,
    surface,
    selectButton,
    measureCaret,
    getSelection: reviewSelection,
    onSelectionChange: (selection) => {
      selectionCandidate = selection;
      selectionOption.disabled = !selection && original.start === original.end;
    },
    getState: () => ({
      scope,
      start: original.start,
      end: original.end,
      busy: !online || busy || Boolean(recovery) || savePending,
      pending: Boolean(session?.hunks.some((hunk) => !hunk.decision)),
    }),
    onSelect: async (selection) => {
      if (busy || Boolean(recovery) || savePending) return;
      if (mobileTabs.mobile() && session?.hunks.some((hunk) => !hunk.decision)) {
        showToast('Review pending changes before changing shared text.', 'warning');
        return;
      }
      if (!mobileTabs.mobile() && !(await confirmDiscard())) return;
      Object.assign(original, selection);
      if (!mobileTabs.mobile()) prompt.value = '';
      changeScope('selection', true);
      mobileTabs.show('ai');
      prompt.focus({preventScroll: true});
    },
  });
  const mobileTabs = createMobileTabs({
    document,
    mount,
    surface,
    body,
    source,
    review: note,
    selectButton,
    closeButton,
  });

  function reviewSelection() {
    if (note.hidden) return null;
    const selection = document.defaultView.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const block = (node) =>
      (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-source-start]');
    const first = block(range.startContainer);
    if (!first || first !== block(range.endContainer) || !note.contains(first)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(first);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = Number(first.dataset.sourceStart) + prefix.toString().length;
    return {
      start,
      end: start + range.toString().length,
      direction: 'forward',
      rect: range.getBoundingClientRect(),
    };
  }
  async function changeScope(nextScope, confirmed = false) {
    if (!online) return;
    if (!mobileTabs.mobile() && !confirmed && !(await confirmDiscard({queryRetained: true})))
      return;
    if (mobileTabs.mobile() && session?.hunks.some((hunk) => !hunk.decision)) {
      showToast('Review pending changes before changing shared text.', 'warning');
      return;
    }
    scope = nextScope;
    if (!mobileTabs.mobile()) {
      resetSession();
      entries = [];
      historyBytes = 0;
    } else contextDirty = Boolean(session);
    if (scope === 'none') source.setSelectionRange(source.selectionEnd, source.selectionEnd);
    render();
    status.textContent = '';
  }

  async function saveDraft() {
    const base = snapshot();
    if (base.noteId !== original.noteId || base.generation !== original.generation)
      throw new Error('The note changed. Close AI and start again.');
    const start = scope === 'note' ? 0 : original.start;
    const end = scope === 'note' ? original.value.length : original.end;
    const ours = original.value.slice(0, start) + session.draft + original.value.slice(end);
    // A synced edit can land while a change is accepted; keep both when they
    // touch different text.
    const next =
      base.value === original.value ? ours : mergeEdits(original.value, ours, base.value);
    if (next === null)
      throw new Error(
        'Another device changed the same text. Undo this change, then review the suggestions again.',
      );
    const moved = changedSpan(ours, next);
    const range = {
      start: mapOffset(start, moved),
      end: mapOffset(start + session.draft.length, moved, {end: true}),
    };
    if (next !== base.value) {
      savePending = true;
      render({content: false});
      if (!(await apply(next, base, range.end)))
        throw new Error('Could not save this change. Choose Retry save to try again.');
      if (closed) return;
    }
    const current = snapshot();
    if (current.generation !== original.generation) {
      close();
      return;
    }
    Object.assign(original, {value: next, revision: current.revision, ...range});
    selectionCandidate = null;
    if (current.value !== next || next !== ours) remotePending = true;
    savePending = false;
  }
  function outdatedCount() {
    return (session?.hunks || []).filter((hunk) => hunk.decision === 'outdated').length;
  }
  // Moves the shared range with a synced edit, then rebases suggestions on the
  // server. Runs only between requests, so a running one finishes first.
  async function applyRemote() {
    if (closed || !remotePending || busy || savePending || recovery || !online) return;
    remotePending = false;
    const current = snapshot();
    if (current.noteId !== original.noteId || current.generation !== original.generation) {
      close();
      return;
    }
    if (current.value !== original.value) {
      const change = changedSpan(original.value, current.value);
      Object.assign(original, {
        value: current.value,
        start: mapOffset(original.start, change),
        end: mapOffset(original.end, change, {end: true}),
      });
      selectionCandidate = null;
    }
    original.revision = current.revision;
    if (!session || scope === 'none' || session.draft === sharedText()) {
      render();
      return;
    }
    const before = outdatedCount();
    await operate(async (signal) => {
      session = await api(`/api/ai/sessions/${session.id}/rebase`, {
        method: 'POST',
        body: JSON.stringify({version: session.version, text: sharedText()}),
        signal,
      });
    });
    const outdated = outdatedCount() - before;
    if (outdated > 0 && !closed)
      showToast(
        `The note changed on another device. ${outdated} AI ${outdated === 1 ? 'suggestion is' : 'suggestions are'} outdated.`,
        'warning',
      );
  }
  function isCurrent() {
    const current = snapshot();
    return (
      current.noteId === original.noteId &&
      current.generation === original.generation &&
      current.value === original.value &&
      current.revision === original.revision
    );
  }
  function resetSession() {
    wordDiffs.clear();
    request?.abort();
    request = null;
    busy = false;
    recovery = null;
    answeredJob = null;
    activePlan = null;
    if (session)
      void api(`/api/ai/sessions/${session.id}`, {method: 'DELETE', keepalive: true}).catch(
        () => {},
      );
    session = null;
  }
  function hasWork({queryRetained = false} = {}) {
    return Boolean(
      entries.length ||
      (!queryRetained && prompt.value.trim()) ||
      busy ||
      recovery ||
      savePending ||
      session?.hunks.some((hunk) => !hunk.decision),
    );
  }
  async function confirmDiscard({queryRetained = false} = {}) {
    if (closed || !hasWork({queryRetained})) return true;
    if (busy && savePending) {
      showToast('Wait for this change to finish saving before leaving AI.', 'warning');
      return false;
    }
    return discardGuard.ask({
      pending: session?.hunks.filter((hunk) => !hunk.decision).length || 0,
      busy: busy || Boolean(recovery),
      unsaved: savePending,
      online,
      queryRetained,
    });
  }
  async function requestClose() {
    if (await confirmDiscard()) close();
  }
  function close() {
    if (closed) return;
    closed = true;
    resetSession();
    discardGuard.destroy();
    lifetime.abort();
    statusResize.disconnect();
    contextHighlight.destroy();
    mobileTabs.destroy();
    panelControls.destroy();
    modal.close(contextDialog);
    contextDialog.remove();
    surface.remove();
    note.remove();
    source.hidden = false;
    readonly.forEach(([node, value]) => (node.readOnly = value));
    if (toolbar) toolbar.inert = wasInert;
    entries = [];
    historyBytes = 0;
    source.setSelectionRange(original.start, original.end, original.direction);
    source.scrollTop = oldScroll;
    source.focus({preventScroll: true});
    onClose();
  }
  function render({content = true} = {}) {
    offlineNotice.hidden = online;
    contextHighlight.setScope(scope, original.start, original.end, original.value);
    contextBar.hidden = scope === 'none';
    const shared = sharedText();
    const prefix = Array.from(shared.slice(0, 240).replace(/\s+/g, ' ').trim())
      .slice(0, 60)
      .join('');
    contextLabel.textContent = `${prefix}…`;
    if (shared !== countedText) {
      const count = countWords(shared);
      contextCount.textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
      countedText = shared;
    }
    contextTitle.textContent = scope === 'note' ? 'Shared note' : 'Shared selection';
    contextRemove.setAttribute(
      'aria-label',
      scope === 'note' ? 'Remove shared note' : 'Remove shared selection',
    );
    contextRemove.title = scope === 'note' ? 'Remove shared note' : 'Remove shared selection';
    contextRemove.disabled = !online || busy || Boolean(recovery) || savePending;
    if (!contextDialog.classList.contains('hidden')) contextPreview.textContent = shared;
    panelControls.update();
    const pending = (session?.hunks || []).filter((hunk) => !hunk.decision);
    const outdated = (session?.hunks || []).filter((hunk) => hunk.decision === 'outdated');
    const reviewing = pending.length > 0 || outdated.length > 0;
    mobileTabs.update(pending.length);
    scopePicker.value = scope;
    selectionOption.disabled = !selectionCandidate && original.start === original.end;
    scopePicker.disabled =
      !online ||
      busy ||
      Boolean(recovery) ||
      savePending ||
      (mobileTabs.mobile() && pending.length > 0);
    if (mobileTabs.mobile() && pending.length) contextRemove.disabled = true;
    note.hidden = !reviewing;
    source.hidden = reviewing;
    emptyState.hidden = entries.length > 0;
    for (const suggestion of suggestions)
      suggestion.disabled = busy || Boolean(recovery) || savePending;

    if (content) {
      conversation.replaceChildren();
      for (const entry of entries) {
        const row = text('div', '', conversation);
        row.className = `ai-message ai-message--${entry.role}`;
        text('p', entry.value, row);
      }
      noteContent.replaceChildren();
      const pendingIDs = new Set(pending.map((hunk) => hunk.id));
      for (const id of wordDiffs.keys()) if (!pendingIDs.has(id)) wordDiffs.delete(id);
      const highlightBudget = {cells: 262144, marks: 2048};
      const offset = scope === 'note' ? 0 : original.start;
      const draft = session?.draft ?? shared;
      const sourceText = (value, start) => {
        if (!value) return;
        const span = text('span', value, noteContent);
        span.className = 'ai-source-text';
        span.dataset.sourceStart = String(start);
      };
      for (const hunk of outdated) {
        const row = text('div', '', noteContent);
        row.className = 'ai-hunk ai-hunk--outdated';
        row.dataset.hunkId = hunk.id;
        const controls = text('div', '', row);
        controls.className = 'ai-actions';
        const reference = text('span', `${hunk.ref} · Outdated`, controls);
        reference.className = 'ai-hunk-ref';
        reference.id = `ai-hunk-ref-${hunk.id}`;
        const dismiss = button(
          'Dismiss outdated change',
          () => review('reject', hunk.id),
          controls,
          'x',
        );
        dismiss.disabled = busy || Boolean(recovery) || savePending;
        dismiss.setAttribute('aria-describedby', reference.id);
        text('del', hunk.before, row);
        text('ins', hunk.after, row);
      }
      if (reviewing) sourceText(original.value.slice(0, offset), 0);
      let cursor = 0;
      if (scope !== 'none' && pending.length) {
        for (const [index, hunk] of pending.entries()) {
          const lineStart = hunk.start === 0 ? 0 : draft.lastIndexOf('\n', hunk.start - 1) + 1;
          const nextLine = draft.indexOf('\n', hunk.end);
          const displayStart = Math.max(cursor, lineStart);
          const displayEnd = Math.min(
            nextLine < 0 ? draft.length : nextLine + 1,
            pending[index + 1]?.start ?? draft.length,
          );
          const leading = draft.slice(displayStart, hunk.start);
          const trailing = draft.slice(hunk.end, displayEnd);
          sourceText(draft.slice(cursor, displayStart), offset + cursor);
          const row = text('div', '', noteContent);
          row.className = 'ai-hunk';
          row.dataset.hunkId = hunk.id;
          const controls = text('div', '', row);
          controls.className = 'ai-actions';
          const reference = text('span', hunk.ref, controls);
          reference.className = 'ai-hunk-ref';
          reference.id = `ai-hunk-ref-${hunk.id}`;
          button('Reject change', () => review('reject', hunk.id), controls, 'x').disabled =
            busy || Boolean(recovery) || savePending;
          button('Accept change', () => review('accept', hunk.id), controls, 'check').disabled =
            busy || Boolean(recovery) || savePending;
          for (const control of controls.querySelectorAll('button'))
            control.setAttribute('aria-describedby', reference.id);
          let ranges = wordDiffs.get(hunk.id);
          if (!ranges) {
            ranges = changedRanges(hunk.before, hunk.after, highlightBudget);
            wordDiffs.set(hunk.id, ranges);
          }
          const line = (tag, value, changed) => {
            if (!leading && !value && !trailing) return null;
            const node = text(tag, '', row);
            node.append(document.createTextNode(leading));
            let cursor = 0;
            for (const [start, end] of changed) {
              node.append(document.createTextNode(value.slice(cursor, start)));
              text('span', value.slice(start, end), node).className = 'ai-diff-word';
              cursor = end;
            }
            node.append(document.createTextNode(value.slice(cursor) + trailing));
            return node;
          };
          const before = line('del', hunk.before, ranges.before);
          if (before) before.dataset.sourceStart = String(offset + displayStart);
          line('ins', hunk.after, ranges.after);
          cursor = displayEnd;
        }
      }
      if (reviewing) sourceText(draft.slice(cursor), offset + cursor);
      const tail = scope === 'note' ? original.value.length : original.end;
      if (reviewing) sourceText(original.value.slice(tail), offset + draft.length);
    }
    note.querySelectorAll('button').forEach((node) => {
      node.disabled = !online;
      node.setAttribute(
        'aria-disabled',
        String(!online || busy || Boolean(recovery) || savePending),
      );
    });
    thinking.disabled = !online || busy || Boolean(recovery) || savePending;
    providers.setDisabled(thinking.disabled);
    const stopping = (busy || Boolean(recovery)) && !savePending;
    send.type = stopping ? 'button' : 'submit';
    send.disabled = savePending || (!online && !stopping);
    send.setAttribute('aria-label', stopping ? 'Cancel request' : 'Send');
    send.title = stopping ? 'Stop request' : 'Send (Enter)';
    send.replaceChildren();
    icon(stopping ? 'stop' : 'send', send);
    closeButton.disabled = busy && savePending;
    acceptAll.hidden = !pending.length;
    acceptAll.disabled = !online || busy || Boolean(recovery) || savePending;
    retrySave.hidden = !savePending || busy;
    retrySave.disabled = !online || busy;
    surface.setAttribute('aria-busy', String(busy));
  }
  function revealConversation() {
    if (mobileTabs.mobile() && mobileTabs.active() !== 'ai') return;
    const target = status.textContent ? status : conversation.lastElementChild;
    if (!target) return;
    const bounds = body.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.bottom > bounds.bottom || rect.top < bounds.top)
      body.scrollTop += rect.bottom - bounds.bottom;
  }
  function showFailure(error, retry) {
    status.replaceChildren();
    const message = text(
      'span',
      recovery
        ? 'Request status is unknown. Check status before continuing.'
        : error.message || 'AI request failed.',
      status,
    );
    if (recovery) {
      const resume = recovery;
      button('Check status', () => operate((signal) => resume(signal)), message);
    } else if (retry && isCurrent()) {
      message.append(document.createTextNode(' '));
      button('retry', retry, message).className = 'ai-request-retry';
    }
  }
  async function operate(run, {scroll = false, canRetry = false} = {}) {
    if (!online || busy || closed) return;
    const focused = document.activeElement;
    const retryFocus = focused?.classList.contains('ai-request-retry');
    const focusedHunk = focused?.closest('.ai-hunk');
    const reviewFocus = focusedHunk || focused === acceptAll || focused === retrySave;
    const index = Math.max(0, [...note.querySelectorAll('.ai-hunk')].indexOf(focusedHunk));
    const label = focused?.getAttribute('aria-label');
    const controller = new AbortController();
    const started = document.defaultView.performance.now();
    request = controller;
    busy = true;
    render({content: false});
    status.replaceChildren();
    icon('loader', status).classList.add('ai-test-spinner');
    text('span', 'Working', status);
    const elapsed = text('span', '0s', status);
    // The live region announces Working once, rather than every clock tick.
    elapsed.setAttribute('aria-hidden', 'true');
    const clock = document.defaultView;
    const timer = clock.setInterval(() => {
      elapsed.textContent = formatElapsed(
        Math.floor((clock.performance.now() - started) / 1000) * 1000,
      );
    }, 1000);
    const stopTimer = () => clock.clearInterval(timer);
    controller.signal.addEventListener('abort', stopTimer, {once: true});
    try {
      await run(controller.signal);
      if (!closed && request === controller) {
        const remaining = (session?.hunks || []).filter((hunk) => !hunk.decision).length;
        status.textContent = reviewFocus
          ? remaining
            ? `${remaining} ${remaining === 1 ? 'change' : 'changes'} left to review.`
            : session?.changed
              ? 'Changes saved.'
              : 'Review complete.'
          : canRetry
            ? `Took ${formatElapsed(document.defaultView.performance.now() - started)}`
            : '';
      }
    } catch (error) {
      if (!closed && request === controller) {
        showFailure(error, canRetry ? () => operate(run, {scroll, canRetry}) : null);
      }
    } finally {
      stopTimer();
      controller.signal.removeEventListener('abort', stopTimer);
      if (request === controller) {
        request = null;
        busy = false;
      }
      if (!closed) {
        const restore =
          reviewFocus &&
          (document.activeElement === focused || document.activeElement === document.body);
        render();
        if (scroll) revealConversation();
        if (retryFocus && document.activeElement === document.body)
          (status.querySelector('.ai-request-retry') || prompt).focus({preventScroll: true});
        if (restore) {
          const rows = [...note.querySelectorAll('.ai-hunk')];
          const row =
            rows.find((node) => node.dataset.hunkId === focusedHunk?.dataset.hunkId) ||
            rows[Math.min(index, rows.length - 1)];
          const next = savePending
            ? retrySave
            : row
              ? [...row.querySelectorAll('button')].find(
                  (node) => node.getAttribute('aria-label') === label,
                ) || row.querySelector('button')
              : prompt;
          next.focus({preventScroll: true});
        }
      }
      if (remotePending && !closed) void applyRemote();
    }
  }
  async function review(action, hunkID) {
    if (savePending || recovery) return;
    await operate(async (signal) => {
      const version = session.version;
      const reconcile = async (signal) => {
        const next = await api(`/api/ai/sessions/${session.id}`, {signal});
        if (closed || signal.aborted) return false;
        session = next;
        recovery = null;
        if (next.version !== version) {
          await saveDraft();
          return true;
        }
        return false;
      };
      recovery = reconcile;
      let next;
      try {
        next = await api(`/api/ai/sessions/${session.id}/review`, {
          method: 'POST',
          body: JSON.stringify({action, hunk_id: hunkID, version}),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (await reconcile(signal)) return;
        throw error;
      }
      if (closed || signal.aborted) return;
      session = next;
      recovery = null;
      if (action !== 'reject') await saveDraft();
    });
  }
  function recordAnswer(job, next) {
    if (answeredJob === job.id) return;
    answeredJob = job.id;
    entries.push({role: 'assistant', value: next.answer});
    historyBytes += next.answer.length;
  }
  async function finishJob(job, signal) {
    while (job.status === 'running') {
      job = await api(`/api/ai/sessions/${session.id}?job=1&wait=1`, {signal, timeoutMs: 30000});
    }
    if (job.status !== 'completed') {
      recovery = null;
      activePlan = null;
      throw new Error(job.error || 'AI request did not finish.');
    }
    const next = await api(`/api/ai/sessions/${session.id}`, {signal});
    if (closed || signal.aborted || !isCurrent()) return;
    session = next;
    recordAnswer(job, next);
    recovery = null;
    activePlan = null;
  }
  async function startJob(plan, signal) {
    activePlan = plan.id;
    const reconcile = async (signal) => {
      const next = await api(`/api/ai/sessions/${session.id}`, {signal});
      if (closed || signal.aborted) return;
      session = next;
      let job = next.job;
      if (job?.snapshot_id !== plan.id) {
        // Server start is idempotent for this exact frozen plan and version.
        job = await api(`/api/ai/sessions/${session.id}/start`, {
          method: 'POST',
          body: JSON.stringify({plan_id: plan.id, version: plan.version}),
          signal,
        });
      }
      await finishJob(job, signal);
    };
    recovery = reconcile;
    try {
      const job = await api(`/api/ai/sessions/${session.id}/start`, {
        method: 'POST',
        body: JSON.stringify({plan_id: plan.id, version: session.version}),
        signal,
      });
      await finishJob(job, signal);
    } catch (error) {
      if (signal.aborted || !recovery) throw error;
      await reconcile(signal);
    }
  }
  composer.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      if (
        busy ||
        recovery ||
        savePending ||
        providers.pending() ||
        !providers.value() ||
        !prompt.value.trim()
      )
        return;
      if (historyBytes + prompt.value.length > 1 << 20) {
        status.textContent = 'Conversation limit reached. Close AI and start again.';
        return;
      }
      const query = prompt.value;
      const providerID = providers.value();
      let recorded = false;
      void operate(
        async (signal) => {
          const useThinking = !thinkingLabel.hidden && thinking.checked;
          if (!isCurrent()) throw new Error('The note changed. Close AI and start again.');
          if (!recorded) {
            entries.push({role: 'user', value: query});
            historyBytes += query.length;
            prompt.value = '';
            recorded = true;
          }
          render();
          revealConversation();
          if (!session) {
            const created = await api('/api/ai/sessions', {
              method: 'POST',
              body: JSON.stringify({
                note_id: original.noteId,
                scope,
                text:
                  scope === 'none'
                    ? ''
                    : scope === 'note'
                      ? original.value
                      : original.value.slice(original.start, original.end),
              }),
              signal,
            });
            if (closed || signal.aborted) {
              void api(`/api/ai/sessions/${created.id}`, {method: 'DELETE'}).catch(() => {});
              return;
            }
            session = created;
            thinkingLabel.hidden = created.thinking_controllable !== true;
            if (thinkingLabel.hidden) thinking.checked = false;
          }
          if (contextDirty) {
            const next = await api(`/api/ai/sessions/${session.id}/context`, {
              method: 'POST',
              body: JSON.stringify({scope, text: sharedText(), version: session.version}),
              signal,
            });
            if (closed || signal.aborted) return;
            session = next;
            contextDirty = false;
          }
          if (session.configuration_id !== providerID) {
            const next = await api(`/api/ai/sessions/${session.id}/configuration`, {
              method: 'POST',
              body: JSON.stringify({configuration_id: providerID, version: session.version}),
              signal,
            });
            if (closed || signal.aborted) return;
            session = next;
          }
          const plan = await api(`/api/ai/sessions/${session.id}/plan`, {
            method: 'POST',
            body: JSON.stringify({
              prompt: query,
              version: session.version,
              thinking: useThinking,
            }),
            signal,
          });
          if (closed || signal.aborted) return;
          await startJob(plan, signal);
        },
        {scroll: true, canRetry: true},
      );
    },
    {signal: lifetime.signal},
  );
  prompt.addEventListener(
    'keydown',
    (event) => {
      if (!event.isComposing && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          prompt.setRangeText('\n', prompt.selectionStart, prompt.selectionEnd, 'end');
          prompt.dispatchEvent(new Event('input', {bubbles: true}));
        } else composer.requestSubmit();
      }
    },
    {signal: lifetime.signal},
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        if (document.querySelector('.modal:not(.hidden)')) return;
        event.preventDefault();
        event.stopPropagation();
        if (!busy || !savePending) void requestClose();
      }
    },
    {capture: true, signal: lifetime.signal},
  );
  document.defaultView.addEventListener('pagehide', () => close(), {signal: lifetime.signal});
  document.defaultView.addEventListener(
    'beforeunload',
    (event) => {
      if (!hasWork()) return;
      event.preventDefault();
      event.returnValue = '';
    },
    {signal: lifetime.signal},
  );
  render();
  if (!mobileTabs.mobile()) prompt.focus();
  return {
    close,
    confirmDiscard,
    hasWork,
    configurationID: () => session?.configuration_id || providers.value(),
    setOnline(value) {
      if (online !== value) {
        online = value;
        render({content: false});
        if (online) void applyRemote();
      }
    },
    refreshProviders: () => providers.refresh(),
    syncRevision(revision) {
      if (closed) return;
      const current = snapshot();
      // Acknowledging the same locked content changes its save revision, not
      // the text the model is editing. Keep the next-save fence current.
      if (
        current.noteId === original.noteId &&
        current.generation === original.generation &&
        current.value === original.value
      )
        original.revision = revision;
    },
    invalidate(message) {
      close();
      if (message) showToast(message, 'warning');
    },
    // The editor already shows the synced text; the review follows it.
    rebase() {
      if (closed) return;
      remotePending = true;
      void applyRemote();
    },
  };
}

// Working and completed attempts share the same monotonic duration formatter.
export function formatElapsed(milliseconds) {
  const tenths = Math.round(Math.max(0, milliseconds) / 100);
  if (tenths < 600) return `${tenths / 10}s`;
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remaining ? `${remaining}s` : '']
    .filter(Boolean)
    .join(' ');
}
