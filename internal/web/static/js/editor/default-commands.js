(function (global) {
  'use strict';

  const directShortcut = (key, shift = false) => ({
    steps: [{key, modifiers: shift ? ['Mod', 'Shift'] : ['Mod']}],
  });

  const sequenceShortcut = (key) => ({
    steps: [
      {key: '/', modifiers: ['Mod']},
      {key, modifiers: []},
    ],
  });

  function create({
    createNote,
    editTags,
    editTitle,
    focusSource,
    format,
    openPreferences,
    saveNote,
    setSplitView,
    setWritingView,
    switchEditorPreview,
  }) {
    const commands = [
      {
        id: 'note.new',
        group: 'General',
        label: 'New note',
        description: 'Create a new blank note.',
        defaultBinding: sequenceShortcut('n'),
        scope: 'global',
        intrusive: true,
        run: createNote,
      },
      {
        id: 'note.save',
        group: 'General',
        label: 'Save note',
        description: 'Save the current note now.',
        defaultBinding: directShortcut('s'),
        scope: 'editor',
        run: saveNote,
      },
      {
        id: 'preferences.open',
        group: 'General',
        label: 'Open preferences',
        description: 'Open application preferences.',
        defaultBinding: sequenceShortcut('p'),
        scope: 'global',
        run: openPreferences,
      },
      {
        id: 'editor.title',
        group: 'Editor',
        label: 'Edit title',
        description: 'Show Details and replace the title.',
        defaultBinding: sequenceShortcut('t'),
        scope: 'editor',
        run: editTitle,
      },
      {
        id: 'editor.tags',
        group: 'Editor',
        label: 'Edit tags',
        description: 'Show Details and add or change tags.',
        defaultBinding: sequenceShortcut('g'),
        scope: 'editor',
        run: editTags,
      },
      {
        id: 'editor.focus',
        group: 'Editor',
        label: 'Focus editor',
        description: 'Move focus to the Markdown editor.',
        defaultBinding: sequenceShortcut('e'),
        scope: 'editor',
        run: focusSource,
      },
      {
        id: 'view.write',
        group: 'View',
        label: 'Write view',
        description: 'Show only the Markdown editor.',
        defaultBinding: sequenceShortcut('1'),
        scope: 'editor',
        run: () => setWritingView('editor'),
      },
      {
        id: 'view.preview',
        group: 'View',
        label: 'Preview view',
        description: 'Show only the rendered preview.',
        defaultBinding: sequenceShortcut('2'),
        scope: 'editor',
        run: () => setWritingView('preview'),
      },
      {
        id: 'view.split',
        group: 'View',
        label: 'Split view',
        description: 'Show editor and preview together.',
        defaultBinding: sequenceShortcut('3'),
        scope: 'editor',
        run: setSplitView,
      },
      {
        id: 'view.zen',
        group: 'View',
        label: 'Zen mode',
        description: 'Write without app chrome. Press Escape to return.',
        scope: 'editor',
        run: () => setWritingView('zen'),
      },
      {
        id: 'view.switch',
        group: 'View',
        label: 'Switch editor and preview',
        description: 'Move to the other pane.',
        defaultBinding: sequenceShortcut('4'),
        scope: 'editor',
        run: switchEditorPreview,
      },
    ];
    const formatting = [
      ['format.bold', 'Bold', 'Make selected text bold.', 'bold', directShortcut('b')],
      ['format.italic', 'Italic', 'Make selected text italic.', 'italic', directShortcut('i')],
      ['format.strike', 'Strikethrough', 'Strike through selected text.', 'strike'],
      ['format.code', 'Inline code', 'Format selected text as code.', 'code'],
      ['format.link', 'Link', 'Insert or format a link.', 'link'],
      ['format.ul', 'Bulleted list', 'Turn text into a bulleted list.', 'ul'],
      ['format.ol', 'Numbered list', 'Turn text into a numbered list.', 'ol'],
      ['format.task', 'Task list', 'Turn text into a task list.', 'task'],
      ['format.blockquote', 'Blockquote', 'Turn text into a quote.', 'blockquote'],
    ].map(([id, label, description, formatID, defaultBinding = null]) => ({
      id,
      group: 'Formatting',
      label,
      description,
      defaultBinding,
      scope: 'source',
      run: () => format(formatID),
    }));
    return [...commands, ...formatting];
  }

  global.VylkDefaultCommands = {create, directShortcut, sequenceShortcut};
})(typeof window !== 'undefined' ? window : globalThis);
