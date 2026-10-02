import {JSDOM} from 'jsdom';
import {describe, expect, test} from 'vitest';

await import('../internal/web/static/js/ui/recovery-entry.js');

describe('recovery word confirmation', () => {
  test('accepts words one at a time and never accepts a pasted key', () => {
    const {window} = new JSDOM(`
      <div class="login-recovery-word-row"><input id="word"></div><label id="label"></label><div id="list"></div><p id="count"></p>
    `);
    const {document} = window;
    const input = document.querySelector('#word');
    let error = '';
    const entry = globalThis.VylkRecoveryEntry.create({
      document,
      input,
      label: document.querySelector('#label'),
      list: document.querySelector('#list'),
      count: document.querySelector('#count'),
      confirmation: true,
      onError: (message) => {
        error = message;
      },
    });
    expect(document.querySelector('#label').textContent).toBe('Enter word 1 (1/24)');

    const paste = new window.Event('paste', {cancelable: true});
    Object.defineProperty(paste, 'clipboardData', {value: {getData: () => 'abandon ability'}});
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(entry.value()).toBe('');
    expect(error).toContain('Enter each recovery word yourself');

    input.value = 'abandon ability';
    entry.addCurrent();
    expect(entry.value()).toBe('');
    input.value = 'abandon';
    entry.addCurrent();
    expect(entry.value()).toBe('abandon');
    expect(document.querySelector('#label').textContent).toBe('Enter word 2 (2/24)');
    expect(document.querySelector('#count').textContent).toBe('1/24 words');
    const backspace = new window.KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(backspace);
    expect(backspace.defaultPrevented).toBe(false);
    expect(entry.value()).toBe('abandon');
    entry.clear();
    expect(entry.value()).toBe('');
    entry.setConfirmation(false);
    input.value = 'a'.repeat(43);
    entry.addCurrent();
    expect(entry.ready()).toBe(true);
    expect(input.closest('.login-recovery-word-row').hidden).toBe(false);
    expect(document.querySelector('#label').textContent).toBe('Recovery key entered');
    window.close();
  });

  test('reorders entered words by keyboard or pointer without removing them', () => {
    const {window} = new JSDOM(`
      <div class="login-recovery-word-row"><input id="word"></div><label id="label"></label><div id="list"></div><p id="count"></p>
    `);
    const {document} = window;
    const input = document.querySelector('#word');
    const list = document.querySelector('#list');
    const entry = globalThis.VylkRecoveryEntry.create({
      document,
      input,
      label: document.querySelector('#label'),
      list,
      count: document.querySelector('#count'),
    });
    for (const word of ['alpha', 'bravo', 'charlie']) {
      input.value = word;
      entry.addCurrent();
    }

    list.children[0].dispatchEvent(
      new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        altKey: true,
        key: 'ArrowRight',
      }),
    );
    expect(entry.value()).toBe('bravo alpha charlie');
    expect(document.activeElement).toBe(list.children[1]);

    const dragged = list.children[1];
    document.elementFromPoint = () => list.children[0];
    for (const [type, x] of [
      ['pointerdown', 0],
      ['pointermove', 20],
      ['pointerup', 20],
    ]) {
      const event = new window.MouseEvent(type, {bubbles: true, button: 0, clientX: x});
      Object.defineProperty(event, 'pointerId', {value: 1});
      Object.defineProperty(event, 'pointerType', {value: 'touch'});
      (type === 'pointerdown' ? dragged : list).dispatchEvent(event);
      if (type === 'pointermove') {
        expect(list.querySelector('.login-recovery-placeholder')).not.toBeNull();
        expect(document.querySelector('.login-recovery-ghost')).not.toBeNull();
      }
    }
    expect(entry.value()).toBe('alpha bravo charlie');
    expect(list.children).toHaveLength(3);
    expect(document.querySelector('.login-recovery-ghost')).toBeNull();

    for (let index = 3; index < 24; index++) {
      input.value = 'alpha';
      entry.addCurrent();
    }
    expect(input.closest('.login-recovery-word-row').hidden).toBe(true);
    expect(document.activeElement).toBe(list.lastElementChild);
    list.lastElementChild.querySelector('.login-recovery-chip-remove').click();
    expect(input.closest('.login-recovery-word-row').hidden).toBe(false);
    expect(entry.ready()).toBe(false);
    window.close();
  });
});
