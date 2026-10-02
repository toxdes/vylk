import {expect, test} from '@playwright/test';

test('resumes an interrupted vault conversion after a page reload', async ({page}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Resume title');
  await page.locator('#note-content').fill('Resume body');
  await page.locator('#save-btn').click();
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+$/);
  const noteID = new URL(page.url()).pathname.slice(1);
  await page.locator('#back-btn').click();
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-setup').click();
  await page.locator('#vault-master').fill('correct horse battery staple!');
  await expect(page.locator('#vault-strength')).toHaveText('Strong passphrase');
  await expect(page.locator('#vault-recovery-key .vault-recovery-word')).toHaveCount(24);
  const master = await page.locator('#vault-master').inputValue();
  const recovery = (
    await page.locator('#vault-recovery-key .vault-recovery-word').allTextContents()
  ).join(' ');

  const startStatus = await page.evaluate(
    async ({master, recovery}) => {
      const vault = window.VylkVaultCrypto;
      const vaultID = vault.toBase64(vault.randomBytes(16));
      const salt = vault.toBase64(vault.randomBytes(16));
      const credential = await vault.credential(master, salt, vaultID);
      const recoveryCredential = await vault.recoveryCredential(recovery, vaultID);
      const raw = vault.randomBytes(32);
      const [wrapped, wrappedRecovery] = await Promise.all([
        vault.wrapVaultKey(raw, credential.wrappingKey, vaultID),
        vault.wrapVaultKey(raw, recoveryCredential.wrappingKey, vaultID),
      ]);
      raw.fill(0);
      const response = await fetch('/api/vault/migration/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          old_password: 'browser-test-password',
          vault_id: vaultID,
          kdf_salt: salt,
          kdf_memory_kib: vault.kdf.memoryKiB,
          kdf_iterations: vault.kdf.iterations,
          auth_proof: credential.loginProof,
          recovery_proof: recoveryCredential.loginProof,
          wrapped_key: wrapped,
          wrapped_recovery_key: wrappedRecovery,
        }),
      });
      return response.status;
    },
    {master, recovery},
  );
  expect(startStatus).toBe(200);

  await page.reload();
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#vault-title')).toHaveText('Resume encryption');
  await expect(page).toHaveURL(/\/preferences\/encryption\/setup$/);
  await page.locator('#vault-old-password').fill('browser-test-password');
  await page.locator('#vault-master').fill(master);
  await page.locator('#vault-master-confirm').fill(master);
  await expect(page.locator('#vault-recovery-key')).toBeHidden();
  for (const word of recovery.split(' ')) {
    await page.locator('#vault-recovery-confirm').fill(word);
    await page.locator('#vault-recovery-confirm').press('Enter');
  }
  await page.locator('#vault-start').click();
  await expect(page.locator('#vault-final-confirm-modal')).toBeVisible();
  // Interrupt after IndexedDB has been encrypted but before server cutover.
  await page.route('**/api/vault/migration/commit', (route) => route.abort('failed'));
  await page.locator('#vault-final-confirm-start').click();
  await expect(page.locator('#vault-error')).not.toHaveText('');
  expect(
    await page.evaluate(async () => {
      const request = indexedDB.open('vylk-offline');
      const db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      try {
        const marker = db
          .transaction('state', 'readonly')
          .objectStore('state')
          .get('vault-local-format');
        return await new Promise((resolve) => {
          marker.onsuccess = () => resolve(marker.result?.value);
        });
      } finally {
        db.close();
      }
    }),
  ).toBe(1);
  await page.unroute('**/api/vault/migration/commit');
  await page.reload();
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#vault-title')).toHaveText('Resume encryption');
  await page.locator('#vault-old-password').fill('browser-test-password');
  await page.locator('#vault-master').fill(master);
  await page.locator('#vault-master-confirm').fill(master);
  for (const word of recovery.split(' ')) {
    await page.locator('#vault-recovery-confirm').fill(word);
    await page.locator('#vault-recovery-confirm').press('Enter');
  }
  await page.locator('#vault-start').click();
  await expect(page.locator('#vault-final-confirm-modal')).toBeVisible();
  await Promise.all([
    page.waitForEvent('load'),
    page.locator('#vault-final-confirm-start').click(),
  ]);
  await expect(page.locator('#login-screen')).toBeVisible({timeout: 30000});
  await page.locator('#login-password').fill(master);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible({timeout: 30000});
  await expect(page.locator(`.note-item[data-id="${noteID}"]`)).toBeVisible();
});
