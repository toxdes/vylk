import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const asset = (path) => new URL(`../../internal/web/static/${path}`, import.meta.url).pathname;
const shell = readFileSync(asset('index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');

async function fixture(
  page,
  value = 'A quiet place to write.\nVisit [Vylk](https://example.com) for more.',
) {
  page.on('pageerror', (error) => console.error(error.stack));
  await page.setContent(shell);
  await page.addStyleTag({path: asset('style.css')});
  for (const path of [
    'vendor/marked.min.js',
    'js/core/motion.js',
    'js/ui/feedback.js',
    'js/editor/markdown-links.js',
    'js/editor/zen-selection.js',
    'js/editor/zen-inline.js',
    'js/editor/zen-editor.js',
    'js/editor/zen-toolbar.js',
    'js/editor/shortcuts.js',
    'js/editor/shortcut-controller.js',
    'js/editor/default-commands.js',
  ])
    await page.addScriptTag({path: asset(path)});
  await page.evaluate((source) => {
    document.querySelector('#app').classList.remove('booting');
    document.querySelector('#boot-screen').hidden = true;
    document.querySelector('#login-screen').classList.add('hidden');
    const screen = document.querySelector('#editor');
    screen.classList.remove('hidden');
    screen.classList.add('zen-mode', 'header-hidden');
    document.querySelector('#editor-panels').classList.add('panels-single');
    document.querySelector('#preview-panel').classList.add('panel-hidden');
    const editor = new window.VylkZenEditor(document.querySelector('#zen-source-editor'));
    window.__zen = editor;
    editor.setValue(source);
    editor.active = true;
    editor.focus();
    const feedback = window.VylkFeedback.create({
      document,
      window,
      localStorage: {getItem: () => null},
      requestFrame: (callback) => requestAnimationFrame(callback),
    });
    window.__toolbar = window.VylkZenToolbar.create({
      document,
      window,
      getEditor: () => editor,
      isLocked: () => false,
      onUnsupported: (message) => feedback.showToast(message, 'warning'),
    });
    const shortcuts = window.VylkShortcutController.create({
      document,
      shortcuts: window.VylkShortcuts,
      commandCanRun: () => editor.active,
      getPreferences: () => ({
        shortcutPrefix: {steps: [{key: 'e', modifiers: ['Mod']}]},
        keyboardShortcuts: {},
      }),
      hasOpenModal: () => !!document.querySelector('.modal:not(.hidden)'),
      onUnhandledEscape: () => false,
    });
    for (const command of window.VylkDefaultCommands.create({
      format: (type) => window.__toolbar.format(type),
    }))
      if (['format.bold', 'format.italic'].includes(command.id)) shortcuts.register(command);
  }, value);
}

async function select(page, start, end = start, direction = 'forward') {
  await page.evaluate(
    ({start, end, direction}) => {
      window.__zen.focus();
      window.__zen.setSelection(start, end, direction);
    },
    {start, end, direction},
  );
}

test('native Select All deletes and replaces the entire document and stays undoable', async ({
  page,
}) => {
  const source = '# One **two**\n\n- three\n\nLast';
  await fixture(page, source);
  await page.keyboard.press('Control+a');
  expect(await page.evaluate(() => window.__zen.selection())).toMatchObject({
    start: 0,
    end: source.length,
  });
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.__zen.value)).toBe('');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.__zen.value)).toBe(source);
  await page.keyboard.press('Control+Shift+z');
  expect(await page.evaluate(() => window.__zen.value)).toBe('');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('Replacement');
  expect(await page.evaluate(() => window.__zen.value)).toBe('Replacement');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.__zen.value)).toBe(source);
});

test('real formatting shortcuts toggle mixed bold and italic uniformly', async ({page}) => {
  await fixture(page, 'foo bar');
  await select(page, 4, 7);
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(() => window.__zen.value)).toBe('foo **bar**');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+i');
  await page.keyboard.press('Control+b');
  expect(await page.locator('.zen-md-strong').evaluate((element) => element.innerText)).toBe(
    'foo bar',
  );
  await page.keyboard.press('Control+b');
  await expect(page.locator('.zen-md-strong')).toHaveCount(0);
  expect(await page.locator('.zen-md-em').evaluate((element) => element.innerText)).toBe('foo bar');
  expect(await page.locator('#zen-source-editor').innerText()).toBe('foo bar');
  await page.keyboard.press('Control+z');
  expect(await page.locator('.zen-md-strong').evaluate((element) => element.innerText)).toBe(
    'foo bar',
  );
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.zen-md-strong')).toHaveCount(0);
});

