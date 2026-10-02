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

test('heading toolbar uses one compact picker for levels one through five', async ({page}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();
  const source = page.locator('#note-content');
  await source.fill('Heading');
  const trigger = page.locator('.fmt-bar [data-fmt="heading"]');
  await expect(page.locator('.fmt-bar [data-fmt="heading"]')).toHaveCount(1);
  await expect(
    page.locator(
      '.fmt-bar [data-fmt="h1"], .fmt-bar [data-fmt="h2"], .fmt-bar [data-fmt="h3"], .fmt-bar [data-fmt="h4"]',
    ),
  ).toHaveCount(0);
  await trigger.click();
  const picker = page.getByRole('dialog', {name: 'Choose heading level'});
  await expect(picker.getByRole('button')).toHaveCount(5);
  await picker.getByRole('button', {name: 'Heading 5'}).click();
  await expect(source).toHaveValue('##### Heading');
  await expect(picker).toBeHidden();
  await trigger.click();
  await picker.getByRole('button', {name: 'Heading 2'}).click();
  await expect(source).toHaveValue('## Heading');
  await page.setViewportSize({width: 390, height: 844});
  await trigger.click();
  const popup = await picker.boundingBox();
  expect(popup).not.toBeNull();
  expect(popup.x).toBeGreaterThanOrEqual(0);
  expect(popup.x + popup.width).toBeLessThanOrEqual(390);
});

test('login, dashboard, and editor use the shared page background', async ({page}) => {
  await signIn(page);

  const themes = await page.evaluate(() => window.VylkThemes.map(({id, vars}) => ({id, vars})));
  const pageSelectors = ['#login-screen', '#dashboard', '#editor'];
  for (const {id, vars} of themes) {
    const colors = await page.evaluate(
      ({themeID, themeVars, selectors}) => {
        const root = document.documentElement;
        root.dataset.theme = themeID;
        root.classList.toggle('dark', window.VylkThemes.find(({id}) => id === themeID).dark);
        Object.entries(themeVars).forEach(([name, value]) => {
          const kebabName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          root.style.setProperty(`--${kebabName}`, value);
        });
        return {
          page: getComputedStyle(document.body).backgroundColor,
          surfaces: selectors.map((selector) => ({
            selector,
            color: getComputedStyle(document.querySelector(selector)).backgroundColor,
          })),
        };
      },
      {themeID: id, themeVars: vars, selectors: pageSelectors},
    );
    for (const surface of colors.surfaces) {
      expect(surface.color, `${id} ${surface.selector} should use the page canvas`).toBe(
        colors.page,
      );
    }
  }
});

test('preferences modal and sidebar use their theme surfaces', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();

  const themes = await page.evaluate(() => window.VylkThemes.map(({id, vars}) => ({id, vars})));
  for (const {id, vars} of themes) {
    const colors = await page.evaluate(
      ({themeID, themeVars}) => {
        const root = document.documentElement;
        root.dataset.theme = themeID;
        root.classList.toggle('dark', window.VylkThemes.find(({id}) => id === themeID).dark);
        Object.entries(themeVars).forEach(([name, value]) => {
          const kebabName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          root.style.setProperty(`--${kebabName}`, value);
        });
        return {
          card: getComputedStyle(document.querySelector('#login-form')).backgroundColor,
          modal: getComputedStyle(document.querySelector('#prefs-modal .prefs-modal-body'))
            .backgroundColor,
          surface: (() => {
            const sample = document.createElement('div');
            sample.style.background = 'var(--surface)';
            document.body.append(sample);
            const color = getComputedStyle(sample).backgroundColor;
            sample.remove();
            return color;
          })(),
          sidebar: getComputedStyle(document.querySelector('.prefs-sidebar')).backgroundColor,
        };
      },
      {themeID: id, themeVars: vars},
    );
    expect(colors.modal, `${id} preferences modal`).toBe(colors.card);
    expect(colors.sidebar, `${id} preferences sidebar`).toBe(colors.surface);
  }
});

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

