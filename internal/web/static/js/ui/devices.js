(function (root) {
  'use strict';

  function bind({api, document, openModal, closeModal, onCurrentDeviceRevoked, beforeSignOut}) {
    const $ = (selector) => document.querySelector(selector);
    const modal = $('#device-signout-modal');
    const status = $('#devices-status');
    const list = $('#devices-list');
    const refresh = $('#devices-refresh');
    const confirm = $('#device-signout-confirm');
    let selected = null;
    let generation = 0;

    function render(devices) {
      list.replaceChildren();
      for (const device of devices) {
        const row = document.createElement('div');
        row.className = 'pref-row device-row';
        row.dataset.deviceId = device.id;
        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = `${device.name}${device.current ? ' · This device' : ''}`;
        const detail = document.createElement('small');
        const lastSeen = new Date(device.last_seen_at);
        detail.textContent = Number.isNaN(lastSeen.getTime())
          ? 'Last activity unavailable'
          : `Last active ${lastSeen.toLocaleString()}`;
        text.append(title, detail);
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn-secondary danger';
        action.textContent = 'Sign out';
        action.setAttribute('aria-label', `Sign out ${device.name}`);
        action.addEventListener('click', () => {
          selected = device;
          $('#device-signout-copy').textContent =
            `Sign out ${device.name}? Encrypted local changes will be kept. If it is offline, it will lock when it reconnects.`;
          $('#device-signout-error').textContent = '';
          openModal(modal);
        });
        row.append(text, action);
        list.append(row);
      }
    }

    async function load() {
      const request = ++generation;
      refresh.disabled = true;
      status.textContent = 'Loading devices…';
      try {
        const result = await api('/api/devices');
        if (request !== generation) return;
        render(result.devices);
        status.textContent = result.devices.length ? '' : 'No signed-in devices.';
      } catch (_) {
        if (request === generation) status.textContent = 'Could not load devices. Try Refresh.';
      } finally {
        if (request === generation) refresh.disabled = false;
      }
    }

    function close() {
      if (confirm.disabled) return;
      selected = null;
      closeModal(modal);
    }

    refresh.addEventListener('click', load);
    $('#prefs-tab-account').addEventListener('click', load);
    $('#device-signout-close').addEventListener('click', close);
    $('#device-signout-cancel').addEventListener('click', close);
    modal.querySelector('.modal-backdrop').addEventListener('click', close);
    confirm.addEventListener('click', async () => {
      if (!selected || confirm.disabled) return;
      const device = selected;
      confirm.disabled = true;
      try {
        if (device.current) await beforeSignOut();
        await api(`/api/devices/${encodeURIComponent(device.id)}`, {method: 'DELETE'});
        closeModal(modal);
        selected = null;
        if (device.current) await onCurrentDeviceRevoked();
        else await load();
      } catch (error) {
        $('#device-signout-error').textContent =
          error.message || 'Could not sign out this device. Try again.';
      } finally {
        confirm.disabled = false;
      }
    });
    return {load};
  }

  root.VylkDevices = {bind};
})(typeof window !== 'undefined' ? window : globalThis);
