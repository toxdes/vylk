import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFile, cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from '@playwright/test';

// This fixture owns a second instance; never reset the suite's shared server.
async function createDemo({disableVaultChanges = true, sourceDirectory = process.cwd()} = {}) {
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
    VYLK_DISABLE_VAULT_CHANGES: String(disableVaultChanges),
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
    await build(sourceDirectory);
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
    async reset({sourceDirectory} = {}) {
      await stop();
      if (sourceDirectory) await build(sourceDirectory);
      await rm(data, {recursive: true, force: true});
      await mkdir(data);
      await start();
    },
    async dispose() {
      await stop();
      await rm(root, {recursive: true, force: true});
    },
  };

  async function build(cwd) {
    // Upgrade fixtures can build a copied source tree without Git metadata.
    await promisify(execFile)('go', ['build', '-buildvcs=false', '-o', binary, './cmd/vylk'], {
      cwd,
      env,
      timeout: 60000,
    });
  }
}

async function signIn(page, url) {
  await page.goto(url);
  await signInCurrentPage(page);
}

async function signInCurrentPage(page) {
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
  await page.keyboard.press('Control+s');
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
      if (cycle === 0) await page.goto(demo.url);
      else {
        // Detect a replacement from the still-open app, without navigation.
        await page.evaluate(() => {
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('online'));
        });
      }
      await expect(page.locator('#dataset-switch-modal')).toBeVisible();
      await page.locator('#dataset-switch-confirm').click();
      await expect(page.locator('#dataset-switch-modal')).toBeHidden();
      await signInCurrentPage(page);
      await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
      await expect(page.locator('#dashboard')).not.toHaveAttribute('inert', '');
      await page.locator('#prefs-btn').click();
      await expect(page.locator('#prefs-modal')).toBeVisible();
      await page.locator('#prefs-close').click();
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
    await page.goto(demo.url);
    await expect(page.locator('#dataset-switch-modal')).toBeVisible();
    await expect(page.locator('#dataset-switch-keep')).toBeFocused();
    await page.locator('#dataset-switch-keep').click();
    await expect(page.locator('#login-error')).toContainText('Notes database changed');
    expect((await page.request.get('/api/notes')).status()).toBe(401);
    await page.reload();
    await expect(page.locator('#dataset-switch-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    const count = syncRequests.length;
    await page.waitForTimeout(2000);
    expect(syncRequests.length - count).toBeLessThan(10);
    expect((await page.request.get('/api/notes')).status()).toBe(401);
    await demo.stop();
    await rm(demo.data, {recursive: true, force: true});
    await cp(backup, demo.data, {recursive: true});
    await demo.start();
    await page.goto(demo.url);
    await expect(page.locator('#dashboard')).toBeVisible();
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

test('Switch installs an updated app before automatically reloading', async ({browser}) => {
  test.setTimeout(120000);
  const demo = await createDemo();
  const context = await browser.newContext({baseURL: demo.url});
  try {
    const page = await context.newPage();
    await signIn(page, demo.url);
    await expect
      .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);
    const originalRevision = await page
      .locator('meta[name="vylk-revision"]')
      .getAttribute('content');
    const source = path.join(demo.root, 'updated-source');
    await mkdir(source);
    for (const entry of ['cmd', 'internal', 'go.mod', 'go.sum', 'VERSION'])
      await cp(path.join(process.cwd(), entry), path.join(source, entry), {recursive: true});
    // Change only a copied asset to exercise a genuine shell revision update.
    await appendFile(
      path.join(source, 'internal/web/static/style.css'),
      '\n/* update fixture */\n',
    );
    await demo.reset({sourceDirectory: source});
    const current = await (await page.request.get('/api/vault/bootstrap')).json();
    expect(current.revision).not.toBe(originalRevision);
    await page.reload();
    await expect(page.locator('#dataset-switch-modal')).toBeVisible();
    await page.locator('#dataset-switch-confirm').click();
    await expect(page.locator('meta[name="vylk-revision"]')).toHaveAttribute(
      'content',
      current.revision,
    );
    await signInCurrentPage(page);
    await expect(page.locator('.toast.update')).toHaveCount(0);
    await createNote(page, 'Created after automatic update');
  } finally {
    await context.close();
    await demo.dispose();
  }
});

test('switches from an encrypted server to a fresh database without losing data before confirmation', async ({
  browser,
}) => {
  test.setTimeout(180000);
  // Optional local upgrade coverage; CI needs no second checkout or network fetch.
  const previousSource = process.env.VYLK_BROWSER_UPGRADE_SOURCE || process.cwd();
  const demo = await createDemo({
    disableVaultChanges: false,
    sourceDirectory: previousSource,
  });
  const context = await browser.newContext({baseURL: demo.url});
  try {
    const page = await context.newPage();
    await signIn(page, demo.url);
    await createNote(page, 'Encrypted original');
    await page.locator('#prefs-btn').click();
    await page.locator('#prefs-tab-encryption').click();
    await page.locator('#vault-open-setup').click();
    const master = 'Correct horse battery staple private vault!';
    await page.locator('#vault-old-password').fill('demo-reset-password');
    await page.locator('#vault-master').fill(master);
    await page.locator('#vault-master-confirm').fill(master);
    const words = await page.locator('#vault-recovery-key .vault-recovery-word').allTextContents();
    await page.locator('#vault-recovery-begin').click();
    for (const word of words) {
      await page.locator('#vault-recovery-confirm').fill(word);
      await page.locator('#vault-recovery-confirm').press('Enter');
    }
    await page.locator('#vault-start').click();
    await page.locator('#vault-final-confirm-start').click();
    await expect(page.locator('#login-screen')).toBeVisible({timeout: 30000});
    await page.locator('#login-password').fill(master);
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('#dashboard')).toBeVisible();
    expect((await (await page.request.get('/api/vault/bootstrap')).json()).mode).toBe('encrypted');
    const other = await context.newPage();
    await other.goto(demo.url);
    await expect(other.locator('#dashboard')).toBeVisible();
    await context.setOffline(true);
    await createNote(page, 'Encrypted pending edit', true);
    await demo.reset({sourceDirectory: process.cwd()});
    await context.setOffline(false);
    await page.reload();
    if (previousSource !== process.cwd())
      await page.locator('.toast-action').filter({hasText: 'Reload'}).click();
    await expect(page.locator('#dataset-switch-modal')).toBeVisible();
    // Leave an older application's tab open during upgrade coverage. Updating
    // both tabs would hide interference from stale cross-tab callbacks.
    if (previousSource === process.cwd())
      await expect(other.locator('#dataset-switch-modal')).toBeVisible();
    await expect(page.locator('#login-error')).not.toContainText('Could not start');
    await page.locator('#dataset-switch-keep').click();
    const inspectStorage = () =>
      page.evaluate(async () => {
        const store = window.VylkOfflineStore.create({createID: () => crypto.randomUUID()});
        try {
          const db = await store.openOfflineDB();
          const tx = db.transaction(['queue', 'keys', 'state'], 'readonly');
          const request = (value) =>
            new Promise((resolve) => {
              value.onsuccess = () => resolve(value.result);
            });
          return {
            pending: await request(tx.objectStore('queue').count()),
            root: Boolean(await request(tx.objectStore('keys').get('root'))),
            encrypted:
              (await request(tx.objectStore('state').get('vault-local-format')))?.value === 1,
          };
        } finally {
          await store.closeOfflineDatabaseConnection();
        }
      });
    const before = await inspectStorage();
    expect(before.pending).toBeGreaterThan(0);
    expect(before.encrypted).toBe(true);
    // Older builds may revoke remembered unlock before learning the new identity.
    if (previousSource === process.cwd()) expect(before.root).toBe(true);
    await page.reload();
    await expect(page.locator('#dataset-switch-modal')).toBeVisible();
    await page.locator('#dataset-switch-confirm').click();
    await expect(page.locator('#dataset-switch-modal')).toBeHidden();
    await expect(other.locator('#dataset-switch-modal')).toBeHidden();
    await expect(page.locator('#login-screen')).toBeVisible();
    expect(await inspectStorage()).toEqual({pending: 0, root: false, encrypted: false});
    expect((await context.cookies()).some((cookie) => cookie.name === 'session')).toBe(false);
    await signInCurrentPage(page);
    await expect(page.locator('.note-item')).toHaveCount(0);
    await expect(page.locator('#dashboard')).not.toHaveAttribute('inert', '');
    await createNote(page, 'Fresh after switch');
    await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  } finally {
    await context.close();
    await demo.dispose();
  }
});
