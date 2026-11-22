import {createServer} from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import {expect, test} from '@playwright/test';

let server;
let providerURL;
const calls = [];
const routeCalls = [];
const capacityChecks = [];
test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/show') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('Content-Type', 'application/json');
      const model = JSON.parse(body).model;
      response.end(
        JSON.stringify(
          model === 'qwen-local'
            ? {capabilities: ['thinking', 'completion'], details: {family: 'qwen35'}}
            : {},
        ),
      );
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      capacityChecks.push(calls.length);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({models: [{model: 'qwen-local', context_length: 4096}]}));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          data: [
            {id: 'openrouter/free', context_length: 128000},
            {id: 'fast-local', context_length: 16384, max_completion_tokens: 16384},
          ],
        }),
      );
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const content = payload.messages.at(-1).content;
    // Multi-section turns route first; recorded apart so section counts hold.
    if (content.includes('"shared_text"')) {
      routeCalls.push(payload);
      const route = content.includes('route-search') ? 'search' : 'edit_sections';
      const tool = {name: route, pattern: 'He go', ignore_case: false, start: 0, end: 0};
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {content: JSON.stringify({answer: '', changes: [], tools: [tool]})},
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    calls.push(payload);
    if (!payload.max_tokens) await new Promise((resolve) => setTimeout(resolve, 40));
    let reply = {answer: 'Ready', edits: []};
    if (content.includes('two edits'))
      reply = {
        answer: 'Two changes to review.',
        edits: [
          {before: 'first', after: 'FIRST'},
          {before: 'second', after: 'SECOND'},
        ],
      };
    if (content.includes('expand launch'))
      reply = {
        answer: 'Here is a practical first step.',
        edits: [
          {
            before: '- [ ] Plan launch',
            after: '- [ ] Draft the launch outline\n- [ ] Review the launch outline',
          },
        ],
      };
    if (content.includes('make it shorter'))
      reply = {
        answer: 'A shorter first step.',
        edits: [
          {
            before: '- [ ] Draft the launch outline\n- [ ] Review the launch outline',
            after: '- [ ] Draft and review the launch outline',
          },
        ],
      };
    if (content.includes('reference first draft'))
      reply = {
        answer: 'Two proposals.',
        edits: [
          {before: 'first task', after: 'first actionable task'},
          {before: 'second task', after: 'second actionable task'},
        ],
      };
    if (content.includes('make @2 shorter'))
      reply = {
        answer: 'Revised the second proposal.',
        changes: [
          {
            id: '@2',
            before: JSON.parse(content).blocks.find((block) => block.id === '@2').text,
            after: 'second',
          },
        ],
      };
    if (content.includes('what happened to @2'))
      reply = {answer: '@2 was superseded. Use @2.1 for the current change.', edits: []};
    if (content.includes('show current @2.1 status'))
      reply = {answer: 'You rejected @2.1.', edits: []};
    if (content.includes('another proposal'))
      reply = {answer: 'Another proposal.', edits: [{before: 'second task', after: 'second step'}]};
    if (content.includes('which model are you'))
      reply = {answer: 'I am an AI language model.', edits: []};
    if (content.includes('give me ideas'))
      reply = {answer: '<script>alert("safe text")</script>\nTry a small prototype.', edits: []};
    if (content.includes('fix grammar in the whole note'))
      reply = {
        answer: 'Review the grammar corrections.',
        changes: JSON.parse(content)
          .blocks.filter((block) => /He go|She walk/.test(block.text))
          .map((block) => ({
            id: block.id,
            before: block.text,
            after: block.text.replaceAll('He go', 'He went').replaceAll('She walk', 'She walked'),
          })),
      };
    if (content.includes('chunk-proofread') || content.includes('chunk-cancel')) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const context = JSON.parse(content);
      reply = {
        answer: 'Suggested changes are ready to review.',
        changes: context.blocks
          .filter((block) => block.text.includes('He go'))
          .map((block) => ({id: block.id, before: 'He go', after: 'He goes'})),
      };
    }
    const context = payload.max_tokens ? {blocks: []} : JSON.parse(content);
    if (context.request === 'hi') reply = {answer: 'Hi! How can I help?', changes: []};
    if (context.tool_results)
      reply = {answer: `Found ${context.tool_results[0].count} matches.`, changes: []};
    if (!reply.changes) {
      const blocks = context.blocks;
      const original = blocks.map((block) => block.text).join('');
      const texts = blocks.map((block) => block.text);
      if (reply.replacement !== undefined && blocks.length) {
        texts[0] = reply.replacement;
        texts.fill('', 1);
      } else {
        const starts = [];
        let cursor = 0;
        for (const block of blocks) {
          starts.push(cursor);
          cursor += block.text.length;
        }
        const edits = (reply.edits || [])
          .map((edit) => ({...edit, start: original.indexOf(edit.before)}))
          .sort((a, b) => b.start - a.start);
        for (const edit of edits) {
          if (edit.start < 0) throw new Error('Mock edit does not match the frozen blocks');
          const end = edit.start + edit.before.length;
          const first = starts.findLastIndex((start) => start <= edit.start);
          const last = starts.findLastIndex((start) => start < end);
          texts[first] =
            texts[first].slice(0, edit.start - starts[first]) +
            edit.after +
            texts[last].slice(end - starts[last]);
          for (let i = first + 1; i <= last; i++) texts[i] = '';
        }
      }
      reply = {
        answer: reply.answer,
        changes: blocks.flatMap((block, index) =>
          texts[index] === block.text
            ? []
            : [{id: block.id, before: block.text, after: texts[index]}],
        ),
      };
    }
    if (content.includes('boundaries-proofread')) {
      reply = {
        answer: 'Suggested changes are ready to review.',
        changes: context.blocks
          .filter((block) => /He go|She walk/.test(block.text))
          .map((block) => ({
            id: block.id,
            before: block.text,
            after: block.text
              .trim()
              .replaceAll('He go', 'He goes')
              .replaceAll('She walk', 'She walks'),
          })),
      };
    }
    if (content.includes('revision-fixture')) {
      reply = {
        answer: 'Suggested changes are ready to review.',
        changes: context.blocks.flatMap((block) => {
          const updated = block.text
            .replaceAll('first task', 'first actionable task')
            .replaceAll('other task', 'other actionable task')
            .replaceAll('I likes bezos daddy.', 'I like Amazon.');
          return updated === block.text ? [] : [{id: block.id, before: block.text, after: updated}];
        }),
      };
    }
    if (content.includes('keep my wording @3')) {
      reply = {
        answer: 'Kept your wording in that suggestion.',
        changes: [{id: '@3', before: 'Amazon', after: 'bezos daddy'}],
      };
    }
    if (content.includes('@3.1 keep original wording')) {
      const proposal = context.blocks.find((block) => block.id === '@3.1');
      const original = context.originals_read_only.find((block) => block.id === '@3.1');
      reply = {
        answer: 'Removed that suggestion.',
        changes: [{id: '@3.1', before: proposal.text, after: original.text}],
      };
    }
    if (content.includes('what happened to @3.1'))
      reply = {answer: 'You withdrew @3.1.', changes: []};
    if (content.includes('redo-structured @3')) {
      reply = context.validation_feedback
        ? {
            answer: 'Revised that suggestion.',
            changes: [{id: '@3', before: 'Amazon', after: 'bezos daddy'}],
          }
        : {
            answer: 'Revised that suggestion.',
            changes: [
              {
                id: 'b0_0',
                before: context.blocks[0].text,
                after: context.blocks[0].text,
              },
            ],
          };
    }
    if (content.includes('compact-anchor-retry')) {
      const block = context.blocks.find((block) => block.text.includes('He go'));
      reply = {
        answer: 'Suggested changes are ready to review.',
        changes: context.validation_feedback
          ? [
              {id: block.id, before: 'He go', after: 'He goes'},
              {id: block.id, before: 'She walk', after: 'She walks'},
            ]
          : [{id: block.id, before: 'This anchor does not exist.', after: 'He goes'}],
      };
    }
    if (content.includes('wrong-block-anchor')) {
      const target = context.blocks.find((block) => block.text.includes('He go'));
      const wrong = context.blocks.find((block) => block.id !== target.id);
      reply = {
        answer: 'Suggested changes are ready to review.',
        changes: [
          {
            id: context.validation_feedback?.anchor_error.matching_block_id || wrong.id,
            before: 'He go',
            after: 'He goes',
          },
        ],
      };
    }
    if (
      content.includes('auto-correct-twice') &&
      calls.filter((call) => call.messages.at(-1).content.includes('auto-correct-twice')).length < 3
    ) {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({choices: [{message: {content: '{invalid JSON'}, finish_reason: 'stop'}]}),
      );
      return;
    }
    const retryKey = content.includes('single-retry-once')
      ? 'single-retry-once'
      : content.includes('multi-retry-once')
        ? 'multi-retry-once'
        : null;
    // Fail one section's request and both corrections. Parallel sections
    // would otherwise spread the failures across sections that recover.
    const sectionOf = (text) => {
      try {
        return JSON.parse(text).section;
      } catch {
        return undefined;
      }
    };
    const section = sectionOf(content);
    const malformed =
      retryKey &&
      (section ?? 1) === 1 &&
      calls.filter(
        (call) =>
          call.messages.at(-1).content.includes(retryKey) &&
          (sectionOf(call.messages.at(-1).content) ?? 1) === 1,
      ).length <= 3;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {content: malformed ? '{invalid JSON' : JSON.stringify(reply)},
            finish_reason: 'stop',
          },
        ],
        usage: {prompt_tokens: 20, completion_tokens: 10, total_tokens: 30},
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  providerURL = `http://127.0.0.1:${server.address().port}/v1`;
});
test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function signIn(page) {
  await page.goto('/');
  await page.locator('#login-password').fill('browser-test-password');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
}
async function preferences(page, values) {
  const current = await (await page.request.get('/api/prefs')).json();
  const result = await page.request.patch('/api/prefs', {
    headers: {'If-Match': String(current.revision)},
    data: {...current, ...values},
  });
  expect(result.ok()).toBe(true);
}
async function configured(page, model = 'openrouter/free') {
  await signIn(page);
  await preferences(page, {aiEnabled: true, startView: 'editor', zenFontFamilyGoogle: false});
  const previous = await page.request.get('/api/ai/configurations');
  for (const configuration of await previous.json())
    expect((await page.request.delete(`/api/ai/configurations/${configuration.id}`)).ok()).toBe(
      true,
    );
  const saved = await page.request.post('/api/ai/configurations', {
    data: {name: 'Test provider', url: providerURL, key: '', model},
  });
  expect(saved.ok()).toBe(true);
  const configuration = await saved.json();
  expect((await page.request.post(`/api/ai/configurations/${configuration.id}/check`)).ok()).toBe(
    true,
  );
  expect((await page.request.post(`/api/ai/configurations/${configuration.id}/default`)).ok()).toBe(
    true,
  );
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#ai-launch')).toBeEnabled();
}
async function shareNote(page) {
  await page.getByRole('combobox', {name: 'Shared text', exact: true}).selectOption('note');
  await discardIfAsked(page);
}
async function discardIfAsked(page) {
  const dialog = page.getByRole('dialog', {name: 'Discard AI conversation?', exact: true});
  if (await dialog.isVisible())
    await dialog.getByRole('button', {name: 'Discard conversation', exact: true}).click();
}
async function closeAI(page) {
  await page.getByRole('button', {name: 'Close AI', exact: true}).click();
  await discardIfAsked(page);
  await expect(page.locator('.ai-review')).toHaveCount(0);
}
test.afterEach(async ({page}) => {
  const current = await page.request.get('/api/prefs');
  if (current.ok())
    await preferences(page, {
      aiEnabled: false,
      startView: 'editor',
      fontFamily: 'system-sans',
      fontFamilyGoogle: false,
      fontSize: '1rem',
    });
});

