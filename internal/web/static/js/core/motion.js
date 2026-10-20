(function (root) {
  'use strict';

  function reduced(document, browser = root) {
    const preference = document.documentElement.dataset.reduceMotion;
    if (preference === 'always') return true;
    if (preference === 'never') return false;
    return Boolean(browser.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  function createPopups(document, browser) {
    const exits = new WeakMap();

    function show(element) {
      exits.get(element)?.();
      element.classList.remove('hidden');
    }

    function hide(element) {
      if (element.classList.contains('hidden')) return;
      element.classList.add('hidden');
      if (reduced(document, browser)) return;
      element.classList.add('popup-leaving');
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
      const finish = () => {
        cancelWait();
        element.classList.remove('popup-leaving');
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
        exits.delete(element);
      };
      const cancelWait = afterExit(element, browser, finish);
      exits.set(element, finish);
    }

    return {hide, show};
  }

  function afterExit(element, browser, finish) {
    // Read the CSS effects once; no per-frame geometry reads or timer/CSS coupling.
    // Ignore perpetual activity indicators nested inside an otherwise closing dialog.
    const animations = element.getAnimations?.({subtree: true}).filter((animation) => {
      return Number.isFinite(animation.effect?.getComputedTiming().endTime);
    });
    const remaining = animations?.map((animation) => {
      return Math.max(
        0,
        animation.effect.getComputedTiming().endTime - (animation.currentTime || 0),
      );
    });
    let active = true;
    const cancel = () => {
      active = false;
      finish = null;
      browser.clearTimeout(timer);
    };
    const complete = () => {
      if (!active) return;
      const onFinish = finish;
      cancel();
      onFinish();
    };
    // Events/promises can stall in background tabs. Bound retention independently
    // of frame delivery, and support browsers without the Web Animations API.
    const timeout = remaining ? Math.min(1000, Math.max(0, ...remaining) + 50) : 190;
    const timer = browser.setTimeout(complete, timeout);
    if (animations) {
      Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(complete);
    }
    return cancel;
  }

  root.VylkMotion = {afterExit, createPopups, reduced};
})(typeof window !== 'undefined' ? window : globalThis);
