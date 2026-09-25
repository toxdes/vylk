import {expect, test} from '@playwright/test';

const password = 'browser-test-password';

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

async function enableInteractivePreview(page) {
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-editor').click();
  const preference = page.locator('#pref-interactive-preview');
  if (!(await preference.isChecked())) await preference.check();
  await page.locator('#prefs-close').click();
}

test('note cards stay stationary on hover', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Stationary hover');
  await page.locator('#note-content').fill('Hovering this card must not move it.');
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();

  const card = page.locator('.note-item').filter({hasText: 'Stationary hover'});
  await card.hover();
  await expect(card).toHaveCSS('transform', 'none');
});

test('preferences headers align and Account owns the restore confirmation', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();

  const [sidebarTitle, contentHeader] = await Promise.all([
    page.locator('.prefs-sidebar-title').boundingBox(),
    page.locator('.prefs-content-header').boundingBox(),
  ]);
  expect(sidebarTitle).not.toBeNull();
  expect(contentHeader).not.toBeNull();
  expect(Math.abs(sidebarTitle.y - contentHeader.y)).toBeLessThanOrEqual(1);

  await page.locator('#prefs-tab-account').click();
  await page.locator('#prefs-restore-defaults').click();
  await expect(page.locator('#restore-defaults-modal')).toBeVisible();
  await expect(page.locator('#restore-defaults-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#restore-defaults-modal')).toBeHidden();
  await expect(page.locator('#prefs-modal')).toBeVisible();
});

test('sign out confirms and returns to the login screen', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-account').click();
  await page.locator('#logout-btn').click();

  await expect(page.locator('#logout-modal')).toBeVisible();
  await expect(page.locator('#logout-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#logout-modal')).toBeHidden();
  await expect(page.locator('#prefs-modal')).toBeVisible();

  await page.locator('#logout-btn').click();
  await page.locator('#logout-confirm').click();
  await expect(page.locator('#login-screen')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
  await expect(page.locator('#prefs-modal')).toBeHidden();
});

test('scrollbars reserve their own space and stay below mobile preference tabs', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await signIn(page);
  await page.locator('#prefs-btn').click();

  const metrics = await page.evaluate(() => {
    const rail = document.querySelector('.prefs-tabs-scroll');
    const tabs = document.querySelector('.prefs-tabs');
    const section = document.querySelector('.prefs-section.active');
    const railBox = rail.getBoundingClientRect();
    const tabsBox = tabs.getBoundingClientRect();
    return {
      bodyGutter: getComputedStyle(document.documentElement).scrollbarGutter,
      sectionGutter: getComputedStyle(section).scrollbarGutter,
      sectionPaddingRight: getComputedStyle(section).paddingRight,
      railOverflow: getComputedStyle(rail).overflowX,
      tabRailGap: railBox.bottom - tabsBox.bottom,
    };
  });

  expect(metrics.bodyGutter).toBe('stable');
  expect(metrics.sectionGutter).toBe('stable');
  expect(metrics.sectionPaddingRight).toBe('0px');
  expect(metrics.railOverflow).toBe('auto');
  expect(metrics.tabRailGap).toBeGreaterThanOrEqual(7);
});

test('editor offline notice follows the configured content rail', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 960});
  await signIn(page);
  await page.locator('#new-note-btn').click();

  const alignment = await page.evaluate(() => {
    const editor = document.querySelector('#editor');
    const notice = editor.querySelector('.offline-notice').cloneNode(true);
    notice.classList.remove('hidden');
    notice.setAttribute('aria-hidden', 'true');
    Object.assign(notice.style, {
      left: '0',
      position: 'absolute',
      top: '0',
      visibility: 'hidden',
    });
    editor.append(notice);

    const body = editor.querySelector('.editor-body');
    const bodyRect = body.getBoundingClientRect();
    const result = {
      noticeContentLeft: notice
        .querySelector('.offline-notice-message')
        .getBoundingClientRect().left,
      editorContentLeft: bodyRect.left + Number.parseFloat(getComputedStyle(body).paddingLeft),
    };
    notice.remove();
    return result;
  });
  expect(Math.abs(alignment.noticeContentLeft - alignment.editorContentLeft)).toBeLessThanOrEqual(
    1,
  );
});

