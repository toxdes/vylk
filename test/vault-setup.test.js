import {describe, expect, test} from 'vitest';

await import('../internal/web/static/js/ui/vault-setup.js');

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
