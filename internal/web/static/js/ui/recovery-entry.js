(function (root) {
  'use strict';

  const oldKeyPattern = /^[A-Za-z0-9_-]{43}$/;

  function create({document, input, label, list, count, submit, onError = () => {}}) {
    let words = [];
    let oldKey = '';

    function render() {
      list.replaceChildren();
      if (oldKey) {
        count.textContent = 'Older recovery key ready';
      } else {
        count.textContent = `${words.length}/24 words`;
        words.forEach((word, index) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'login-recovery-chip';
          chip.textContent = `${index + 1}. ${word} ×`;
          chip.setAttribute('aria-label', `Remove word ${index + 1}: ${word}`);
          chip.addEventListener('click', () => {
            words.splice(index, 1);
            render();
            input.focus();
          });
          list.append(chip);
        });
      }
      submit.disabled = !oldKey && words.length !== 24;
      label.textContent =
        words.length === 24 || oldKey ? 'All words entered' : `Word ${words.length + 1}`;
    }

    function add(raw) {
      const value = raw.trim();
      if (!value) return;
      if (oldKeyPattern.test(value)) {
        words = [];
        oldKey = value;
      } else {
        const next = value.toLowerCase().split(/\s+/);
        if (next.some((word) => !/^[a-z]+$/.test(word))) {
          onError('Recovery words contain letters only.');
          return;
        }
        if (words.length + next.length > 24) {
          onError('A recovery key has 24 words. Remove extra words and try again.');
          return;
        }
        oldKey = '';
        words.push(...next);
      }
      onError('');
      input.value = '';
      render();
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        add(input.value);
      } else if (event.key === 'Backspace' && !input.value && words.length) {
        words.pop();
        render();
      }
    });
    input.addEventListener('paste', (event) => {
      const value = event.clipboardData?.getData('text') || '';
      if (!value) return;
      event.preventDefault();
      add(value);
    });
    render();

    return {
      addCurrent: () => add(input.value),
      clear: () => {
        words = [];
        oldKey = '';
        input.value = '';
        onError('');
        render();
      },
      ready: () => Boolean(oldKey || words.length === 24),
      value: () => oldKey || words.join(' '),
    };
  }

  root.VylkRecoveryEntry = {create};
})(typeof window !== 'undefined' ? window : globalThis);
