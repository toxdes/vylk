(function (root) {
  'use strict';

  const focusableSelector =
    'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';

  function create({document, onEscape, window}) {
    const stateByModal = new WeakMap();

    function stateFor(modal) {
      let state = stateByModal.get(modal);
      if (!state) {
        state = {closeTimer: null, opener: null};
        stateByModal.set(modal, state);
        modal.addEventListener('keydown', handleKeydown);
      }
      return state;
    }

    function focusableElements(modal) {
      return [...modal.querySelectorAll(focusableSelector)].filter((element) => {
        if (element.disabled || element.hidden || element.closest('.hidden, [hidden]'))
          return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
    }

    function handleKeydown(event) {
      const modal = event.currentTarget;
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape(modal);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(modal);
      if (!focusable.length) {
        event.preventDefault();
        modal.querySelector('[role="dialog"]')?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function open(modal) {
      const state = stateFor(modal);
      if (state.closeTimer) {
        window.clearTimeout(state.closeTimer);
        state.closeTimer = null;
      }
      state.opener =
        document.activeElement && typeof document.activeElement.focus === 'function'
          ? document.activeElement
          : null;
      modal.classList.remove('hidden', 'is-closing');
      modal.setAttribute('aria-hidden', 'false');
      const initialFocus =
        modal.querySelector('[autofocus]') ||
        modal.querySelector('.modal-close') ||
        focusableElements(modal)[0] ||
        modal.querySelector('[role="dialog"]');
      initialFocus?.focus();
    }

    function close(modal) {
      if (modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;
      const state = stateFor(modal);
      modal.classList.add('is-closing');
      const opener = state.opener;
      const finish = () => {
        modal.classList.remove('is-closing');
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        state.opener = null;
        if (opener?.isConnected) opener.focus();
      };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish();
      } else {
        state.closeTimer = window.setTimeout(() => {
          state.closeTimer = null;
          finish();
        }, 190);
      }
    }

    return {close, open};
  }

  root.VylkModal = {create};
})(typeof window !== 'undefined' ? window : globalThis);