test('preference rows and shortcut reset use consistent feedback', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();

  const appearanceWidth = page.locator('#prefs-panel-appearance .pref-control').first();
  await expect(appearanceWidth).toHaveCSS('border-top-width', '0px');
  await appearanceWidth.hover();
  const selectRowColor = await appearanceWidth
    .locator('strong')
    .first()
    .evaluate((element) => getComputedStyle(element).color);

  await page.locator('#prefs-tab-zen').click();
  await expect(page.locator('#prefs-panel-zen .pref-control').first()).toHaveCSS(
    'border-top-width',
    '0px',
  );
  const toggleRow = page.locator('#prefs-panel-zen .pref-row').first();
  await toggleRow.hover();
  await expect(toggleRow.locator('strong')).toHaveCSS('color', selectRowColor);

  await page.locator('#prefs-tab-shortcuts').click();
  await expect(page.locator('.shortcut-reset-row')).toContainText('Default shortcuts');
  await expect(page.locator('.shortcut-reset-row')).toHaveCSS('border-bottom-width', '1px');
  await expect(page.locator('.shortcut-prefix-row')).toHaveCSS('border-top-width', '0px');
  await page.locator('#shortcut-reset').click();
  await expect(page.locator('#shortcut-reset-modal')).toBeVisible();
  await page.locator('#shortcut-reset-cancel').click();
  await expect(page.locator('#shortcut-reset-modal')).toBeHidden();
  await page.locator('#shortcut-reset').click();
  await page.locator('#shortcut-reset-confirm').click();
  await expect(page.locator('.toast.success')).toContainText('Default shortcuts restored.');
  await expect(page.locator('#shortcut-recorder-status')).toBeEmpty();
});

test('dashboard and editor share page gutters while Preferences fits the viewport', async ({
  page,
}) => {
  const viewports = [
    {width: 390, height: 844},
    {width: 768, height: 900},
    {width: 1440, height: 960},
  ];
  const contentEdges = (selector) =>
    page.locator(selector).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: bounds.left + Number.parseFloat(style.paddingLeft),
        right: bounds.right - Number.parseFloat(style.paddingRight),
      };
    });
  const expectEdgesToMatch = (first, second) => {
    expect(Math.abs(first.left - second.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.right - second.right)).toBeLessThanOrEqual(1);
  };

  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-title').fill('Aligned page rails');
  await page.locator('#note-content').fill('This note provides a visible card edge.');
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();

  const unconvertedFields = await page
    .locator(
      '#app input[type="text"]:not(.label-input__control), #app input[type="password"]:not(.label-input__control)',
    )
    .count();
  expect(unconvertedFields).toBe(0);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.locator('#dashboard .dashboard-body').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });

    const dashboardHeader = await contentEdges('#dashboard .header-inner');
    const dashboardCard = await page
      .locator('.note-item')
      .filter({hasText: 'Aligned page rails'})
      .boundingBox();
    expect(dashboardCard).not.toBeNull();
    expect(Math.abs(dashboardCard.x - dashboardHeader.left)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(dashboardCard.x + dashboardCard.width - dashboardHeader.right),
    ).toBeLessThanOrEqual(1);

    await page.locator('#new-note-btn').click();
    await page.locator('#editor .editor-body').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const editorHeader = await contentEdges('#editor > header .header-inner');
    expectEdgesToMatch(dashboardHeader, editorHeader);
    const editorPanel = await page.locator('#editor .meta-pane').boundingBox();
    expect(editorPanel).not.toBeNull();
    expect(Math.abs(editorPanel.x - dashboardHeader.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(editorPanel.x + editorPanel.width - dashboardHeader.right)).toBeLessThanOrEqual(
      1,
    );
    await page.locator('#back-btn').click();

    await page.locator('#prefs-btn').click();
    await page.locator('#prefs-modal .prefs-modal-body').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const prefsHeadingBox = await page.locator('.prefs-content-header h2').boundingBox();
    const prefsCloseBox = await page.locator('#prefs-close').boundingBox();
    const prefsControlBox = await page
      .locator('.prefs-section.active .pref-control')
      .first()
      .boundingBox();
    expect(prefsHeadingBox).not.toBeNull();
    expect(prefsCloseBox).not.toBeNull();
    expect(prefsControlBox).not.toBeNull();
    expect(Math.abs(prefsControlBox.x - prefsHeadingBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(prefsControlBox.x + prefsControlBox.width - prefsCloseBox.x - prefsCloseBox.width),
    ).toBeLessThanOrEqual(1);
    const prefsShell = await page.locator('#prefs-modal .prefs-modal-body').boundingBox();
    expect(prefsShell).not.toBeNull();
    expect(prefsShell.x).toBeGreaterThanOrEqual(0);
    expect(prefsShell.y).toBeGreaterThanOrEqual(0);
    expect(prefsShell.x + prefsShell.width).toBeLessThanOrEqual(viewport.width);
    expect(prefsShell.y + prefsShell.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.width <= 640) {
      const prefsRail = await page.locator('.prefs-tabs-scroll').boundingBox();
      expect(prefsRail).not.toBeNull();
      expect(prefsRail.x).toBeGreaterThanOrEqual(prefsShell.x);
      expect(prefsRail.x + prefsRail.width).toBeLessThanOrEqual(prefsShell.x + prefsShell.width);
    }
    await page.locator('#prefs-close').click();
  }
});

