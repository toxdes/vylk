import {expect, test} from '@playwright/test';
import {useEditorFixture} from './editor-fixture.js';

// Align component bounds to content rails; icons remain centered in their controls.
async function inspect(page, name, root, kind, axis = 'vertical') {
  return page.evaluate(
    ({name, root, kind, axis}) => {
      document.querySelector('#layout-guides')?.remove();
      const visible = (element) =>
        element &&
        element.getClientRects().length &&
        getComputedStyle(element).visibility !== 'hidden';
      const bounds = (element) => {
        const box = element.getBoundingClientRect();
        return {left: box.left, right: box.right, top: box.top, bottom: box.bottom};
      };
      const inner = (element) => {
        const box = bounds(element);
        const css = getComputedStyle(element);
        return {
          ...box,
          left: box.left + element.clientLeft + parseFloat(css.paddingLeft),
          right: box.left + element.clientLeft + element.clientWidth - parseFloat(css.paddingRight),
        };
      };
      const host = document.querySelector(root);
      const rail = inner(
        kind === 'preferences'
          ? host.querySelector('.prefs-content-header')
          : ['dashboard', 'editor'].includes(kind)
            ? host.querySelector('.header-inner')
            : host,
      );
      const checks = [];
      const horizontal = axis === 'horizontal';
      const rails = new Set(horizontal ? [] : [rail.left, rail.right]);
      const guideKinds = new Map();
      const check = (label, actual, expected, verticalRail = true, tolerance = 1) => {
        if (verticalRail) rails.add(expected);
        checks.push({label, actual, expected, tolerance, error: Math.abs(actual - expected)});
      };
      const edges = (element, reference, label) => {
        if (!visible(element)) return;
        const box = bounds(element);
        check(`${label}: start`, box.left, reference.left);
        check(`${label}: end`, box.right, reference.right);
      };
      if (!horizontal) {
        if (kind === 'login') {
          host
            .querySelectorAll(
              '#login-credentials > .label-input, #login-credentials > button[type="submit"]',
            )
            .forEach((element) => edges(element, rail, element.id || 'login control'));
        }
        if (kind === 'dashboard' || kind === 'editor') {
          const header = inner(host.querySelector('.header-inner'));
          const targets =
            kind === 'dashboard'
              ? host.querySelectorAll('.note-item-row')
              : host.querySelectorAll('.meta-pane, .editor-panels');
          targets.forEach((element) => edges(element, header, element.className));
          const settings = host.querySelector('.header-right > .prefs-btn');
          if (visible(settings))
            check('header settings control: end', bounds(settings).right, header.right);
          if (kind === 'editor') {
            const toggle = host.querySelector('.meta-toggle span');
            const first = host.querySelector('.meta-fields .label-input');
            if (visible(first) && visible(toggle))
              check('Details text / first field: start', bounds(first).left, bounds(toggle).left);
            const textarea = host.querySelector('#note-content');
            const preview = host.querySelector('#preview');
            if (visible(textarea) && visible(preview) && inner(textarea).top === inner(preview).top)
              check(
                'editor / preview writing inset',
                inner(textarea).left - bounds(textarea).left,
                inner(preview).left - bounds(preview).left,
                false,
              );
          }
        }
        if (kind === 'preferences') {
          const heading = host.querySelector('.prefs-content-header');
          const content = inner(heading);
          const panel = host.querySelector('.prefs-section.active');
          panel
            .querySelectorAll(
              '.pref-control, .pref-row, .about-row, .shortcut-row, .shortcut-prefix-row, .pref-subsection h3',
            )
            .forEach((element) => {
              if (!visible(element)) return;
              check(
                `${element.id || element.className}: start`,
                bounds(element).left,
                content.left,
              );
              if (!element.matches('h3'))
                check(
                  `${element.id || element.className}: end`,
                  bounds(element).right,
                  content.right,
                );
            });
          const closeRow =
            innerWidth > 640 ? heading : host.querySelector('.prefs-sidebar-heading');
          const close = closeRow.querySelector('.prefs-close');
          check('preferences close control: end', bounds(close).right, inner(closeRow).right);
          const copy = host.querySelector('.prefs-sidebar-title');
          const navigation = host.querySelector('.prefs-nav');
          if (innerWidth > 640)
            check(
              'sidebar heading / navigation text: start',
              inner(copy).left,
              inner(navigation).left,
            );
          const picks = [
            ...panel.querySelectorAll('.pref-control:not(.font-control) select'),
          ].filter(visible);
          if (innerWidth > 640 && picks.length) {
            const start = bounds(picks[0]).left;
            picks.forEach((element) =>
              check(`${element.id}: control column`, bounds(element).left, start),
            );
            panel.querySelectorAll('.font-size-control').forEach((element) => {
              if (
                visible(element) &&
                getComputedStyle(element.closest('.font-input-row')).gridTemplateColumns.split(' ')
                  .length > 1
              )
                check('font size: control column', bounds(element).left, start);
            });
          }
          panel.querySelectorAll('.font-input-row').forEach((row) => {
            if (!visible(row)) return;
            const input = row.querySelector('input');
            const select = row.querySelector('select');
            if (getComputedStyle(row).gridTemplateColumns.split(' ').length > 1)
              check('font controls: top', bounds(input).top, bounds(select).top, false);
            row.querySelectorAll('label').forEach((label) => {
              const control = document.getElementById(label.htmlFor);
              check(`${label.htmlFor}: label start`, bounds(label).left, bounds(control).left);
            });
          });
        }
        if (kind === 'dialog') {
          host
            .querySelectorAll(
              ':scope > .modal-heading, :scope > .modal-copy, :scope > .modal-actions, :scope > form, :scope > .vault-master-methods',
            )
            .forEach((element) => edges(element, rail, element.className));
          const close = host.querySelector('.modal-heading .modal-close');
          if (visible(close))
            check('close control / content: end', bounds(close).right, rail.right);
          host
            .querySelectorAll(
              'form > .label-input, .vault-master-fields > .label-input, .vault-recovery-entry-step > .label-input',
            )
            .forEach((element) => edges(element, inner(element.parentElement), 'form field'));
        }
        if (kind === 'popup') {
          check('popup stays inside viewport: start', Math.max(0, -bounds(host).left), 0, false);
          check(
            'popup stays inside viewport: end',
            Math.max(0, bounds(host).right - document.documentElement.clientWidth),
            0,
            false,
          );
          const cells = host.querySelector('.table-grid');
          if (cells) edges(cells, rail, 'table grid');
          else {
            const buttons = [...host.querySelectorAll('button')].filter(visible);
            if (buttons.length) {
              check('picker first item: start', bounds(buttons[0]).left, rail.left);
              check('picker last item: end', bounds(buttons.at(-1)).right, rail.right);
            }
          }
        }
        if (kind === 'zen') {
          const source = host.querySelector('.zen-source-editor');
          const preview = host.querySelector('.preview');
          const writing = visible(source) ? inner(source) : inner(preview);
          const title = host.querySelector('.zen-note-title');
          const count = host.querySelector('.zen-word-count');
          const exit = host.querySelector('.zen-controls');
          if (visible(title)) check('Zen title / writing: start', bounds(title).left, writing.left);
          if (visible(count)) check('Zen count / writing: end', bounds(count).right, writing.right);
          if (visible(exit))
            check('Zen controls / writing: end', bounds(exit).right, writing.right);
        }
      } else {
        const center = (element) => {
          const box = bounds(element);
          return (box.top + box.bottom) / 2;
        };
        const context = document.createElement('canvas').getContext('2d');
        const baseline = (element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (
              !node.textContent.trim() ||
              !visible(node.parentElement) ||
              node.parentElement.closest('svg')
            )
              continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getClientRects()[0];
            const css = getComputedStyle(node.parentElement);
            context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
            return box.top + context.measureText(node.textContent).fontBoundingBoxAscent;
          }
          return null;
        };
        const capCenter = (element) => {
          const y = baseline(element);
          const css = getComputedStyle(element);
          context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
          return y - context.measureText('H').actualBoundingBoxAscent / 2;
        };
        const iconCenter = (element) => {
          element = element.matches('svg') ? element : element.querySelector('svg');
          const box = element.getBoundingClientRect();
          const ink = element.getBBox();
          const view = element.viewBox.baseVal;
          const scale = view.height ? box.height / view.height : 1;
          return box.top + (ink.y + ink.height / 2 - view.y) * scale;
        };
        const align = (label, actual, expected, role = 'center', tolerance = 1) => {
          check(label, actual, expected, true, tolerance);
          guideKinds.set(expected, role);
        };
        // Cap height comes from system fonts, which differ across machines.
        const opticalTolerance = parseFloat(getComputedStyle(document.body).fontSize) / 8;
        const alignToCaps = (label, icon, text) =>
          align(label, iconCenter(icon), capCenter(text), 'center', opticalTolerance);
        const alignedControls = (selector, label) => {
          const elements = [...host.querySelectorAll(selector)].filter(visible);
          for (const element of elements) {
            const first = elements.find(
              (candidate) => Math.abs(bounds(candidate).top - bounds(element).top) < 1,
            );
            if (first !== element) align(label, center(element), center(first));
          }
        };
        if (['dashboard', 'editor'].includes(kind)) {
          const brand = host.querySelector('.app-brand span');
          const settings = host.querySelector('.header-right > .prefs-btn');
          if (visible(brand) && visible(settings))
            alignToCaps('header icon / wordmark center', settings, brand);
          if (kind === 'dashboard') {
            host.querySelectorAll('.note-item-row').forEach((row) => {
              const title = row.querySelector('.note-title');
              const pin = row.querySelector('.note-pin .icon');
              if (visible(title) && visible(pin))
                alignToCaps('note pin / title center', pin, title);
            });
          } else {
            alignedControls(
              '.meta-fields input, .meta-actions > button',
              'Details controls: center',
            );
            const source = host.querySelector('#note-content');
            const preview = host.querySelector('#preview');
            if (innerWidth > 640 && visible(source) && visible(preview)) {
              const contentTop = (element) =>
                bounds(element).top +
                parseFloat(getComputedStyle(element).paddingTop) +
                parseFloat(getComputedStyle(element).borderTopWidth);
              align(
                'source / preview content start',
                contentTop(source),
                contentTop(preview),
                'content',
              );
            }
          }
        }
        if (kind === 'preferences') {
          const title = host.querySelector('.prefs-content-header h2');
          const sidebar = host.querySelector('.prefs-sidebar-title');
          if (innerWidth > 640)
            align('Preferences titles: baseline', baseline(sidebar), baseline(title), 'baseline');
          alignToCaps(
            'Preferences close / title center',
            [...host.querySelectorAll('.prefs-close .icon')].find(visible),
            innerWidth > 640 ? title : sidebar,
          );
          const panel = host.querySelector('.prefs-section.active');
          panel
            .querySelectorAll(
              '.pref-control:not(.font-control), .pref-row, .about-row, .shortcut-row, .shortcut-prefix-row',
            )
            .forEach((row) => {
              const copy = row.querySelector(':scope > span');
              if (!visible(copy)) return;
              const control = row.querySelector(
                ':scope > select, :scope > input, :scope > button, :scope > .accent-actions, :scope > .shortcut-row-actions',
              );
              if (
                !visible(control) ||
                (innerWidth <= 640 &&
                  row.matches('.pref-control, .shortcut-row, .shortcut-prefix-row'))
              )
                return;
              align('setting copy / control center', center(control), center(copy));
            });
          panel.querySelectorAll('.font-input-row').forEach((row) => {
            if (!visible(row)) return;
            const labels = [...row.querySelectorAll('label')];
            if (
              labels.length === 2 &&
              getComputedStyle(row).gridTemplateColumns.split(' ').length > 1
            )
              align('font labels: baseline', baseline(labels[0]), baseline(labels[1]), 'baseline');
            const controls = row.querySelectorAll('input, select');
            if (getComputedStyle(row).gridTemplateColumns.split(' ').length > 1)
              align('font fields: center', center(controls[0]), center(controls[1]));
          });
        }
        if (kind === 'dialog') {
          const heading = host.querySelector('.modal-heading');
          const title = heading?.querySelector('h2,h3');
          const close = heading?.querySelector('.modal-close .icon');
          if (visible(close) && visible(title))
            alignToCaps('dialog close / title center', close, title);
          if (visible(heading)) {
            const minimum = parseFloat(
              getComputedStyle(document.querySelector('.modal-close')).height,
            );
            check(
              'dialog heading row is consistent',
              Math.max(0, minimum - (bounds(heading).bottom - bounds(heading).top)),
              0,
              false,
            );
          }
          host.querySelectorAll('.modal-actions').forEach((row) => {
            if (!visible(row)) return;
            const buttons = [...row.querySelectorAll(':scope > button')].filter(visible);
            for (const button of buttons) {
              const first = buttons.find(
                (candidate) => Math.abs(bounds(candidate).top - bounds(button).top) < 1,
              );
              if (first !== button)
                align('dialog actions: baseline', baseline(button), baseline(first), 'baseline');
            }
          });
        }
        if (kind === 'popup') alignedControls(':scope > button', 'picker items: center');
        if (kind === 'zen') {
          const title = host.querySelector('.zen-note-title');
          const count = host.querySelector('.zen-word-count');
          if (visible(title) && visible(count))
            align('Zen footer: baseline', baseline(title), baseline(count), 'baseline');
          alignedControls('.zen-controls > button', 'Zen controls: center');
        }
      }
      const ns = 'http://www.w3.org/2000/svg';
      const overlay = document.createElementNS(ns, 'svg');
      overlay.id = 'layout-guides';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });
      document.body.append(overlay);
      // Fixed percentage dimensions can exclude reserved scrollbar gutters.
      const viewport = overlay.getBoundingClientRect();
      overlay.setAttribute(
        'viewBox',
        `${viewport.left} ${viewport.top} ${viewport.width} ${viewport.height}`,
      );
      const unit = parseFloat(getComputedStyle(document.body).fontSize) / 4;
      const extent = horizontal
        ? bounds(kind === 'preferences' ? host.querySelector('.prefs-modal-body') : host)
        : rail;
      for (
        let coordinate = horizontal ? Math.max(viewport.top, extent.top) : extent.left;
        coordinate < (horizontal ? Math.min(viewport.bottom, extent.bottom) : extent.right);
        coordinate += unit
      ) {
        const strip = document.createElementNS(ns, 'rect');
        for (const [key, value] of Object.entries({
          x: horizontal ? viewport.left : coordinate,
          y: horizontal ? coordinate : viewport.top,
          width: horizontal ? viewport.width : unit / 2,
          height: horizontal ? unit / 2 : viewport.height,
          fill: '#008cff',
          'fill-opacity': 0.045,
        }))
          strip.setAttribute(key, String(value));
        overlay.append(strip);
      }
      const frame = bounds(kind === 'preferences' ? host.querySelector('.prefs-modal-body') : host);
      const canvas = bounds(document.body);
      const guides = [
        ...(horizontal ? [viewport.top, viewport.bottom] : [canvas.left, canvas.right]).map(
          (x) => ({x, role: 'canvas', color: '#64748b'}),
        ),
        ...(horizontal ? [frame.top, frame.bottom] : [frame.left, frame.right]).map((x) => ({
          x,
          role: 'container',
          color: '#008f9c',
        })),
        ...[...rails].map((x) => ({
          x,
          role: guideKinds.get(x) || 'content',
          color: guideKinds.get(x) === 'center' ? '#c47b00' : '#e43ac4',
        })),
      ];
      for (const {x, role, color} of guides) {
        const line = document.createElementNS(ns, 'line');
        line.dataset.guide = role;
        if (role === 'container') line.setAttribute('stroke-dasharray', '4 4');
        for (const [key, value] of Object.entries({
          x1: horizontal ? viewport.left : x,
          x2: horizontal ? viewport.right : x,
          y1: horizontal ? x : viewport.top,
          y2: horizontal ? x : viewport.bottom,
          stroke: color,
          'stroke-width': 0.75,
        }))
          line.setAttribute(key, String(value));
        overlay.append(line);
      }
      for (const line of overlay.querySelectorAll('line')) {
        const drawn = line.getBoundingClientRect();
        check(
          'rendered guide matches viewport coordinate',
          horizontal ? (drawn.top + drawn.bottom) / 2 : (drawn.left + drawn.right) / 2,
          horizontal ? line.y1.baseVal.value : line.x1.baseVal.value,
          false,
        );
      }
      return {
        name,
        axis,
        fontScale:
          parseFloat(getComputedStyle(document.body).fontSize) /
          parseFloat(getComputedStyle(document.documentElement).fontSize),
        checks,
        failures: checks.filter((item) => item.error > item.tolerance),
      };
    },
    {name, root, kind, axis},
  );
}