test('selection popup formats, undoes, edits URLs and leaves the label intact', async ({page}) => {
  await fixture(page, 'Hello world');
  await select(page, 0, 5, 'backward');
  const toolbar = page.locator('#zen-selection-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', {name: 'Bold', exact: true}).click();
  await expect(page.locator('.zen-md-strong')).toHaveText('Hello');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.__zen.value)).toBe('Hello world');
  await select(page, 0, 5);
  await toolbar.getByRole('button', {name: 'Link', exact: true}).click();
  await page.getByRole('textbox', {name: 'Link URL'}).fill('https://example.com/a(b)');
  await page.getByRole('button', {name: 'Apply link', exact: true}).click();
  expect(await page.evaluate(() => window.__zen.value)).toBe(
    '[Hello](https://example.com/a\\(b\\)) world',
  );
  await expect(page.locator('.zen-md-link')).toHaveText('Hello');
  await expect(page.locator('.zen-md-link-syntax').first()).toBeHidden();
  expect(await page.locator('#zen-source-editor').innerText()).toBe('Hello world');
  await page.locator('.zen-md-link').click();
  await toolbar.getByRole('button', {name: 'Edit link', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Link URL'})).toHaveValue(
    'https://example.com/a(b)',
  );
  await page.getByRole('textbox', {name: 'Link URL'}).fill('/updated');
  await page.getByRole('textbox', {name: 'Link URL'}).press('Enter');
  expect(await page.evaluate(() => window.__zen.value)).toBe('[Hello](/updated) world');
  await page.locator('.zen-md-link').click();
  await toolbar.getByRole('button', {name: 'Edit link', exact: true}).click();
  await page.getByRole('textbox', {name: 'Link URL'}).fill('');
  await page.getByRole('button', {name: 'Apply link', exact: true}).click();
  expect(await page.evaluate(() => window.__zen.value)).toBe('Hello world');
});

test('typing a complete link renders it, and editing adjacent text keeps offsets correct', async ({
  page,
}) => {
  await fixture(page, 'Before ');
  await select(page, 7);
  await page.keyboard.type('[label](https://example.com)');
  await expect(page.locator('.zen-md-link')).toHaveText('label');
  await page.keyboard.type(' after');
  expect(await page.evaluate(() => window.__zen.value)).toBe(
    'Before [label](https://example.com) after',
  );
  await select(page, 10);
  await page.keyboard.type('X');
  expect(await page.evaluate(() => window.__zen.value)).toBe(
    'Before [laXbel](https://example.com) after',
  );
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.__zen.value)).toBe(
    'Before [label](https://example.com) after',
  );
});

test('completed inline formatting hides markers during typing and keeps edits undoable', async ({
  page,
}) => {
  await fixture(page, '');
  const editor = page.locator('#zen-source-editor');
  for (const marker of ['**', '*', '~~', '`']) {
    await page.evaluate(() => window.__zen.setValue(''));
    await page.keyboard.type(marker + 'Hello');
    expect(await editor.innerText()).toBe(marker + 'Hello');
    await page.keyboard.type(marker);
    expect(await editor.innerText()).toBe('Hello');
    expect(await page.evaluate(() => window.__zen.value)).toBe(marker + 'Hello' + marker);
    await page.keyboard.type(' world');
    expect(await page.evaluate(() => window.__zen.value)).toBe(
      marker + 'Hello' + marker + ' world',
    );
    expect(await editor.innerText()).toBe('Hello world');
    await select(page, marker.length + 2);
    await page.keyboard.type('X');
    expect(await editor.innerText()).toBe('HeXllo world');
    await page.keyboard.press('Control+z');
    expect(await editor.innerText()).toBe('Hello world');
    await select(page, 0, marker.length * 2 + 5);
    await page.keyboard.press('Backspace');
    expect(await page.evaluate(() => window.__zen.value)).toBe(' world');
    await page.keyboard.press('Control+z');
    expect(await editor.innerText()).toBe('Hello world');
  }
});