test('label inputs float their labels and toggle password visibility', async ({page}) => {
  await page.goto('/');
  const passwordInput = page.locator('#login-password');
  const label = page.locator('label[for="login-password"]');
  const toggle = page.locator('[data-password-toggle="login-password"]');

  await expect(passwordInput).toHaveAttribute('placeholder', ' ');
  await expect(label).toHaveText('Password');
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await passwordInput.focus();
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).top)).toBe('0px');

  await passwordInput.fill('browser-test-password');
  await passwordInput.blur();
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).top)).toBe('0px');

  await toggle.click();
  await expect(passwordInput).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Hide password');
  await toggle.click();
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  const badge = page.locator('#sync-status');
  await expect(badge).toHaveCSS('border-top-width', '0px');
  await expect(badge).toHaveCSS('border-top-left-radius', '4px');
  await expect(badge).toHaveCSS('font-size', '12px');
  await expect(badge).toHaveCSS('font-weight', '500');
  await expect(badge).toHaveCSS('line-height', '12px');
  await expect(badge).toHaveCSS('padding', '4px 6px');
  await expect(badge).toHaveCSS('gap', '4px');

  const dot = page.locator('#sync-status .sync-indicator-dot');
  await expect(dot).toHaveCSS('width', '6px');
  await expect(dot).toHaveCSS('height', '6px');
  await expect(dot).toHaveCSS('border-radius', '50%');
  await expect(dot).toHaveCSS('box-shadow', 'none');
  await expect(badge).toHaveCSS('margin', '0px');

  await page.evaluate(() => {
    document.documentElement.dataset.statusDisplay = 'compact';
  });
  await expect(badge).toHaveCSS('padding', '4px');
  await expect(badge).toHaveCSS('width', '14px');
});

test('encryption inputs use one focus ring', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-encryption').click();
  await page.locator('#vault-open-setup').click();

  const password = page.locator('#vault-old-password');
  await password.focus();
  await expect(password).toHaveCSS('outline-style', 'none');
  await expect
    .poll(async () =>
      password.evaluate((element) => {
        const accentSample = document.createElement('span');
        accentSample.style.color = 'var(--accent)';
        document.body.append(accentSample);
        const accent = getComputedStyle(accentSample).color;
        accentSample.remove();
        return getComputedStyle(element).borderColor === accent;
      }),
    )
    .toBe(true);
  await expect(password).not.toHaveCSS('box-shadow', 'none');
});