test('disabled AI stays confined to preferences without loading AI modules', async ({page}) => {
  await signIn(page);
  await preferences(page, {aiEnabled: false});
  const requested = [];
  page.on('request', (request) => {
    if (/\/js\/(editor\/ai-controller|ui\/ai-settings)|\/api\/ai\//.test(request.url()))
      requested.push(request.url());
  });
  await page.reload();
  await page.locator('#new-note-btn').click();
  await expect(page.locator('#ai-launch')).toBeHidden();
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-shortcuts').click();
  await expect(page.locator('#shortcut-groups')).not.toContainText('Open AI');
  expect(requested).toEqual([]);
  const recorder = page.locator('[data-shortcut-command="note.new"]');
  await recorder.click();
  await page.keyboard.press('Control+e');
  await page.keyboard.press('a');
  await expect(page.locator('#shortcut-recorder-status')).toHaveText('Shortcut updated.');
  await recorder.click();
  await page.keyboard.press('Control+e');
  await page.keyboard.press('n');
  await expect(page.locator('#shortcut-recorder-status')).toHaveText('Shortcut updated.');
  await page.locator('#prefs-tab-ai').click();
  await expect(page.locator('#pref-ai-enabled')).not.toBeChecked();
  await expect(page.locator('#ai-settings')).toBeEmpty();
});

test('saves each accepted selection edit and keeps the review open for follow-ups', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 960});
  await configured(page);
  const original = '# Private heading\n\n- [ ] Plan launch\n\nUnshared details';
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#note-content').evaluate((node) => {
    const start = node.value.indexOf('- [ ]');
    node.setSelectionRange(start, start + '- [ ] Plan launch'.length);
    node.focus();
  });
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue(
    'selection',
  );
  await expect(page.locator('#note-content')).toBeVisible();
  await page.locator('#ai-prompt').fill('expand launch');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toBeVisible();
  await expect(page.locator('.ai-message--user p')).toHaveText('expand launch');
  await expect(page.locator('.ai-message--assistant p')).toHaveText(
    'Here is a practical first step.',
  );
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took \d+(?:\.\d)?s$/);
  await expect(page.getByRole('button', {name: 'Accept changes', exact: true})).toHaveCount(0);
  await expect(page.locator('#note-content')).toHaveValue(original);
  const first = calls.findLast((call) => call.messages.at(-1).content.includes('expand launch'));
  expect(JSON.stringify(first)).not.toContain('Unshared details');
  expect(JSON.stringify(first)).not.toContain('Private heading');
  await page.screenshot({path: testInfo.outputPath('ai-desktop.png'), fullPage: true});
  const pendingID = await page.locator('.ai-hunk').getAttribute('data-hunk-id');
  await page.locator('#ai-prompt').fill('which model are you?');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-message--assistant p').last()).toHaveText(
    'I am an AI language model.',
  );
  await expect(page.locator('.ai-hunk')).toHaveAttribute('data-hunk-id', pendingID);
  await expect(page.locator('#note-content')).toHaveValue(original);
  await page.getByRole('button', {name: 'Accept change', exact: true}).click();
  const expanded = original.replace(
    '- [ ] Plan launch',
    '- [ ] Draft the launch outline\n- [ ] Review the launch outline',
  );
  await expect(page.locator('#note-content')).toHaveValue(expanded);
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await expect(page.locator('.ai-context-mirror mark')).toHaveText(
    '- [ ] Draft the launch outline\n- [ ] Review the launch outline',
  );
  await expect(page.locator('.ai-note-review')).toBeHidden();
  await page.getByRole('button', {name: 'View shared text', exact: true}).click();
  await expect(page.locator('.ai-context-preview')).toHaveText(
    '- [ ] Draft the launch outline\n- [ ] Review the launch outline',
  );
  await page.getByRole('button', {name: 'Close shared text', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Undo last acceptance', exact: true})).toHaveCount(
    0,
  );
  await page.locator('#ai-prompt').fill('make it shorter');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk ins')).toHaveText(
    '- [ ] Draft and review the launch outline',
  );
  expect(calls.at(-1).messages.at(-1).content).toContain('Draft the launch outline');
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(
    original.replace('- [ ] Plan launch', '- [ ] Draft and review the launch outline'),
  );
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await closeAI(page);
  await page.locator('[data-panel="both"]').click();
  await expect(page.locator('#ai-launch')).toBeHidden();
  await page.locator('[data-panel="preview"]').click();
  await expect(page.locator('#ai-launch')).toBeHidden();
  await page.locator('[data-panel="zen"]').click();
  await expect(page.locator('#ai-launch')).toBeHidden();
});

