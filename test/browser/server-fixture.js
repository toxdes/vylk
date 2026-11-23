import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test as base, expect} from '@playwright/test';

export const BROWSER_BINARY = path.join(tmpdir(), 'vylk-browser-bin', 'vylk');
export const PASSWORD = 'browser-test-password';

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vylk exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`vylk did not start at ${url}`);
}

// Each worker owns a server and database, so spec files run in parallel without shared state.
// A spec that changes the whole server (vault encryption) sets its own `serverScope`,
// which gives it a dedicated worker and a fresh server.
export const test = base.extend({
  serverScope: ['shared', {scope: 'worker', option: true}],
  serverURL: [
    async ({serverScope}, use, workerInfo) => {
      const port = 18100 + workerInfo.parallelIndex;
      const url = `http://127.0.0.1:${port}`;
      const data = mkdtempSync(path.join(tmpdir(), `vylk-browser-${serverScope}-`));
      const child = spawn(BROWSER_BINARY, [], {
        env: {
          ...process.env,
          PORT: String(port),
          VYLK_NO_BROWSER: '1',
          VYLK_PASSWORD: PASSWORD,
          VYLK_DIR: path.join(data, 'notes'),
          VYLK_DB: path.join(data, 'vylk.db'),
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      try {
        await waitForServer(`${url}/`, child);
        await use(url);
      } finally {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        if (child.exitCode === null) child.kill();
        await exited;
        rmSync(data, {recursive: true, force: true});
      }
    },
    {scope: 'worker', auto: true},
  ],
  baseURL: async ({serverURL}, use) => use(serverURL),
  // Preferences are server state that later tests on the same worker would inherit,
  // so every test ends by restoring the fresh server's values.
  restorePreferences: [
    async ({serverURL, serverScope, playwright}, use) => {
      const api = await playwright.request.newContext({baseURL: serverURL});
      const signIn = () => api.post('/api/login', {data: {password: PASSWORD}});
      const shared = serverScope === 'shared' && (await signIn()).ok();
      const fresh = shared ? await (await api.get('/api/prefs')).json() : {};
      delete fresh.revision;
      try {
        await use();
        if (!shared || !(await signIn()).ok()) return;
        const current = await (await api.get('/api/prefs')).json();
        await api.patch('/api/prefs', {
          headers: {'If-Match': String(current.revision)},
          data: {...current, ...fresh},
        });
      } finally {
        await api.dispose();
      }
    },
    {auto: true},
  ],
});

export {expect};