test('status badge colors come from every theme palette', async ({page}) => {
  await signIn(page);

  const result = await page.evaluate(() => {
    const badge = document.querySelector('#sync-status');
    const root = document.documentElement;
    const stateTokens = {
      online: 'online',
      local: 'syncing',
      syncing: 'syncing',
      offline: 'offline',
    };
    const toRGB = (hex) => {
      const digits = hex.slice(1);
      const full =
        digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits;
      const values = full.match(/.{2}/g).map((value) => Number.parseInt(value, 16));
      return `rgb(${values.join(', ')})`;
    };

    return window.VylkThemes.map((theme) => {
      Object.entries(theme.vars).forEach(([name, value]) => {
        const property = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        root.style.setProperty(`--${property}`, value);
      });

      const states = Object.entries(stateTokens).map(([state, token]) => {
        badge.dataset.state = state;
        const style = getComputedStyle(badge);
        return {
          state,
          expected: theme.vars[token] ? toRGB(theme.vars[token]) : null,
          actual: style.color,
          background: style.backgroundColor,
          card: getComputedStyle(root).getPropertyValue('--card-bg').trim(),
        };
      });
      return {id: theme.id, states};
    });
  });

  expect(result.length).toBeGreaterThan(0);
  for (const theme of result) {
    for (const state of theme.states) {
      expect(state.expected, `${theme.id} must define ${state.state} status color`).not.toBeNull();
      expect(state.actual, `${theme.id} ${state.state} badge text`).toBe(state.expected);
      expect(state.background, `${theme.id} ${state.state} badge tint`).not.toBe(state.card);
    }
  }
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
  expect(Number.parseFloat(metrics.sectionPaddingRight)).toBeGreaterThanOrEqual(8);
  expect(metrics.railOverflow).toBe('auto');
  expect(metrics.tabRailGap).toBeGreaterThanOrEqual(9.5);
});

test('preference sections enter quickly and respect reduced motion', async ({page}) => {
  await signIn(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-editor').click();
  await expect(page.locator('#prefs-panel-editor')).toBeVisible();
  await expect(page.locator('#prefs-panel-editor')).toHaveCSS('animation-name', 'app-content-in');

  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.locator('#prefs-tab-encryption').click();
  await expect(page.locator('#prefs-panel-encryption')).toBeVisible();
  await expect(page.locator('#prefs-panel-encryption')).toHaveCSS('animation-name', 'none');
});

test('dashboard and editor content enter on navigation and respect reduced motion', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.locator('#dashboard .dashboard-body')).toHaveCSS(
    'animation-name',
    'app-content-in',
  );
  await page.evaluate(() => {
    window.screenEntrances = {dashboard: 0, editor: 0};
    for (const screen of ['dashboard', 'editor']) {
      const body = document.querySelector(`#${screen} .${screen}-body`);
      const animationName = screen === 'dashboard' ? 'app-content-return' : 'app-content-in';
      // The sign-in entrance may start after this listener is installed, and
      // animation events from descendants bubble. Count only this navigation.
      body.addEventListener('animationstart', (event) => {
        if (event.target === body && event.animationName === animationName) {
          window.screenEntrances[screen]++;
        }
      });
    }
    // Reproduce irrelevant events deterministically instead of depending on
    // whether the browser delivers the sign-in entrance before this listener.
    const dashboardBody = document.querySelector('#dashboard .dashboard-body');
    dashboardBody.dispatchEvent(
      new AnimationEvent('animationstart', {animationName: 'app-content-in'}),
    );
    const child = dashboardBody.appendChild(document.createElement('span'));
    child.dispatchEvent(
      new AnimationEvent('animationstart', {animationName: 'app-content-return', bubbles: true}),
    );
    child.remove();
  });
  expect(await page.evaluate(() => window.screenEntrances)).toEqual({dashboard: 0, editor: 0});

  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor .editor-body')).toHaveCSS('animation-name', 'app-content-in');
  await expect.poll(() => page.evaluate(() => window.screenEntrances.editor)).toBe(1);

  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.screenEntrances.dashboard)).toBe(1);

  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#editor .editor-body')).toHaveCSS('animation-name', 'none');
  await page.locator('#back-btn').click();
  await expect(page.locator('#dashboard .dashboard-body')).toHaveCSS('animation-name', 'none');
});

