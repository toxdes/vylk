import {beforeEach, describe, expect, test} from 'vitest';
import {JSDOM} from 'jsdom';

await import('../internal/web/static/js/ui/labeled-input.js');

describe('password label input', () => {
  let window;
  let input;
  let button;

  beforeEach(() => {
    window = new JSDOM(`
      <div class="label-input">
        <input id="secret" type="password" placeholder=" " />
        <label for="secret">Password</label>
        <button type="button" data-password-toggle="secret" aria-label="Show password" aria-pressed="false">
          <svg data-password-icon="hidden"></svg>
          <svg data-password-icon="visible" hidden></svg>
        </button>
      </div>
    `).window;
    input = window.document.querySelector('#secret');
    button = window.document.querySelector('[data-password-toggle]');
    globalThis.VylkLabeledInput.bind(window.document);
  });

  test('shows and hides the password without changing its value', () => {
    input.value = 'private value';
    button.click();

    expect(input.type).toBe('text');
    expect(input.value).toBe('private value');
    expect(button.getAttribute('aria-label')).toBe('Hide password');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('[data-password-icon="visible"]').hidden).toBe(false);

    button.click();

    expect(input.type).toBe('password');
    expect(button.getAttribute('aria-label')).toBe('Show password');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.querySelector('[data-password-icon="hidden"]').hidden).toBe(false);
  });

  test('ignores toggles without an associated password input', () => {
    button.dataset.passwordToggle = 'missing';
    button.click();

    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  test('uses the field name for the visibility control', () => {
    button.dataset.secretName = 'passphrase';
    button.click();
    expect(button.getAttribute('aria-label')).toBe('Hide passphrase');
    button.click();
    expect(button.getAttribute('aria-label')).toBe('Show passphrase');
  });

  test('returns password fields to hidden after their form resets', () => {
    const form = window.document.createElement('form');
    const secondInput = input.cloneNode();
    const secondButton = button.cloneNode(true);
    secondInput.id = 'second-secret';
    secondButton.dataset.passwordToggle = secondInput.id;
    secondButton.setAttribute('aria-label', 'Show password');
    form.append(secondInput, secondButton);
    window.document.body.append(form);
    secondButton.click();

    form.reset();

    expect(secondInput.type).toBe('password');
    expect(secondButton.getAttribute('aria-pressed')).toBe('false');
  });
});
