import {describe, expect, test} from 'bun:test';

await import('./sync-batch.js');

describe('sync batch protocol', () => {
  test('serializes only fields accepted by each operation type', () => {
    expect(
      globalThis.VylkSyncBatch.serialize({
        client_sequence: 3,
        op_id: 'op-3',
        type: 'note.save',
        note_id: 'note-1',
        base_revision: 2,
        note: {title: 'Title', tags: 'one,two', content: 'Body', pinned: 1, localOnly: true},
        attempted_at: 'ignored',
      }),
    ).toEqual({
      client_sequence: 3,
      op_id: 'op-3',
      type: 'note.save',
      note_id: 'note-1',
      base_revision: 2,
      title: 'Title',
      tags: 'one,two',
      content: 'Body',
      pinned: true,
    });
  });

  test('measures encoded UTF-8 bytes rather than JavaScript characters', () => {
    expect(globalThis.VylkSyncBatch.encodedByteLength('🔥')).toBe(6);
  });
});