test('clipped editor controls keep their focus rings inside and clear the scrollbar', async ({
  page,
}) => {
  await page.setViewportSize({width: 390, height: 844});
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.keyboard.press('Tab');
  await page.locator('.meta-toggle').focus();
  await expect(page.locator('.meta-toggle')).toHaveCSS('outline-offset', '-3px');

  const toolbar = page.locator('#editor .fmt-bar');
  await expect(toolbar).toHaveCSS('scrollbar-gutter', 'stable');
  const bottomPadding = await toolbar.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingBottom),
  );
  expect(bottomPadding).toBeGreaterThanOrEqual(8);
  const firstFormattingButton = toolbar.locator('button').first();
  await firstFormattingButton.focus();
  await expect(firstFormattingButton).toHaveCSS('outline-offset', '-2px');
});

test('editor offline notice follows the configured content rail', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 960});
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#view-controls [data-panel="both"]').click();
  await expect(page.locator('#editor-panels')).not.toHaveClass(/panels-single/);

  const readAlignment = () =>
    page.evaluate(() => {
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
        noticeContentLeft: notice.querySelector('.offline-notice-message').getBoundingClientRect()
          .left,
        editorContentLeft: bodyRect.left + Number.parseFloat(getComputedStyle(body).paddingLeft),
      };
      notice.remove();
      return Math.abs(result.noticeContentLeft - result.editorContentLeft);
    });
  await expect.poll(readAlignment).toBeLessThanOrEqual(1);
});

test('editor and preview content stay aligned while the splitter remains unobtrusive', async ({
  page,
}) => {
  await signIn(page);
  await page.locator('#new-note-btn').click();

  await expect(page.locator('#editor-panel .panel-label')).toBeHidden();
  await expect(page.locator('#view-controls')).toBeVisible();
  await expect(page.locator('#save-btn')).toBeVisible();

  const desktopControlSurface = await page
    .locator('#editor-panel .panel-header-actions')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const panel = element.closest('.panel').getBoundingClientRect();
      const actions = element.getBoundingClientRect();
      return {
        borderTop: style.borderTopWidth,
        borderRight: style.borderRightWidth,
        borderBottom: style.borderBottomWidth,
        borderLeft: style.borderLeftWidth,
        bottomLeftRadius: style.borderBottomLeftRadius,
        topRightRadius: style.borderTopRightRadius,
        rightEdgeAligned: Math.abs(actions.right - panel.right) <= 1,
      };
    });
  expect(desktopControlSurface).toEqual({
    borderTop: '0px',
    borderRight: '0px',
    borderBottom: '1px',
    borderLeft: '1px',
    bottomLeftRadius: '8px',
    topRightRadius: '0px',
    rightEdgeAligned: true,
  });

  const desktopToolbar = await page.locator('#editor-panel .fmt-bar').boundingBox();
  const desktopControls = await page.locator('#editor-panel .panel-header').boundingBox();
  expect(desktopToolbar).not.toBeNull();
  expect(desktopControls).not.toBeNull();
  expect(desktopControls.y + desktopControls.height).toBeLessThanOrEqual(desktopToolbar.y);

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

