import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';

await import('../internal/web/static/js/ui/auth.js');
const html = readFileSync(new URL('../internal/web/static/index.html', import.meta.url), 'utf8');
let dom;

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});

function bindAuth(mode) {
  dom = new JSDOM(html, {url: 'https://vylk.test/'});
  const {window} = dom;
  vi.stubGlobal('window', window);
  window.VylkRecoveryEntry = {
    create: () => ({ready: () => true, value: () => 'recovery words', clear: () => {}}),
  };
  const config = {mode, salt: 'old salt'};
  const vaultSession = {
    config: () => config,
    bootstrap: vi.fn(async () => {
      config.salt = 'new salt';
    }),
    encrypted: () => mode === 'encrypted',
    requiresSecureContext: () => false,
    unlock: vi.fn(async () => {
      if (config.salt !== 'new salt') throw new Error('stale credential derivation');
      return {ok: true, instance_id: 'instance'};
    }),
  };
  const dependencies = {
    document: window.document,
    localStorage: window.localStorage,
    vaultSession,
    vaultSetup: {open: vi.fn(async () => {})},
    api: vi.fn(async () => ({ok: true, instance_id: 'instance'})),
    cacheVersion: () => {},
    clearDiagnostic: () => {},
    setAuthenticationRequired: vi.fn(),
    handleServerIdentity: vi.fn(async () => {
      if (mode === 'preparing') throw new Error('local vault is locked');
    }),
    loadPreferences: async () => {},
    restoreRoute: vi.fn(async () => {}),
    connectEvents: () => {},
    scheduleSync: () => {},
    closeModal: () => {},
  };
  globalThis.VylkAuth.bind(dependencies);
  const form = window.document.querySelector('#login-form');
  form.password = window.document.querySelector('#login-password');
  form.password.value = 'new passphrase';
  return dependencies;
}

test.each(['login-form', 'login-recovery-form'])(
  '%s refreshes an existing configuration before unlock',
  async (formID) => {
    const dependencies = bindAuth('encrypted');
    dom.window.document
      .querySelector(`#${formID}`)
      .dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(dependencies.restoreRoute).toHaveBeenCalledOnce());
    expect(dependencies.vaultSession.bootstrap).toHaveBeenCalledOnce();
    expect(dependencies.vaultSession.unlock).toHaveBeenCalledOnce();
  },
);

test('preparing sign-in opens conversion resume before reading locked offline state', async () => {
  const dependencies = bindAuth('preparing');
  dom.window.document
    .querySelector('#login-form')
    .dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true}));
  await vi.waitFor(() => expect(dependencies.vaultSetup.open).toHaveBeenCalledOnce());
  expect(dependencies.handleServerIdentity).not.toHaveBeenCalled();
  expect(dependencies.restoreRoute).not.toHaveBeenCalled();
});

test('successful sign-in clears authentication required while bootstrap was pending', async () => {
  const dependencies = bindAuth('legacy');
  let resolveBootstrap;
  dependencies.vaultSession.bootstrap.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveBootstrap = resolve;
      }),
  );
  dom.window.document
    .querySelector('#login-form')
    .dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true}));
  dependencies.setAuthenticationRequired(true);
  resolveBootstrap();
  await vi.waitFor(() => expect(dependencies.restoreRoute).toHaveBeenCalledOnce());
  expect(dependencies.setAuthenticationRequired).toHaveBeenLastCalledWith(false);
});