test('previews shared context from a chip, follows interface typography, and keeps AI out of Zen mode', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 960});
  await configured(page);
  const original =
    'Plan launch\n\n' +
    Array.from({length: 40}, (_, index) => `Private detail ${index + 1}.`).join('\n');
  const source = page.locator('#note-content');
  await source.fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await preferences(page, {
    fontFamily: 'system-serif',
    fontFamilyGoogle: false,
    fontSize: '1.25rem',
  });
  await page.reload();
  await expect(source).toHaveValue(original);
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(0, 'Plan launch'.length);
  });
  const assist = page.getByRole('button', {name: 'Ask AI', exact: true});
  await expect(assist).toBeVisible();
  const sourceBox = await source.boundingBox();
  await expect.poll(async () => (await assist.boundingBox()).x).toBeLessThan(sourceBox.x + 160);
  expect((await assist.boundingBox()).y).toBeGreaterThan(sourceBox.y + 32);
  await page.screenshot({path: testInfo.outputPath('ai-assist-selection.png')});
  await assist.click();
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue(
    'selection',
  );
  const mirror = page.locator('.ai-context-mirror');
  await expect(mirror.locator('mark')).toHaveText('Plan launch');
  await expect(page.locator('.ai-note-review')).toBeHidden();
  await expect(page.locator('.ai-context-count')).toHaveText('2 words');
  const selectionChip = page.getByRole('button', {name: 'View shared text', exact: true});
  await selectionChip.click();
  const contextDialog = page.getByRole('dialog', {name: 'Shared selection', exact: true});
  await expect(contextDialog).toBeVisible();
  await expect(contextDialog.locator('.ai-context-preview')).toHaveText('Plan launch');
  await expect(contextDialog).not.toContainText('Private detail');
  const accessibility = await new AxeBuilder({page}).include('#ai-context-dialog').analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact),
    ),
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(contextDialog).toBeHidden();
  await expect(selectionChip).toBeFocused();
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await selectionChip.click();
  await page.locator('#ai-context-dialog .modal-backdrop').click({position: {x: 4, y: 4}});
  await expect(contextDialog).toBeHidden();
  await expect(selectionChip).toBeFocused();
  await page.getByRole('button', {name: 'Remove shared selection', exact: true}).click();
  await discardIfAsked(page);
  await expect(page.locator('.ai-context-bar')).toBeHidden();
  await expect(mirror).toBeHidden();
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue('none');
  await expect(page.locator('#ai-prompt')).toBeFocused();
  expect(await source.evaluate((node) => node.selectionStart === node.selectionEnd)).toBe(true);
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await page.getByRole('combobox', {name: 'Shared text', exact: true}).selectOption('selection');
  await expect(selectionChip).toBeVisible();
  await expect(mirror.locator('mark')).toHaveText('Plan launch');
  await expect(page.locator('.ai-review')).not.toContainText('Private detail');
  await expect(page.locator('.ai-sharing-disclosure')).toHaveCount(0);
  await page.locator('#ai-prompt').fill('give me ideas');
  await expect(mirror).toBeVisible();
  await source.evaluate((node) => (node.scrollTop = 200));
  await expect.poll(() => mirror.evaluate((node) => node.scrollTop)).toBe(200);
  await source.evaluate((node) => (node.scrollTop = 0));
  await expect.poll(() => mirror.evaluate((node) => node.scrollTop)).toBe(0);
  const fonts = await page.evaluate(() => {
    const metrics = (selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return {family: style.fontFamily, size: style.fontSize};
    };
    return {
      body: metrics('body'),
      sidebar: metrics('.ai-review'),
      prompt: metrics('#ai-prompt'),
      review: metrics('.ai-note-review'),
    };
  });
  expect(fonts.sidebar).toEqual(fonts.body);
  expect(fonts.prompt).toEqual(fonts.body);
  expect(fonts.review.family).toEqual(
    await source.evaluate((node) => getComputedStyle(node).fontFamily),
  );
  await page.screenshot({path: testInfo.outputPath('ai-shared-selection.png'), fullPage: true});
  await shareNote(page);
  await expect(mirror.locator('mark')).toHaveText(original);
  const noteChip = page.getByRole('button', {name: 'View shared text', exact: true});
  await noteChip.click();
  const noteDialog = page.getByRole('dialog', {name: 'Shared note', exact: true});
  await expect(noteDialog.locator('.ai-context-preview')).toHaveText(original);
  const dialogFont = await noteDialog.evaluate((node) => ({
    family: getComputedStyle(node).fontFamily,
    size: getComputedStyle(node).fontSize,
  }));
  expect(dialogFont).toEqual(fonts.body);
  await page.screenshot({path: testInfo.outputPath('ai-context-desktop.png'), fullPage: true});
  await page.keyboard.press('Shift+Tab');
  await expect(noteDialog.locator('.ai-context-preview')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', {name: 'Close shared text'})).toBeFocused();
  await page.setViewportSize({width: 390, height: 844});
  const dialogBox = await noteDialog.boundingBox();
  expect(dialogBox.width).toBeLessThanOrEqual(358);
  expect(dialogBox.height).toBeLessThanOrEqual(812);
  await page.screenshot({path: testInfo.outputPath('ai-context-mobile.png'), fullPage: true});
  expect(
    await noteDialog
      .locator('.ai-context-preview')
      .evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  await page.getByRole('button', {name: 'Close shared text'}).click();
  await expect(noteChip).toBeFocused();
  await page.setViewportSize({width: 1440, height: 960});
  await expect(page.locator('.ai-query-status')).toBeEmpty();
  await page.getByRole('button', {name: 'Remove shared note', exact: true}).click();
  await discardIfAsked(page);
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue('none');
  await expect(mirror).toBeHidden();
  await expect(page.locator('.ai-context-bar')).toBeHidden();
  await expect(page.locator('.ai-note-review')).toBeHidden();
  await closeAI(page);
  await expect(mirror).toHaveCount(0);
  await expect(page.locator('#ai-context-dialog')).toHaveCount(0);

  await page.locator('[data-panel="zen"]').click();
  const zen = page.locator('#zen-source-editor');
  await zen.evaluate((node) => {
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node.firstElementChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('#zen-selection-toolbar')).toBeVisible();
  await expect(page.locator('[data-zen-format="ai"]')).toHaveCount(0);
  await page.keyboard.press('Control+e');
  await page.keyboard.press('a');
  await expect(page.locator('.ai-review')).toHaveCount(0);
  await expect(zen).toHaveAttribute('contenteditable', 'true');
});

test('resizes AI, shows pending prompts, and starts a fresh query from a new selection', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 960});
  await configured(page);
  const source = page.locator('#note-content');
  await source.fill('first\nsecond');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await preferences(page, {
    fontFamily: 'system-serif',
    fontFamilyGoogle: false,
    accentColor: '#7c3aed',
    theme: 'default-dark',
  });
  await page.reload();
  const appHeader = page.locator('#editor > header > .header-inner');
  const closedWidth = (await appHeader.boundingBox()).width;
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(0, 0);
  });
  await page.locator('#ai-launch').click();
  await expect.poll(async () => (await appHeader.boundingBox()).width).toBeGreaterThan(closedWidth);
  await expect(source).not.toBeEditable();
  await source.press('x');
  await expect(page.locator('#toast-region')).toContainText('Close AI to edit the note directly.');
  await expect(source).toHaveValue('first\nsecond');
  const scopePicker = page.getByRole('combobox', {name: 'Shared text', exact: true});
  const selectionOption = scopePicker.locator('option[value="selection"]');
  await expect(selectionOption).toHaveAttribute('disabled', '');
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(0, 5);
  });
  await expect(selectionOption).not.toHaveAttribute('disabled');
  await expect(scopePicker).toHaveValue('none');
  await expect(page.locator('.ai-context-bar')).toBeHidden();
  await scopePicker.selectOption('selection');
  const sidebar = page.locator('.ai-review');
  await expect(page.locator('.ai-review-header strong')).toHaveText('AI');
  await expect(page.locator('.ai-context-prefix')).toHaveText('first…');
  await expect(page.locator('.ai-context-count')).toHaveText('1 word');
  const separator = page.getByRole('separator', {name: 'Resize AI sidebar'});
  const before = (await sidebar.boundingBox()).width;
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeGreaterThan(before + 20);
  const box = await separator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeGreaterThan(before + 60);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/ai/sessions/*/start', async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator('#ai-prompt').fill('give me ideas');
  const send = page.getByRole('button', {name: 'Send', exact: true});
  await expect(send).toHaveText('');
  await send.click();
  await expect(page.locator('.ai-message--user p')).toHaveText('give me ideas');
  await expect(page.locator('.ai-query-status')).toHaveText(/^Working\d+s$/);
  await expect(page.locator('.ai-query-status .ai-test-spinner')).toBeVisible();
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(6, 12);
  });
  const select = page.getByRole('button', {name: 'Select this text', exact: true});
  await expect(select).toBeVisible();
  await expect(select).toBeDisabled();
  await page.screenshot({path: testInfo.outputPath('ai-working-desktop.png'), fullPage: true});
  release();
  await expect(page.locator('.ai-message--assistant p')).toContainText('Try a small prototype.');
  await expect(page.locator('.ai-message--assistant .ai-message-role')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Copy answer'})).toHaveCount(0);
  await expect(select).toBeEnabled();
  await select.click();
  await discardIfAsked(page);
  await expect(page.locator('.ai-context-prefix')).toHaveText('second…');
  await expect(page.locator('.ai-context-count')).toHaveText('1 word');
  await expect(page.locator('.ai-message')).toHaveCount(0);
  await expect(page.locator('#ai-prompt')).toHaveValue('');
  await page.locator('#ai-prompt').fill('give me ideas again');
  await send.click();
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  const messages = calls.at(-1).messages;
  expect(messages).toHaveLength(2);
  expect(
    JSON.parse(messages.at(-1).content)
      .blocks.map((block) => block.text)
      .join(''),
  ).toBe('second');
  const metrics = await page.evaluate(() => ({
    bodyFont: getComputedStyle(document.body).fontFamily,
    sidebarFont: getComputedStyle(document.querySelector('.ai-review')).fontFamily,
    header: document.querySelector('.ai-review-header').getBoundingClientRect().height,
  }));
  expect(metrics.sidebarFont).toBe(metrics.bodyFont);
  expect(metrics.header).toBeLessThanOrEqual(34);
  const accessibility = await new AxeBuilder({page}).include('.ai-review').analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact),
    ),
  ).toEqual([]);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({width, height: 960});
    await expect(sidebar).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({path: testInfo.outputPath(`ai-sidebar-${width}.png`), fullPage: true});
  }
  await closeAI(page);
  await expect(separator).toHaveCount(0);
  await expect(select).toHaveCount(0);
  await preferences(page, {accentColor: '', theme: 'default-light'});
});

test('whole-note proofreading saves accepted hunks and leaves rejected text unchanged', async ({
  page,
}) => {
  await configured(page);
  const original = '# Draft\n\nHe go home yesterday.\n\nShe walk to work.\n';
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await preferences(page, {fontSize: '1.25rem'});
  await page.reload();
  await expect(page.locator('#note-content')).toHaveValue(original);
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('fix grammar in the whole note');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await expect(page.locator('.ai-hunk del .ai-diff-word').first()).toHaveText('go');
  await expect(page.locator('.ai-hunk ins .ai-diff-word').first()).toHaveText('went');
  await expect(page.locator('#note-content')).toHaveValue(original);
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().click();
  await expect(page.locator('#note-content')).toHaveValue(
    '# Draft\n\nHe went home yesterday.\n\nShe walk to work.\n',
  );
  await page.getByRole('button', {name: 'Reject change', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(
    '# Draft\n\nHe went home yesterday.\n\nShe walk to work.\n',
  );
  await closeAI(page);
  await page.reload();
  await expect(page.locator('#note-content')).toHaveValue(
    '# Draft\n\nHe went home yesterday.\n\nShe walk to work.\n',
  );
});

test('retries a failed local acceptance save before allowing further changes', async ({page}) => {
  await configured(page);
  const source = page.locator('#note-content');
  await source.fill('first\nsecond');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(0, node.value.length);
  });
  await page.locator('#ai-launch').click();
  await page.locator('#ai-prompt').fill('two edits');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(2);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'notes' && value.content === 'FIRST\nsecond') {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('Simulated storage failure', 'QuotaExceededError');
      }
      return put.call(this, value, ...args);
    };
  });
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().click();
  await expect(page.getByRole('button', {name: 'Retry save', exact: true})).toBeVisible();
  await expect(source).toHaveValue('first\nsecond');
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Retry save', exact: true}).click();
  await expect(source).toHaveValue('FIRST\nsecond');
  await expect(page.getByRole('button', {name: 'Retry save', exact: true})).toBeHidden();
  await page.getByRole('button', {name: 'Accept change', exact: true}).click();
  await expect(source).toHaveValue('FIRST\nSECOND');
  await closeAI(page);
  await page.reload();
  await expect(source).toHaveValue('FIRST\nSECOND');
});

test('mobile prompt-only conversation renders untrusted answers as text', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await configured(page);
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue('none');
  // A brand-new blank note has no remote record yet. Force a full snapshot
  // while AI is open; absence from that snapshot must not mean deletion.
  let forcedSnapshot = false;
  await page.route('**/api/sync?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (!forcedSnapshot) {
      forcedSnapshot = true;
      data.resetRequired = true;
    }
    await route.fulfill({response, json: data});
  });
  // Advance the real server cursor instead of overwriting it during an active sync.
  const seed = await page.request.post('/api/notes', {
    data: {title: 'Sync fixture', tags: '', content: 'Existing server note', base_revision: 0},
  });
  expect(seed.ok()).toBe(true);
  const sync = await page.request.get('/api/sync?since=0&limit=100');
  expect(sync.ok()).toBe(true);
  const targetSequence = (await sync.json()).nextSequence;
  expect(targetSequence).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const request = indexedDB.open('vylk-offline');
          const db = await new Promise((resolve) => {
            request.onsuccess = () => resolve(request.result);
          });
          try {
            const get = db
              .transaction('state', 'readonly')
              .objectStore('state')
              .get('syncSequence');
            return await new Promise((resolve) => {
              get.onsuccess = () => resolve(Number(get.result?.value || 0));
            });
          } finally {
            db.close();
          }
        }),
      {timeout: 20_000},
    )
    .toBeGreaterThanOrEqual(targetSequence);
  expect(forcedSnapshot).toBe(true);
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await page.locator('#ai-prompt').fill('give me ideas');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-conversation')).toContainText(
    '<script>alert("safe text")</script>',
  );
  await expect(page.locator('.ai-conversation script')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Accept changes', exact: true})).toBeHidden();
  await page.screenshot({path: testInfo.outputPath('ai-mobile.png'), fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await closeAI(page);
  await expect(page.locator('#note-content')).toBeEditable();
});

test('preferences test a configuration before Save and keep shared inputs aligned', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 960});
  await signIn(page);
  await page.locator('#prefs-btn').click();
  await page.locator('#prefs-tab-ai').click();
  await expect(page.getByText('Enable AI Assist', {exact: true})).toBeVisible();
  await page.locator('#pref-ai-enabled').check();
  await expect(page.getByRole('button', {name: 'Add configuration', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Add configuration', exact: true}).click();
  const form = page.locator('.ai-config-form');
  const testButton = form.getByRole('button', {name: 'Test', exact: true});
  const save = form.getByRole('button', {name: 'Save', exact: true});
  await expect(form.getByRole('heading', {name: 'Add new configuration'})).toBeVisible();
  await expect(testButton).toBeDisabled();
  await expect(save).toBeDisabled();
  await page.screenshot({path: testInfo.outputPath('ai-form-empty.png'), fullPage: true});
  await page.getByLabel('Name', {exact: true}).fill('UI configured provider');
  await page.getByLabel('Endpoint', {exact: true}).fill('https://openrouter.ai/api/v1');
  await page.getByLabel('Model', {exact: true}).fill('openrouter/free');
  await expect(testButton).toBeDisabled();
  await page.getByLabel('API Key', {exact: true}).fill('test-key');
  await expect(testButton).toBeEnabled();
  await page.getByLabel('Endpoint', {exact: true}).fill(providerURL);
  const [endpoint, model] = await Promise.all([
    page.getByLabel('Endpoint', {exact: true}).boundingBox(),
    page.getByLabel('Model', {exact: true}).boundingBox(),
  ]);
  expect(endpoint.y).toBeCloseTo(model.y, 0);
  expect(endpoint.width).toBeCloseTo(model.width, 0);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({width, height: 960});
    await page.screenshot({path: testInfo.outputPath(`ai-form-${width}.png`), fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({width: 1440, height: 960});
  let releaseTest;
  const failTest = (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({error: 'Provider rejected this API key.', code: 'ai_request_failed'}),
    });
  await page.route('**/api/ai/configurations/test', failTest);
  await testButton.click();
  await expect(page.locator('#ai-settings-status')).toHaveText('Provider rejected this API key.');
  await expect(save).toBeDisabled();
  await expect(testButton).toBeEnabled();
  await expect(form.locator('.ai-test-result')).toBeEmpty();
  await page.screenshot({path: testInfo.outputPath('ai-form-error.png'), fullPage: true});
  await page.unroute('**/api/ai/configurations/test', failTest);
  const idleTestBounds = await testButton.boundingBox();
  const gate = new Promise((resolve) => {
    releaseTest = resolve;
  });
  const holdTest = async (route) => {
    await gate;
    await route.continue();
  };
  await page.route('**/api/ai/configurations/test', holdTest);
  await testButton.click();
  try {
    await expect(form.getByRole('button', {name: 'Testing', exact: true})).toBeDisabled();
    expect(
      (await form.getByRole('button', {name: 'Testing', exact: true}).boundingBox()).width,
    ).toBeCloseTo(idleTestBounds.width, 0);
    await expect(save).toBeDisabled();
    await page.screenshot({path: testInfo.outputPath('ai-form-testing.png'), fullPage: true});
  } finally {
    releaseTest();
  }
  await expect(form.locator('.ai-test-result')).toHaveText('OK');
  await expect(form.getByLabel('Context window (tokens)', {exact: true})).toHaveValue('128000');
  await expect(testButton).toBeEnabled();
  await expect(testButton).toBeFocused();
  await expect(save).toBeEnabled();
  await page.unroute('**/api/ai/configurations/test', holdTest);
  await page.getByLabel('Model', {exact: true}).fill('');
  await expect(testButton).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(form.locator('.ai-test-result')).toBeEmpty();
  await page.getByLabel('Model', {exact: true}).fill('openrouter/free');
  await expect(testButton).toBeEnabled();
  await expect(save).toBeDisabled();
  await testButton.click();
  await expect(form.locator('.ai-test-result')).toHaveText('OK');
  await page.screenshot({path: testInfo.outputPath('ai-form-ok.png'), fullPage: true});
  for (const theme of ['default-dark', 'default-light']) {
    await page.locator('#prefs-tab-appearance').click();
    await page.locator('#pref-theme').selectOption(theme);
    await page.locator('#prefs-tab-ai').click();
    await expect(form.locator('.ai-test-result')).toHaveText('OK');
    const accessibility = await new AxeBuilder({page}).include('#prefs-panel-ai').analyze();
    expect(
      accessibility.violations.filter((violation) =>
        ['critical', 'serious'].includes(violation.impact),
      ),
    ).toEqual([]);
    await page.screenshot({path: testInfo.outputPath(`ai-form-${theme}.png`), fullPage: true});
  }
  await save.click();
  const row = page.locator('.ai-configuration').filter({hasText: 'UI configured provider'});
  await expect(row).toBeVisible();
  await expect(row).toContainText('Checked');
  await page.screenshot({path: testInfo.outputPath('ai-settings.png'), fullPage: true});
  await row.getByRole('button', {name: 'Edit', exact: true}).click();
  await expect(page.getByLabel('API Key', {exact: true})).toHaveValue('');
  await expect(page.getByLabel('API Key', {exact: true})).toHaveAttribute(
    'placeholder',
    /Saved key/,
  );
  await expect(form.getByRole('button', {name: 'Save', exact: true})).toBeDisabled();
  await page.locator('#pref-ai-enabled').uncheck();
  await expect(page.locator('#ai-settings')).toBeEmpty();
  await page.locator('#prefs-tab-shortcuts').click();
  await expect(page.locator('#shortcut-groups')).not.toContainText('Open AI');
});

test('AI Assist enable and disable propagate between devices', async ({page, browser}) => {
  await signIn(page);
  const context = await browser.newContext({baseURL: new URL(page.url()).origin});
  const other = await context.newPage();
  try {
    await signIn(other);
    for (const current of [page, other]) {
      await current.locator('#prefs-btn').click();
      await current.locator('#prefs-tab-ai').click();
    }
    await page.locator('#pref-ai-enabled').check();
    await expect(other.locator('#pref-ai-enabled')).toBeChecked();
    await other.locator('#pref-ai-enabled').uncheck();
    await expect(page.locator('#pref-ai-enabled')).not.toBeChecked();
    expect((await (await page.request.get('/api/prefs')).json()).aiEnabled).toBe(false);
  } finally {
    await context.close();
  }
});

test('a same-content remote save preserves staged AI review across revision changes', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('- [ ] Plan launch');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('expand launch');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk')).toHaveCount(1);
  const noteID = new URL(page.url()).pathname.slice(1);
  const current = await (await page.request.get(`/api/notes/${noteID}`)).json();
  const result = await page.request.post('/api/notes', {
    data: {
      id: current.id,
      title: current.title,
      tags: current.tags,
      content: current.content,
      base_revision: current.revision,
    },
  });
  expect(result.ok()).toBe(true);
  const saved = await result.json();
  expect(saved.revision).toBeGreaterThan(current.revision);
  await expect
    .poll(() =>
      page.evaluate(
        async ({noteID, revision}) => {
          const request = indexedDB.open('vylk-offline');
          const db = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const get = db.transaction('notes', 'readonly').objectStore('notes').get(noteID);
            const note = await new Promise((resolve, reject) => {
              get.onsuccess = () => resolve(get.result);
              get.onerror = () => reject(get.error);
            });
            return note?.revision === revision || note?.base_revision === revision;
          } finally {
            db.close();
          }
        },
        {noteID, revision: saved.revision},
      ),
    )
    .toBe(true);
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(
    '- [ ] Draft the launch outline\n- [ ] Review the launch outline',
  );
});