test('preview-only mode keeps long prose at a readable measure', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 960});
  await signIn(page);
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill(`Long-form preview ${'stays readable '.repeat(80)}`);
  await enableInteractivePreview(page);
  await page.locator('#view-controls [data-panel="preview"]').click();

  const measure = await page
    .locator('#preview .interactive-preview-block-card')
    .evaluate((card) => {
      const preview = card.closest('.preview').getBoundingClientRect();
      const block = card.getBoundingClientRect();
      return {blockWidth: block.width, previewWidth: preview.width};
    });
  expect(measure.blockWidth).toBeLessThanOrEqual(measure.previewWidth * 0.8);
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
  expect(controls.y + controls.height).toBeLessThanOrEqual(toolbar.y);
  expect(controls.height).toBeCloseTo(29, 0);

  const topRightButtons = page.locator('#editor-panel .panel-header-actions button');
  await expect(topRightButtons).toHaveCount(5);
  for (const button of await topRightButtons.all()) {
    const bounds = await button.boundingBox();
    expect(bounds.width).toBe(24);
    expect(bounds.height).toBe(24);
  }

  const controlSurface = await page
    .locator('#editor-panel .panel-header-actions')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const panel = element.closest('.panel').getBoundingClientRect();
      const actions = element.getBoundingClientRect();
      return {
        borderTop: style.borderTopWidth,
        padding: style.paddingTop,
        borderRight: style.borderRightWidth,
        borderBottom: style.borderBottomWidth,
        borderLeft: style.borderLeftWidth,
        bottomLeftRadius: style.borderBottomLeftRadius,
        topRightRadius: style.borderTopRightRadius,
        rightEdgeAligned: Math.abs(actions.right - panel.right) <= 1,
      };
    });
  expect(controlSurface).toEqual({
    borderTop: '0px',
    padding: '2px',
    borderRight: '0px',
    borderBottom: '1px',
    borderLeft: '1px',
    bottomLeftRadius: '8px',
    topRightRadius: '0px',
    rightEdgeAligned: true,
  });
  await expect(page.locator('#editor-panel .fmt-bar')).toHaveCSS('padding-right', '6.4px');
  const formattingButton = page.locator('#editor-panel .fmt-bar button').first();
  const formattingButtonBox = await formattingButton.boundingBox();
  expect(formattingButtonBox).not.toBeNull();
  expect(formattingButtonBox.width).toBe(24);
  expect(formattingButtonBox.height).toBe(24);
  const iconWidths = await formattingButton.locator('.icon').evaluate((icon) => ({
    toolbar: Number.parseFloat(getComputedStyle(icon).width),
    corner: Number.parseFloat(
      getComputedStyle(document.querySelector('#view-controls .icon')).width,
    ),
  }));
  expect(iconWidths.toolbar).toBeCloseTo(iconWidths.corner, 1);

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
  expect(contentInsets.source).toBeGreaterThan(contentInsets.preview);
  expect(Math.abs(contentInsets.sourceInset - contentInsets.previewInset)).toBeLessThanOrEqual(1);

  const previewSpacing = await page.locator('#preview').evaluate((preview) => {
    const style = getComputedStyle(preview);
    const controls = document.querySelector('#editor-panel .panel-header-actions');
    const toolbar = document.querySelector('#editor-panel .fmt-bar');
    return {
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      interactive: preview.classList.contains('interactive-preview-active'),
      controlsHeight: controls.getBoundingClientRect().height,
      toolbarPaddingRight: Number.parseFloat(getComputedStyle(toolbar).paddingRight),
    };
  });
  expect(previewSpacing.paddingTop).toBe(12);
  expect(previewSpacing.toolbarPaddingRight).toBeCloseTo(6.4, 1);
  expect(previewSpacing.paddingLeft).toBe(16);
  expect(previewSpacing.paddingBottom).toBe(64);

  if (!previewSpacing.interactive) await enableInteractivePreview(page);
  await expect(page.locator('#preview')).toHaveCSS('padding-top', '12px');
  await expect(page.locator('#panel-resizer')).toBeHidden();
});
