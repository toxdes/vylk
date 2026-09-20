(function (global) {
  'use strict';

  function create({navigator, onUnavailable, requestValue, tabID, window, withOfflineStore}) {
    const leaseKey = 'syncLease';
    const leaseDurationMs = 60_000;
    let renewTimer = null;

    async function acquireLease() {
      const now = Date.now();
      return withOfflineStore(['state'], 'readwrite', async (stores) => {
        const current = await requestValue(stores.state.get(leaseKey));
        const lease = current?.value;
        if (lease && lease.owner !== tabID && Number(lease.expiresAt) > now) return false;
        await requestValue(
          stores.state.put({
            key: leaseKey,
            value: {owner: tabID, expiresAt: now + leaseDurationMs},
          }),
        );
        return true;
      });
    }

    async function renewLease() {
      const now = Date.now();
      try {
        await withOfflineStore(['state'], 'readwrite', async (stores) => {
          const current = await requestValue(stores.state.get(leaseKey));
          if (current?.value?.owner !== tabID) return;
          await requestValue(
            stores.state.put({
              key: leaseKey,
              value: {owner: tabID, expiresAt: now + leaseDurationMs},
            }),
          );
        });
      } catch (error) {
        console.warn('could not renew sync lease', error);
      }
    }

    async function releaseLease() {
      if (renewTimer) window.clearInterval(renewTimer);
      renewTimer = null;
      await withOfflineStore(['state'], 'readwrite', async (stores) => {
        const current = await requestValue(stores.state.get(leaseKey));
        if (current?.value?.owner === tabID) await requestValue(stores.state.delete(leaseKey));
      });
    }

    async function run(work) {
      if (navigator.locks && typeof navigator.locks.request === 'function') {
        let acquired = false;
        let result;
        try {
          await navigator.locks.request('vylk-sync', {ifAvailable: true}, async (lock) => {
            if (!lock) return;
            acquired = true;
            result = await work();
          });
          if (acquired) return result;
          onUnavailable();
          return false;
        } catch (error) {
          if (acquired) throw error;
          console.warn('Web Locks unavailable; using IndexedDB sync lease', error);
        }
      }
      if (!(await acquireLease())) {
        onUnavailable();
        return false;
      }
      renewTimer = window.setInterval(() => void renewLease(), leaseDurationMs / 3);
      try {
        return await work();
      } finally {
        await releaseLease();
      }
    }

    return {run};
  }

  global.VylkSyncLeadership = {create};
})(typeof window !== 'undefined' ? window : globalThis);
