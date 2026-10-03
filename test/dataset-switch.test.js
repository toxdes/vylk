import {afterEach, expect, test, vi} from 'vitest';
import {JSDOM} from 'jsdom';

await import('../internal/web/static/js/core/http.js');
await import('../internal/web/static/js/ui/dataset-switch.js');
let dom;
afterEach(() => dom?.window.close());

function setup() {
  dom = new JSDOM(
    '<div id="dataset-switch-modal" class="hidden"><div class="modal-backdrop"></div><button id="dataset-switch-keep"></button><button id="dataset-switch-confirm"></button><p id="dataset-switch-error"></p></div>',
  );
  const config = {instance_id: 'replacement', mode: 'legacy'};
  const offlineStore = {
    inspectDataset: vi.fn(async (value) => ({changed: value.instance_id !== 'original'})),
    switchDataset: vi.fn(async () => true),
  };
  const dependencies = {
    document: dom.window.document,
    offlineStore,
    fetchBootstrap: vi.fn(async () => config),
    endSession: vi.fn(async () => {}),
    prepareSwitch: vi.fn(async () => {}),
    openModal: (modal) => modal.classList.remove('hidden'),
    closeModal: (modal) => modal.classList.add('hidden'),
    pause: vi.fn(),
    resume: vi.fn(),
    broadcast: vi.fn(),
    switched: vi.fn(async () => {}),
  };
  const controller = globalThis.VylkDatasetSwitch.create(dependencies);
  return {
    controller,
    dependencies,
    config,
    modal: dom.window.document.querySelector('#dataset-switch-modal'),
    confirm: dom.window.document.querySelector('#dataset-switch-confirm'),
  };
}

test('Keep changes dismisses the dialog without clearing or resuming sync', async () => {
  const {controller, dependencies, config, modal} = setup();
  await expect(controller.inspect(config)).rejects.toMatchObject({code: 'server_instance_changed'});
  controller.keepChanges();
  expect(modal.classList.contains('hidden')).toBe(true);
  expect(controller.paused()).toBe(true);
  expect(dependencies.offlineStore.switchDataset).not.toHaveBeenCalled();
  expect(dependencies.resume).not.toHaveBeenCalled();
  await expect(controller.inspect(config)).rejects.toMatchObject({code: 'server_instance_changed'});
  expect(modal.classList.contains('hidden')).toBe(true);
  await controller.inspect({instance_id: 'original', mode: 'legacy'});
  expect(controller.paused()).toBe(false);
  expect(dependencies.resume).toHaveBeenCalledOnce();
});

test('Switch verifies identity again after signing out and ignores duplicate clicks', async () => {
  const {controller, dependencies, config, confirm} = setup();
  await expect(controller.inspect(config)).rejects.toMatchObject({code: 'server_instance_changed'});
  confirm.click();
  confirm.click();
  await vi.waitFor(() => expect(dependencies.switched).toHaveBeenCalledOnce());
  expect(dependencies.fetchBootstrap).toHaveBeenCalledTimes(2);
  expect(dependencies.endSession).toHaveBeenCalledOnce();
  expect(dependencies.prepareSwitch).toHaveBeenCalledExactlyOnceWith(config);
  expect(dependencies.prepareSwitch.mock.invocationCallOrder[0]).toBeLessThan(
    dependencies.endSession.mock.invocationCallOrder[0],
  );
  expect(dependencies.offlineStore.switchDataset).toHaveBeenCalledExactlyOnceWith(config);
  expect(dependencies.broadcast).toHaveBeenLastCalledWith({
    type: 'dataset-switched',
    instanceID: config.instance_id,
  });
});

test('an update download failure keeps local data and allows retry', async () => {
  const {controller, dependencies, config, confirm} = setup();
  await expect(controller.inspect(config)).rejects.toMatchObject({code: 'server_instance_changed'});
  dependencies.prepareSwitch.mockRejectedValue(new Error('Could not download the update'));
  confirm.click();
  await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  expect(dependencies.endSession).not.toHaveBeenCalled();
  expect(dependencies.offlineStore.switchDataset).not.toHaveBeenCalled();
  expect(dependencies.switched).not.toHaveBeenCalled();
  expect(dom.window.document.querySelector('#dataset-switch-error').textContent).toContain(
    'Could not download',
  );
});

test.each(['before logout', 'after logout'])(
  'another server change %s invalidates the confirmation',
  async (stage) => {
    const {controller, dependencies, config, confirm} = setup();
    await expect(controller.inspect(config)).rejects.toMatchObject({
      code: 'server_instance_changed',
    });
    if (stage === 'after logout') dependencies.fetchBootstrap.mockResolvedValueOnce(config);
    dependencies.fetchBootstrap.mockResolvedValue({instance_id: 'third', mode: 'legacy'});
    confirm.click();
    await vi.waitFor(() =>
      expect(dom.window.document.querySelector('#dataset-switch-error').textContent).toContain(
        'changed again',
      ),
    );
    expect(dependencies.offlineStore.switchDataset).not.toHaveBeenCalled();
    expect(dependencies.switched).not.toHaveBeenCalled();
    expect(confirm.disabled).toBe(false);
  },
);

test('an unreachable server keeps local data and allows retry', async () => {
  const {controller, dependencies, config, confirm} = setup();
  await expect(controller.inspect(config)).rejects.toMatchObject({code: 'server_instance_changed'});
  dependencies.fetchBootstrap.mockRejectedValue(new Error('Server is unreachable'));
  confirm.click();
  await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  expect(dependencies.offlineStore.switchDataset).not.toHaveBeenCalled();
  expect(dependencies.endSession).not.toHaveBeenCalled();
  expect(controller.paused()).toBe(true);
});