test('native caret navigation skips hidden syntax in both directions', async ({page}) => {
  await fixture(page, 'A **bold** Z');
  const editor = page.locator('#zen-source-editor');
  await select(page, 0);
  for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('X');
  expect(await editor.innerText()).toBe('A bold ZX');
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  expect(await editor.innerText()).toBe(' bold ZX');
  await page.keyboard.press('End');
  for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Y');
  expect(await editor.innerText()).toBe('Y bold ZX');
});

test('list hanging indents preserve native character navigation in both directions', async ({
  page,
}) => {
  await fixture(page, '- Item');
  await select(page, 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('X');
  expect(await page.evaluate(() => window.__zen.value)).toBe('- XItem');
  await page.evaluate(() => window.__zen.setValue('- Item'));
  await select(page, 6);
  for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Y');
  expect(await page.evaluate(() => window.__zen.value)).toBe('- YItem');
});

test('native IME replacement across hidden formatting retains the unselected prefix', async ({
  page,
}) => {
  await fixture(page, '**Hello** world');
  await select(page, 4, 12);
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.imeSetComposition', {text: '語', selectionStart: 1, selectionEnd: 1});
    await input.send('Input.insertText', {text: '語'});
    expect(await page.evaluate(() => window.__zen.value)).toBe('**He**語rld');
    expect(await page.locator('#zen-source-editor').innerText()).toBe('He語rld');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.__zen.value)).toBe('**Hello** world');
  } finally {
    await input.detach();
  }
});

test('clicking away cancels a URL draft without changing the existing link', async ({page}) => {
  await fixture(page, '[Hello](https://example.com) world');
  await select(page, 3);
  await page.locator('#zen-selection-toolbar').getByRole('button', {name: 'Edit link'}).click();
  const popup = page.locator('#zen-link-popup');
  await expect(popup.getByRole('button')).toHaveCount(1);
  await page.getByRole('textbox', {name: 'Link URL'}).fill('/discard-me');
  await page.locator('#zen-source-editor').click({position: {x: 20, y: 100}});
  await expect(popup).toBeHidden();
  expect(await page.evaluate(() => window.__zen.value)).toBe('[Hello](https://example.com) world');
});

