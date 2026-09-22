import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./conflict-resolver.js');

function setup(conflict) {
  const dom = new JSDOM(`
    <div id="conflict-modal" class="hidden"><button class="modal-backdrop"></button></div>
    <h2 id="conflict-title"></h2><p class="conflict-intro"></p>
    <div class="conflict-fields"></div><div class="conflict-metadata-compare"></div>
    <div class="conflict-compare"></div><div class="conflict-result"></div>
    <div class="conflict-base"><pre id="conflict-base-content"></pre></div>
    <div id="conflict-deleted-details" class="conflict-base hidden"><pre id="conflict-deleted-content"></pre></div>
    <article class="conflict-version-local"><pre id="conflict-local-metadata"></pre><pre id="conflict-local-diff"></pre></article>
    <article class="conflict-version-remote"><pre id="conflict-remote-metadata"></pre><pre id="conflict-remote-diff"></pre></article>
    <button id="conflict-use-local"></button><button id="conflict-use-remote"></button>
    <p id="conflict-selection-status"></p>
    <input id="conflict-note-title"><input id="conflict-note-tags"><textarea id="conflict-note-content"></textarea>
    <button id="conflict-save"></button><button id="conflict-copy"></button>
    <button id="conflict-later"></button><button id="conflict-close"></button>
  `);
  const calls = [];
  const document = dom.window.document;
  const resolver = globalThis.VylkConflictResolver.create({
    closeModal: (modal) => modal.classList.add('hidden'),
    document,
    getConflict: async () => conflict,
    onAcceptDeletion: async (id) => calls.push(['delete', id]),
    onKeepCopy: async (id) => calls.push(['copy', id]),
    onKeepDeletedCopy: async (id) => calls.push(['deleted-copy', id]),
    onSaveResolution: async (id, value) => calls.push(['save', id, value]),
    openModal: (modal) => modal.classList.remove('hidden'),
  });
  return {calls, document, resolver};
}

const editConflict = {
  note_id: 'note-a',
  base: {content: 'same\nbase'},
  local: {title: 'Local', tags: 'mine', content: 'same\nlocal'},
  remote: {title: 'Remote', tags: 'theirs', content: 'same\nremote'},
};

describe('conflict resolver view', () => {
  test('renders both edits and submits the editable resolution', async () => {
    const context = setup(editConflict);
    context.resolver.showEdit(editConflict);

    expect(context.document.querySelector('#conflict-modal').classList.contains('hidden')).toBe(
      false,
    );
    expect(context.document.querySelector('#conflict-local-diff mark').textContent).toBe('local\n');
    context.document.querySelector('#conflict-use-remote').click();
    await Promise.resolve();
    expect(context.document.querySelector('#conflict-note-title').value).toBe('Remote');

    context.document.querySelector('#conflict-note-title').value = 'Resolved';
    context.document
      .querySelector('#conflict-note-title')
      .dispatchEvent(new context.document.defaultView.Event('input'));
    context.document.querySelector('#conflict-save').click();
    await Promise.resolve();

    expect(context.calls).toEqual([
      ['save', 'note-a', {title: 'Resolved', tags: 'theirs', content: 'same\nremote'}],
    ]);
  });

  test('presents remote deletion actions without edit controls', async () => {
    const conflict = {
      kind: 'remote-deleted',
      note_id: 'note-a',
      local: {title: 'Local', tags: '', content: 'body'},
    };
    const context = setup(conflict);
    await context.resolver.showFor('note-a');

    expect(context.document.querySelector('#conflict-title').textContent).toBe(
      'Note deleted on another device',
    );
    expect(context.document.querySelector('#conflict-deleted-content').textContent).toContain(
      'body',
    );
    context.document.querySelector('#conflict-copy').click();
    context.document.querySelector('#conflict-save').click();
    await Promise.resolve();
    expect(context.calls).toEqual([
      ['deleted-copy', 'note-a'],
      ['delete', 'note-a'],
    ]);
  });
});
