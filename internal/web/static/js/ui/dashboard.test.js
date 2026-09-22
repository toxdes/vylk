import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./dashboard.js');

function createDashboard(overrides = {}) {
  const dom = new JSDOM('<div id="tag-bar"></div><ul id="note-list"></ul>');
  const opened = [];
  const pinned = [];
  const dashboard = globalThis.VylkDashboard.create({
    document: dom.window.document,
    emptyState: () => 'ready',
    escapeHTML: (value) => value,
    formatDate: (value) => `date:${value}`,
    onOpen: (id) => opened.push(id),
    onPin: (id) => pinned.push(id),
    ...overrides,
  });
  return {dashboard, document: dom.window.document, opened, pinned};
}

describe('dashboard view', () => {
  test('reconciles rows and filters notes by tag', () => {
    const view = createDashboard();
    const notes = [
      {id: 'a', title: 'Alpha', tags: 'work, shared', updated_at: 'one', pinned: true},
      {id: 'b', title: 'Beta', tags: 'home', updated_at: 'two'},
    ];
    view.dashboard.render(notes, new Set(['b']));

    expect(view.document.querySelectorAll('.note-item-row')).toHaveLength(2);
    expect(view.document.querySelector('[data-note-id="b"] .note-conflict').textContent).toBe(
      'Conflict',
    );

    view.document.querySelector('[data-tag="work"]').click();
    expect(
      [...view.document.querySelectorAll('.note-title')].map((node) => node.textContent),
    ).toEqual(['Alpha']);
  });

  test('delegates note and pin actions', () => {
    const view = createDashboard();
    view.dashboard.render([{id: 'a', title: 'Alpha'}], new Set());

    view.document.querySelector('.note-item').click();
    view.document.querySelector('.note-pin').click();

    expect(view.opened).toEqual(['a']);
    expect(view.pinned).toEqual(['a']);
  });

  test('renders the lifecycle-specific empty state', () => {
    const view = createDashboard({emptyState: () => 'offline-empty'});
    view.dashboard.render([], new Set());
    expect(view.document.querySelector('.note-empty').textContent).toBe(
      'No notes are available on this device yet.',
    );
  });
});
