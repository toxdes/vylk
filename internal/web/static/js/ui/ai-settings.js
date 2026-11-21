export function create({
  document,
  api,
  enabled,
  setEnabled,
  onChanged,
  beforeMutation = () => true,
}) {
  const root = document.querySelector('#ai-settings');
  const toggle = document.querySelector('#pref-ai-enabled');
  const status = document.querySelector('#ai-settings-status');
  const lifetime = new AbortController();
  let request = null;
  let generation = 0;
  let activeForm = null;

  function text(tag, value, parent = root) {
    const node = document.createElement(tag);
    node.textContent = value;
    parent.append(node);
    return node;
  }
  function button(label, parent, run, className = 'btn-text') {
    const node = text('button', label, parent);
    node.type = 'button';
    node.className = className;
    node.addEventListener('click', () => void run());
    return node;
  }
  function icon(name, parent) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    parent.append(svg);
    return svg;
  }
  function link(label, href, parent) {
    const node = text('a', label, parent);
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    return node;
  }
  async function action(run) {
    if (request) return;
    const controller = new AbortController();
    request = controller;
    const buttons = [...root.querySelectorAll('button')];
    buttons.forEach((node) => (node.disabled = true));
    status.textContent = 'Working…';
    try {
      const changed = await run(controller.signal);
      if (changed === false) {
        status.textContent = '';
        return;
      }
      if (controller.signal.aborted) return;
      status.textContent = '';
      await refresh();
      await onChanged();
    } catch (error) {
      if (!controller.signal.aborted)
        status.textContent = error.message || 'Could not update AI settings.';
    } finally {
      if (request === controller) request = null;
      buttons.forEach((node) => (node.disabled = false));
    }
  }
  function form(configuration = null) {
    request?.abort();
    request = null;
    root.replaceChildren();
    status.textContent = '';
    const form = document.createElement('form');
    form.className = 'ai-config-form';
    activeForm = form;
    root.append(form);
    text('h3', configuration ? 'Edit configuration' : 'Add new configuration', form);
    const inputs = {};
    function field(key, label, type, max, placeholder, parent = form) {
      const wrapper = text('div', '', parent);
      wrapper.className = 'ai-config-field';
      const control = text('div', '', wrapper);
      control.className = 'label-input';
      const input = document.createElement('input');
      input.id = `ai-config-${key}`;
      input.className = 'label-input__control';
      input.type = type;
      input.maxLength = max;
      input.placeholder = placeholder;
      input.required = !['key', 'context_tokens', 'concurrency'].includes(key);
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (key !== 'key') input.value = configuration?.[key] || '';
      control.append(input);
      const labelNode = text('label', label, control);
      labelNode.htmlFor = input.id;
      labelNode.className = 'label-input__label';
      inputs[key] = input;
      return wrapper;
    }
    field('name', 'Name', 'text', 120, 'e.g. free-openrouter');
    const connection = text('div', '', form);
    connection.className = 'ai-config-connection';
    field('url', 'Endpoint', 'url', 2048, 'e.g. https://openrouter.ai/api/v1', connection);
    const model = field('model', 'Model', 'text', 256, 'e.g. openrouter/free', connection);
    const help = text('small', 'Check out ', model);
    link('models.dev', 'https://models.dev/', help);
    const profileLabel = text('label', '', form);
    profileLabel.className = 'checkbox-label';
    const profile = document.createElement('input');
    profile.type = 'checkbox';
    profile.checked = configuration?.output_profile === 'json_schema';
    profileLabel.append(profile, document.createTextNode(' Use native JSON schema'));
    const profileHelp = text(
      'small',
      'For compatible servers that support strict JSON schema output. Test this setting before saving; unsupported requests fail without a fallback.',
      form,
    );
    profileHelp.className = 'ai-profile-help';
    profile.addEventListener('change', invalidate, {signal: lifetime.signal});
    const limits = text('div', '', form);
    limits.className = 'ai-config-limits';
    field('context_tokens', 'Context window (tokens)', 'number', 8, 'Filled in by Test', limits);
    field('concurrency', 'Parallel requests', 'number', 1, 'Server default', limits);
    Object.assign(inputs.context_tokens, {min: 2048, max: 16777216, step: 1});
    Object.assign(inputs.concurrency, {min: 1, max: 8, step: 1});
    const contextHelp = text(
      'small',
      'Test fills this in from the provider when it reports one. Edit it if your model supports a different window.',
      form,
    );
    contextHelp.className = 'ai-profile-help';
    let contextEdited = Boolean(configuration?.context_tokens);
    inputs.context_tokens.addEventListener(
      'input',
      () => {
        contextEdited = true;
        update();
      },
      {signal: lifetime.signal},
    );
    inputs.concurrency.addEventListener('input', update, {signal: lifetime.signal});
    const keyRow = text('div', '', form);
    keyRow.className = 'ai-config-key-row';
    field(
      'key',
      'API Key',
      'password',
      16384,
      configuration?.has_key ? 'Saved key — leave blank to keep' : 'e.g. sk-or-v1-...',
      keyRow,
    );
    const testing = text('div', '', keyRow);
    testing.className = 'ai-test-controls';
    const test = button('Test', testing, testConfiguration);
    test.classList.add('ai-test-button');
    const result = text('span', '', testing);
    result.className = 'ai-test-result';
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    let clearKey = null;
    if (configuration?.has_key) {
      const label = text('label', '', form);
      label.className = 'ai-remove-key checkbox-label';
      clearKey = document.createElement('input');
      clearKey.type = 'checkbox';
      label.append(clearKey, document.createTextNode(' Remove saved API key'));
    }
    const actions = text('div', '', form);
    actions.className = 'ai-config-actions';
    const cancel = button('Cancel', actions, async () => {
      request?.abort();
      request = null;
      activeForm = null;
      status.textContent = '';
      await refresh();
    });
    const save = text('button', 'Save', actions);
    save.type = 'submit';
    save.className = 'btn-primary';
    let testToken = null;
    let isTesting = false;
    let isSaving = false;
    function valid(value, max, multiline = false) {
      return (
        new TextEncoder().encode(value).length <= max &&
        !(multiline ? /\0/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)
      );
    }
    function endpoint() {
      try {
        const url = new URL(inputs.url.value);
        return ['http:', 'https:'].includes(url.protocol) &&
          url.hostname &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          valid(inputs.url.value, 2048)
          ? url
          : null;
      } catch (_) {
        return null;
      }
    }
    function validConnection() {
      const url = endpoint();
      const host = url?.hostname || '';
      const local =
        url?.protocol === 'http:' ||
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host === '[::1]' ||
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
      const hasKey =
        inputs.key.value.length > 0 || (configuration?.has_key && !clearKey?.checked) || local;
      return Boolean(
        url &&
        hasKey &&
        valid(inputs.key.value, 16384) &&
        inputs.model.value.trim() &&
        valid(inputs.model.value, 256),
      );
    }
    function validLimit(input, min, max) {
      if (!input.value) return true;
      const value = Number(input.value);
      return Number.isInteger(value) && value >= min && value <= max;
    }
    function validLimits() {
      return (
        validLimit(inputs.context_tokens, 2048, 16777216) && validLimit(inputs.concurrency, 1, 8)
      );
    }
    function update() {
      test.disabled = isSaving || !validConnection();
      test.setAttribute('aria-disabled', String(isTesting || test.disabled));
      test.setAttribute('aria-busy', String(isTesting));
      test.replaceChildren();
      if (isTesting) {
        const spinner = icon('loader', test);
        spinner.classList.add('ai-test-spinner');
      }
      test.append(document.createTextNode(isTesting ? 'Testing' : 'Test'));
      save.disabled =
        isTesting ||
        isSaving ||
        !testToken ||
        !validConnection() ||
        !validLimits() ||
        !inputs.name.value.trim() ||
        !valid(inputs.name.value, 120);
      cancel.disabled = isSaving;
      result.replaceChildren();
      if (testToken) {
        icon('check', result);
        result.append(document.createTextNode('OK'));
      }
    }
    function invalidate() {
      request?.abort();
      request = null;
      testToken = null;
      isTesting = false;
      status.textContent = '';
      update();
    }
    function payload() {
      const data = {
        name: inputs.name.value,
        url: inputs.url.value,
        model: inputs.model.value,
        output_profile: profile.checked ? 'json_schema' : '',
        context_tokens: Number(inputs.context_tokens.value) || 0,
        concurrency: Number(inputs.concurrency.value) || 0,
      };
      if (!configuration || inputs.key.value || clearKey?.checked)
        data.key = clearKey?.checked ? '' : inputs.key.value;
      if (configuration) {
        data.id = configuration.id;
        data.revision = configuration.revision;
      }
      return data;
    }
    async function testConfiguration() {
      if (test.disabled || request) return;
      const controller = new AbortController();
      request = controller;
      isTesting = true;
      testToken = null;
      status.textContent = '';
      update();
      try {
        const data = payload();
        if (!data.name.trim()) data.name = 'New configuration';
        const response = await api('/api/ai/configurations/test', {
          method: 'POST',
          body: JSON.stringify(data),
          timeoutMs: 610000,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && activeForm === form) {
          testToken = response.test_token;
          const reported = Number(response.reported_context_tokens) || 0;
          const fallback = Number(response.default_context_tokens) || 0;
          if (!contextEdited && (reported || fallback)) {
            inputs.context_tokens.value = String(reported || fallback);
            contextHelp.textContent = reported
              ? 'Reported by the provider. Edit it if your model supports a different window.'
              : `The provider didn't report a window, so this uses a ${fallback.toLocaleString()}-token default. Raise it if your model supports more.`;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && activeForm === form)
          status.textContent =
            error.message || 'Test failed. Check the endpoint, API key, and model.';
      } finally {
        if (request === controller) {
          request = null;
          isTesting = false;
        }
        if (activeForm === form) update();
      }
    }
    for (const key of ['url', 'key', 'model']) inputs[key].addEventListener('input', invalidate);
    clearKey?.addEventListener('change', invalidate);
    inputs.name.addEventListener('input', update);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (save.disabled || request) return;
      const controller = new AbortController();
      request = controller;
      isSaving = true;
      update();
      try {
        const data = payload();
        delete data.id;
        if (configuration && !(await beforeMutation(configuration.id))) return;
        data.test_token = testToken;
        await api(`/api/ai/configurations${configuration ? `/${configuration.id}` : ''}`, {
          method: configuration ? 'PUT' : 'POST',
          body: JSON.stringify(data),
          signal: controller.signal,
        });
        if (controller.signal.aborted || activeForm !== form) return;
        request = null;
        activeForm = null;
        status.textContent = '';
        await refresh();
        await onChanged();
      } catch (error) {
        if (!controller.signal.aborted && activeForm === form) {
          testToken = null;
          status.textContent = error.message || 'Could not save. Test the configuration again.';
        }
      } finally {
        if (request === controller) request = null;
        isSaving = false;
        if (activeForm === form) update();
      }
    });
    update();
    inputs.name.focus();
  }
  async function refresh() {
    const current = ++generation;
    toggle.checked = enabled();
    if (activeForm && enabled()) return;
    if (!enabled()) {
      request?.abort();
      request = null;
      activeForm = null;
      status.textContent = '';
    }
    root.replaceChildren();
    if (!enabled()) return;
    const configurations = await api('/api/ai/configurations', {signal: lifetime.signal});
    if (current !== generation || !enabled() || activeForm) return;
    for (const configuration of configurations) {
      const row = text('div', '');
      row.className = 'ai-configuration';
      text('strong', configuration.name, row);
      text(
        'p',
        `${configuration.model} · ${configuration.checked ? 'Checked' : 'Not checked'}${configuration.is_default ? ' · Default' : ''}`,
        row,
      );
      const actions = text('div', '', row);
      actions.className = 'ai-actions';
      button('Edit', actions, () => form(configuration));
      button('Check', actions, () =>
        action(async (signal) => {
          if (!(await beforeMutation(configuration.id))) return false;
          return api(`/api/ai/configurations/${configuration.id}/check`, {
            method: 'POST',
            timeoutMs: 610000,
            signal,
          });
        }),
      );
      if (configuration.checked && !configuration.is_default)
        button('Set default', actions, () =>
          action((signal) =>
            api(`/api/ai/configurations/${configuration.id}/default`, {method: 'POST', signal}),
          ),
        );
      button('Delete', actions, () =>
        action(async (signal) => {
          if (!(await beforeMutation(configuration.id))) return false;
          return api(`/api/ai/configurations/${configuration.id}`, {method: 'DELETE', signal});
        }),
      );
    }
    const add = text('div', '');
    add.className = 'ai-add-configuration';
    button('Add configuration', add, () => form(), 'btn-primary');
  }
  toggle.addEventListener(
    'change',
    () => {
      toggle.disabled = true;
      request?.abort();
      void setEnabled(toggle.checked)
        .then(refresh)
        .catch((error) => {
          status.textContent = error.message;
        })
        .finally(() => {
          toggle.disabled = false;
        });
    },
    {signal: lifetime.signal},
  );
  return {
    refresh,
    syncEnabled() {
      if (toggle.checked !== enabled()) {
        toggle.checked = enabled();
        void refresh().catch((error) => {
          status.textContent = error.message;
        });
      }
    },
    dispose() {
      generation++;
      request?.abort();
      lifetime.abort();
      activeForm = null;
      root.replaceChildren();
    },
  };
}
