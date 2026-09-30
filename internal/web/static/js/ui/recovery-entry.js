(function (root) {
  'use strict';

  const oldKeyPattern = /^[A-Za-z0-9_-]{43}$/;

  function create({
    document,
    input,
    label,
    list,
    count,
    submit,
    confirmation = false,
    onError = () => {},
    onChange = () => {},
  }) {
    let words = [];
    let oldKey = '';
    let confirming = confirmation;
    let drag = null;
    const row = input.closest('.login-recovery-word-row');

    list.setAttribute('role', 'list');

    function render({scrollToEnd = false, focusIndex = null} = {}) {
      const scrollTop = list.scrollTop;
      list.replaceChildren();
      list.hidden = Boolean(oldKey);
      if (oldKey) {
        count.textContent = 'Older recovery key ready';
      } else {
        count.textContent = `${words.length}/24 words`;
        words.forEach((word, index) => {
          const chip = document.createElement('div');
          chip.className = 'login-recovery-chip';
          chip.dataset.index = String(index);
          chip.setAttribute('role', 'listitem');
          chip.setAttribute('tabindex', '0');
          chip.setAttribute(
            'aria-label',
            `Word ${index + 1}: ${word}. Drag or press Alt and an arrow key to reorder.`,
          );
          const text = document.createElement('span');
          text.textContent = `${index + 1}. ${word}`;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'login-recovery-chip-remove';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `Remove word ${index + 1}: ${word}`);
          remove.addEventListener('click', () => {
            words.splice(index, 1);
            render();
            input.focus();
          });
          chip.append(text, remove);
          list.append(chip);
        });
      }
      list.scrollTop = scrollToEnd ? list.scrollHeight : scrollTop;
      if (focusIndex !== null) list.children[focusIndex]?.focus();
      const ready = Boolean(oldKey || words.length === 24);
      if (row) row.hidden = words.length === 24;
      if (submit) submit.disabled = !ready;
      label.textContent = oldKey
        ? 'Recovery key entered'
        : words.length === 24
          ? 'All 24 words entered'
          : `Enter word ${words.length + 1} (${words.length + 1}/24)`;
      onChange(ready);
    }

    function add(raw) {
      const value = raw.trim();
      if (!value || words.length === 24) return;
      if (confirming && !/^[a-z]+$/i.test(value)) {
        onError('Enter one recovery word at a time.');
        return;
      }
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
      render({scrollToEnd: true});
      if (oldKey) submit?.focus();
      else if (words.length === 24) list.lastElementChild?.focus();
      else input.focus();
    }

    function moveWord(from, to) {
      if (from === to || from < 0 || to < 0 || from >= words.length || to >= words.length) return;
      words.splice(to, 0, words.splice(from, 1)[0]);
      render({focusIndex: to});
    }

    function animateReflow(before) {
      if (document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      for (const [chip, first] of before) {
        if (!chip.isConnected || !chip.animate) continue;
        const last = chip.getBoundingClientRect();
        const x = first.left - last.left;
        const y = first.top - last.top;
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        chip
          .getAnimations?.()
          .filter((animation) => animation.id === 'recovery-reflow')
          .forEach((animation) => animation.cancel());
        const animation = chip.animate(
          [{transform: `translate3d(${x}px,${y}px,0)`}, {transform: 'translate3d(0,0,0)'}],
          {duration: 180, easing: 'cubic-bezier(.16,1,.3,1)'},
        );
        animation.id = 'recovery-reflow';
      }
    }

    function armDrag() {
      if (!drag || drag.active) return;
      const rect = drag.chip.getBoundingClientRect();
      const placeholder = document.createElement('div');
      placeholder.className = 'login-recovery-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.style.width = `${rect.width}px`;
      placeholder.style.height = `${rect.height}px`;
      const ghost = drag.chip.cloneNode(true);
      ghost.classList.add('login-recovery-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('tabindex', '-1');
      ghost.querySelector('button')?.setAttribute('tabindex', '-1');
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.inert = true;
      drag.chip.replaceWith(placeholder);
      document.body.append(ghost);
      drag.placeholder = placeholder;
      drag.ghost = ghost;
      drag.active = true;
    }

    function clearDrag() {
      if (!drag) return;
      const pointerId = drag.pointerId;
      drag.ghost?.remove();
      drag.placeholder?.remove();
      drag = null;
      if (list.hasPointerCapture?.(pointerId)) list.releasePointerCapture(pointerId);
    }

    function stopDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        clearDrag();
        return;
      }
      const dropped = event.type === 'pointerup';
      const from = drag.from;
      const to = dropped ? [...list.children].indexOf(drag.placeholder) : from;
      if (dropped && to >= 0 && to !== from) words.splice(to, 0, words.splice(from, 1)[0]);
      clearDrag();
      if (dropped) render({focusIndex: to >= 0 ? to : from});
      else render();
    }

    list.addEventListener('pointerdown', (event) => {
      const chip = event.target.closest('.login-recovery-chip');
      if (!chip || event.target.closest('.login-recovery-chip-remove') || event.button !== 0)
        return;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        from: Number(chip.dataset.index),
        active: false,
        chip,
      };
      list.setPointerCapture?.(event.pointerId);
    });
    list.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6)
        return;
      armDrag();
      event.preventDefault();
      drag.ghost.style.transform = `translate3d(${event.clientX - drag.startX}px,${event.clientY - drag.startY}px,0)`;
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top + 24) list.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 24) list.scrollTop += 12;
      const target = document
        .elementFromPoint?.(event.clientX, event.clientY)
        ?.closest('.login-recovery-chip');
      if (!target || !list.contains(target)) return;
      const beforeTarget = Number(target.dataset.index) < drag.from;
      if (
        (beforeTarget && drag.placeholder.nextSibling === target) ||
        (!beforeTarget && target.nextSibling === drag.placeholder)
      )
        return;
      const before = new Map(
        [...list.querySelectorAll('.login-recovery-chip')].map((chip) => [
          chip,
          chip.getBoundingClientRect(),
        ]),
      );
      list.insertBefore(drag.placeholder, beforeTarget ? target : target.nextSibling);
      animateReflow(before);
    });
    list.addEventListener('pointerup', stopDrag);
    list.addEventListener('pointercancel', stopDrag);
    list.addEventListener('lostpointercapture', (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      clearDrag();
      render();
    });
    list.addEventListener('keydown', (event) => {
      if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
        return;
      const chip = event.target.closest('.login-recovery-chip');
      if (!chip || event.target !== chip) return;
      event.preventDefault();
      const from = Number(chip.dataset.index);
      moveWord(from, from + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1));
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        add(input.value);
      }
    });
    input.addEventListener('paste', (event) => {
      if (confirming) {
        event.preventDefault();
        onError('Enter each recovery word yourself to confirm your saved copy.');
        return;
      }
      const value = event.clipboardData?.getData('text') || '';
      if (!value) return;
      event.preventDefault();
      add(value);
    });
    render();

    return {
      addCurrent: () => add(input.value),
      setConfirmation: (value) => {
        confirming = value;
      },
      clear: () => {
        clearDrag();
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
