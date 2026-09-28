import AxeBuilder from '@axe-core/playwright';
import {expect, test} from '@playwright/test';

async function expectCredentialModalToFit(page, modalID, fieldLabelID) {
  const modal = page.locator(`#${modalID} .modal-body`);
  const modalBounds = await modal.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
  expect(modalBounds).not.toBeNull();
  expect(modalBounds.x).toBeGreaterThanOrEqual(0);
  expect(modalBounds.x + modalBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(modalBounds.y).toBeGreaterThanOrEqual(0);
  expect(modalBounds.y + modalBounds.height).toBeLessThanOrEqual(viewport.height);
  await expect(page.locator(`label[for="${fieldLabelID}"]`)).toHaveCSS('position', 'absolute');
  await expect(page.locator(`label[for="${fieldLabelID}"]`)).toHaveCSS('font-weight', '400');

  await modal.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(modal.locator('.vault-form-actions button:visible').last()).toBeInViewport();
  const accessibility = await new AxeBuilder({page}).include(`#${modalID}`).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact),
    ),
  ).toEqual([]);
  await modal.evaluate((element) => {
    element.scrollTop = 0;
  });
}

async function enterRecoveryKey(page, key) {
  await page.locator('#login-forgot-password').click();
  await page.locator('#login-have-recovery').click();
  await page.locator('#login-recovery-word').fill(key);
  await page.locator('#login-recovery-word').press('Enter');
  await expect(page.locator('#login-recovery-count')).toHaveText('24/24 words');
}