test('editor and preview content stay aligned while the splitter remains unobtrusive', async ({
  page,
}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();

  await expect(page.locator('#editor-panel .panel-label')).toBeHidden();
  await expect(page.locator('#view-controls')).toBeVisible();
  await expect(page.locator('#save-btn')).toBeVisible();

  const resizer = page.locator('#panel-resizer');
  await expect(resizer).toBeVisible();
  const affordance = await resizer.evaluate((element) => ({
    cursor: getComputedStyle(element).cursor,
    before: getComputedStyle(element, '::before').content,
    after: getComputedStyle(element, '::after').content,
  }));
  expect(affordance).toEqual({cursor: 'col-resize', before: 'none', after: 'none'});

  const contentTops = await page.evaluate(() => {
    const source = document.querySelector('#note-content');
    const preview = document.querySelector('#preview');
    const sourcePanel = document.querySelector('#editor-panel');
    const previewPanel = document.querySelector('#preview-panel');
    const sourceRect = source.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    return {
      source: sourceRect.top + Number.parseFloat(getComputedStyle(source).paddingTop),
      preview: previewRect.top + Number.parseFloat(getComputedStyle(preview).paddingTop),
      sourceInset:
        sourceRect.left +
        Number.parseFloat(getComputedStyle(source).paddingLeft) -
        sourcePanel.getBoundingClientRect().left,
      previewInset:
        previewRect.left +
        Number.parseFloat(getComputedStyle(preview).paddingLeft) -
        previewPanel.getBoundingClientRect().left,
    };
  });
  expect(Math.abs(contentTops.source - contentTops.preview)).toBeLessThanOrEqual(1);
  expect(Math.abs(contentTops.sourceInset - contentTops.previewInset)).toBeLessThanOrEqual(1);

  await expect(page.locator('.view-control[aria-pressed="true"]')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );

  await resizer.focus();
  await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '55');

  await page.locator('.fmt-bar').evaluate((toolbar) => toolbar.classList.add('hidden'));
  await expect(page.locator('.fmt-bar')).toBeHidden();

  await page.locator('#note-content').fill('First line');
  await page.locator('#note-content').click();
  await expect(page.locator('.editor-current-line')).toHaveCSS('opacity', '1');
  await expect(page.locator('.editor-current-line')).toHaveCSS('border-top-left-radius', '0px');
  const cueAndControls = await page.evaluate(() => {
    const cue = document.querySelector('.editor-current-line');
    const controls = document.querySelector('#editor-panel .panel-header');
    return {
      cueTop: cue.getBoundingClientRect().top,
      controlsBottom: controls.getBoundingClientRect().bottom,
    };
  });
  expect(cueAndControls.cueTop).toBeGreaterThanOrEqual(cueAndControls.controlsBottom);
  const hiddenToolbarContentTops = await page.evaluate(() => {
    const source = document.querySelector('#note-content');
    const preview = document.querySelector('#preview');
    const sourceRect = source.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    return {
      source: sourceRect.top + Number.parseFloat(getComputedStyle(source).paddingTop),
      preview: previewRect.top + Number.parseFloat(getComputedStyle(preview).paddingTop),
    };
  });
  expect(
    Math.abs(hiddenToolbarContentTops.source - hiddenToolbarContentTops.preview),
  ).toBeLessThanOrEqual(1);

  await page.locator('#note-content').fill('A preview block must share the editor gutter.');
  await enableInteractivePreview(page);
  await expect(page.locator('#preview .preview-drag-content')).toBeVisible();
  const interactiveInset = await page.evaluate(() => {
    const preview = document.querySelector('#preview');
    const content = document.querySelector('#preview .preview-drag-content');
    const previewRect = preview.getBoundingClientRect();
    return {
      renderedContent: content.getBoundingClientRect().left - previewRect.left,
      previewGutter: Number.parseFloat(getComputedStyle(preview).paddingLeft),
    };
  });
  expect(
    Math.abs(interactiveInset.renderedContent - interactiveInset.previewGutter),
  ).toBeLessThanOrEqual(1);
});

test('mobile editor controls stay clear of the formatting toolbar', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await signIn(page);
  await page.locator('#new-note-btn').click();

  const [toolbar, controls] = await Promise.all([
    page.locator('.fmt-bar').boundingBox(),
    page.locator('#editor-panel .panel-header').boundingBox(),
  ]);
  expect(toolbar).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(controls.y).toBeGreaterThan(toolbar.y + toolbar.height);

  const contentInsets = await page.evaluate(() => {
    const source = document.querySelector('#note-content');
    const preview = document.querySelector('#preview');
    const sourcePanel = document.querySelector('#editor-panel');
    const previewPanel = document.querySelector('#preview-panel');
    return {
      source:
        source.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(source).paddingTop) -
        sourcePanel.getBoundingClientRect().top,
      preview:
        preview.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(preview).paddingTop) -
        previewPanel.getBoundingClientRect().top,
      sourceInset:
        source.getBoundingClientRect().left +
        Number.parseFloat(getComputedStyle(source).paddingLeft) -
        sourcePanel.getBoundingClientRect().left,
      previewInset:
        preview.getBoundingClientRect().left +
        Number.parseFloat(getComputedStyle(preview).paddingLeft) -
        previewPanel.getBoundingClientRect().left,
    };
  });
  expect(Math.abs(contentInsets.source - contentInsets.preview)).toBeLessThanOrEqual(1);
  expect(Math.abs(contentInsets.sourceInset - contentInsets.previewInset)).toBeLessThanOrEqual(1);
  await expect(page.locator('#panel-resizer')).toBeHidden();
});
