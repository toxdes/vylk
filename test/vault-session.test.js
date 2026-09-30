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

describe('remembered vault unlock', () => {
  function setup({
    saved = {vaultID: 'vault', epoch: 2, key: {}},
    marker = {value: 1, vaultID: 'vault', epoch: 2},
    failure,
    mode = 'encrypted',
  } = {}) {
    const offlineStore = {
      cacheVaultBootstrap: vi.fn(),
      rememberedVaultRoot: vi.fn(async () => saved),
      vaultLocalMetadata: vi.fn(async () => marker),
      forgetRememberedVaultRoot: vi.fn(),
      unlockVaultLocal: vi.fn(),
    };
    const apiClient = {
      request: vi.fn(async (path) => {
        if (path === '/api/vault/bootstrap') return {mode, vault_id: 'vault', epoch: 2};
        if (failure) throw failure;
        return {ok: true, vault_mode: mode, vault_epoch: 2};
      }),
    };
    vi.stubGlobal('VylkVaultCrypto', {noteKeys: vi.fn(async () => ({}))});
    const session = globalThis.VylkVaultSession.create({apiClient, offlineStore});
    return {session, offlineStore, apiClient};
  }

  test.each([undefined, {kind: 'network'}, {kind: 'timeout'}])(
    'restores a matching key with online or offline credentials (%j)',
    async (failure) => {
      const {session, offlineStore} = setup({failure});
      await session.bootstrap();
      const result = await session.resumeRemembered();
      expect(result).toMatchObject(failure ? {offline: true} : {ok: true});
      expect(session.unlocked()).toBe(true);
      expect(offlineStore.unlockVaultLocal).toHaveBeenCalledWith(
        expect.anything(),
        'vault',
        true,
        2,
      );
    },
  );

  test.each([
    {saved: {vaultID: 'other', epoch: 2}},
    {saved: {vaultID: 'vault', epoch: 1}},
    {marker: {value: 2, vaultID: 'vault', epoch: 2}},
    {failure: {status: 401}},
  ])('does not restore mismatched, migrating, or revoked state (%j)', async (options) => {
    const {session, offlineStore} = setup(options);
    await session.bootstrap();
    expect(await session.resumeRemembered()).toBeNull();
    expect(session.unlocked()).toBe(false);
    expect(offlineStore.unlockVaultLocal).not.toHaveBeenCalled();
    expect(offlineStore.forgetRememberedVaultRoot).toHaveBeenCalled();
  });

  test('never restores a remembered key in an insecure context', async () => {
    vi.stubGlobal('isSecureContext', false);
    const {session, offlineStore} = setup();
    await session.bootstrap();
    expect(await session.resumeRemembered()).toBeNull();
    expect(offlineStore.rememberedVaultRoot).not.toHaveBeenCalled();
  });
});
