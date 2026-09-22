import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./modal.js');

function setup() {
  const dom = new JSDOM(`
    <button id="opener">Open</button>
    <div id="modal" class="hidden" aria-hidden="true">
      <div role="dialog" tabindex="-1">
        <button id="first" class="modal-close">Close</button>
        <button id="last">Continue</button>
      </div>
    </div>
  `);
  dom.window.matchMedia = () => ({matches: true});
  const escaped = [];
  const controller = globalThis.VylkModal.create({
    document: dom.window.document,
    onEscape: (modal) => escaped.push(modal.id),
    window: dom.window,
  });
  return {controller, document: dom.window.document, escaped, window: dom.window};
}

describe('modal controller', () => {
  test('moves focus into the modal and restores its opener', () => {
    const context = setup();
    const opener = context.document.querySelector('#opener');
    const modal = context.document.querySelector('#modal');
    opener.focus();

    context.controller.open(modal);
    expect(context.document.activeElement.id).toBe('first');
    expect(modal.getAttribute('aria-hidden')).toBe('false');

    context.controller.close(modal);
    expect(context.document.activeElement).toBe(opener);
    expect(modal.getAttribute('aria-hidden')).toBe('true');
  });

  test('traps Tab navigation and delegates Escape handling', () => {
    const context = setup();
    const modal = context.document.querySelector('#modal');
    context.controller.open(modal);
    context.document.querySelector('#last').focus();
    context.document
      .querySelector('#last')
      .dispatchEvent(
        new context.window.KeyboardEvent('keydown', {bubbles: true, cancelable: true, key: 'Tab'}),
      );
    expect(context.document.activeElement.id).toBe('first');

    modal.dispatchEvent(
      new context.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    );
    expect(context.escaped).toEqual(['modal']);
  });
});