async function editRemotely(page, content) {
  const noteID = new URL(page.url()).pathname.slice(1);
  const current = await (await page.request.get(`/api/notes/${noteID}`)).json();
  const result = await page.request.post('/api/notes', {
    data: {
      id: current.id,
      title: current.title,
      tags: current.tags,
      content,
      base_revision: current.revision,
    },
  });
  expect(result.ok()).toBe(true);
}

test('a remote note edit keeps the AI conversation without overwriting that edit', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('- [ ] Plan launch');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#note-content').evaluate((node) => {
    node.setSelectionRange(0, node.value.length);
    node.focus();
  });
  await page.locator('#ai-launch').click();
  await page.locator('#ai-prompt').fill('expand launch');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  const noteID = new URL(page.url()).pathname.slice(1);
  const accepted = await page.locator('#note-content').inputValue();
  // Accepted changes sync without closing AI, so the remote edit builds on them.
  await expect
    .poll(async () => (await (await page.request.get(`/api/notes/${noteID}`)).json()).content)
    .toBe(accepted);
  await editRemotely(page, 'Changed on another device');
  await expect(page.locator('#note-content')).toHaveValue('Changed on another device');
  await expect(page.locator('#ai-prompt')).toBeVisible();
  await expect(page.locator('.ai-message--user p')).toHaveText('expand launch');
});

test('a remote edit moves untouched suggestions and marks touched ones outdated', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(2);
  // Text appended after a suggestion leaves it applicable; this edit changes its word.
  await editRemotely(page, 'first\nsecund');
  await expect(page.locator('.ai-hunk--outdated')).toHaveCount(1);
  await expect(page.locator('.ai-hunk--outdated del')).toHaveText('second');
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(1);
  await page.getByRole('button', {name: 'Accept change', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecund');
  await page.getByRole('button', {name: 'Dismiss outdated change', exact: true}).click();
  await expect(page.locator('.ai-hunk')).toHaveCount(0);
  await expect(page.locator('#note-content')).toBeVisible();
  const noteID = new URL(page.url()).pathname.slice(1);
  await expect
    .poll(async () => (await (await page.request.get(`/api/notes/${noteID}`)).json()).content)
    .toBe('FIRST\nsecund');
});

test('a same-line conflict keeps AI open and rebases onto the resolution', async ({page}) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(2);
  // Hold pushes so the accepted change stays local while another device edits.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/sync/push', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().click();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecond');
  await editRemotely(page, 'first edited elsewhere\nsecond');
  release();
  await expect(page.locator('#conflict-modal')).toBeVisible();
  await expect(page.locator('#ai-prompt')).toBeAttached();
  await expect(page.locator('.ai-message--user p')).toHaveText('two edits');
  await expect(page.locator('#note-content')).toHaveValue('first edited elsewhere\nsecond');
  await page.locator('#conflict-use-local').click();
  await page.locator('#conflict-save').click();
  await expect(page.locator('#conflict-modal')).toBeHidden();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecond');
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(1);
  await page.getByRole('button', {name: 'Accept change', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nSECOND');
});

test('keyboard review preserves focus through errors and saves accepted changes', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#note-content').evaluate((node) => {
    node.setSelectionRange(0, node.value.length);
    node.focus();
  });
  await page.keyboard.press('Control+e');
  await page.keyboard.press('a');
  await expect(page.locator('#ai-prompt')).toBeFocused();
  await page.locator('#ai-prompt').fill('two edits');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(2);
  let fail = true;
  await page.route('**/api/ai/sessions/*/review', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({error: 'Review failed; try again.', code: 'ai_request_failed'}),
      });
    } else await route.continue();
  });
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ai-query-status')).toHaveText('Review failed; try again.');
  await expect(
    page.getByRole('button', {name: 'Accept change', exact: true}).first(),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toHaveCount(1);
  await expect(page.getByRole('button', {name: 'Accept change', exact: true})).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', {name: 'Reject change', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ai-prompt')).toBeFocused();
  await expect(page.getByRole('button', {name: 'Accept changes', exact: true})).toHaveCount(0);
  await expect(page.locator('.ai-review')).toHaveCount(1);
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecond');
});

