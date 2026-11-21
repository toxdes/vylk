export function create({document, parent, api, signal, onChanged, onError}) {
  const select = document.createElement('select');
  select.className = 'ai-provider-picker';
  select.setAttribute('aria-label', 'AI provider');
  parent.append(select);
  let selected = null;
  let choices = [];
  let disabled = false;
  let saving = false;
  let generation = 0;
  const update = () => (select.disabled = disabled || saving || !selected);

  async function refresh() {
    const current = ++generation;
    try {
      const configurations = await api('/api/ai/configurations', {signal});
      if (signal.aborted || current !== generation) return;
      choices = configurations;
      selected = configurations.find((configuration) => configuration.is_default) || null;
      select.replaceChildren();
      if (!selected)
        select.add(new document.defaultView.Option('Choose a default in AI settings', ''));
      for (const configuration of configurations) {
        const option = new document.defaultView.Option(configuration.name, configuration.id);
        option.disabled = !configuration.checked;
        select.add(option);
      }
      select.value = selected?.id || '';
      select.title = selected?.name || 'No default provider';
      update();
      await onChanged(selected);
    } catch (error) {
      if (current === generation) select.value = selected?.id || '';
      if (!signal.aborted && current === generation) onError(error);
    }
  }
  select.addEventListener(
    'change',
    async () => {
      const id = select.value;
      if (saving || disabled || id === selected?.id) return;
      const next = choices.find((configuration) => configuration.id === id);
      ++generation;
      saving = true;
      update();
      try {
        await api(`/api/ai/configurations/${id}/default`, {method: 'POST', signal});
        if (signal.aborted) return;
        ++generation;
        selected = next;
        select.value = id;
        await refresh();
      } catch (error) {
        select.value = selected?.id || '';
        if (!signal.aborted) onError(error);
      } finally {
        saving = false;
        update();
      }
    },
    {signal},
  );
  update();
  return {
    refresh,
    value: () => selected?.id,
    setDisabled(value) {
      disabled = value;
      update();
    },
    pending: () => saving,
  };
}
