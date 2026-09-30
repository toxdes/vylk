import {afterEach, describe, expect, test, vi} from 'vitest';

await import('../internal/web/static/js/core/vault-session.js');

afterEach(() => vi.unstubAllGlobals());

describe('vault secure-context policy', () => {
  test.each(['preparing', 'encrypted', 'cleaning'])(
    'requires a secure context in %s mode',
    async (mode) => {
      vi.stubGlobal('isSecureContext', false);
      const session = globalThis.VylkVaultSession.create({
        apiClient: {request: async () => ({mode})},
        offlineStore: {cacheVaultBootstrap: async () => {}},
      });
      await session.bootstrap();
      expect(session.requiresSecureContext()).toBe(true);
      vi.stubGlobal('isSecureContext', true);
      expect(session.requiresSecureContext()).toBe(false);
    },
  );

  test('allows legacy sign-in without a secure context', async () => {
    vi.stubGlobal('isSecureContext', false);
    const session = globalThis.VylkVaultSession.create({
      apiClient: {request: async () => ({mode: 'legacy'})},
      offlineStore: {},
    });
    await session.bootstrap();
    expect(session.requiresSecureContext()).toBe(false);
  });
});
