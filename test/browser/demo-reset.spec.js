import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from '@playwright/test';

// This fixture owns a second instance; never reset the suite's shared server.
async function createDemo() {
  const root = await mkdtemp(path.join(tmpdir(), 'vylk-demo-reset-'));
  const data = path.join(root, 'data');
  const binary = path.join(root, 'vylk');
  const url = 'http://127.0.0.1:18082';
  let process;
  let log = '';
  const env = {
    ...globalThis.process.env,
    PORT: '18082',
    VYLK_NO_BROWSER: '1',
    VYLK_PASSWORD: 'demo-reset-password',
    VYLK_DISABLE_VAULT_CHANGES: 'true',
    VYLK_DIR: path.join(data, 'notes'),
    VYLK_DB: path.join(data, 'vylk.db'),
    GOCACHE: path.join(tmpdir(), 'vylk-browser-go-cache'),
  };
  async function stop() {
    if (!process || process.exitCode !== null) return;
    const exited = once(process, 'exit');
    process.kill('SIGTERM');
    await exited;
  }
  async function start() {
    process = spawn(binary, [], {env, stdio: ['ignore', 'ignore', 'pipe']});
    process.stderr.on('data', (chunk) => {
      log = (log + chunk).slice(-65536);
    });
    await expect
      .poll(
        async () => {
          if (process.exitCode !== null) throw new Error(log);
          return fetch(`${url}/api/vault/bootstrap`)
            .then((response) => response.status)
            .catch(() => 0);
        },
        {timeout: 20000},
      )
      .toBe(200);
  }
  try {
    await mkdir(data);
    await promisify(execFile)('go', ['build', '-o', binary, './cmd/vylk'], {env, timeout: 60000});
    await start();
  } catch (error) {
    await stop();
    await rm(root, {recursive: true, force: true});
    throw error;
  }
  return {
    url,
    data,
    root,
    start,
    stop,
    async reset() {
      await stop();
      await rm(data, {recursive: true, force: true});
      await mkdir(data);
      await start();
    },
    async dispose() {
      await stop();
      await rm(root, {recursive: true, force: true});
    },
  };
}

async function signIn(page, url) {
  await page.goto(url);
  await expect(page.locator('#login-screen')).toBeVisible();
  await page.locator('#login-password').fill('demo-reset-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

async function createNote(page, title, offline = false) {
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill(title);
  await page.locator('#note-tags').fill('demo, reset, markdown');
  await page
    .locator('#note-content')
    .fill('# Markdown\n\n**Bold** café ✓\n\n- [ ] task\n\n```go\nfmt.Println("hello")\n```');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  if (!offline) {
    await expect
      .poll(async () => {
        const notes = await (await page.request.get('/api/notes')).json();
        return notes.some((note) => note.title === title);
      })
      .toBe(true);
    await expect(page.locator('#editor-status')).toHaveAttribute('data-state', 'online');
  }
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('demo resets stop stale sync and preserve pending edits until the original data returns', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const demo = await createDemo();
  const context = await browser.newContext({baseURL: demo.url});
  try {
    const page = await context.newPage();
    const syncRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/sync')) syncRequests.push(request.url());
    });
    await signIn(page, demo.url);
    await page.locator('#prefs-btn').click();
    await page.locator('#prefs-tab-encryption').click();
    await expect(page.locator('#vault-status-copy')).toHaveText('End-to-end encryption is off');
    for (const endpoint of [
      'reset',
      'credentials',
      'migration/start',
      'migration/stage',
      'migration/verify',
      'migration/commit',
    ]) {
      const response = await page.request.post(`/api/vault/${endpoint}`, {data: {}});
      expect(response.status()).toBe(403);
      expect((await response.json()).code).toBe('vault_changes_disabled');
    }
    await page.keyboard.press('Escape');
    await createNote(page, 'Synced before restart');
    const original = (await (await page.request.get('/api/check')).json()).instance_id;
    await demo.stop();
    await demo.start();
    await page.reload();
    await expect(page.locator('#dashboard')).toBeVisible();
    expect((await (await page.request.get('/api/check')).json()).instance_id).toBe(original);
    await expect(
      page.locator('.note-item').filter({hasText: 'Synced before restart'}),
    ).toBeVisible();
    for (let cycle = 0; cycle < 2; cycle++) {
      await demo.reset();
      await signIn(page, demo.url);
      await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
      await expect(page.locator('.note-item')).toHaveCount(0);
      const count = syncRequests.length;
      // An observation window, not an initialization deadline. A busy loop would
      // exceed this generous allowance by orders of magnitude.
      await page.waitForTimeout(2000);
      expect(syncRequests.length - count).toBeLessThan(10);
      await createNote(page, `After reset ${cycle}`);
    }
    await context.setOffline(true);
    await createNote(page, 'Pending from original database', true);
    await demo.stop();
    const backup = path.join(demo.root, 'backup');
    await cp(demo.data, backup, {recursive: true});
    await demo.reset();
    await context.setOffline(false);
    await signIn(page, demo.url);
    const notice = page.locator('.offline-notice:visible').first();
    await expect(notice).toContainText('server database changed');
    expect(await (await page.request.get('/api/notes')).json()).toEqual([]);
    await page.reload();
    await expect(page.locator('#dashboard')).toBeVisible();
    await expect(notice).toContainText('server database changed');
    await notice.locator('.offline-retry').click();
    await expect(notice).toContainText('server database changed');
    const count = syncRequests.length;
    await page.waitForTimeout(2000);
    expect(syncRequests.length - count).toBeLessThan(10);
    expect(await (await page.request.get('/api/notes')).json()).toEqual([]);
    await demo.stop();
    await rm(demo.data, {recursive: true, force: true});
    await cp(backup, demo.data, {recursive: true});
    await demo.start();
    await signIn(page, demo.url);
    await expect
      .poll(async () => {
        const restored = await (await page.request.get('/api/notes')).json();
        return restored.some((note) => note.title === 'Pending from original database');
      })
      .toBe(true);
    await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  } finally {
    await context.close();
    await demo.dispose();
  }
});
