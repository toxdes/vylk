import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach, describe, expect, test, vi} from 'vitest';

await import('../internal/web/static/js/ui/vault-setup.js');

let dom;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.unstubAllGlobals();
});

test.each(['error', 'load'])(
  'strength checks retry after a failed estimator script %s event',
  async (failureEvent) => {
    vi.resetModules();
    await import('../internal/web/static/js/ui/vault-setup.js');
    const html = readFileSync(
      new URL('../internal/web/static/index.html', import.meta.url),
      'utf8',
    );
    dom = new JSDOM(html, {url: 'https://vylk.test/'});
    const {document} = dom.window;
    vi.stubGlobal('document', document);
    vi.stubGlobal('zxcvbn', undefined);
    vi.stubGlobal('VylkRecoveryEntry', {create: () => ({})});
    globalThis.VylkVaultSetup.bind({
      document,
      vaultSession: {config: () => ({})},
      showEncryption: async () => {},
      openModal: () => {},
      closeModal: () => {},
      onComplete: () => {},
    });
    const field = document.querySelector('#vault-master');
    const feedback = document.querySelector('#vault-strength');
    field.value = 'a long test passphrase';
    field.dispatchEvent(new dom.window.Event('input'));
    field.dispatchEvent(new dom.window.Event('input'));
    const failedScript = document.querySelector('script[src="/vendor/zxcvbn.js"]');
    expect(failedScript).not.toBeNull();
    expect(document.querySelectorAll('script[src="/vendor/zxcvbn.js"]')).toHaveLength(1);
    failedScript.dispatchEvent(new dom.window.Event(failureEvent));
    await vi.waitFor(() =>
      expect(feedback.textContent).toBe('Passphrase strength could not be checked.'),
    );

    field.dispatchEvent(new dom.window.Event('input'));
    await vi.waitFor(() => {
      const retry = document.querySelector('script[src="/vendor/zxcvbn.js"]');
      expect(retry).not.toBeNull();
      expect(retry).not.toBe(failedScript);
    });
    expect(failedScript.isConnected).toBe(false);
    vi.stubGlobal(
      'zxcvbn',
      vi.fn(() => ({score: 4})),
    );
    const retry = document.querySelector('script[src="/vendor/zxcvbn.js"]');
    retry.dispatchEvent(new dom.window.Event('load'));
    await vi.waitFor(() => expect(feedback.textContent).toBe('Strong passphrase'));
    expect(retry.isConnected).toBe(false);
    expect(retry.onload).toBeNull();
    expect(retry.onerror).toBeNull();
  },
);

describe('vault setup errors', () => {
  test('downloads a numbered recovery key without a paste-ready phrase', () => {
    const words = Array.from({length: 24}, (_, index) => `word${index + 1}`);
    const content = globalThis.VylkVaultSetup.formatRecoveryKey(words.join(' '));

    expect(content).toContain('1. word1\n2. word2');
    expect(content).toContain('24. word24\n');
    expect(content).not.toContain(words.join(' '));
  });

  test('replaces internal base64 errors with a recovery step', () => {
    const message = globalThis.VylkVaultSetup.formatError(
      new Error('invalid base64url value'),
      true,
    );

    expect(message).toContain('Close this window and try again');
    expect(message).not.toContain('base64url');
  });

  test('explains whether the reset completed before device setup failed', () => {
    const completed = new Error('unexpected local decoding issue');
    completed.vaultResetState = 'created';
    expect(globalThis.VylkVaultSetup.formatError(completed, true)).toContain(
      'Your new vault was created',
    );

    const unknown = new Error('fetch failed');
    unknown.vaultResetState = 'unknown';
    expect(globalThis.VylkVaultSetup.formatError(unknown, true)).toContain(
      'could not confirm the result',
    );
  });
});
