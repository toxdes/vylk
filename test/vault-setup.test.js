import {describe, expect, test} from 'vitest';

await import('../internal/web/static/js/ui/vault-setup.js');

describe('vault setup errors', () => {
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