test('rendered guides retain viewport coordinates with reserved scrollbar gutters', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#login-form')).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const gutter of ['stable', 'stable both-edges']) {
      await page.evaluate((gutter) => {
        document.documentElement.style.scrollbarGutter = gutter;
      }, gutter);
      const result = await inspect(page, 'login', '#login-form', 'login');
      expect(
        result.failures.filter((failure) => failure.label.startsWith('rendered guide')),
        `${width}, ${gutter}`,
      ).toEqual([]);
    }
  }
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-editor').click();
  const fontRow = await page.locator('#pref-editor-font-size').boundingBox();
  await inspect(page, 'preferences-editor', '#prefs-modal', 'preferences');
  const lines = await page
    .locator('#layout-guides line')
    .evaluateAll((elements) => elements.map((line) => line.x1.baseVal.value));
  expect(lines.some((x) => Math.abs(x - fontRow.y) < 0.01)).toBe(false);
});

test('all screens follow their content and optical alignment guides', async ({page}) => {
  test.setTimeout(240000);
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
  await page.locator('#new-note-btn').click();
  await page
    .locator('#note-title')
    .fill('Alignment reference with a long title that wraps on a narrow screen');
  await page
    .locator('#note-content')
    .fill(
      '# Alignment reference\n\nA paragraph with a [link](https://example.com).\n\n- One\n- Two',
    );
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-zen').click();
  await page.locator('#pref-zen-word-count').check();
  await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
  const results = [];
  // Geometry is theme-independent; the extremes of width and font size bound the layout.
  const theme = 'default-light';
  for (const width of [390, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const size of [1, 1.5]) {
      await page.locator('#prefs-btn').click();
      await page.locator('#prefs-tab-appearance').click();
      await page.locator('#pref-theme').selectOption(theme);
      await page.locator('#pref-font-size').selectOption(`${size}rem`);
      await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
      await page.evaluate(
        ({size, theme}) => {
          const choice = window.VylkThemes.find((item) => item.id === theme);
          document.documentElement.classList.toggle('dark', choice.dark);
          for (const [name, value] of Object.entries(choice.vars))
            document.documentElement.style.setProperty(
              `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
              value,
            );
          document.documentElement.style.setProperty('--font-size', `${size}rem`);
          document.documentElement.dataset.reduceMotion = 'always';
        },
        {size, theme},
      );
      const capture = async (name, root, kind) => {
        for (const axis of ['vertical', 'horizontal']) {
          const result = await inspect(page, name, root, kind, axis);
          expect(result.fontScale).toBeCloseTo(size, 2);
          results.push({...result, width, size});
          await page.evaluate(() => document.querySelector('#layout-guides')?.remove());
        }
      };
      await page.locator('.note-item-row').first().hover();
      await capture('dashboard', '#dashboard', 'dashboard');
      for (const section of [
        'appearance',
        'editor',
        'zen',
        'shortcuts',
        'account',
        'encryption',
        'about',
      ]) {
        await page.locator('#prefs-btn').click();
        await page.locator(`#prefs-tab-${section}`).click();
        await page.locator('.prefs-content').evaluate((element) => {
          element.scrollTop = 0;
        });
        await capture(`preferences-${section}`, '#prefs-modal', 'preferences');
        await page.locator('.prefs-content').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await capture(`preferences-${section}--scroll-end`, '#prefs-modal', 'preferences');
        await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
      }
      await page.locator('#new-note-btn').click();
      await page
        .locator('#note-content')
        .fill('# Writing reference\n\nA paragraph to check the writing inset.');
      for (const mode of ['both', 'editor', 'preview']) {
        await page.locator(`#view-controls [data-panel="${mode}"]`).click();
        if (mode === 'both')
          await expect(page.locator('#preview')).toContainText('Writing reference');
        await capture(`note-${mode}`, '#editor', 'editor');
        if (mode === 'both') {
          for (const picker of ['heading', 'table']) {
            await page.locator(`.fmt-bar [data-fmt="${picker}"]`).click();
            await capture(`note-both--${picker}-picker`, `.${picker}-picker`, 'popup');
            await page.locator(`.fmt-bar [data-fmt="${picker}"]`).click();
          }
        }
      }
      await page.locator('#view-controls [data-panel="zen"]').click();
      await capture('zen-write', '#editor', 'zen');
      await page.locator('[data-zen-action="preview"]').click();
      await capture('zen-preview', '#editor', 'zen');
      await page.locator('[data-zen-action="exit"]').click();
      await page.locator('#back-btn').click();
      const modals = await page
        .locator('.modal:not(#prefs-modal)')
        .evaluateAll((elements) => elements.map((element) => element.id));
      for (const id of modals) {
        await page.evaluate((id) => {
          const modal = document.getElementById(id);
          modal.classList.remove('hidden');
          modal.removeAttribute('aria-hidden');
        }, id);
        await capture(id, `#${id} .modal-body`, 'dialog');
        if (['vault-master-modal', 'vault-recovery-modal'].includes(id)) {
          const prefix = id === 'vault-master-modal' ? 'vault-master' : 'vault-recovery';
          const original = await page
            .locator(`#${id} [id]`)
            .evaluateAll((elements) =>
              elements.map((element) => ({id: element.id, hidden: element.hidden})),
            );
          for (const method of ['password', 'recovery']) {
            await page.evaluate(
              ({prefix, method}) => {
                document.getElementById(`${prefix}-methods`).hidden = true;
                document.getElementById(`${prefix}-fields`).hidden = false;
                const fresh = document.getElementById(`${prefix}-new-fields`);
                if (fresh) fresh.hidden = false;
                document.getElementById(`${prefix}-current-field`).hidden = method !== 'password';
                document.getElementById(`${prefix}-current-recovery`).hidden =
                  method !== 'recovery';
              },
              {prefix, method},
            );
            await capture(`${id}--${method}`, `#${id} .modal-body`, 'dialog');
          }
          await page.evaluate((original) => {
            for (const item of original) document.getElementById(item.id).hidden = item.hidden;
          }, original);
        }
        await page.evaluate((id) => document.getElementById(id).classList.add('hidden'), id);
      }
      await page.evaluate(() => {
        document.querySelector('#dashboard').classList.add('hidden');
        document.querySelector('#login-screen').classList.remove('hidden');
      });
      await capture('login', '#login-form', 'login');
      await page.evaluate(() => {
        document.querySelector('#login-screen').classList.add('hidden');
        document.querySelector('#dashboard').classList.remove('hidden');
      });
    }
  }
  expect(
    results.flatMap((screen) =>
      screen.failures.map(
        (failure) =>
          `${screen.name} ${screen.width}/${screen.size}: ${failure.label} (${failure.error.toFixed(2)})`,
      ),
    ),
  ).toEqual([]);
});

test('icon-only controls change ink color without changing hover backgrounds', async ({page}) => {
  await page.goto('/');
  const hover = async (button, parent) => {
    if (parent) await parent.hover();
    else await page.mouse.move(0, 0);
    const before = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    await button.hover();
    await button.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .filter((animation) => Number.isFinite(animation.effect.getComputedTiming().endTime))
          .map((animation) => animation.finished),
      );
    });
    await expect(button).toHaveCSS('background-color', before);
    const accent = await button.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(button).toHaveCSS('color', accent);
  };
  await hover(page.locator('[data-password-toggle="login-password"]'));
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
  await page.locator('#new-note-btn').click();
  const hoverTitle = `Hover reference ${Date.now()}`;
  await page.locator('#note-title').fill(hoverTitle);
  await page.locator('#note-content').fill('An independent note for checking icon hover.');
  await page.locator('#save-btn').click();
  await page.locator('#back-btn').click();
  await hover(page.locator('#prefs-btn'));
  const pin = page.locator('.note-item-row').filter({hasText: hoverTitle}).locator('.note-pin');
  await hover(pin, pin.locator('..'));
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await hover(pin, pin.locator('..'));
  await page.locator('#prefs-btn').click();
  await hover(page.getByRole('button', {name: 'Close preferences', exact: true}));
  await page.locator('#prefs-tab-shortcuts').click();
  for (const clear of await page.locator('.shortcut-clear:enabled').all()) await hover(clear);
  await page.locator('#prefs-tab-encryption').click();
  await hover(page.locator('.vault-info summary'));
  await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
  await page.locator('#new-note-btn').click();
  await page.locator('#note-content').fill('Enable the save control.');
  await hover(page.locator('#back-btn'));
  await hover(page.locator('#save-btn'));
  for (const control of await page.locator('#view-controls button, .fmt-bar button').all()) {
    if ((await control.isVisible()) && (await control.isEnabled())) await hover(control);
  }
  await page.locator('[data-panel="zen"]').click();
  for (const control of await page.locator('.zen-controls button').all()) {
    if (await control.isVisible()) await hover(control);
  }
  await page.locator('[data-zen-action="exit"]').click();
  for (const id of await page
    .locator('.modal:not(#prefs-modal)')
    .evaluateAll((elements) => elements.map((element) => element.id))) {
    const close = page.locator(`#${id} .modal-close`);
    if (!(await close.count())) continue;
    await page.evaluate((id) => document.getElementById(id).classList.remove('hidden'), id);
    await hover(close);
    await page.evaluate((id) => document.getElementById(id).classList.add('hidden'), id);
  }
});

test('enlarged mobile font fields stay readable without narrowing their labels', async ({page}) => {
  await page.setViewportSize({width: 390, height: 900});
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await useEditorFixture(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-appearance').click();
  await page.locator('#pref-theme').selectOption('default-light');
  await page.locator('#pref-font-size').selectOption('1.5rem');
  await page.locator('#prefs-tab-editor').click();
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-size', '1.5rem');
    document.documentElement.dataset.reduceMotion = 'always';
  });
  const row = page.locator('#prefs-panel-editor .font-input-row').first();
  await expect(row.locator('input')).toHaveCSS('height', '42px');
  await row.scrollIntoViewIfNeeded();
  const metrics = await row.evaluate((row) => {
    const input = row.querySelector('input');
    const select = row.querySelector('select');
    const css = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    return {
      input: input.getBoundingClientRect().toJSON(),
      select: select.getBoundingClientRect().toJSON(),
      available: input.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      text: context.measureText(input.value).width,
    };
  });
  expect(metrics.select.y).toBeGreaterThanOrEqual(metrics.input.bottom);
  expect(metrics.select.width).toBeCloseTo(metrics.input.width, 0);
  expect(metrics.available).toBeGreaterThanOrEqual(metrics.text);
});
