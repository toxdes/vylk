import {describe, expect, test, vi} from 'vitest';
import {createApp} from './app-harness.js';
import {installAppLifecycle, pointerEvent, styleSource} from './frontend-test-context.js';

const track = installAppLifecycle();

describe('markdown preview policy', () => {
  test('interactive preview is opt-in, keeps source editing available, and toggles task Markdown', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Tasks',
      content: '- [ ] ship this\n- [x] review that',
    });
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    const checkbox = app.window.document.querySelector('#preview input[type="checkbox"]');
    expect(app.window.document.querySelector('#preview-edit-toggle')).toBeNull();
    expect(textarea.readOnly).toBe(false);
    app.hooks.setInteractiveSourceLocked(true);
    expect(textarea.readOnly).toBe(true);
    app.hooks.setInteractiveSourceLocked(false);
    expect(textarea.readOnly).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(
      app.window.document.querySelectorAll('#preview [data-preview-drag-indicator]'),
    ).toHaveLength(2);
    const preview = app.window.document.querySelector('#preview');
    preview.scrollTop = 37;
    checkbox.click();
    expect(textarea.value).toContain('- [x] ship this');
    expect(preview.scrollTop).toBe(37);
    expect(app.window.document.querySelector('#toast-region').children).toHaveLength(0);

    const interactiveUndo = new app.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    app.window.document
      .querySelector('#preview input[type="checkbox"]')
      .dispatchEvent(interactiveUndo);
    expect(interactiveUndo.defaultPrevented).toBe(true);
    expect(textarea.value).toContain('- [ ] ship this');
    expect(preview.scrollTop).toBe(37);
    expect(app.window.document.querySelector('#toast-region').children).toHaveLength(0);
    await app.hooks.savePref('interactivePreview', false);
    expect(textarea.readOnly).toBe(false);
    expect(
      app.window.document
        .querySelector('#preview')
        .classList.contains('interactive-preview-active'),
    ).toBe(false);
    expect(
      app.window.document.querySelectorAll('#preview [data-preview-drag-indicator]'),
    ).toHaveLength(0);
  });

  test('keeps Zen preview read-only while preserving standard interactive preview', async () => {
    const app = track(await createApp({realMarked: true}));
    const source = '# Heading\n\n- [ ] ship this\n- Keep writing';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Tasks', content: source});
    await app.hooks.savePref('interactivePreview', true);
    app.hooks.setPanelState('zen');
    app.window.document.querySelector('[data-zen-action="preview"]').click();

    const editor = app.window.document.querySelector('#editor');
    const previewPanel = app.window.document.querySelector('.panel-preview');
    const editorPanel = app.window.document.querySelector('.panel-editor');
    const preview = app.window.document.querySelector('#preview');
    expect(editor.classList.contains('zen-mode')).toBe(true);
    expect(previewPanel.classList.contains('panel-hidden')).toBe(false);
    expect(editorPanel.classList.contains('panel-hidden')).toBe(true);
    expect(preview.classList.contains('interactive-preview-active')).toBe(false);
    expect(preview.querySelectorAll('[data-preview-drag-indicator]')).toHaveLength(0);
    expect(preview.querySelector('input[type="checkbox"]').disabled).toBe(true);

    app.hooks.setPanelState('both');
    expect(preview.classList.contains('interactive-preview-active')).toBe(true);
  });

  test('toggles a task checkbox without replacing the rendered preview', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Tasks',
      content: '- [ ] keep this row\n- other row',
    });
    await app.hooks.savePref('interactivePreview', true);

    const preview = app.window.document.querySelector('#preview');
    const checkbox = preview.querySelector('input[type="checkbox"]');
    const list = checkbox.closest('li');

    checkbox.click();

    expect(preview.querySelector('input[type="checkbox"]') === checkbox).toBe(true);
    expect(app.window.document.querySelector('#note-content').value).toContain(
      '- [x] keep this row',
    );
    expect(checkbox.checked).toBe(true);
    expect(preview.querySelector('li') === list).toBe(true);
  });

  test('does not apply a drag using stale preview ranges after source edits', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '- Alpha\n- Bravo'});
    await app.hooks.savePref('interactivePreview', true);

    const preview = app.window.document.querySelector('#preview');
    const items = [...preview.querySelectorAll('li[data-interactive-start]')];
    const rectangle = (top) => ({
      left: 100,
      top,
      right: 400,
      bottom: top + 40,
      width: 300,
      height: 40,
      x: 100,
      y: top,
      toJSON() {
        return this;
      },
    });
    items[0].getBoundingClientRect = () => rectangle(80);
    items[1].getBoundingClientRect = () => rectangle(140);
    preview.getBoundingClientRect = () => ({
      left: 80,
      top: 60,
      right: 420,
      bottom: 240,
      width: 340,
      height: 180,
      x: 80,
      y: 60,
      toJSON() {
        return this;
      },
    });

    const textarea = app.window.document.querySelector('#note-content');
    const editedSource = 'Introduction\n\n- Alpha\n- Bravo';
    textarea.value = editedSource;
    textarea.dispatchEvent(new app.window.Event('input', {bubbles: true}));

    const handle = items[0].querySelector('.preview-drag-handle');
    handle.dispatchEvent(
      pointerEvent(app.window, 'pointerdown', {
        pointerId: 7,
        button: 0,
        clientX: 120,
        clientY: 100,
      }),
    );
    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointermove', {
        pointerId: 7,
        buttons: 1,
        clientX: 120,
        clientY: 175,
      }),
    );
    await new Promise((resolve) => app.window.requestAnimationFrame(resolve));
    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointerup', {pointerId: 7, button: 0, clientX: 120, clientY: 175}),
    );

    expect(textarea.value).toBe(editedSource);
  });

  test('leaves native undo and redo available without an interactive transaction', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'Original'});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    textarea.value = 'Ordinary source edit';
    textarea.dispatchEvent(new app.window.Event('input', {bubbles: true}));
    const title = app.window.document.querySelector('#note-title');
    const sourceUndo = new app.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const titleUndo = new app.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const sourceRedo = new app.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(sourceUndo);
    title.dispatchEvent(titleUndo);
    textarea.dispatchEvent(sourceRedo);

    expect([
      sourceUndo.defaultPrevented,
      titleUndo.defaultPrevented,
      sourceRedo.defaultPrevented,
    ]).toEqual([false, false, false]);
  });

  test('renders interactive blocks as gutter, handle, and content cards', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Note',
      content: '13. [ ] first\n14. second\n\n---\n\nParagraph',
    });
    await app.hooks.savePref('interactivePreview', true);

    const preview = app.window.document.querySelector('#preview');
    const listItem = preview.querySelector('li[data-interactive-start]');
    const listCard = listItem.querySelector(':scope > .interactive-preview-card');
    expect(listCard.children[0].classList.contains('preview-drag-handle')).toBe(true);
    expect(listCard.children[1].classList.contains('preview-drag-content')).toBe(true);
    expect(listCard.children[2].classList.contains('preview-edit-button')).toBe(true);
    expect(listCard.children[2].getAttribute('aria-label')).toBe('Edit this block in source');
    expect(listCard.children[2].querySelector('use').getAttribute('href')).toBe('#icon-edit');
    expect(listCard.querySelector('.preview-list-marker').textContent).toBe('13.');
    expect(listCard.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(
      listCard.children[0].compareDocumentPosition(listCard.querySelector('.preview-list-marker')) &
        app.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const blockCard = preview.querySelector(':scope > .interactive-preview-block-card');
    expect(blockCard.querySelector(':scope > .preview-drag-handle')).not.toBeNull();
    const ruleCard = preview.querySelector(':scope > .interactive-preview-rule-card');
    expect(ruleCard.querySelector(':scope > .preview-block-content > hr')).not.toBeNull();
    expect(
      preview.querySelector(':scope > .interactive-preview-block-card .preview-block-content > p')
        ?.textContent,
    ).toBe('Paragraph');
  });

  test('moves the source caret to an interactive block and leaves preview-only mode', async () => {
    const app = track(await createApp({realMarked: true}));
    const source = '# Heading\n\n13. [ ] first task';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: source});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    app.window.document
      .querySelector('.interactive-preview-block-card .preview-edit-button')
      .click();
    expect(app.window.document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(source.indexOf('Heading'));
    expect(textarea.selectionEnd).toBe(source.indexOf('Heading'));
    expect(
      app.window.document.querySelector('.panel-editor').classList.contains('panel-hidden'),
    ).toBe(false);
    expect(
      app.window.document.querySelector('.panel-preview').classList.contains('panel-hidden'),
    ).toBe(false);

    app.hooks.setPanelState('preview');
    app.window.document
      .querySelector('.interactive-preview-list-card .preview-edit-button')
      .click();
    expect(app.window.document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(source.indexOf('first task'));
    expect(
      app.window.document.querySelector('.panel-editor').classList.contains('panel-hidden'),
    ).toBe(false);
    expect(
      app.window.document.querySelector('.panel-preview').classList.contains('panel-hidden'),
    ).toBe(true);
  });

  test('preserves native text selection intent and keeps the drag ghost under the pointer', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading'});
    await app.hooks.savePref('interactivePreview', true);
    app.hooks.cancelScheduledSync();

    const card = app.window.document.querySelector('.interactive-preview-block-card');
    const content = card.querySelector('.preview-drag-content');
    content.dispatchEvent(
      pointerEvent(app.window, 'pointerdown', {button: 0, clientX: 120, clientY: 100}),
    );
    expect(app.hooks.getInteractivePreviewState().pending).toBe(false);
    content.dispatchEvent(new app.window.Event('selectstart', {bubbles: true, cancelable: true}));
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({
      pending: false,
      dragging: false,
      sourceLocked: false,
    });

    const rect = {
      left: 100,
      top: 80,
      right: 400,
      bottom: 128,
      width: 300,
      height: 48,
      x: 100,
      y: 80,
      toJSON() {
        return this;
      },
    };
    card.getBoundingClientRect = () => rect;
    const preview = app.window.document.querySelector('#preview');
    preview.getBoundingClientRect = () => ({
      left: 80,
      top: 60,
      right: 420,
      bottom: 300,
      width: 340,
      height: 240,
      x: 80,
      y: 60,
      toJSON() {
        return this;
      },
    });
    app.window.document.elementFromPoint = () => card;
    const handle = card.querySelector('.preview-drag-handle');
    handle.dispatchEvent(
      pointerEvent(app.window, 'pointerdown', {
        pointerId: 2,
        button: 0,
        clientX: 120,
        clientY: 100,
      }),
    );
    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointermove', {
        pointerId: 2,
        buttons: 1,
        clientX: 170,
        clientY: 130,
      }),
    );
    await vi.waitFor(() =>
      expect(app.hooks.getInteractivePreviewState().ghostTransform).toBe(
        'translate3d(50px,30px,0)',
      ),
    );
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({
      pending: true,
      dragging: true,
      sourceLocked: true,
      outside: false,
    });

    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointermove', {
        pointerId: 2,
        buttons: 1,
        clientX: 460,
        clientY: 130,
      }),
    );
    await vi.waitFor(() => expect(app.hooks.getInteractivePreviewState().outside).toBe(true));

    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointerup', {pointerId: 2, button: 0, clientX: 460, clientY: 130}),
    );
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({
      pending: false,
      dragging: false,
      sourceLocked: false,
      outside: false,
    });
  });

  test('does not claim touch gestures from preview content', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading'});
    await app.hooks.savePref('interactivePreview', true);

    const content = app.window.document.querySelector(
      '.interactive-preview-block-card .preview-drag-content',
    );
    content.dispatchEvent(
      pointerEvent(app.window, 'pointerdown', {
        pointerType: 'touch',
        button: 0,
        clientX: 120,
        clientY: 100,
      }),
    );

    expect(app.hooks.getInteractivePreviewState()).toMatchObject({
      pending: false,
      dragging: false,
      sourceLocked: false,
    });
  });

  test('claims only the touch handle and arms a stationary hold', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading\n\nParagraph'});
    await app.hooks.savePref('interactivePreview', true);

    const card = app.window.document.querySelector('.interactive-preview-block-card');
    const handle = card.querySelector('.preview-drag-handle');
    const rect = {
      left: 100,
      top: 80,
      right: 400,
      bottom: 128,
      width: 300,
      height: 48,
      x: 100,
      y: 80,
      toJSON() {
        return this;
      },
    };
    card.getBoundingClientRect = () => rect;
    const preview = app.window.document.querySelector('#preview');
    preview.getBoundingClientRect = () => ({
      left: 80,
      top: 60,
      right: 420,
      bottom: 300,
      width: 340,
      height: 240,
      x: 80,
      y: 60,
      toJSON() {
        return this;
      },
    });
    app.window.document.elementFromPoint = () => card;

    const pointerDown = pointerEvent(app.window, 'pointerdown', {
      pointerId: 3,
      pointerType: 'touch',
      button: 0,
      clientX: 120,
      clientY: 100,
    });
    handle.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(card.classList.contains('is-drag-pending')).toBe(true);
    expect(app.hooks.getInteractivePreviewState()).toMatchObject({
      pending: true,
      dragging: false,
      sourceLocked: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 240));
    await vi.waitFor(() =>
      expect(app.hooks.getInteractivePreviewState()).toMatchObject({
        pending: true,
        dragging: true,
        sourceLocked: true,
      }),
    );
    expect(card.classList.contains('is-drag-pending')).toBe(false);

    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointermove', {
        pointerId: 3,
        pointerType: 'touch',
        buttons: 1,
        clientX: 170,
        clientY: 130,
      }),
    );
    await vi.waitFor(() =>
      expect(app.hooks.getInteractivePreviewState().ghostTransform).toBe(
        'translate3d(50px,30px,0)',
      ),
    );
    app.window.document.dispatchEvent(
      pointerEvent(app.window, 'pointercancel', {
        pointerId: 3,
        pointerType: 'touch',
        clientX: 170,
        clientY: 130,
      }),
    );
  });

  test('suppresses native long-press behavior only on preview drag handles', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading'});
    await app.hooks.savePref('interactivePreview', true);

    const card = app.window.document.querySelector('.interactive-preview-block-card');
    const handle = card.querySelector('.preview-drag-handle');
    const content = card.querySelector('.preview-drag-content');
    for (const type of ['touchstart', 'contextmenu', 'selectstart', 'dragstart']) {
      const handleEvent = new app.window.Event(type, {bubbles: true, cancelable: true});
      handle.dispatchEvent(handleEvent);
      expect(handleEvent.defaultPrevented, `${type} on handle`).toBe(true);

      const contentEvent = new app.window.Event(type, {bubbles: true, cancelable: true});
      content.dispatchEvent(contentEvent);
      expect(contentEvent.defaultPrevented, `${type} on content`).toBe(false);
    }
  });

  test('auto-scrolls only near reachable preview edges', async () => {
    const app = track(await createApp());
    const preview = {
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 300,
      getBoundingClientRect: () => ({top: 100, bottom: 400, height: 300}),
    };

    expect(app.hooks.previewAutoScrollDelta(preview, 250)).toBe(0);
    expect(app.hooks.previewAutoScrollDelta(preview, 396)).toBeGreaterThan(0);
    expect(app.hooks.previewAutoScrollDelta(preview, 104)).toBeLessThan(0);
    preview.scrollTop = 0;
    expect(app.hooks.previewAutoScrollDelta(preview, 104)).toBe(0);
    preview.scrollTop = 700;
    expect(app.hooks.previewAutoScrollDelta(preview, 396)).toBe(0);
  });

  test('reorders only sibling list items and renumbers ordered Markdown', async () => {
    const app = track(await createApp());
    const source = '6. first\n7. second\n8. third';
    const entries = app.window.VylkInteractive.listItemRanges(source, 0, 'list:0');
    const moved = app.window.VylkInteractive.reorderListItems(
      source,
      entries,
      entries[2].start,
      entries[0].start,
      'before',
    );
    expect(moved.source).toBe('6. third\n7. first\n8. second');

    const nested = app.window.VylkInteractive.listItemRanges(
      '- one\n  - nested\n- two',
      0,
      'list:0',
    );
    expect(
      app.window.VylkInteractive.reorderListItems(
        '- one\n  - nested\n- two',
        nested,
        nested[1].start,
        nested[2].start,
        'before',
      ),
    ).toBeNull();
  });

  test('keeps nested content attached when ordered-list renumbering crosses a digit boundary', async () => {
    const app = track(await createApp());
    const source = '9. first\n   - child-first\n10. second\n    - child-second';
    const entries = app.window.VylkInteractive.listItemRanges(source, 0, 'list:0');
    const siblings = entries.filter((entry) => entry.parent === null);

    const moved = app.window.VylkInteractive.reorderListItems(
      source,
      entries,
      siblings[0].start,
      siblings[1].start,
      'after',
    );
    const lines = moved.source.split('\n');
    const movedItemIndex = lines.indexOf('10. first');
    const markerWidth = lines[movedItemIndex].match(/^\s*\d+[.)]\s+/)[0].length;
    const childIndent = lines[movedItemIndex + 1].match(/^\s*/)[0].length;

    expect(childIndent).toBeGreaterThanOrEqual(markerWidth);
  });

  test('moves valid Markdown units across block and list boundaries', async () => {
    const app = track(await createApp());
    const source = '# Heading\n\nParagraph\n\n- one\n- two';
    const heading = {start: 0, end: '# Heading'.length, indent: 0, kind: 'block', scope: 'blocks'};
    const paragraphStart = source.indexOf('Paragraph');
    const paragraph = {
      start: paragraphStart,
      end: paragraphStart + 'Paragraph'.length,
      indent: 0,
      kind: 'block',
      scope: 'blocks',
    };
    const listStart = source.indexOf('- one');
    const listEntries = app.window.VylkInteractive.listItemRanges(
      source.slice(listStart),
      listStart,
      `list:${listStart}`,
    );
    const entries = [heading, paragraph, ...listEntries];

    const headingIntoList = app.window.VylkInteractive.moveMarkdownUnit(
      source,
      entries,
      heading.start,
      heading.scope,
      listEntries[0].start,
      listEntries[0].scope,
      'after',
    );
    expect(headingIntoList).not.toBeNull();
    expect(headingIntoList.source.indexOf('- one')).toBeLessThan(
      headingIntoList.source.indexOf('# Heading'),
    );
    expect(headingIntoList.source.indexOf('# Heading')).toBeLessThan(
      headingIntoList.source.indexOf('- two'),
    );

    const listBeforeParagraph = app.window.VylkInteractive.moveMarkdownUnit(
      source,
      entries,
      listEntries[1].start,
      listEntries[1].scope,
      paragraph.start,
      paragraph.scope,
      'before',
    );
    expect(listBeforeParagraph).not.toBeNull();
    expect(listBeforeParagraph.source.indexOf('- two')).toBeLessThan(
      listBeforeParagraph.source.indexOf('Paragraph'),
    );
  });

  test('preserves the starting number of ordered lists', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Note',
      content: '6. [ ] six\n7. [ ] seven\n8. [ ] eight',
    });
    app.hooks.updatePreview();

    const ordered = app.window.document.querySelector('#preview ol');
    expect(ordered).not.toBeNull();
    expect(ordered.getAttribute('start')).toBe('6');
  });

  test('preserves nested and signed ordered-list starts but strips malformed attributes', async () => {
    const app = track(await createApp({realMarked: true}));
    app.window.marked = {
      parse: () =>
        '<ol start="6"><li>outer<ol start="-2"><li>nested</li></ol></li></ol><ol start="not-a-number"><li>bad</li></ol><p start="9">not a list</p>',
    };
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'ordered'});
    app.hooks.updatePreview();

    const lists = [...app.window.document.querySelectorAll('#preview ol')];
    expect(lists.map((list) => list.getAttribute('start'))).toEqual(['6', '-2', null]);
    expect(app.window.document.querySelector('#preview p').getAttribute('start')).toBeNull();
  });

  test('keeps the editor compact and the native caret distinct', async () => {
    const app = track(await createApp());
    expect(app.window.document.querySelector('.editor-position-bar')).toBeNull();
    expect(app.window.document.querySelector('.editor-current-line')).not.toBeNull();
    expect(styleSource).toContain('caret-color:var(--accent)');
    expect(styleSource).toContain('.editor-caret-measure');
    expect(styleSource).toContain('.editor-source-wrap.is-caret-visible .editor-current-line');
    expect(styleSource).toContain('background:color-mix(in srgb,var(--accent) 6%,transparent)');
    expect(styleSource).toContain(
      '#note-content{padding-bottom:1rem;scroll-padding-bottom:1rem;caret-color:var(--accent)}',
    );
    expect(styleSource).not.toContain(
      '.editor-source-wrap:focus-within{box-shadow:inset 3px 0 0 var(--accent)}',
    );
    expect(styleSource).not.toMatch(/\.editor-current-line\{[^}]*transition:[^}]*\btop/);
  });

  test('softly aligns the preview anchor with the editor caret', async () => {
    const app = track(await createApp());

    expect(
      app.hooks.calculatePreviewScrollAdjustment({
        previewTop: 0,
        previewHeight: 200,
        previewScrollTop: 0,
        previewScrollHeight: 600,
        anchorTop: 300,
        caretTop: 100,
        margin: 30,
        deadband: 20,
      }),
    ).toBe(200);

    expect(
      app.hooks.calculatePreviewScrollAdjustment({
        previewTop: 0,
        previewHeight: 200,
        previewScrollTop: 100,
        previewScrollHeight: 600,
        anchorTop: 112,
        caretTop: 100,
        margin: 30,
        deadband: 20,
      }),
    ).toBe(0);
  });

  test('highlights the rendered block containing the caret', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Note',
      content: '# Heading\n\n- first\n\n- second\n\n```text\ninside\n\ncode\n```\n\ntail',
    });
    app.hooks.updatePreview();

    const textarea = app.window.document.querySelector('#note-content');
    const codeOffset = textarea.value.indexOf('code');
    textarea.selectionStart = textarea.selectionEnd = codeOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[2].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('maps a caret inside a loose list to the exact list item', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '- first\n\n- second\n\nparagraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const secondItemOffset = content.indexOf('second');
    textarea.selectionStart = textarea.selectionEnd = secondItemOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    const items = [...blocks[0].querySelectorAll(':scope > li')];
    expect(blocks[0].tagName).toBe('UL');
    expect(blocks[0].classList.contains('highlight')).toBe(false);
    expect(items[0].classList.contains('highlight')).toBe(false);
    expect(items[1].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('highlights the deepest interactive list item containing the caret', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '- parent\n  - nested child\n- sibling';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});
    await app.hooks.savePref('interactivePreview', true);

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('nested child');
    app.hooks.highlightBlock();

    const items = [...app.window.document.querySelectorAll('#preview li[data-interactive-start]')];
    const parentCard = items[0].querySelector(':scope > .interactive-preview-card');
    const nestedCard = items[1].querySelector(':scope > .interactive-preview-card');
    expect(parentCard.classList.contains('highlight')).toBe(false);
    expect(nestedCard.classList.contains('highlight')).toBe(true);
    expect(app.window.document.querySelector('#preview > ul').classList.contains('highlight')).toBe(
      false,
    );
  });

  test('highlights blocks at their boundaries but not separator whitespace', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '# First\n\nfirst paragraph\n\n# Second\n\nsecond paragraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});
    app.hooks.updatePreview();

    const textarea = app.window.document.querySelector('#note-content');
    const blocks = [...app.window.document.querySelector('#preview').children];
    const positions = [
      {position: content.indexOf('# First') + '# First'.length, block: 0},
      {position: content.indexOf('\n\nfirst') + 1, block: -1},
      {position: content.indexOf('\n\n# Second') + 1, block: -1},
      {position: content.length, block: blocks.length - 1},
    ];

    for (const {position, block} of positions) {
      textarea.selectionStart = textarea.selectionEnd = position;
      app.hooks.highlightBlock();
      expect(blocks.filter((element) => element.classList.contains('highlight'))).toHaveLength(
        block < 0 ? 0 : 1,
      );
      if (block >= 0) expect(blocks[block].classList.contains('highlight')).toBe(true);
    }
  });

  test('maps a caret inside fenced code across blank lines to the code block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '```text\ninside\n\ncode\n```\n\ntail';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const codeOffset = content.indexOf('code');
    textarea.selectionStart = textarea.selectionEnd = codeOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[0].tagName).toBe('PRE');
    expect(blocks[0].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('does not use preview ranges from an older source while rendering is pending', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Note',
      content: 'first paragraph\n\nsecond paragraph',
    });

    const textarea = app.window.document.querySelector('#note-content');
    textarea.value = 'short\n\nsecond';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.indexOf('second');
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks.every((block) => !block.classList.contains('highlight'))).toBe(true);

    app.hooks.updatePreview();
    app.hooks.highlightBlock();
    const refreshedBlocks = [...app.window.document.querySelector('#preview').children];
    expect(refreshedBlocks[1].classList.contains('highlight')).toBe(true);
  });

  test('maps headings, blockquotes, thematic breaks, and tables to their blocks', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '> quoted\n\n## heading\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const preview = app.window.document.querySelector('#preview');
    const blocks = [...preview.children];
    expect(blocks.map((block) => block.tagName)).toEqual(['BLOCKQUOTE', 'H2', 'HR', 'TABLE']);
    for (const [index, marker] of ['quoted', 'heading', '---', '| 1'].entries()) {
      textarea.selectionStart = textarea.selectionEnd = content.indexOf(marker);
      app.hooks.highlightBlock();
      expect(blocks[index].classList.contains('highlight')).toBe(true);
    }
  });

  test('maps a Setext heading to its rendered heading block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = 'Setext heading\n==============\n\nparagraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('Setext');
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks.map((block) => block.tagName)).toEqual(['H1', 'P']);
    expect(blocks[0].classList.contains('highlight')).toBe(true);
  });

  test('maps rendered blocks after an omitted link-reference definition', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '[docs]: https://example.com\n\nParagraph with [docs].';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('Paragraph');
    app.hooks.highlightBlock();

    const paragraph = app.window.document.querySelector('#preview > p');
    expect(paragraph).not.toBeNull();
    expect(paragraph.classList.contains('highlight')).toBe(true);
  });

  test('highlighting does not change preview block geometry', () => {
    expect(styleSource).toMatch(/\.preview \.highlight\{[^}]*background:/);
    expect(styleSource).not.toMatch(/\.preview \.highlight\{[^}]*\bmargin:/);
    expect(styleSource).not.toMatch(/\.preview \.highlight\{[^}]*\bpadding:/);
    expect(styleSource).toContain('.preview p{margin:0 0 1em}');
  });

  test('escapes raw HTML, rejects unsafe resource URLs, and lazy-loads images', async () => {
    const app = track(await createApp());
    app.window.marked = {
      Renderer: class {},
      parse: (markdown, options) =>
        [
          '<p>before</p>',
          options.renderer.html({text: '<form action="/delete"><input name="title"></form>'}),
          '<a href="javascript:alert(1)">unsafe link</a>',
          '<img src="https://example.com/image.png" alt="remote">',
          '<img src="data:text/html,unsafe" alt="blocked">',
        ].join(''),
    };

    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Note'});

    const preview = app.window.document.querySelector('#preview');
    expect(preview.querySelector('form')).toBeNull();
    expect(preview.textContent).toContain('<form action="/delete">');
    expect(preview.querySelector('a').getAttribute('href')).toBeNull();
    const remoteImage = preview.querySelector('img[src="https://example.com/image.png"]');
    expect(remoteImage).not.toBeNull();
    expect(remoteImage.getAttribute('loading')).toBe('lazy');
    expect(remoteImage.getAttribute('decoding')).toBe('async');
    expect(preview.querySelector('img[src^="data:"]')).toBeNull();
  });
});