for (const viewport of [
  {width: 1440, height: 900},
  {width: 390, height: 844},
]) {
  test(`partial formatting preserves surrounding styles and link labels at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const source = '***foo bar baz***\n\n**[linked words](/notes)**';
    await fixture(page, source);
    await page.evaluate(() => {
      const walker = document.createTreeWalker(
        window.__zen.element.firstChild,
        NodeFilter.SHOW_TEXT,
      );
      let node;
      while ((node = walker.nextNode()))
        if (node.data === 'foo bar baz') {
          getSelection().setBaseAndExtent(node, 7, node, 4);
          break;
        }
    });
    await page.keyboard.press('Control+b');
    const line = page.locator('.zen-editor-line').first();
    expect(await line.innerText()).toBe('foo bar baz');
    expect(await line.locator('.zen-md-strong').allInnerTexts()).toEqual(['foo', 'baz']);
    expect(await line.locator('.zen-md-em').innerText()).toBe('foo bar baz');
    expect(await page.evaluate(() => window.__zen.selection().direction)).toBe('backward');
    await page.keyboard.press('Control+i');
    expect(await line.locator('.zen-md-em').allInnerTexts()).toEqual(['foo', 'baz']);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.__zen.value)).toBe(source);
    await page.evaluate(() => {
      const node = document.querySelector('.zen-md-link').firstChild;
      getSelection().setBaseAndExtent(node, 7, node, 12);
    });
    await page.keyboard.press('Control+b');
    const link = page.locator('#zen-source-editor a');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/notes');
    expect(await link.innerText()).toBe('linked words');
    expect(await link.locator('.zen-md-strong').allInnerTexts()).toEqual(['linked']);
    await page.screenshot({path: `.impeccable/review/zen-partial-${viewport.width}.png`});
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.__zen.value)).toBe(source);
    const literal = 'before ```` **literal** ```` after';
    await page.evaluate((value) => window.__zen.setValue(value), literal);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    expect(await page.locator('.zen-md-code').innerText()).toBe(' **literal** ');
    expect(await page.evaluate(() => window.__zen.value)).toContain('```` **literal** ````');
    expect(await page.locator('.zen-md-strong').allInnerTexts()).toEqual(['before', 'after']);
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.__zen.value)).toBe(literal);
    await page.evaluate(() => window.__zen.setValue('a!b'));
    await select(page, 1, 2);
    await page.keyboard.press('Control+b');
    const toast = page.locator('#toast-region .toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(
      'Markdown cannot represent this formatting exactly. Select complete words or spans.',
    );
    expect(await page.evaluate(() => window.__zen.value)).toBe('a!b');
    await page.screenshot({path: `.impeccable/review/zen-unsupported-${viewport.width}.png`});
  });

  test(`Google Fonts links and checkboxes are independent at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await page
      .context()
      .route('https://fonts.google.com/**', (route) =>
        route.fulfill({status: 200, body: '', contentType: 'text/html'}),
      );
    for (const [id, section] of [
      ['pref-font-google', 'appearance'],
      ['pref-editor-font-google', 'editor'],
      ['pref-preview-font-google', 'editor'],
      ['pref-zen-font-google', 'zen'],
    ]) {
      await page.evaluate(
        ({id, section}) => {
          const modal = document.querySelector('#prefs-modal');
          modal.classList.remove('hidden');
          modal.setAttribute('aria-hidden', 'false');
          for (const panel of modal.querySelectorAll('[data-pref-panel]')) {
            panel.hidden = panel.dataset.prefPanel !== section;
            panel.classList.toggle('active', !panel.hidden);
          }
          for (const tab of modal.querySelectorAll('[data-pref-section]')) {
            const active = tab.dataset.prefSection === section;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
          }
          document.querySelector('#prefs-title').textContent = document
            .querySelector(`#prefs-tab-${section}`)
            .textContent.trim();
          const font = document.getElementById(id.replace('-google', ''));
          font.value = 'Inter';
          const sizes = document.getElementById(id.replace('-google', '-size'));
          sizes.replaceChildren(new Option('16px', '1rem'));
        },
        {id, section},
      );
      const checkbox = page.locator(`#${id}`);
      const row = checkbox.locator('..');
      await checkbox.scrollIntoViewIfNeeded();
      await expect(checkbox).toHaveAccessibleName('Use Google Fonts to fetch');
      await row.locator('span').click({position: {x: 3, y: 5}});
      await expect(checkbox).not.toBeChecked();
      const popup = page.waitForEvent('popup');
      await row.getByRole('link', {name: 'Google Fonts', exact: true}).click();
      const catalogue = await popup;
      await expect(catalogue).toHaveURL('https://fonts.google.com/?sort=popularity');
      await catalogue.close();
      await expect(checkbox).not.toBeChecked();
      await checkbox.click();
      await expect(checkbox).toBeChecked();
      if (id === 'pref-preview-font-google')
        await page.screenshot({path: `.impeccable/review/font-fetch-${viewport.width}.png`});
    }
  });

  test(`popup geometry and keyboard access at ${viewport.width}px`, async ({page}) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await select(page, 2, 7);
    const toolbar = page.locator('#zen-selection-toolbar');
    await expect(toolbar).toBeVisible();
    await page.keyboard.press('Alt+F10');
    await expect(toolbar.getByRole('button', {name: 'Bold', exact: true})).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', {name: 'Italic', exact: true})).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toolbar).toBeHidden();
    await expect(page.locator('#zen-source-editor')).toBeFocused();
    await select(page, 3, 8);
    await toolbar.getByRole('button', {name: 'Link', exact: true}).click();
    const popup = page.locator('#zen-link-popup');
    await expect(popup).toBeVisible();
    const bounds = await popup.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    await page.setViewportSize({...viewport, height: viewport.height - 250});
    await expect(popup).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'Link URL'})).toBeFocused();
    const resizedBounds = await popup.boundingBox();
    expect(resizedBounds.y + resizedBounds.height).toBeLessThanOrEqual(viewport.height - 250 - 7);
    await page.setViewportSize(viewport);
    const original = await page.evaluate(() => window.__zen.value);
    for (const invalid of ['hello', 'https://']) {
      await page.getByRole('textbox', {name: 'Link URL'}).fill(invalid);
      await page.getByRole('button', {name: 'Apply link', exact: true}).click();
      await expect(popup.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('textbox', {name: 'Link URL'})).toBeFocused();
      expect(await page.evaluate(() => window.__zen.value)).toBe(original);
    }
    await page.screenshot({path: `.impeccable/review/zen-link-invalid-${viewport.width}.png`});
    const accessibility = await new AxeBuilder({page}).include('#zen-link-popup').analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole('textbox', {name: 'Link URL'}).fill('https://example.com');
    await page.getByRole('button', {name: 'Apply link', exact: true}).click();
    await select(page, 4, 5);
    await expect(toolbar).toBeVisible();
    await page.screenshot({path: `.impeccable/review/zen-toolbar-${viewport.width}.png`});
    await toolbar.getByRole('button', {name: 'Edit link', exact: true}).click();
    await expect(popup).toBeVisible();
    await page.screenshot({path: `.impeccable/review/zen-link-${viewport.width}.png`});
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(page.locator('#editor')).toHaveClass(/zen-mode/);
  });

  test(`Zen headings match Preview across font preferences at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(
      page,
      [
        ...Array.from({length: 6}, (_, index) => '#'.repeat(index + 1) + ` Heading ${index + 1}`),
        '####### Ordinary prose',
      ].join('\n'),
    );
    const scales = [2, 1.625, 1.3125, 1.125, 1, 0.875];
    for (const preference of [16, 20, 24]) {
      const sizes = await page.evaluate((size) => {
        const editor = window.__zen.element;
        editor.style.setProperty('--zen-font-size', `${size}px`);
        const preview = document.querySelector('#preview-panel .preview');
        preview.style.setProperty('--preview-font-size', `${size}px`);
        preview.innerHTML = window.marked.parse(window.__zen.value);
        return {
          zen: [...editor.children].map((line) => parseFloat(getComputedStyle(line).fontSize)),
          preview: [...preview.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
            parseFloat(getComputedStyle(heading).fontSize),
          ),
        };
      }, preference);
      for (let index = 0; index < scales.length; index++) {
        expect(sizes.zen[index]).toBeCloseTo(preference * scales[index], 1);
        expect(sizes.zen[index]).toBeCloseTo(sizes.preview[index], 1);
      }
      expect(sizes.zen[6]).toBe(preference);
    }
    await page.evaluate(() => window.__zen.element.style.setProperty('--zen-font-size', '16px'));
    await page.screenshot({path: `.impeccable/review/zen-headings-${viewport.width}.png`});
  });

  test(`Zen prose type styles match Preview at ${viewport.width}px`, async ({page}) => {
    await page.setViewportSize(viewport);
    await fixture(
      page,
      [
        '# A quiet place to write',
        '',
        'A paragraph with **bold**, *italic*, ~~strikethrough~~, `inline code`, and a [link](https://example.com). This longer sentence should wrap naturally at the chosen page width.',
        '',
        '> A quote keeps its Markdown marker visible.',
        '',
        '- First list item with a longer continuation that remains easy to follow when it wraps onto another line, including on a narrow screen with a custom writing font and a larger text size.',
        '- Second list item',
      ].join('\n'),
    );
    const metrics = await page.evaluate(() => {
      const editor = window.__zen.element;
      editor.style.setProperty('--zen-font-size', '20px');
      editor.style.setProperty('--zen-font', 'Georgia, serif');
      const preview = document.querySelector('#preview');
      preview.style.setProperty('--preview-font-size', '20px');
      preview.innerHTML = window.marked.parse(window.__zen.value);
      const styles = (element, properties) =>
        properties.map((property) => getComputedStyle(element)[property]);
      const compare = (zen, rendered, properties) => ({
        zen: styles(zen ? editor.querySelector(zen) : editor, properties),
        preview: styles(rendered ? preview.querySelector(rendered) : preview, properties),
      });
      const list = editor.querySelector('.zen-md-list');
      const range = document.createRange();
      range.selectNodeContents(list.querySelector('.zen-md-list-content'));
      const lineStarts = new Map();
      for (const rect of range.getClientRects())
        if (rect.width > 0.5 && !lineStarts.has(rect.top)) lineStarts.set(rect.top, rect.left);
      return {
        source: window.__zen.value,
        family: getComputedStyle(editor).fontFamily,
        body: compare(null, null, ['fontSize', 'lineHeight']),
        heading: compare('.zen-md-heading', 'h1', [
          'fontSize',
          'lineHeight',
          'fontWeight',
          'letterSpacing',
        ]),
        bold: compare('.zen-md-strong', 'strong', ['fontWeight']),
        italic: compare('.zen-md-em', 'em', ['fontStyle']),
        strike: compare('.zen-md-strike', 'del', ['textDecorationLine']),
        code: compare('.zen-md-code', 'code', [
          'fontSize',
          'fontFamily',
          'paddingTop',
          'paddingLeft',
          'backgroundColor',
        ]),
        listLefts: [...lineStarts.values()],
        blankHeight: editor.querySelector('.zen-md-blank').getBoundingClientRect().height,
        blankCount: editor.querySelectorAll('.zen-md-blank').length,
        headingHeight: editor.firstElementChild.getBoundingClientRect().height,
      };
    });
    expect(metrics.family).toContain('Georgia');
    for (const key of ['body', 'heading', 'bold', 'italic', 'strike', 'code'])
      expect(metrics[key].zen, key).toEqual(metrics[key].preview);
    expect(metrics.listLefts.length).toBeGreaterThan(1);
    for (const left of metrics.listLefts) expect(left).toBeCloseTo(metrics.listLefts[0], 0);
    expect(metrics.blankCount).toBe(3);
    expect(metrics.blankHeight).toBeLessThan(parseFloat(metrics.body.zen[1]));
    const headingLines = metrics.headingHeight / parseFloat(metrics.heading.zen[1]);
    expect(headingLines).toBeGreaterThanOrEqual(1);
    expect(headingLines).toBeCloseTo(Math.round(headingLines), 1);
    expect(await page.evaluate(() => window.__zen.value)).toBe(metrics.source);
    await page.screenshot({path: `.impeccable/review/zen-prose-${viewport.width}.png`});
  });
}

test('large notes keep untouched line nodes during link edits', async ({page}) => {
  await fixture(
    page,
    [
      '[link](https://example.com)',
      ...Array.from({length: 5000}, (_, index) => `Paragraph ${index}`),
    ].join('\n'),
  );
  const result = await page.evaluate(() => {
    const editor = window.__zen;
    const untouched = editor.lines[4000].element;
    editor.setSelection(3);
    const start = performance.now();
    for (let index = 0; index < 30; index++) editor.replaceSelection('x');
    return {
      ms: performance.now() - start,
      retained: untouched === editor.lines[4000].element,
      count: editor.lines.length,
    };
  });
  expect(result.retained).toBe(true);
  expect(result.count).toBe(5001);
  test.info().annotations.push({
    type: 'edit-timing',
    description: `${result.ms.toFixed(1)}ms for 30 edits in a 5,001-line note`,
  });
});

test('mouse selection edge scrolling stays gradual, bounded and stops on release', async ({
  page,
}) => {
  await fixture(
    page,
    Array.from({length: 300}, (_, index) => `Line ${index}: a paragraph to select precisely.`).join(
      '\n',
    ),
  );
  const editor = page.locator('#zen-source-editor');
  const rect = await editor.boundingBox();
  const x = rect.x + 60;
  await page.mouse.move(x, rect.y + 25);
  await page.mouse.down();
  await page.mouse.move(x, rect.y + rect.height - 18, {steps: 8});
  await expect(page.locator('#zen-selection-toolbar')).toBeHidden();
  const gentle = await editor.evaluate((element) => ({
    top: element.scrollTop,
    time: performance.now(),
  }));
  await page.waitForTimeout(400);
  const first = await editor.evaluate((element) => ({
    top: element.scrollTop,
    time: performance.now(),
  }));
  expect(first.top - gentle.top).toBeGreaterThan(5);
  expect(first.top - gentle.top).toBeLessThan((first.time - gentle.time) * 0.1 + 8);
  await page.mouse.move(x, rect.y + rect.height + 80);
  const before = await editor.evaluate((element) => ({
    top: element.scrollTop,
    time: performance.now(),
  }));
  await page.waitForTimeout(600);
  const after = await editor.evaluate((element) => ({
    top: element.scrollTop,
    time: performance.now(),
    selection: getSelection().toString(),
  }));
  expect(after.top - before.top).toBeGreaterThan(30);
  expect(after.top - before.top).toBeLessThan((after.time - before.time) * 0.26 + 12);
  expect(after.selection).toContain('Line');
  await page.mouse.up();
  const released = await editor.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(150);
  expect(await editor.evaluate((element) => element.scrollTop)).toBe(released);
  expect(await page.evaluate(() => window.__zen.selecting)).toBe(false);
});
