(function (root) {
  'use strict';

  function setVisibility(button, input, visible) {
    input.type = visible ? 'text' : 'password';
    const name = button.dataset.secretName || 'password';
    button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${name}`);
    button.setAttribute('aria-pressed', String(visible));
    button.querySelector('[data-password-icon="visible"]').hidden = !visible;
    button.querySelector('[data-password-icon="hidden"]').hidden = visible;
  }

  function bind(document) {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-password-toggle]');
      if (!button || button.disabled) return;

      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input || !['password', 'text'].includes(input.type)) return;

      const visible = input.type === 'password';
      setVisibility(button, input, visible);
    });

    document.addEventListener('reset', (event) => {
      for (const button of event.target.querySelectorAll('[data-password-toggle]')) {
        const input = document.getElementById(button.dataset.passwordToggle);
        if (input) setVisibility(button, input, false);
      }
    });
  }

  root.VylkLabeledInput = {bind};
})(typeof window !== 'undefined' ? window : globalThis);
