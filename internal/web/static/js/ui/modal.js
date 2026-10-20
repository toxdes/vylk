(function (root) {
  'use strict';

  const focusableSelector =
    'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';

  function create({document, onEscape, window}) {
    const stateByModal = new WeakMap();
    const openModals = [];
    const motionProperties = [
      '--overlay-start-opacity',
      '--overlay-start-transform',
      '--overlay-backdrop-start-opacity',
    ];

    function clearMotionStart(modal) {
      for (const property of motionProperties) modal.style.removeProperty(property);
    }

    function captureMotionStart(modal) {
      const body = modal.querySelector('.modal-body');
      const backdrop = modal.querySelector('.modal-backdrop');
      // Sample once before changing the animation; reversing an unfinished
      // transition must start from the painted state, not its fixed endpoint.
      const bodyStyle = body && window.getComputedStyle(body);
      const backdropStyle = backdrop && window.getComputedStyle(backdrop);
      const values = [bodyStyle?.opacity, bodyStyle?.transform, backdropStyle?.opacity];
      for (let index = 0; index < motionProperties.length; index++) {
        if (values[index]) modal.style.setProperty(motionProperties[index], values[index]);
        else modal.style.removeProperty(motionProperties[index]);
      }
    }

    function syncActiveModal() {
      const active = openModals.at(-1);
      for (const modal of openModals) {
        const isActive = modal === active;
        modal.toggleAttribute('inert', !isActive);
        modal.setAttribute('aria-hidden', String(!isActive));
      }
    }

    function stateFor(modal) {
      let state = stateByModal.get(modal);
      if (!state) {
        state = {cancelClose: null, opener: null};
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
      if (modal.classList.contains('is-closing') && !root.VylkMotion.reduced(document, window))
        captureMotionStart(modal);
      else if (modal.classList.contains('hidden')) clearMotionStart(modal);
      state.cancelClose?.();
      state.cancelClose = null;
      const existing = openModals.indexOf(modal);
      if (existing === -1) {
        state.opener =
          document.activeElement && typeof document.activeElement.focus === 'function'
            ? document.activeElement
            : null;
      }
      if (existing !== -1) openModals.splice(existing, 1);
      openModals.push(modal);
      modal.classList.remove('hidden', 'is-closing');
      syncActiveModal();
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
      const reduced = root.VylkMotion.reduced(document, window);
      if (!reduced) captureMotionStart(modal);
      modal.classList.add('is-closing');
      const opener = state.opener;
      const finish = () => {
        state.cancelClose = null;
        modal.classList.remove('is-closing');
        modal.classList.add('hidden');
        clearMotionStart(modal);
        modal.removeAttribute('inert');
        modal.setAttribute('aria-hidden', 'true');
        const index = openModals.indexOf(modal);
        if (index !== -1) openModals.splice(index, 1);
        syncActiveModal();
        state.opener = null;
        if (opener?.isConnected && (!openModals.length || openModals.at(-1).contains(opener)))
          opener.focus();
      };
      if (reduced) {
        finish();
      } else {
        state.cancelClose = root.VylkMotion.afterExit(modal, window, finish);
      }
    }

    return {close, open};
  }

  root.VylkModal = {create};
})(typeof window !== 'undefined' ? window : globalThis);
