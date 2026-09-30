import {expect, test} from '@playwright/test';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('groups browser tabs as one device and signs out another browser', async ({page, browser}) => {
  test.setTimeout(90000);
  await signIn(page);
  const tab = await page.context().newPage();
  await tab.goto('/');
  await expect(tab.locator('#dashboard')).toBeVisible();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await signIn(other);
    const otherID = (await otherContext.cookies()).find(
      (cookie) => cookie.name === 'vylk-device',
    ).value;
    await page.locator('#prefs-btn').click();
    await page.locator('#prefs-tab-account').click();
    await expect(page.locator('#devices-status')).toHaveText('');
    const current = page.locator('#devices-list .pref-row').filter({hasText: 'This device'});
    await expect(current).toHaveCount(1);
    const result = await page.request.get('/api/devices');
    const devices = (await result.json()).devices;
    expect(devices.some((device) => device.id === otherID && !device.current)).toBe(true);
    const remote = page.locator(`#devices-list .pref-row[data-device-id="${otherID}"]`);
    await remote.getByRole('button', {name: /Sign out/}).click();
    await expect(page.locator('#device-signout-modal')).toBeVisible();
    await page.locator('#device-signout-cancel').click();
    expect((await other.request.get('/api/check')).status()).toBe(200);
    await remote.getByRole('button', {name: /Sign out/}).click();
    await page.locator('#device-signout-confirm').click();
    await expect(page.locator('#device-signout-modal')).toBeHidden();
    expect((await other.request.get('/api/check')).status()).toBe(401);
    // Remote revocation is detected by SSE's 25-second heartbeat when idle.
    await expect(other.locator('#login-screen')).toBeVisible({timeout: 60000});
    await expect(tab.locator('#dashboard')).toBeVisible();
    if (process.env.VYLK_CAPTURE_DEVICES) {
      await page.screenshot({path: '.impeccable/review/devices-desktop.png', fullPage: true});
      await page.setViewportSize({width: 390, height: 844});
      await page.screenshot({path: '.impeccable/review/devices-mobile.png', fullPage: true});
    }
  } finally {
    await tab.close();
    await otherContext.close();
  }
});