test('encrypts an existing note and syncs ciphertext between independent devices', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const bip39Requests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/vendor/bip39.min.js')
      bip39Requests.push(request.url());
  });
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(bip39Requests).toEqual([]);

  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Private browser title');
  await page.locator('#note-content').fill('Private browser body');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteID = new URL(page.url()).pathname.slice(1);
  await page.locator('#back-btn').click();
  await expect(page.locator(`.note-item[data-id="${noteID}"]`)).toBeVisible();

  const second = await browser.newContext();
  const phone = await second.newPage();
  await phone.goto('/');
  await phone.locator('#login-password').fill('browser-test-password');
  await phone.locator('#login-form button[type="submit"]').click();
  await expect(phone.locator(`.note-item[data-id="${noteID}"]`)).toBeVisible();

  await page.locator('#prefs-btn').click();
  const desktopAccountLayout = await page
    .locator('#prefs-modal .prefs-page-body')
    .evaluate((element) => ({
      width: element.offsetWidth,
      height: element.offsetHeight,
    }));
  await page.locator('#prefs-tab-encryption').click();
  const desktopEncryptionLayout = await page
    .locator('#prefs-modal .prefs-page-body')
    .evaluate((element) => ({
      width: element.offsetWidth,
      height: element.offsetHeight,
    }));
  expect(desktopEncryptionLayout.width).toBe(desktopAccountLayout.width);
  expect(desktopEncryptionLayout.height).toBe(desktopAccountLayout.height);
  await expect(page.locator('.vault-info')).not.toHaveAttribute('open');
  await page.locator('.vault-info summary').click();
  await expect(page.locator('.vault-info-copy')).toBeVisible();
  const learnMore = page.locator('.vault-info-copy a');
  await expect(learnMore).toHaveAttribute('href', 'https://vylk.toxdes.com/docs');
  await expect(learnMore).toHaveAttribute('target', '_blank');
  await expect(learnMore).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.vault-info-copy')).not.toContainText('Close other Vylk tabs');
  await page.locator('.vault-info summary').click();
  await page.locator('#vault-open-setup').click();
  await expect(page.locator('#vault-setup-modal')).toBeVisible();
  await expect(page.locator('#vault-setup-form')).toBeVisible();
  await expect(page.locator('#vault-master')).toHaveValue('');
  await expectCredentialModalToFit(page, 'vault-setup-modal', 'vault-master');
  await page.locator('#vault-master').fill('password');
  await expect(page.locator('#vault-weak-confirm-row')).toBeVisible();
  await page.locator('#vault-master').fill('correct horse battery staple!');
  await expect(page.locator('#vault-weak-confirm-row')).toBeHidden();
  await expect.poll(() => bip39Requests.length).toBe(1);
  const accessibility = await new AxeBuilder({page})
    .include('#prefs-modal')
    .include('#vault-setup-modal')
    .analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact),
    ),
  ).toEqual([]);
  await page.locator('#vault-setup-cancel').click();
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.locator('#prefs-panel-encryption')).toBeVisible();
  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-setup').click();
  await expectCredentialModalToFit(page, 'vault-setup-modal', 'vault-master');
  await page.locator('#vault-setup-cancel').click();
  const mobileLayout = await page.locator('#prefs-modal .prefs-page-body').evaluate((element) => ({
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
  expect(mobileLayout.width).toBeLessThanOrEqual(390);
  await page.locator('#prefs-tab-account').click();
  const mobileAccountLayout = await page
    .locator('#prefs-modal .prefs-page-body')
    .evaluate((element) => ({
      width: element.offsetWidth,
      height: element.offsetHeight,
    }));
  expect(mobileLayout).toEqual(mobileAccountLayout);
  await page.locator('#prefs-tab-encryption').click();
  await page.setViewportSize({width: 1280, height: 720});
  await page.locator('#vault-open-setup').click();
  await page.locator('#vault-master').fill('password');
  await expect(page.locator('#vault-weak-confirm-row')).toBeVisible();
  await page.locator('#vault-setup-cancel').click();
  await page.locator('#prefs-panel-encryption').evaluate((panel) => {
    panel.scrollTop = 200;
  });
  await page.locator('#prefs-tab-account').click();
  await page.locator('#prefs-tab-encryption').click();
  await expect
    .poll(() => page.locator('#prefs-panel-encryption').evaluate((panel) => panel.scrollTop))
    .toBe(0);
  await page.locator('#vault-open-setup').click();
  await page.locator('#vault-master').fill('password');
  await expect(page.locator('#vault-weak-confirm-row')).toBeVisible();
  await expect(page.locator('#vault-recovery-key')).toHaveText(/^[a-z]+( [a-z]+){23}$/);
  const master = await page.locator('#vault-master').inputValue();
  const recovery = await page.locator('#vault-recovery-key').textContent();
  expect(recovery.trim().split(/\s+/)).toHaveLength(24);
  await page.locator('#vault-old-password').fill('browser-test-password');
  await page.locator('#vault-weak-confirm').check();
  await page.locator('#vault-master-confirm').fill(master);
  await page.locator('#vault-recovery-confirm').fill(recovery);
  await page.locator('#vault-start').click();
  await expect(page.locator('#login-screen')).toBeVisible({timeout: 10000});
  await page.locator('#login-password').fill(master);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-encryption').click();
  await expect(page.locator('#vault-status-icon')).toBeVisible();
  await expect(page.locator('#vault-status-copy')).toHaveText('End-to-end encryption is on');
  await page.locator('#prefs-close').click();

  const oldClientResponse = await page.request.get('/api/notes');
  expect(oldClientResponse.status()).toBe(426);
  const bootstrap = await page.request.get('/api/vault/bootstrap');
  const originalVaultConfig = await bootstrap.json();
  expect(originalVaultConfig.mode).toBe('encrypted');
  expect(originalVaultConfig.require_strong_passwords).toBe(false);
  const wire = await page.request.get(`/api/notes/${noteID}`, {
    headers: {'X-Vylk-Vault-Protocol': '1'},
  });
  expect(wire.status()).toBe(200);
  expect(await wire.text()).not.toContain('Private browser');

  try {
    await phone.reload();
    await expect(phone.locator('#login-forgot-password')).toBeVisible();
    await expect(phone.locator('#login-ask-each-time')).toHaveCount(0);
    await expect(phone.locator('label[for="login-password"]')).toHaveText('Passphrase');
    await phone.locator('#login-password').fill(master);
    await phone.locator('#login-form button[type="submit"]').click();
    await expect(phone.locator('#dashboard')).toBeVisible({timeout: 30000});
    await expect(phone.locator(`.note-item[data-id="${noteID}"]`)).toContainText(
      'Private browser title',
    );
    await phone.locator(`.note-item[data-id="${noteID}"]`).click();
    await expect(phone.locator('#note-content')).toHaveValue('Private browser body');
    await phone.locator('#note-content').fill('Updated on the second device');
    await phone.locator('#save-btn').click();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/notes/${noteID}`, {
            headers: {'X-Vylk-Vault-Protocol': '1'},
          });
          return (await response.json()).revision;
        },
        {timeout: 15000},
      )
      .toBe(2);
    await page.locator(`.note-item[data-id="${noteID}"]`).click();
    await expect(page.locator('#note-content')).toHaveValue('Updated on the second device', {
      timeout: 15000,
    });

    await phone.evaluate(() => navigator.serviceWorker.ready);
    await second.setOffline(true);
    await phone.reload();
    await expect(phone.locator('#login-screen')).toBeVisible();
    await phone.locator('#login-password').fill(master);
    await phone.locator('#login-form button[type="submit"]').click();
    await expect(phone.locator('#editor')).toBeVisible();
    await expect(phone.locator('#note-content')).toHaveValue('Updated on the second device');
    await phone.locator('#note-content').fill('Saved offline under encryption');
    await phone.locator('#save-btn').click();
    await expect(phone.locator('#note-content')).toHaveValue('Saved offline under encryption');
    await second.setOffline(false);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/notes/${noteID}`, {
            headers: {'X-Vylk-Vault-Protocol': '1'},
          });
          return (await response.json()).revision;
        },
        {timeout: 15000},
      )
      .toBe(3);
    await expect(page.locator('#note-content')).toHaveValue('Saved offline under encryption', {
      timeout: 15000,
    });
  } finally {
    await second.close();
  }

  const recoveryDevice = await browser.newContext();
  try {
    const recoveryPage = await recoveryDevice.newPage();
    await recoveryPage.goto('/');
    await enterRecoveryKey(recoveryPage, recovery);
    await recoveryPage.locator('#login-recovery-submit').click();
    await expect(recoveryPage.locator(`.note-item[data-id="${noteID}"]`)).toBeVisible();
    await expect(recoveryPage.locator('#recovery-signin-notice')).toBeVisible();
    await recoveryPage.locator('#recovery-change-passphrase').click();
    await expect(recoveryPage.locator('#vault-master-modal')).toBeVisible();
  } finally {
    await recoveryDevice.close();
  }

  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-passphrase').click();
  await expect(page.locator('#vault-master-form')).toBeVisible();
  await expect(page.locator('#vault-master-fields')).toBeHidden();
  await page.locator('[data-vault-master-method="password"]').click();
  await expect(page.locator('#vault-master-fields')).toBeVisible();
  await expect(page.locator('#vault-master-current-label')).toHaveText('Passphrase');
  await page.locator('#vault-master-change-method').click();
  await expect(page.locator('#vault-master-fields')).toBeHidden();
  await page.locator('[data-vault-master-method="recovery"]').click();
  await expect(page.locator('#vault-master-current-label')).toHaveText('Recovery key');
  await expectCredentialModalToFit(page, 'vault-master-modal', 'vault-new-master');
  await page.setViewportSize({width: 1280, height: 720});
  await expectCredentialModalToFit(page, 'vault-master-modal', 'vault-new-master');
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#vault-new-master').fill('password');
  await expect(page.locator('#vault-new-weak-confirm-row')).toBeVisible();
  await page.locator('#vault-new-master').fill('another strong encryption password phrase');
  await expect(page.locator('#vault-new-weak-confirm-row')).toBeHidden();
  await expect(page.locator('#vault-new-master-strength')).toHaveText('Strong passphrase');
  const newMaster = await page.locator('#vault-new-master').inputValue();
  await expect(page.locator('#vault-master-current-secret')).toHaveAttribute('autocomplete', 'off');
  await page.locator('#vault-master-current-secret').fill(recovery);
  await page.locator('#vault-new-master-confirm').fill(newMaster);
  await page.locator('#vault-master-submit').click();
  await expect(page.locator('#login-screen')).toBeVisible({timeout: 15000});
  await page.locator('#login-password').fill(newMaster);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-recovery').click();
  await expect(page.locator('#vault-recovery-methods')).toBeVisible();
  await expect(page.locator('#vault-recovery-fields')).toBeHidden();
  await page.locator('[data-vault-recovery-method="recovery"]').click();
  await expect(page.locator('#vault-recovery-current-label')).toHaveText('Recovery key');
  await page.locator('#vault-recovery-change-method').click();
  await expect(page.locator('#vault-recovery-current-secret')).toHaveValue('');
  await page.locator('[data-vault-recovery-method="password"]').click();
  await expectCredentialModalToFit(page, 'vault-recovery-modal', 'vault-recovery-current-secret');
  await page.setViewportSize({width: 1280, height: 720});
  await expectCredentialModalToFit(page, 'vault-recovery-modal', 'vault-recovery-current-secret');
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.locator('#vault-new-recovery-step')).toBeHidden();
  await expect(page.locator('#vault-recovery-submit')).toBeHidden();
  await expect(page.locator('#vault-recovery-current-label')).toHaveText('Passphrase');
  await expect(page.locator('#vault-recovery-current-secret')).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  await page.locator('#vault-recovery-current-secret').fill('incorrect passphrase');
  await page.locator('#vault-recovery-verify').click();
  await expect(page.locator('#vault-recovery-error')).toHaveText(
    'That passphrase or recovery key is incorrect.',
  );
  await expect(page.locator('#vault-new-recovery-step')).toBeHidden();
  await page.locator('#vault-recovery-current-secret').fill(newMaster);
  await page.locator('#vault-recovery-verify').click();
  await expect(page.locator('#vault-new-recovery-step')).toBeVisible();
  await expect(page.locator('#vault-new-recovery-key')).toHaveText(/^[a-z]+( [a-z]+){23}$/);
  await page.locator('#vault-recovery-current-secret').fill('changed after verification');
  await expect(page.locator('#vault-new-recovery-step')).toBeHidden();
  await expect(page.locator('#vault-recovery-submit')).toBeHidden();
  await page.locator('#vault-recovery-current-secret').fill(newMaster);
  await page.locator('#vault-recovery-verify').click();
  await expect(page.locator('#vault-new-recovery-step')).toBeVisible();
  const newRecovery = await page.locator('#vault-new-recovery-key').textContent();
  await page.locator('#vault-new-recovery-confirm').fill(newRecovery);
  await page.locator('#vault-recovery-submit').click();
  await expect(page.locator('#login-screen')).toBeVisible({timeout: 15000});

  const rotatedRecoveryDevice = await browser.newContext();
  try {
    const recoveryPage = await rotatedRecoveryDevice.newPage();
    await recoveryPage.goto('/');
    await recoveryPage.locator('#login-password').fill(master);
    await recoveryPage.locator('#login-form button[type="submit"]').click();
    await expect(recoveryPage.locator('#login-error')).toHaveText('Wrong passphrase');
    await enterRecoveryKey(recoveryPage, recovery);
    await recoveryPage.locator('#login-recovery-submit').click();
    await expect(recoveryPage.locator('#login-recovery-error')).toHaveText(
      'That recovery key did not unlock your notes. Check the words and their order.',
    );
    await recoveryPage.locator('#login-recovery-back').click();
    await recoveryPage.locator('#login-have-recovery').click();
    await recoveryPage.locator('#login-recovery-word').fill(newRecovery);
    await recoveryPage.locator('#login-recovery-word').press('Enter');
    await recoveryPage.locator('#login-recovery-submit').click();
    await expect(recoveryPage.locator(`.note-item[data-id="${noteID}"]`)).toBeVisible();
    await recoveryPage.locator('#recovery-dismiss-notice').click();
    await expect(recoveryPage.locator('#recovery-signin-notice')).toBeHidden();
  } finally {
    await rotatedRecoveryDevice.close();
  }

  const signedOutPage = await browser.newPage();
  try {
    await signedOutPage.addInitScript(() => {
      localStorage.setItem('vylk-revision', 'stale-browser-revision');
    });
    await signedOutPage.goto('/');
    await expect(signedOutPage.locator('.toast.update')).toContainText('New version available.');
    await expect(signedOutPage.locator('.toast.update .toast-action')).toHaveText('Reload');
    await expect(signedOutPage.locator('#login-forgot-password')).toBeVisible();
    await expect(signedOutPage.locator('#login-ask-each-time')).toHaveCount(0);
    await expect(signedOutPage.getByText('Start a new empty vault')).toHaveCount(0);
    await expect(signedOutPage.locator('#login-password')).toHaveAttribute('placeholder', ' ');
    await expect(signedOutPage.locator('#login-form .label-input__toggle')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    await signedOutPage.locator('#login-forgot-password').click();
    await expect(signedOutPage.locator('#login-recovery-form')).toBeHidden();
    await expect(signedOutPage.locator('.toast.update')).toBeHidden();
    await signedOutPage.locator('#login-no-recovery').click();
    await expect(signedOutPage.locator('#login-recovery-lost-modal')).toBeVisible();
    await expect(signedOutPage.locator('#login-recovery-entry-modal')).toBeHidden();
    await expect(signedOutPage.locator('#login-recovery-lost')).toContainText(
      'Restarting the server alone will not reset it.',
    );
    await signedOutPage.locator('#login-recovery-lost-back').click();
    await signedOutPage.locator('#login-have-recovery').click();
    await expect(signedOutPage.locator('#login-recovery-entry-modal')).toBeVisible();
    await expect(signedOutPage.locator('#login-recovery-lost-modal')).toBeHidden();
    await signedOutPage.locator('#login-recovery-word').fill('abandon');
    await signedOutPage.locator('#login-recovery-word').press('Enter');
    await expect(signedOutPage.locator('#login-recovery-count')).toHaveText('1/24 words');
    await signedOutPage.locator('.login-recovery-chip').click();
    await expect(signedOutPage.locator('#login-recovery-count')).toHaveText('0/24 words');
    await signedOutPage.locator('#login-recovery-word').evaluate((input, key) => {
      const data = new DataTransfer();
      data.setData('text', key);
      input.dispatchEvent(
        new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}),
      );
    }, newRecovery);
    await expect(signedOutPage.locator('#login-recovery-count')).toHaveText('24/24 words');
  } finally {
    await signedOutPage.close();
  }
});
