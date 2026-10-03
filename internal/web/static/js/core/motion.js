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
        browser.clearTimeout(timer);
        element.removeEventListener('animationend', onEnd);
        element.classList.remove('popup-leaving');
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
        exits.delete(element);
      };
      const onEnd = (event) => {
        if (event.target === element) finish();
      };
      const timer = browser.setTimeout(finish, 190);
      element.addEventListener('animationend', onEnd);
      exits.set(element, finish);
    }

    return {hide, show};
  }

  root.VylkMotion = {createPopups, reduced};
})(typeof window !== 'undefined' ? window : globalThis);
