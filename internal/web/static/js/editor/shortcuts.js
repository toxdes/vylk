(function () {
  'use strict';

  const PRIMARY = 'Mod';
  const DEFAULT_PREFIX = {key: '/', modifiers: [PRIMARY]};
  const reservedDirectKeys = new Set([
    'd',
    'f',
    'g',
    'h',
    'j',
    'l',
    'n',
    'o',
    'p',
    'q',
    'r',
    't',
    'u',
    'w',
  ]);
  const reservedShiftKeys = new Set(['c', 'i', 'j', 'n', 'o', 'p', 'r', 's', 't', 'w']);

  function platformIsMac() {
    const value = navigator.userAgentData?.platform || navigator.platform || '';
    return /mac|iphone|ipad|ipod/i.test(value);
  }

  function normalizeKey(value) {
    if (typeof value !== 'string') return '';
    const key = value.trim();
    if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
    if (key === '/' || key === '?') return '/';
    if (key === ';' || key === ':') return ';';
    return '';
  }

  function normalizeModifiers(value) {
    const modifiers = Array.isArray(value) ? value : [];
    const normalized = [
      ...new Set(modifiers.filter((modifier) => modifier === 'Mod' || modifier === 'Shift')),
    ];
    return ['Mod', 'Shift'].filter((modifier) => normalized.includes(modifier));
  }

  function normalizeStep(value, {allowBare = false} = {}) {
    const key = normalizeKey(value?.key);
    const modifiers = normalizeModifiers(value?.modifiers);
    if (!key || (!allowBare && !modifiers.includes(PRIMARY))) return null;
    return {key, modifiers};
  }

  function normalizeBinding(value) {
    const steps = Array.isArray(value?.steps)
      ? value.steps.map((step, index) => normalizeStep(step, {allowBare: index === 1}))
      : [];
    if (!steps.length || steps.some((step) => !step) || steps.length > 2) return null;
    if (steps.length === 2 && !steps[0].modifiers.includes(PRIMARY)) return null;
    if (steps.length === 2 && steps[1].modifiers.length !== 0) return null;
    return {steps};
  }

  function sameStep(left, right) {
    const a = normalizeStep(left, {allowBare: true});
    const b = normalizeStep(right, {allowBare: true});
    return Boolean(a && b && a.key === b.key && a.modifiers.join(',') === b.modifiers.join(','));
  }

  function sameBinding(left, right) {
    const a = normalizeBinding(left);
    const b = normalizeBinding(right);
    return Boolean(
      a &&
      b &&
      a.steps.length === b.steps.length &&
      a.steps.every((step, index) => sameStep(step, b.steps[index])),
    );
  }

  function eventMatchesStep(event, value) {
    const step = normalizeStep(value, {allowBare: true});
    if (!step || event.isComposing || event.altKey) return false;
    const mac = platformIsMac();
    const primaryPressed = mac ? event.metaKey : event.ctrlKey;
    const otherPrimaryPressed = mac ? event.ctrlKey : event.metaKey;
    return (
      Boolean(primaryPressed) === step.modifiers.includes(PRIMARY) &&
      !otherPrimaryPressed &&
      Boolean(event.shiftKey) === step.modifiers.includes('Shift') &&
      normalizeKey(event.key) === step.key
    );
  }

  function capturedStep(event) {
    if (event.isComposing || event.altKey) return null;
    const mac = platformIsMac();
    const primaryPressed = mac ? event.metaKey : event.ctrlKey;
    const otherPrimaryPressed = mac ? event.ctrlKey : event.metaKey;
    const key = normalizeKey(event.key);
    if (!primaryPressed || otherPrimaryPressed || !key) return null;
    return {key, modifiers: event.shiftKey ? ['Mod', 'Shift'] : ['Mod']};
  }

  function capturedSequenceStep(event) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return null;
    const key = normalizeKey(event.key);
    return key ? {key, modifiers: []} : null;
  }

  function bindingFromEvent(event) {
    const step = capturedStep(event);
    return step ? {steps: [step]} : null;
  }

  function isLeader(value, prefix = DEFAULT_PREFIX) {
    const binding = normalizeBinding(value);
    return sameStep(binding ? binding.steps[0] : value, prefix);
  }

  function isReservedBinding(value) {
    const binding = normalizeBinding(value);
    if (!binding || binding.steps.length !== 1) return !binding;
    const step = binding.steps[0];
    return step.modifiers.includes('Shift')
      ? reservedShiftKeys.has(step.key)
      : reservedDirectKeys.has(step.key);
  }

  function isAllowedPrefix(value) {
    const binding = normalizeBinding(value);
    return Boolean(
      binding && binding.steps.length === 1 && binding.steps[0].modifiers.includes(PRIMARY),
    );
  }

  function displayStep(value) {
    const step = normalizeStep(value);
    if (!step) return '';
    const mac = platformIsMac();
    const modifiers = mac
      ? `${step.modifiers.includes('Mod') ? '⌘' : ''}${step.modifiers.includes('Shift') ? '⇧' : ''}`
      : `${step.modifiers.includes('Mod') ? 'Ctrl + ' : ''}${step.modifiers.includes('Shift') ? 'Shift + ' : ''}`;
    return `${modifiers}${step.key.toUpperCase()}`;
  }

  function displayBinding(value) {
    const binding = normalizeBinding(value);
    return binding ? binding.steps.map(displayStep).join(', ') : '';
  }

  function ariaBinding(value) {
    const binding = normalizeBinding(value);
    if (!binding) return '';
    const mac = platformIsMac();
    return binding.steps
      .map((step) =>
        [
          ...(step.modifiers.includes('Mod') ? [mac ? 'Meta' : 'Control'] : []),
          ...(step.modifiers.includes('Shift') ? ['Shift'] : []),
          step.key.toUpperCase(),
        ].join('+'),
      )
      .join(' ');
  }

  window.VylkShortcuts = {
    DEFAULT_PREFIX,
    normalizeBinding,
    sameBinding,
    eventMatchesStep,
    capturedStep,
    capturedSequenceStep,
    bindingFromEvent,
    isLeader,
    isReservedBinding,
    isAllowedPrefix,
    displayBinding,
    ariaBinding,
  };
})();