test('sends a whole-note request directly and reviews combined diffs in the editor', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 960});
  await configured(page);
  const original =
    '# Draft\n\n' +
    Array.from(
      {length: 360},
      (_, i) => `Paragraph ${i}: He go home after work. Keep this sentence.\n\n`,
    ).join('');
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('chunk-proofread');
  const before = calls.length;
  let completionReads = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.searchParams.get('job') === '1') {
      completionReads++;
      expect(url.searchParams.get('wait')).toBe('1');
    }
  });
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.getByRole('button', {name: /Process \d+ sections/})).toHaveCount(0);
  await expect(page.locator('.ai-query-status')).toHaveText(/^Working\d+s$/);
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toBeDisabled();
  await expect(page.locator('.ai-hunk').first()).toBeVisible();
  await expect(page.locator('.ai-review .ai-hunk')).toHaveCount(0);
  await expect(page.locator('.panel-editor .ai-note-review')).toBeVisible();
  await expect(page.locator('.ai-source-text').first()).toHaveText('# Draft\n\n');
  await expect(page.locator('#note-content')).toBeHidden();
  await expect(page.locator('#note-content')).toHaveValue(original);
  expect(completionReads).toBe(1);
  const requests = calls.slice(before);
  const count = requests.length;
  expect(count).toBeGreaterThan(1);
  await expect(page.locator('.ai-message--assistant p')).toHaveText(
    'Suggested changes are ready to review.',
  );
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took \d+(?:\.\d)?s$/);
  let covered = '';
  // Sections run in parallel, so arrival order is not source order.
  const contexts = requests
    .map((request) => JSON.parse(request.messages.at(-1).content))
    .sort((a, b) => a.section - b.section);
  for (const context of contexts) {
    expect(context.sections).toBe(count);
    expect(context.read_only_before).toBeDefined();
    expect(context.read_only_after).toBeDefined();
    covered += context.blocks.map((block) => block.text).join('');
  }
  expect(covered).toBe(original);
  const accessibility = await new AxeBuilder({page})
    .include('.panel-editor')
    .include('.ai-review')
    .analyze();
  expect(
    accessibility.violations.filter((v) => ['critical', 'serious'].includes(v.impact)),
  ).toEqual([]);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({width, height: 960});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 390) {
      const sidebar = await page.locator('.ai-review').boundingBox();
      expect(sidebar.height).toBeGreaterThan(200);
      expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(960);
    }
    await page.screenshot({
      path: testInfo.outputPath(`ai-editor-diff-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('tab', {name: /^Note/}).click();
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#note-content')).toHaveValue(original.replaceAll('He go', 'He goes'));
});

test('cancels a section job and can start another query without stale changes', async ({page}) => {
  await configured(page);
  const original = Array.from(
    {length: 240},
    (_, i) => `Paragraph ${i}: He go home after work.\n\n`,
  ).join('');
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('chunk-cancel');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-query-status')).toHaveText(/^Working\d+s$/);
  await page.getByRole('button', {name: 'Cancel request', exact: true}).click();
  await expect(page.locator('.ai-query-status')).toHaveText('Request cancelled.');
  await expect(page.locator('.ai-hunk')).toHaveCount(0);
  await expect(page.locator('#note-content')).toHaveValue(original);
  await page.getByRole('button', {name: 'Remove shared note', exact: true}).click();
  await discardIfAsked(page);
  await page.locator('#ai-prompt').fill('give me ideas');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-message--assistant')).toContainText('Try a small prototype.');
  await expect(page.locator('.ai-hunk')).toHaveCount(0);
});

test('selects unchanged text from editor diff review as a fresh context', async ({page}) => {
  await configured(page);
  const original = 'first\nsecond\nUntouched paragraph';
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await page
    .locator('.ai-source-text')
    .last()
    .evaluate((element) => {
      const text = element.firstChild;
      const range = document.createRange();
      range.setStart(text, text.textContent.indexOf('Untouched'));
      range.setEnd(text, text.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  const select = page.getByRole('button', {name: 'Select this text', exact: true});
  await expect(select).toBeVisible();
  await select.click();
  await discardIfAsked(page);
  await expect(page.locator('.ai-context-prefix')).toHaveText('Untouched paragraph…');
  await expect(page.locator('.ai-message')).toHaveCount(0);
  await expect(page.locator('.ai-hunk')).toHaveCount(0);
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#note-content')).toHaveValue(original);
});

test('retries invalid structured output inline without repeating the user message', async ({
  page,
}, testInfo) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const query = 'two edits single-retry-once';
  await page.locator('#ai-prompt').fill(query);
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  const status = page.locator('.ai-query-status');
  await expect(status).toContainText("Couldn't complete this request. Your note hasn't changed.");
  const retry = status.getByRole('button', {name: 'retry', exact: true});
  await expect(retry).toBeVisible();
  expect(
    calls.filter((call) => call.messages.at(-1).content.includes('single-retry-once')),
  ).toHaveLength(3);
  await expect(page.locator('.ai-hunk')).toHaveCount(0);
  await page.screenshot({path: testInfo.outputPath('ai-inline-retry.png'), fullPage: true});
  const accessibility = await new AxeBuilder({page}).include('.ai-review').analyze();
  expect(
    accessibility.violations.filter((v) => ['critical', 'serious'].includes(v.impact)),
  ).toEqual([]);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(/^Working\d+s$/);
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await expect(page.locator('.ai-message--user p')).toHaveText(query);
  await expect(page.locator('#note-content')).toHaveValue('first\nsecond');
  await expect(retry).toHaveCount(0);
  expect(
    calls.filter((call) => call.messages.at(-1).content.includes('single-retry-once')),
  ).toHaveLength(4);
});

test('counting a large note answers exactly from a tool without section requests', async ({
  page,
}) => {
  await configured(page);
  const original = Array.from(
    {length: 480},
    (_, i) => `Paragraph ${i}: He go home after work.\n\n`,
  ).join('');
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const sections = calls.length;
  const routes = routeCalls.length;
  await page.locator('#ai-prompt').fill('route-search how many times does He go appear?');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-message--assistant p')).toHaveText('Found 480 matches.');
  expect(routeCalls.length - routes).toBe(1);
  const followUps = calls.slice(sections);
  expect(followUps).toHaveLength(1);
  const results = JSON.parse(followUps[0].messages.at(-1).content);
  expect(results.tool_rounds_remaining).toBe(7);
  expect(results.blocks).toBeUndefined();
  await expect(page.locator('#note-content')).toHaveValue(original);
});

test('inline retry replans a failed section job against the same note', async ({page}) => {
  await configured(page);
  const original = Array.from(
    {length: 480},
    (_, i) => `Paragraph ${i}: He go home after work.\n\n`,
  ).join('');
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const query = 'chunk-proofread multi-retry-once';
  await page.locator('#ai-prompt').fill(query);
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-query-status')).toContainText(
    "Couldn't complete this request. Your note hasn't changed.",
  );
  const retried = () =>
    calls.filter((call) => call.messages.at(-1).content.includes('multi-retry-once')).length;
  const beforeRetry = retried();
  await page.getByRole('button', {name: 'retry', exact: true}).click();
  await expect(page.locator('.ai-hunk').first()).toBeVisible();
  await expect(page.locator('.ai-message--user p')).toHaveText(query);
  await expect(page.locator('#note-content')).toHaveValue(original);
  expect(retried() - beforeRetry).toBe(JSON.parse(calls.at(-1).messages.at(-1).content).sections);
});

test('stable diff labels resolve follow-ups and survive acceptance and replacement', async ({
  page,
}, testInfo) => {
  await configured(page);
  await page.locator('#note-content').fill('first task\nsecond task');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const send = async (query) => {
    await page.locator('#ai-prompt').fill(query);
    await page.getByRole('button', {name: 'Send', exact: true}).click();
  };
  await send('reference first draft');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2']);
  await expect(page.locator('.ai-hunk ins .ai-diff-word').first()).toHaveText('actionable ');
  for (const theme of ['default-light', 'default-dark']) {
    await preferences(page, {theme});
    if (theme === 'default-dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 960});
      await page.screenshot({
        path: testInfo.outputPath(`ai-labelled-word-diffs-${theme}-${width}.png`),
        fullPage: true,
      });
    }
    const accessibility = await new AxeBuilder({page})
      .include('.panel-editor')
      .include('.ai-review')
      .analyze();
    expect(
      accessibility.violations.filter((v) => ['critical', 'serious'].includes(v.impact)),
    ).toEqual([]);
  }
  await preferences(page, {theme: 'default-light'});
  await page.setViewportSize({width: 1440, height: 960});
  const first = page
    .locator('.ai-hunk')
    .filter({has: page.locator('.ai-hunk-ref', {hasText: '@1'})});
  await expect(
    first.getByRole('button', {name: 'Accept change', exact: true}),
  ).toHaveAccessibleDescription('@1');
  await first.getByRole('button', {name: 'Accept change', exact: true}).click();
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@2']);
  await send('make @2 shorter');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@2.1']);
  const revised = JSON.parse(calls.at(-1).messages.at(-1).content);
  expect(revised.references).toMatchObject([
    {
      ref: '@2',
      status: 'pending',
      editable_here: true,
    },
  ]);
  expect(revised.mode).toBe('revise_suggestions');
  expect(revised.blocks).toEqual([{id: '@2', text: 'second actionable task'}]);
  expect(revised.originals_read_only).toEqual([{id: '@2', text: 'second task'}]);
  expect(revised.references[0]).not.toHaveProperty('before');
  expect(revised.references[0]).not.toHaveProperty('after');
  await send('what happened to @2?');
  await expect(page.locator('.ai-message--assistant p').last()).toHaveText(
    '@2 was superseded. Use @2.1 for the current change.',
  );
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@2.1']);
  expect(JSON.parse(calls.at(-1).messages.at(-1).content).references).toMatchObject([
    {ref: '@2', status: 'superseded', after: 'second actionable task', editable_here: false},
  ]);
  await page.getByRole('button', {name: 'Reject change', exact: true}).click();
  await send('show current @2.1 status');
  await expect(page.locator('.ai-message--assistant p').last()).toHaveText('You rejected @2.1.');
  expect(JSON.parse(calls.at(-1).messages.at(-1).content).references[0].status).toBe('rejected');
  await send('another proposal');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@3']);
  const count = calls.length;
  await send('change @999');
  await expect(page.locator('.ai-query-status')).toContainText('unknown change reference @999');
  expect(calls).toHaveLength(count);
  await expect(page.locator('#note-content')).toHaveValue('first actionable task\nsecond task');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@3']);
});

test('shows elapsed time beside Working and replaces it with completed duration', async ({
  page,
}, testInfo) => {
  await configured(page);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/ai/sessions/*/plan', async (route) => {
    await held;
    await route.continue();
  });
  await page.locator('#ai-launch').click();
  await page.locator('#ai-prompt').fill('give me ideas');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  const status = page.locator('.ai-query-status');
  try {
    await expect(status).toHaveText(/^Working\d+s$/);
    await expect(status.locator('span[aria-hidden="true"]')).toHaveText(/^[1-9]\d*s$/);
    await expect(status.locator('.ai-test-spinner')).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 960});
      await expect
        .poll(() =>
          status.evaluate((node) => {
            const bounds = node.parentElement.getBoundingClientRect();
            const rect = node.getBoundingClientRect();
            return rect.bottom <= bounds.bottom + 1 && rect.top >= bounds.top - 1;
          }),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`ai-working-time-${width}.png`),
        fullPage: true,
      });
    }
  } finally {
    release();
  }
  await expect(status).toHaveText(/^Took /);
  await expect(status.locator('.ai-test-spinner')).toHaveCount(0);
  await closeAI(page);
});

test('thinking stays hidden when the provider cannot control reasoning', async ({page}) => {
  await configured(page);
  const count = calls.length;
  await page.locator('#ai-launch').click();
  await expect(page.locator('.ai-review')).toBeVisible();
  const capabilities = await page.request.get('/api/ai/capabilities');
  expect(await capabilities.json()).toMatchObject({thinking_controllable: false});
  await expect(page.getByRole('checkbox', {name: 'Use thinking (slower)'})).toBeHidden();
  expect(calls.length).toBe(count);
  await closeAI(page);
});

test('optional thinking starts unchecked and sends the per-request choice', async ({
  page,
}, testInfo) => {
  await configured(page);
  // Isolate the UI against advertised capabilities; provider parameter mapping
  // and plan snapshots are exercised independently by the Go tests.
  await page.route('**/api/ai/capabilities', (route) =>
    route.fulfill({json: {thinking_controllable: true}}),
  );
  await page.route('**/api/ai/sessions', async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({response, json: {...session, thinking_controllable: true}});
  });
  const settings = [];
  await page.route('**/api/ai/sessions/*/plan', async (route) => {
    settings.push(route.request().postDataJSON().thinking);
    await route.fulfill({status: 400, json: {error: 'Thinking request recorded'}});
  });
  await page.locator('#ai-launch').click();
  const thinking = page.getByRole('checkbox', {name: 'Use thinking (slower)'});
  await expect(thinking).toBeVisible();
  await expect(thinking).not.toBeChecked();
  for (const enabled of [false, true]) {
    await thinking.setChecked(enabled);
    await page.locator('#ai-prompt').fill('give me ideas');
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await expect.poll(() => settings.length).toBe(enabled ? 2 : 1);
    await expect(thinking).toBeEnabled();
  }
  expect(settings).toEqual([false, true]);
  await thinking.uncheck();
  await page.getByRole('button', {name: 'retry', exact: true}).click();
  await expect.poll(() => settings).toEqual([false, true, false]);
  await expect(thinking).toBeEnabled();
  await page.screenshot({path: testInfo.outputPath('ai-thinking-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await expect(thinking).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('ai-thinking-mobile.png'), fullPage: true});
  await closeAI(page);
  await page.locator('#ai-launch').click();
  await expect(thinking).not.toBeChecked();
  await closeAI(page);
});

test('proofreading preserves paragraph and heading separators omitted by the provider', async ({
  page,
}) => {
  await configured(page);
  const original =
    '# Draft\n\nHe go home.\n\nShe walk to work.\n\n## Next section\n\nUnchanged text';
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('boundaries-proofread');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  const matching = calls.filter((call) =>
    call.messages.at(-1).content.includes('boundaries-proofread'),
  );
  expect(matching).toHaveLength(1);
  const {blocks} = JSON.parse(matching[0].messages.at(-1).content);
  expect(blocks.map((block) => block.text.trim())).toEqual([
    '# Draft',
    'He go home.',
    'She walk to work.',
    '## Next section',
    'Unchanged text',
  ]);
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(
    original.replace('He go', 'He goes').replace('She walk', 'She walks'),
  );
  await closeAI(page);
});

test('revises a named suggestion without touching other proposals or applying the note', async ({
  page,
}) => {
  await configured(page);
  const original =
    'first task\n\nother task\n\n' +
    'A paragraph to keep.\n\n'.repeat(400) +
    'I likes bezos daddy.\n\nLast task';
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const send = async (query) => {
    await page.locator('#ai-prompt').fill(query);
    await page.getByRole('button', {name: 'Send', exact: true}).click();
  };
  await send('revision-fixture');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2', '@3']);
  await expect(page.locator('.ai-message--assistant p').last()).toHaveText(
    'Suggested changes are ready to review.',
  );
  const untouched = await page
    .locator('.ai-hunk')
    .evaluateAll((nodes) => nodes.slice(0, 2).map((node) => node.dataset.hunkId));
  const before = calls.length;
  await send('keep my wording @3');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2', '@3.1']);
  expect(calls.length - before).toBe(1);
  expect(
    await page
      .locator('.ai-hunk')
      .evaluateAll((nodes) => nodes.slice(0, 2).map((node) => node.dataset.hunkId)),
  ).toEqual(untouched);
  await expect(page.locator('.ai-hunk ins').last()).toContainText('I like bezos daddy.');
  await expect(page.locator('#note-content')).toHaveValue(original);
  await send('@3.1 keep original wording');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2']);
  await expect(page.locator('#note-content')).toHaveValue(original);
  await send('what happened to @3.1?');
  await expect(page.locator('.ai-message--assistant p').last()).toHaveText('You withdrew @3.1.');
  expect(JSON.parse(calls.at(-1).messages.at(-1).content).references[0].status).toBe('withdrawn');
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2']);
  await closeAI(page);
});

test('feeds a reference validation error back to the model and requires a corrected structured reply', async ({
  page,
}) => {
  await configured(page);
  const original = 'first task\n\nother task\n\nI likes bezos daddy.';
  await page.locator('#note-content').fill(original);
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('revision-fixture');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2', '@3']);
  const query = 'redo-structured @3';
  await page.locator('#ai-prompt').fill(query);
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-hunk-ref')).toHaveText(['@1', '@2', '@3.1']);
  const attempts = calls.filter((call) => call.messages.at(-1).content.includes(query));
  expect(attempts).toHaveLength(2);
  const first = JSON.parse(attempts[0].messages.at(-1).content);
  const corrected = JSON.parse(attempts[1].messages.at(-1).content);
  expect(first.mode).toBe('revise_suggestions');
  expect(first.blocks).toEqual([{id: '@3', text: 'I like Amazon.'}]);
  expect(first.originals_read_only).toEqual([{id: '@3', text: 'I likes bezos daddy.'}]);
  expect(corrected.validation_feedback.error).toContain('instead of revising');
  expect(corrected.blocks).toEqual(first.blocks);
  expect(corrected.references).toEqual(first.references);
  expect(corrected.request).toBe(first.request);
  await expect(page.locator('.ai-hunk ins').last()).toHaveText('I like bezos daddy.');
  await expect(page.locator('#note-content')).toHaveValue(original);
  await expect(page.locator('.ai-message--user p').last()).toHaveText(query);
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
  await closeAI(page);
});

test('imported Ollama Qwen3.5 thinking is discovered without thinking.values and disabled by default', async ({
  page,
}) => {
  const before = calls.length;
  await configured(page, 'qwen-local');
  const configurationTest = calls
    .slice(before)
    .find((call) => call.model === 'qwen-local' && call.max_tokens);
  expect(configurationTest.reasoning_effort).toBe('none');
  expect(configurationTest.response_format.type).toBe('json_schema');
  await page.locator('#ai-launch').click();
  const thinking = page.getByRole('checkbox', {name: 'Use thinking (slower)'});
  await expect(thinking).toBeVisible();
  await expect(thinking).not.toBeChecked();
  for (const enabled of [false, true, false]) {
    await thinking.setChecked(enabled);
    const start = calls.length;
    await page.locator('#ai-prompt').fill('give me ideas');
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
    const generation = calls
      .slice(start)
      .filter((call) => call.model === 'qwen-local' && !call.max_tokens);
    expect(generation).toHaveLength(1);
    expect(generation[0].reasoning_effort).toBe(enabled ? 'medium' : 'none');
    expect(generation[0].reasoning).toBeUndefined();
  }
  await closeAI(page);
});

test('Test discovers the active local context and whole-note planning uses smaller ranges', async ({
  page,
}) => {
  const checkedBefore = capacityChecks.length;
  const callsBefore = calls.length;
  await configured(page, 'qwen-local');
  expect(capacityChecks).toHaveLength(checkedBefore + 1);
  expect(capacityChecks.at(-1)).toBeGreaterThan(callsBefore);
  const source = 'He go home. Keep the facts and voice.\n\n'.repeat(80);
  await page.locator('#note-content').fill(source);
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const before = calls.length;
  const planned = page.waitForResponse(
    (response) => response.url().endsWith('/plan') && response.request().method() === 'POST',
  );
  await page.locator('#ai-prompt').fill('fix grammar in the whole note');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  const plan = await (await planned).json();
  expect(plan.sections).toBeGreaterThan(1);
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
  const generation = calls.slice(before).filter((call) => !call.max_tokens);
  expect(generation).toHaveLength(plan.sections);
  expect(generation.every((call) => call.reasoning_effort === 'none')).toBe(true);
  const shared = generation
    .map((call) =>
      JSON.parse(call.messages.at(-1).content)
        .blocks.map((block) => block.text)
        .join(''),
    )
    .join('');
  expect(shared).toBe(source);
  await closeAI(page);
});

test('compact corrections share one block ID, repair invalid anchors, and preserve surrounding text', async ({
  page,
}) => {
  await configured(page);
  const original =
    'Keep this wording and punctuation. '.repeat(40) +
    'He go home. She walk away.\n\n## Keep this heading\n';
  await page.locator('#note-content').fill(original);
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const before = calls.length;
  await page.locator('#ai-prompt').fill('compact-anchor-retry: fix grammar');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
  const generation = calls.slice(before).filter((call) => !call.max_tokens);
  expect(generation).toHaveLength(2);
  expect(JSON.parse(generation[1].messages.at(-1).content).validation_feedback.error).toContain(
    'before must match exact text',
  );
  await expect(page.locator('#note-content')).toHaveValue(original);
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(
    original.replace('He go', 'He goes').replace('She walk', 'She walks'),
  );
  await closeAI(page);
});

test('wrong block anchors receive a scoped diagnostic and require a corrected model reply', async ({
  page,
}) => {
  await configured(page);
  const original = 'He go home.\n\nKeep this paragraph.';
  await page.locator('#note-content').fill(original);
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const before = calls.length;
  await page.locator('#ai-prompt').fill('wrong-block-anchor: fix grammar');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
  const generation = calls.slice(before).filter((call) => !call.max_tokens);
  expect(generation).toHaveLength(2);
  const request = JSON.parse(generation[0].messages.at(-1).content);
  const corrected = JSON.parse(generation[1].messages.at(-1).content);
  expect(corrected.validation_feedback.anchor_error).toEqual({
    change_index: 0,
    id: request.blocks[1].id,
    before: 'He go',
    matching_block_id: request.blocks[0].id,
  });
  expect(corrected.blocks).toEqual(request.blocks);
  await expect(page.locator('#note-content')).toHaveValue(original);
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(original.replace('He go', 'He goes'));
  await closeAI(page);
});

test('automatically corrects two invalid replies without showing internal errors', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const before = calls.length;
  await page.locator('#ai-prompt').fill('two edits auto-correct-twice');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
  expect(calls.slice(before).filter((call) => !call.max_tokens)).toHaveLength(3);
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await expect(page.locator('.ai-message--user p')).toHaveCount(1);
  await expect(page.locator('#note-content')).toHaveValue('first\nsecond');
  await expect(page.getByRole('button', {name: 'retry', exact: true})).toBeHidden();
  await closeAI(page);
});

test('keeps a fitting thousand-word note in one provider call', async ({page}) => {
  await configured(page, 'fast-local');
  const source = Array.from({length: 100}, (_, i) =>
    i === 0
      ? 'He go home and keep all the original wording unchanged.'
      : 'Careful editors preserve meaningful punctuation throughout every original Markdown paragraph.',
  ).join('\n\n');
  expect(source.split(/\s+/)).toHaveLength(1000);
  await page.locator('#note-content').fill(source);
  await page.locator('#ai-launch').click();
  await shareNote(page);
  const before = calls.length;
  const planned = page.waitForResponse(
    (response) => response.url().endsWith('/plan') && response.request().method() === 'POST',
  );
  await page.locator('#ai-prompt').fill('fix grammar in the whole note');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  const plan = await (await planned).json();
  expect(plan.sections).toBe(1);
  await expect(page.locator('.ai-query-status')).toHaveText(/^Took /);
  expect(calls.slice(before).filter((call) => !call.max_tokens)).toHaveLength(1);
  await expect(page.locator('#note-content')).toHaveValue(source);
  await page.getByRole('button', {name: 'Accept all', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue(source.replace('He go', 'He went'));
  await closeAI(page);
});

test('recovers an accepted review after its response is lost without resubmitting it', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  let posts = 0;
  await page.route('**/api/ai/sessions/*/review', async (route) => {
    posts++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().click();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecond');
  await expect(page.locator('.ai-hunk')).toHaveCount(1);
  expect(posts).toBe(1);
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeEnabled();
  await closeAI(page);
});

for (const failure of ['start', 'poll', 'result']) {
  test(`recovers a lost ${failure} response by resuming the existing job`, async ({page}) => {
    await configured(page);
    await page.locator('#note-content').fill('first\nsecond');
    await page.locator('#ai-launch').click();
    await shareNote(page);
    let failed = false;
    await page.route('**/api/ai/sessions/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const matches =
        failure === 'start'
          ? url.pathname.endsWith('/start')
          : failure === 'poll'
            ? url.searchParams.has('job')
            : request.method() === 'GET' && !url.search && !url.pathname.endsWith('/capabilities');
      if (!failed && matches) {
        failed = true;
        if (failure === 'start') await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    const before = calls.length;
    await page.locator('#ai-prompt').fill('two edits');
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await expect(page.locator('.ai-hunk')).toHaveCount(2);
    await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
    expect(failed).toBe(true);
    expect(calls.slice(before).filter((call) => !call.max_tokens)).toHaveLength(1);
    await expect(page.locator('#note-content')).toHaveValue('first\nsecond');
    await closeAI(page);
  });
}

test('unknown cancellation remains locked until stopping is acknowledged', async ({page}) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/ai/sessions/*/start', async (route) => {
    const response = await route.fetch();
    await held;
    try {
      await route.fulfill({response});
    } catch {
      /* cancelled browser request */
    }
  });
  let fail = true;
  await page.route('**/api/ai/sessions/*/cancel', async (route) => {
    if (fail) await route.abort('failed');
    else await route.continue();
  });
  await page.route('**/api/ai/sessions/*', async (route) => {
    if (fail && route.request().method() === 'GET' && !new URL(route.request().url()).search)
      await route.abort('failed');
    else await route.fallback();
  });
  await page.locator('#ai-prompt').fill('give me ideas');
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  const stop = page.getByRole('button', {name: 'Cancel request', exact: true});
  await expect(stop.locator('use')).toHaveAttribute('href', '#icon-stop');
  await stop.click();
  await expect(page.locator('.ai-query-status')).toContainText('status is unknown');
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Check status', exact: true})).toBeVisible();
  fail = false;
  release();
  await stop.click();
  await expect(page.locator('.ai-query-status')).toHaveText(/Request (cancelled|completed)\./);
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeEnabled();
  await closeAI(page);
});

test('mobile tabs preserve query, scroll and conversation while selecting shared text', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await configured(page);
  const source = page.locator('#note-content');
  await source.fill('first\nsecond\n' + 'More note text.\n'.repeat(100));
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  await page.locator('#ai-launch').click();
  const ai = page.getByRole('tab', {name: 'AI', exact: true});
  const noteTab = page.getByRole('tab', {name: /^Note/});
  const prompt = page.getByRole('textbox', {name: 'Message', exact: true});
  await expect(ai).toHaveAttribute('aria-selected', 'true');
  await expect(source).toBeHidden();
  await expect(page.locator('.meta-pane')).toBeHidden();
  await expect(prompt).not.toBeFocused();
  await prompt.fill('draft to keep');
  await noteTab.click();
  await expect(source).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Ask AI about selected text', exact: true}),
  ).toBeHidden();
  await expect(page.locator('.ai-review')).toBeHidden();
  await source.evaluate((node) => {
    node.scrollTop = 250;
  });
  await ai.click();
  await expect(prompt).toHaveValue('draft to keep');
  await noteTab.click();
  expect(await source.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(0, 5);
    node.scrollTop = 0;
    node.dispatchEvent(new Event('select'));
  });
  const ask = page.getByRole('button', {name: 'Ask AI about selected text', exact: true});
  await expect(ask).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('mobile-note-selection.png'), fullPage: true});
  await ask.click();
  await expect(ai).toHaveAttribute('aria-selected', 'true');
  await expect(prompt).toHaveValue('draft to keep');
  await expect(page.locator('.ai-context-prefix')).toHaveText('first…');
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue(
    'selection',
  );
  await prompt.fill('hi');
  await prompt.press('Enter');
  await expect(page.locator('.ai-message--assistant p')).toHaveText('Hi! How can I help?');
  await prompt.fill('another draft');
  const before = calls.length;
  for (let i = 0; i < 3; i++) {
    await noteTab.click();
    await ai.click();
  }
  await expect(prompt).toHaveValue('another draft');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  expect(calls.length).toBe(before);
  await noteTab.click();
  await source.evaluate((node) => {
    node.focus();
    node.setSelectionRange(6, 12);
    node.scrollTop = 0;
    node.dispatchEvent(new Event('select'));
  });
  await ask.click();
  await expect(prompt).toHaveValue('another draft');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  await prompt.fill('give me ideas');
  await prompt.press('Enter');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(2);
  expect(
    calls
      .at(-1)
      .messages.some(
        (message) => message.role === 'assistant' && message.content === 'Hi! How can I help?',
      ),
  ).toBe(true);
  expect(
    JSON.parse(calls.at(-1).messages.at(-1).content)
      .blocks.map((block) => block.text)
      .join(''),
  ).toBe('second');
  await prompt.fill('another draft');
  await page.setViewportSize({width: 390, height: 480});
  const box = await page.locator('.ai-composer').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(480);
  await page.screenshot({
    path: testInfo.outputPath('mobile-ai-short-viewport.png'),
    fullPage: true,
  });
  await page.setViewportSize({width: 1440, height: 960});
  await expect(source).toBeVisible();
  await expect(page.locator('.ai-review')).toBeVisible();
  await expect(page.getByRole('tablist', {name: 'Note and AI'})).toBeHidden();
  await page.setViewportSize({width: 390, height: 844});
  await expect(prompt).toHaveValue('another draft');
  await page.screenshot({path: testInfo.outputPath('mobile-ai-tab.png'), fullPage: true});
  const accessibility = await new AxeBuilder({page})
    .include('.ai-mobile-tabs')
    .include('.ai-review')
    .include('#editor-panel')
    .analyze();
  expect(
    accessibility.violations.filter((v) => ['critical', 'serious'].includes(v.impact)),
  ).toEqual([]);
  await closeAI(page);
  await expect(page.locator('.ai-mobile-tabs')).toHaveCount(0);
  await expect(source).toBeEditable();
  await expect(page.locator('.meta-pane')).toBeVisible();
});

test('mobile Note tab retains pending changes and reviews them without clearing the chat draft', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.locator('#ai-prompt').press('Enter');
  const noteTab = page.getByRole('tab', {name: 'Note (2)', exact: true});
  await expect(noteTab).toBeVisible();
  await expect(page.locator('.ai-note-review')).toBeHidden();
  await page.locator('#ai-prompt').fill('keep this query');
  await noteTab.click();
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await expect(page.locator('.ai-hunk').first()).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('mobile-note-review.png'), fullPage: true});
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().click();
  await expect(page.getByRole('tab', {name: 'Note (1)', exact: true})).toBeVisible();
  await page.getByRole('tab', {name: 'AI', exact: true}).click();
  await expect(page.locator('#ai-prompt')).toHaveValue('keep this query');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toBeDisabled();
  await page.getByRole('tab', {name: 'Note (1)', exact: true}).click();
  await page.getByRole('button', {name: 'Reject change', exact: true}).click();
  await expect(page.getByRole('tab', {name: 'Note', exact: true})).toBeVisible();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecond');
  await closeAI(page);
});

test('switching mobile tabs during generation leaves the request running', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await configured(page);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let starts = 0;
  await page.route('**/api/ai/sessions/*/start', async (route) => {
    starts++;
    await held;
    await route.continue();
  });
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toBeEnabled();
  await page.locator('#ai-prompt').fill('hi');
  await page.locator('#ai-prompt').press('Enter');
  try {
    await expect(page.locator('.ai-query-status')).toContainText('Working');
    await page.getByRole('tab', {name: 'Note', exact: true}).click();
    await expect(page.locator('#note-content')).toBeVisible();
  } finally {
    release();
  }
  await expect(page.locator('.ai-message--assistant p')).toHaveText('Hi! How can I help?');
  await expect(page.getByRole('tab', {name: 'Note', exact: true})).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', {name: 'AI', exact: true}).click();
  await expect(page.locator('.ai-message--assistant p')).toBeVisible();
  expect(starts).toBe(1);
  await closeAI(page);
});

test('AI launch and shortcuts stay disabled offline and recover after reconnecting', async ({
  page,
}) => {
  await configured(page);
  const launch = page.locator('#ai-launch');
  await expect(launch).toBeEnabled();
  const before = calls.length;
  await page.context().setOffline(true);
  await expect(launch).toBeDisabled();
  await expect(launch).toHaveAttribute('title', 'AI is unavailable offline');
  await page.keyboard.press('Control+/');
  await page.keyboard.press('a');
  await expect(page.locator('.ai-review')).toHaveCount(0);
  expect(calls.length).toBe(before);
  await page.context().setOffline(false);
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(page.locator('.ai-review')).toBeVisible();
  await closeAI(page);
});

test('offline AI keeps the conversation and draft while blocking new requests', async ({page}) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  await page.locator('#ai-prompt').fill('hi');
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toBeEnabled();
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  await expect(page.locator('.ai-query-status')).toContainText('Took');
  await page.locator('#ai-prompt').fill('keep this draft');
  await page.context().setOffline(true);
  await expect(page.locator('.ai-offline-notice')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeDisabled();
  const before = calls.length;
  await page.locator('#ai-prompt').press('Enter');
  expect(calls.length).toBe(before);
  await expect(page.locator('#ai-prompt')).toHaveValue('keep this draft');
  await page.context().setOffline(false);
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeEnabled();
  await expect(page.locator('.ai-offline-notice')).toBeHidden();
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  await expect(page.locator('#ai-prompt')).toHaveValue('keep this draft');
  await closeAI(page);
});

test('closing pending AI edits asks before discarding and keeps work on cancellation', async ({
  page,
}, testInfo) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await page.locator('#ai-prompt').fill('unsent query');
  await page.getByRole('button', {name: 'Close AI', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Discard AI conversation?', exact: true});
  await expect(dialog).toContainText('2 pending suggestions');
  await expect(dialog.getByRole('button', {name: 'Keep conversation', exact: true})).toBeFocused();
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 844});
    await page.screenshot({path: testInfo.outputPath(`ai-discard-${width}.png`), fullPage: true});
  }
  await dialog.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await expect(page.locator('#ai-prompt')).toHaveValue('unsent query');
  await page.getByRole('button', {name: 'Close AI', exact: true}).click();
  await dialog.getByRole('button', {name: 'Discard conversation', exact: true}).click();
  await expect(page.locator('.ai-review')).toHaveCount(0);
  await expect(page.locator('#note-content')).toHaveValue('first\nsecond');
});

test('closing during generation preserves the request until discard is confirmed', async ({
  page,
}) => {
  await configured(page);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let starts = 0;
  await page.route('**/api/ai/sessions/*/start', async (route) => {
    starts++;
    await held;
    try {
      await route.continue();
    } catch {
      /* The confirmed close aborts this request. */
    }
  });
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toBeEnabled();
  await page.locator('#ai-prompt').fill('hi');
  await page.locator('#ai-prompt').press('Enter');
  const dialog = page.getByRole('dialog', {name: 'Discard AI conversation?', exact: true});
  try {
    await expect(page.locator('.ai-query-status')).toContainText('Working');
    await page.getByRole('button', {name: 'Close AI', exact: true}).click();
    await expect(dialog).toContainText('active request');
    await dialog.getByRole('button', {name: 'Keep conversation', exact: true}).click();
    await expect(page.locator('.ai-query-status')).toContainText('Working');
    await page.getByRole('button', {name: 'Close AI', exact: true}).click();
    await dialog.getByRole('button', {name: 'Discard conversation', exact: true}).click();
    await expect(page.locator('.ai-review')).toHaveCount(0);
    expect(starts).toBe(1);
  } finally {
    release();
  }
});

test('leaving the note and changing writing view require AI discard approval', async ({page}) => {
  await configured(page);
  await page.locator('#note-content').fill('Saved note');
  await expect(page.locator('#sync-status')).toHaveAttribute('data-state', 'online');
  const url = page.url();
  await page.locator('#ai-launch').click();
  await page.locator('#ai-prompt').fill('keep this query');
  const dialog = page.getByRole('dialog', {name: 'Discard AI conversation?', exact: true});
  await page.locator('#back-btn').click();
  await dialog.getByRole('button', {name: 'Keep conversation', exact: true}).click();
  await expect(page).toHaveURL(url);
  await expect(page.locator('#ai-prompt')).toHaveValue('keep this query');
  await page.goBack();
  await dialog.getByRole('button', {name: 'Keep conversation', exact: true}).click();
  await expect(page).toHaveURL(url);
  await page.locator('[data-panel="preview"]').click();
  await dialog.getByRole('button', {name: 'Keep conversation', exact: true}).click();
  await expect(page.locator('[data-panel="editor"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-panel="preview"]').click();
  await dialog.getByRole('button', {name: 'Discard conversation', exact: true}).click();
  await expect(page.locator('.ai-review')).toHaveCount(0);
  await expect(page.locator('[data-panel="preview"]')).toHaveAttribute('aria-pressed', 'true');
});

test('desktop sharing reset and disabling AI preserve the conversation when cancelled', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toBeEnabled();
  await page.locator('#ai-prompt').fill('hi');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  const dialog = page.getByRole('dialog', {name: 'Discard AI conversation?', exact: true});
  await page.getByRole('combobox', {name: 'Shared text', exact: true}).selectOption('note');
  await dialog.getByRole('button', {name: 'Keep conversation', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Shared text', exact: true})).toHaveValue('none');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-ai').click();
  await page.locator('#pref-ai-enabled').uncheck();
  await dialog.getByRole('button', {name: 'Keep conversation', exact: true}).click();
  await expect(page.locator('#pref-ai-enabled')).toBeChecked();
  await page.locator('#pref-ai-enabled').uncheck();
  await dialog.getByRole('button', {name: 'Discard conversation', exact: true}).click();
  await expect(page.locator('.ai-review')).toHaveCount(0);
  await expect(page.locator('#pref-ai-enabled')).not.toBeChecked();
  await expect
    .poll(async () => (await (await page.request.get('/api/prefs')).json()).aiEnabled)
    .toBe(false);
  await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
});

test('empty conversation suggestions fill and focus the query without sending', async ({
  page,
}, testInfo) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  const empty = page.locator('.ai-empty-state');
  const prompt = page.getByRole('textbox', {name: 'Message', exact: true});
  await expect(empty).toContainText('Try a prompt');
  const before = calls.length;
  for (const [label, query] of [
    ['Fix grammar and typos', 'Fix grammar and typos in the shared text.'],
    ['Break this task into actionable subtasks', 'Break this task down into actionable subtasks.'],
    ['Insert a quote', 'Insert a quote.'],
  ]) {
    await empty.getByRole('button', {name: label, exact: true}).click();
    await expect(prompt).toHaveValue(query);
    await expect(prompt).toBeFocused();
    await expect(page.locator('.ai-message')).toHaveCount(0);
    expect(calls.length).toBe(before);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 960});
    await expect(empty).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({path: testInfo.outputPath(`ai-empty-${width}.png`), fullPage: true});
  }
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toBeEnabled();
  await prompt.fill('hi');
  await prompt.press('Enter');
  await expect(page.locator('.ai-message--assistant p')).toHaveText('Hi! How can I help?');
  await expect(empty).toBeHidden();
  await closeAI(page);
  await page.locator('#ai-launch').click();
  await expect(page.locator('.ai-empty-state')).toBeVisible();
  await closeAI(page);
});

test('greetings keep conversational replies and composer controls sit below the message', async ({
  page,
}, testInfo) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toBeEnabled();
  await expect(
    page.getByRole('combobox', {name: 'AI provider'}).locator('option:checked'),
  ).toHaveText('Test provider');
  await expect(page.locator('.ai-composer')).not.toContainText('Request or follow-up');
  await page.getByRole('textbox', {name: 'Message', exact: true}).fill('hi');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-message--assistant p')).toHaveText('Hi! How can I help?');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({width, height: 960});
    const prompt = await page.locator('#ai-prompt').boundingBox();
    const send = await page.getByRole('button', {name: 'Send', exact: true}).boundingBox();
    const provider = await page.getByRole('combobox', {name: 'AI provider'}).boundingBox();
    const container = await page.locator('.ai-composer-input').boundingBox();
    const sharing = await page.locator('.ai-sharing').boundingBox();
    expect(send.y).toBeGreaterThanOrEqual(prompt.y + prompt.height);
    expect(provider.y).toBeGreaterThanOrEqual(prompt.y + prompt.height);
    expect(provider.x + provider.width).toBeLessThanOrEqual(send.x);
    expect(sharing.x).toBeGreaterThan(container.x);
    expect(sharing.x + sharing.width).toBeLessThanOrEqual(provider.x);
    expect(sharing.y + sharing.height).toBeLessThan(container.y + container.height);
    expect(send.width).toBeLessThanOrEqual(32);
    expect(send.height).toBeLessThanOrEqual(32);
    expect(send.x + send.width).toBeLessThan(container.x + container.width);
    expect(prompt.width).toBeGreaterThan(container.width - 16);
    await expect(page.locator('.ai-review-header .ai-provider-picker')).toHaveCount(0);
    expect(prompt.height).toBeLessThanOrEqual(50);
    await page.screenshot({path: testInfo.outputPath(`ai-compact-${width}.png`), fullPage: true});
  }
  await closeAI(page);
});

test('Enter sends and Ctrl+Enter inserts a newline', async ({page}) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  await expect(page.locator('.ai-sharing-disclosure')).toHaveCount(0);
  await expect(page.getByLabel('Read together', {exact: true})).toHaveCount(0);
  const prompt = page.locator('#ai-prompt');
  await prompt.fill('give me');
  await prompt.press('Control+Enter');
  await expect(prompt).toHaveValue('give me\n');
  await prompt.press('End');
  await prompt.press('i');
  await expect(page.locator('.ai-message--user')).toHaveCount(0);
  await prompt.fill('give me ideas');
  await prompt.press('Enter');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  await closeAI(page);
});

test('composer provider picker persists the default and keeps pending suggestions', async ({
  page,
}) => {
  await configured(page);
  const saved = await page.request.post('/api/ai/configurations', {
    data: {name: 'Local provider', url: providerURL, key: '', model: 'fast-local'},
  });
  const configuration = await saved.json();
  expect((await page.request.post(`/api/ai/configurations/${configuration.id}/check`)).ok()).toBe(
    true,
  );
  await page.locator('#note-content').fill('first\nsecond');
  await page.locator('#ai-launch').click();
  const picker = page.getByRole('combobox', {name: 'AI provider'});
  await expect(picker).toBeEnabled();
  await expect(picker.locator('option')).toHaveCount(2);
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await expect(picker).toBeEnabled();
  await picker.selectOption(configuration.id);
  await expect(picker).toBeEnabled();
  const response = await page.request.get('/api/ai/configurations');
  expect((await response.json()).find((config) => config.is_default).id).toBe(configuration.id);
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  const before = calls.length;
  await page.locator('#ai-prompt').fill('give me ideas');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(2);
  const generation = calls.slice(before).filter((call) => !call.max_tokens);
  expect(generation.length).toBeGreaterThan(0);
  expect(generation.every((call) => call.model === 'fast-local')).toBe(true);
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  await closeAI(page);
  await page.locator('#ai-launch').click();
  await expect(page.getByRole('combobox', {name: 'AI provider'})).toHaveValue(configuration.id);
  await closeAI(page);
});

test('provider picker lists unchecked providers and restores selection after a failed switch', async ({
  page,
}) => {
  await configured(page);
  const saved = await page.request.post('/api/ai/configurations', {
    data: {name: 'Other provider', url: providerURL, key: '', model: 'fast-local'},
  });
  const configuration = await saved.json();
  await page.locator('#ai-launch').click();
  const picker = page.getByRole('combobox', {name: 'AI provider'});
  await expect(picker).toBeEnabled();
  await expect(picker.locator(`option[value="${configuration.id}"]`)).toBeDisabled();
  await page.request.post(`/api/ai/configurations/${configuration.id}/check`);
  await expect(picker.locator(`option[value="${configuration.id}"]`)).toBeEnabled();
  const original = await picker.inputValue();
  await page.route(`**/api/ai/configurations/${configuration.id}/default`, (route) =>
    route.fulfill({status: 400, json: {error: 'Switch failed'}}),
  );
  await picker.selectOption(configuration.id);
  await expect(page.locator('.ai-query-status')).toContainText('Switch failed');
  await expect(picker).toHaveValue(original);
  await expect(picker).toBeEnabled();
  await page.unroute(`**/api/ai/configurations/${configuration.id}/default`);
  await page.route('**/api/ai/configurations', (route) => route.abort('failed'));
  await picker.selectOption(configuration.id);
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue(configuration.id);
  const response = await page.request.get('/api/ai/configurations');
  expect((await response.json()).find((config) => config.is_default).id).toBe(configuration.id);
  await closeAI(page);
});

test('explicit native schema profile is tested and saved for a generic compatible server', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#editor-prefs-btn').click();
  await page.locator('#prefs-tab-ai').click();
  await page.getByRole('button', {name: 'Add configuration', exact: true}).click();
  await page.getByLabel('Name', {exact: true}).fill('Explicit schema');
  await page.getByLabel('Endpoint', {exact: true}).fill(providerURL);
  await page.getByLabel('Model', {exact: true}).fill('generic-schema');
  await page.getByLabel('Use native JSON schema', {exact: true}).check();
  const before = calls.length;
  await page.locator('.ai-config-form').getByRole('button', {name: 'Test', exact: true}).click();
  await expect(
    page.locator('.ai-config-form').getByRole('button', {name: 'Save', exact: true}),
  ).toBeEnabled();
  expect(calls.slice(before).find((call) => call.max_tokens).response_format.type).toBe(
    'json_schema',
  );
  await page.locator('.ai-config-form').getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.locator('.ai-config-form')).toHaveCount(0);
  const response = await page.request.get('/api/ai/configurations');
  expect(
    (await response.json()).find((config) => config.name === 'Explicit schema').output_profile,
  ).toBe('json_schema');
  await page.getByRole('button', {name: 'Close preferences', exact: true}).click();
});

test('keeps an ambiguous review locked until Check status recovers its accepted draft', async ({
  page,
}) => {
  await configured(page);
  await page.locator('#note-content').fill('first\nsecond');
  await page.locator('#ai-launch').click();
  await shareNote(page);
  await page.locator('#ai-prompt').fill('two edits');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-hunk')).toHaveCount(2);
  let posts = 0;
  let unreadable = true;
  await page.route('**/api/ai/sessions/*/review', async (route) => {
    posts++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.route('**/api/ai/sessions/*', async (route) => {
    if (unreadable && route.request().method() === 'GET' && !new URL(route.request().url()).search)
      await route.abort('failed');
    else await route.fallback();
  });
  await page.getByRole('button', {name: 'Accept change', exact: true}).first().click();
  await expect(page.locator('.ai-query-status')).toContainText('status is unknown');
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Accept all', exact: true})).toBeDisabled();
  await expect(page.locator('#note-content')).toHaveValue('first\nsecond');
  unreadable = false;
  await page.getByRole('button', {name: 'Check status', exact: true}).click();
  await expect(page.locator('#note-content')).toHaveValue('FIRST\nsecond');
  await expect(page.locator('.ai-hunk')).toHaveCount(1);
  expect(posts).toBe(1);
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeEnabled();
  await closeAI(page);
});

test('stopping a new plan does not report a previous job as completed', async ({page}) => {
  await configured(page);
  await page.locator('#ai-launch').click();
  await page.locator('#ai-prompt').fill('give me ideas');
  await page.locator('#ai-prompt').press('Enter');
  await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/ai/sessions/*/plan', async (route) => {
    await held;
    try {
      await route.continue();
    } catch {
      /* request was cancelled */
    }
  });
  await page.locator('#ai-prompt').fill('give me ideas again');
  await page.locator('#ai-prompt').press('Enter');
  await page.getByRole('button', {name: 'Cancel request', exact: true}).click();
  try {
    await expect(page.locator('.ai-query-status')).toHaveText('Request cancelled.');
    await expect(page.locator('.ai-message--assistant')).toHaveCount(1);
  } finally {
    release();
  }
  await closeAI(page);
});
