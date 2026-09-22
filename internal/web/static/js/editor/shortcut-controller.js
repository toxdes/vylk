(function (root) {
  'use strict';

  function create({
    commandCanRun,
    defaultPrefix,
    document,
    escapeHTML,
    getPreferences,
    hasOpenModal,
    onIntrusive,
    onUnhandledEscape,
    savePreference,
    shortcuts,
  }) {
    const select = (selector) => document.querySelector(selector);
    const selectAll = (selector) => document.querySelectorAll(selector);
    const commands = [];
    const commandsByID = new Map();
    let recording = null;
    let pendingSequence = false;

    function register(command) {
      commands.push(command);
      commandsByID.set(command.id, command);
    }

    function prefixBinding() {
      return getPreferences().shortcutPrefix;
    }

    function materialize(binding) {
      if (!binding || binding.steps.length !== 2) return binding;
      return {steps: [prefixBinding().steps[0], binding.steps[1]]};
    }

    function bindingFor(command) {
      const overrides = getPreferences().keyboardShortcuts;
      const binding = Object.hasOwn(overrides, command.id)
        ? overrides[command.id]
        : command.defaultBinding || null;
      return materialize(binding);
    }

    function preferenceLabel(binding) {
      if (!binding) return 'Not set';
      if (binding.steps.length === 2) return `Prefix, ${binding.steps[1].key.toUpperCase()}`;
      return shortcuts.displayBinding(binding);
    }

    function commandForBinding(binding, {sequence = false} = {}) {
      return commands.find((command) => {
        const current = bindingFor(command);
        return (
          current &&
          current.steps.length === (sequence ? 2 : 1) &&
          shortcuts.sameBinding(current, binding)
        );
      });
    }

    function updateAffordances() {
      commands.forEach((command) => {
        const binding = bindingFor(command);
        const aria = binding ? shortcuts.ariaBinding(binding) : '';
        const suffix = binding ? ` (${shortcuts.displayBinding(binding)})` : '';
        const selector =
          command.id === 'note.save'
            ? '#save-btn'
            : command.id.startsWith('view.')
              ? `.view-control[data-panel="${command.id === 'view.write' ? 'editor' : command.id === 'view.split' ? 'both' : command.id === 'view.preview' ? 'preview' : ''}"]`
              : command.id.startsWith('format.')
                ? `.fmt-bar [data-fmt="${command.id.slice('format.'.length)}"]`
                : '';
        if (!selector) return;
        selectAll(selector).forEach((button) => {
          button.title = `${command.label}${suffix}`;
          if (aria) button.setAttribute('aria-keyshortcuts', aria);
          else button.removeAttribute('aria-keyshortcuts');
        });
      });
    }

    function render() {
      const prefix = select('#shortcut-prefix');
      if (prefix) {
        const isRecording = recording?.type === 'prefix';
        prefix.classList.toggle('is-recording', isRecording);
        prefix.textContent = isRecording
          ? 'Press prefix…'
          : shortcuts.displayBinding(prefixBinding());
        prefix.setAttribute(
          'aria-label',
          isRecording
            ? 'Recording shortcut prefix'
            : `Record shortcut prefix, currently ${shortcuts.ariaBinding(prefixBinding())}`,
        );
      }
      const groups = select('#shortcut-groups');
      if (!groups) return;
      groups.replaceChildren();
      const byGroup = new Map();
      commands.forEach((command) => {
        if (!byGroup.has(command.group)) byGroup.set(command.group, []);
        byGroup.get(command.group).push(command);
      });
      byGroup.forEach((groupCommands, group) => {
        const section = document.createElement('section');
        section.className = 'shortcut-group';
        const title = document.createElement('h3');
        title.className = 'shortcut-group-title';
        title.textContent = group;
        section.append(title);
        groupCommands.forEach((command) => {
          const row = document.createElement('div');
          row.className = 'shortcut-row';
          const copy = document.createElement('span');
          copy.className = 'shortcut-copy';
          copy.innerHTML = `<strong>${escapeHTML(command.label)}</strong><small>${escapeHTML(command.description)}</small>`;
          const actions = document.createElement('div');
          actions.className = 'shortcut-row-actions';
          actions.setAttribute('role', 'group');
          actions.setAttribute('aria-label', `Shortcut controls for ${command.label}`);
          const record = document.createElement('button');
          record.type = 'button';
          record.className = 'shortcut-binding';
          record.dataset.shortcutCommand = command.id;
          const binding = bindingFor(command);
          const isRecording = recording?.type === 'command' && recording.id === command.id;
          record.textContent = isRecording
            ? recording.awaitingSequenceKey
              ? 'Prefix,'
              : 'Press shortcut…'
            : preferenceLabel(binding);
          record.setAttribute(
            'aria-label',
            `Record shortcut for ${command.label}. Press Backspace or Delete to clear it.`,
          );
          actions.append(record);
          row.append(copy, actions);
          section.append(row);
        });
        groups.append(section);
      });
      updateAffordances();
    }

    function setStatus(message = '', error = false) {
      const status = select('#shortcut-recorder-status');
      status.textContent = message;
      status.classList.toggle('is-error', error);
    }

    function stopRecording({rerender = true} = {}) {
      recording = null;
      if (rerender) render();
    }

    function conflictingCommand(commandID, binding) {
      return commands.find(
        (command) =>
          command.id !== commandID && shortcuts.sameBinding(bindingFor(command), binding),
      );
    }

    async function setOverride(commandID, binding) {
      const command = commandsByID.get(commandID);
      if (!command) return;
      const next = {...getPreferences().keyboardShortcuts};
      const defaultBinding = materialize(command.defaultBinding);
      if (binding && defaultBinding && shortcuts.sameBinding(binding, defaultBinding))
        delete next[commandID];
      else next[commandID] = binding;
      const saved = savePreference('keyboardShortcuts', next);
      render();
      await saved;
    }

    function startRecording(commandID) {
      if (!commandsByID.has(commandID)) return;
      recording = {type: 'command', id: commandID, awaitingSequenceKey: false};
      setStatus(
        'Press a shortcut, or press Prefix then a key for a sequence. Press Escape to cancel.',
      );
      render();
    }

    function startPrefixRecording() {
      recording = {type: 'prefix'};
      setStatus('Press Ctrl/Command and a key. Press Escape to cancel.');
      render();
    }

    function startSequence() {
      pendingSequence = true;
      const hint = select('#shortcut-sequence-hint');
      const available = commands.filter(
        (command) => commandCanRun(command) && bindingFor(command)?.steps.length === 2,
      );
      const title = document.createElement('strong');
      title.className = 'shortcut-sequence-title';
      title.textContent = 'Keyboard shortcuts';
      const subtitle = document.createElement('span');
      subtitle.className = 'shortcut-sequence-subtitle';
      subtitle.textContent = 'Choose a key, or press Escape to cancel.';
      const options = document.createElement('div');
      options.className = 'shortcut-sequence-options';
      available.forEach((command) => {
        const option = document.createElement('span');
        option.className = 'shortcut-sequence-option';
        const key = document.createElement('kbd');
        key.textContent = bindingFor(command).steps[1].key.toUpperCase();
        const label = document.createElement('span');
        label.textContent = command.label;
        option.append(key, label);
        options.append(option);
      });
      hint.replaceChildren(title, subtitle, options);
      hint.classList.remove('hidden');
    }

    function cancelSequence() {
      pendingSequence = false;
      select('#shortcut-sequence-hint')?.classList.add('hidden');
    }

    async function execute(commandID, {source = 'shortcut'} = {}) {
      const command = commandsByID.get(commandID);
      if (!command || !commandCanRun(command)) return false;
      if (command.intrusive && source === 'shortcut') await onIntrusive(command);
      else await command.run();
      return true;
    }

    document.addEventListener(
      'keydown',
      (event) => {
        if (recording) {
          if (event.key === 'Escape') {
            event.preventDefault();
            stopRecording();
            setStatus('Shortcut recording cancelled.');
            return;
          }
          if (
            recording.type === 'command' &&
            (event.key === 'Backspace' || event.key === 'Delete')
          ) {
            event.preventDefault();
            const id = recording.id;
            stopRecording({rerender: false});
            void setOverride(id, null);
            setStatus('Shortcut cleared.');
            return;
          }
          if (recording.type === 'prefix') {
            const binding = shortcuts.bindingFromEvent(event);
            if (!binding) return;
            event.preventDefault();
            if (!shortcuts.isAllowedPrefix(binding)) {
              setStatus('Use Ctrl/Command and a supported key for the prefix.', true);
              return;
            }
            const conflict = conflictingCommand(null, binding);
            if (conflict) {
              setStatus(`Already used by ${conflict.label}.`, true);
              return;
            }
            stopRecording({rerender: false});
            void savePreference('shortcutPrefix', binding);
            setStatus('Prefix updated.');
            return;
          }
          if (recording.awaitingSequenceKey) {
            const second = shortcuts.capturedSequenceStep(event);
            if (!second) return;
            event.preventDefault();
            const binding = {steps: [prefixBinding().steps[0], second]};
            const conflict = conflictingCommand(recording.id, binding);
            if (conflict) {
              setStatus(`Already used by ${conflict.label}.`, true);
              stopRecording();
              return;
            }
            const id = recording.id;
            stopRecording({rerender: false});
            void setOverride(id, binding);
            setStatus('Shortcut updated.');
            return;
          }
          const binding = shortcuts.bindingFromEvent(event);
          if (!binding) return;
          event.preventDefault();
          if (shortcuts.sameBinding(binding, prefixBinding())) {
            recording.awaitingSequenceKey = true;
            setStatus('Prefix registered. Press the next key, or Escape to cancel.');
            render();
            return;
          }
          if (shortcuts.isReservedBinding(binding)) {
            setStatus('That shortcut belongs to your browser or operating system.', true);
            return;
          }
          const conflict = conflictingCommand(recording.id, binding);
          if (conflict) {
            setStatus(`Already used by ${conflict.label}.`, true);
            return;
          }
          const id = recording.id;
          stopRecording({rerender: false});
          void setOverride(id, binding);
          setStatus('Shortcut updated.');
          return;
        }
        if (pendingSequence) {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelSequence();
            return;
          }
          const second = shortcuts.capturedSequenceStep(event);
          if (!second) return;
          const binding = {steps: [prefixBinding().steps[0], second]};
          const command = commandForBinding(binding, {sequence: true});
          cancelSequence();
          if (!command || !commandCanRun(command)) return;
          event.preventDefault();
          void execute(command.id);
          return;
        }
        if (event.key === 'Escape' && onUnhandledEscape()) {
          event.preventDefault();
          return;
        }
        if (event.defaultPrevented || event.isComposing || event.repeat || hasOpenModal()) return;
        const first = shortcuts.bindingFromEvent(event);
        if (!first) return;
        if (shortcuts.isLeader(first, prefixBinding().steps[0])) {
          const hasSequence = commands.some(
            (command) => commandCanRun(command) && bindingFor(command)?.steps.length === 2,
          );
          if (!hasSequence) return;
          event.preventDefault();
          startSequence();
          return;
        }
        const command = commandForBinding(first);
        if (!command || !commandCanRun(command)) return;
        event.preventDefault();
        void execute(command.id);
      },
      true,
    );

    select('#shortcut-groups').addEventListener('click', (event) => {
      const record = event.target.closest('[data-shortcut-command]');
      if (record) startRecording(record.dataset.shortcutCommand);
    });
    select('#shortcut-prefix').addEventListener('click', startPrefixRecording);
    select('#shortcut-reset').addEventListener('click', () => {
      setStatus('Restoring default shortcuts…');
      void savePreference('shortcutPrefix', defaultPrefix)
        .then(() => savePreference('keyboardShortcuts', {}))
        .then(() => setStatus('Default shortcuts restored.'));
    });

    return {bindingFor, commands, commandsByID, execute, prefixBinding, register, render};
  }

  root.VylkShortcutController = {create};
})(typeof window !== 'undefined' ? window : globalThis);
