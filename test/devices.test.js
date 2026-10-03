import {afterEach, expect, test, vi} from 'vitest';
import {JSDOM} from 'jsdom';

await import('../internal/web/static/js/ui/devices.js');
const windows = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function setup(
  api,
  {
    beforeSignOut = async () => {},
    onCurrentDeviceRevoked = async () => {},
    getCurrentDeviceID = async () => null,
    onLocalSignOut = null,
  } = {},
) {
  const dom =
    new JSDOM(`<button id="prefs-tab-account"></button><button id="devices-refresh"></button>
    <p id="devices-status"></p><div id="devices-list"></div>
    <div id="device-signout-modal" hidden><div class="modal-backdrop"></div>
    <p id="device-signout-copy"></p><p id="device-signout-error"></p>
    <button id="device-signout-close"></button><button id="device-signout-cancel"></button>
    <button id="device-signout-confirm"></button></div>`);
  windows.push(dom.window);
  const document = dom.window.document;
  const devices = globalThis.VylkDevices.bind({
    api,
    document,
    beforeSignOut,
    onCurrentDeviceRevoked,
    getCurrentDeviceID,
    onLocalSignOut,
    openModal: (modal) => {
      modal.hidden = false;
    },
    closeModal: (modal) => {
      modal.hidden = true;
    },
  });
  return {devices, document};
}

test('renders device names as text and signs out only after confirmation', async () => {
  const api = vi.fn(async (path) =>
    path === '/api/devices'
      ? {
          devices: [
            {
              id: 'a',
              name: '<script>bad</script>',
              current: false,
              last_seen_at: '2026-09-30T00:00:00Z',
            },
          ],
        }
      : true,
  );
  const {devices, document} = setup(api);
  await devices.load();
  expect(document.querySelector('#devices-list script')).toBeNull();
  document.querySelector('#devices-list button').click();
  expect(api).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#device-signout-modal').hidden).toBe(false);
  document.querySelector('#device-signout-confirm').click();
  await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/devices/a', {method: 'DELETE'}));
  await vi.waitFor(() => expect(document.querySelector('#device-signout-modal').hidden).toBe(true));
});

test('keeps a single current-device sign-out available when the device API is offline', async () => {
  const api = vi.fn(async () => {
    throw Object.assign(new Error('offline'), {kind: 'network'});
  });
  const localSignOut = vi.fn(async () => {});
  const save = vi.fn(async () => {});
  const {devices, document} = setup(api, {
    getCurrentDeviceID: async () => 'current',
    onLocalSignOut: localSignOut,
    beforeSignOut: save,
  });
  await devices.load();
  expect(document.querySelectorAll('#devices-list button')).toHaveLength(1);
  expect(document.querySelector('#devices-list').textContent).toContain('This device');
  document.querySelector('#devices-list button').click();
  document.querySelector('#device-signout-confirm').click();
  await vi.waitFor(() => expect(localSignOut).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledTimes(1);
});

test('a failed network revocation can sign out locally, but an explicit server rejection cannot', async () => {
  let failure = Object.assign(new Error('offline'), {kind: 'network'});
  const api = vi.fn(async (path) => {
    if (path === '/api/devices')
      return {devices: [{id: 'current', name: 'Browser', current: true}]};
    throw failure;
  });
  const localSignOut = vi.fn(async () => {});
  const {devices, document} = setup(api, {onLocalSignOut: localSignOut});
  await devices.load();
  document.querySelector('#devices-list button').click();
  document.querySelector('#device-signout-confirm').click();
  await vi.waitFor(() => expect(localSignOut).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(document.querySelector('#device-signout-confirm').disabled).toBe(false),
  );
  failure = Object.assign(new Error('forbidden'), {kind: 'http', responseStatus: 403});
  document.querySelector('#devices-list button').click();
  document.querySelector('#device-signout-confirm').click();
  await vi.waitFor(() =>
    expect(document.querySelector('#device-signout-error').textContent).toBe('forbidden'),
  );
  expect(localSignOut).toHaveBeenCalledOnce();
});

test('does not revoke the current device if its pending edit could not be persisted', async () => {
  const api = vi.fn(async () => ({devices: [{id: 'a', name: 'Firefox', current: true}]}));
  const lock = vi.fn();
  const {devices, document} = setup(api, {
    beforeSignOut: async () => {
      throw new Error('Save failed');
    },
    onCurrentDeviceRevoked: lock,
  });
  await devices.load();
  document.querySelector('#devices-list button').click();
  document.querySelector('#device-signout-confirm').click();
  await vi.waitFor(() =>
    expect(document.querySelector('#device-signout-error').textContent).toBe('Save failed'),
  );
  expect(api).toHaveBeenCalledTimes(1);
  expect(lock).not.toHaveBeenCalled();
  expect(document.querySelector('#device-signout-modal').hidden).toBe(false);
});
