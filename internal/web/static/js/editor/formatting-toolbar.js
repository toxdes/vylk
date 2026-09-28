(function (root) {
  'use strict';

  function create({document, formatting, isLocked, onFormatted, readSource, window, writeSource}) {
    const picker = document.createElement('div');
    picker.id = 'table-picker';
    picker.className = 'table-picker hidden';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Choose table size');
    picker.innerHTML =
      '<div class="table-picker-label" aria-live="polite">Table</div><div class="table-grid" role="group" aria-label="Table size options"></div>';
    document.body.append(picker);

    const grid = picker.querySelector('.table-grid');
    const label = picker.querySelector('.table-picker-label');
    const tableTrigger = document.querySelector('.fmt-bar [data-fmt="table"]');
    const headingTrigger = document.querySelector('.fmt-bar [data-fmt="heading"]');
    const headingPicker = document.createElement('div');
    headingPicker.id = 'heading-picker';
    headingPicker.className = 'heading-picker hidden';
    headingPicker.setAttribute('role', 'dialog');
    headingPicker.setAttribute('aria-label', 'Choose heading level');
    for (let level = 1; level <= 5; level++) {
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.heading = `h${level}`;
      option.textContent = `H${level}`;
      option.setAttribute('aria-label', `Heading ${level}`);
      headingPicker.append(option);
    }
    document.body.append(headingPicker);

    for (let row = 1; row <= 6; row++) {
      for (let column = 1; column <= 8; column++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'table-grid-cell';
        cell.dataset.rows = String(row);
        cell.dataset.columns = String(column);
        cell.setAttribute('aria-label', `${column} columns by ${row} rows`);
        grid.append(cell);
      }
    }

    function highlight(rows = 0, columns = 0) {
      label.textContent = rows && columns ? `${columns} × ${rows} table` : 'Table';
      grid.querySelectorAll('.table-grid-cell').forEach((cell) => {
        cell.classList.toggle(
          'active',
          Number(cell.dataset.rows) <= rows && Number(cell.dataset.columns) <= columns,
        );
      });
    }

    function hide() {
      picker.classList.add('hidden');
      tableTrigger.setAttribute('aria-expanded', 'false');
      highlight();
    }

    function hideHeading() {
      headingPicker.classList.add('hidden');
      headingTrigger?.setAttribute('aria-expanded', 'false');
    }

    function placePopup(popup, trigger) {
      const rect = trigger.getBoundingClientRect();
      const gutter = 8;
      popup.style.left = `${Math.max(gutter, Math.min(rect.left, window.innerWidth - popup.offsetWidth - gutter))}px`;
      popup.style.top = `${Math.max(gutter, Math.min(rect.bottom + gutter, window.innerHeight - popup.offsetHeight - gutter))}px`;
    }

    function show(trigger) {
      hideHeading();
      picker.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      placePopup(picker, trigger);
    }

    function showHeading() {
      if (isLocked()) return;
      hide();
      headingPicker.classList.remove('hidden');
      headingTrigger.setAttribute('aria-expanded', 'true');
      placePopup(headingPicker, headingTrigger);
      headingPicker.querySelector('button').focus();
    }

    function applyResult(result, immediate = false) {
      writeSource(result.value, result.cursor);
      onFormatted({immediate});
    }

    function insertTable(rows, columns) {
      const source = readSource();
      applyResult(formatting.table(source.value, source.start, source.end, rows, columns));
    }

    function format(type) {
      if (isLocked()) return;
      const source = readSource();
      const result = formatting.format(source.value, source.start, source.end, type);
      if (result) applyResult(result, true);
    }

    grid.addEventListener('pointerover', (event) => {
      const cell = event.target.closest('.table-grid-cell');
      if (cell) highlight(Number(cell.dataset.rows), Number(cell.dataset.columns));
    });
    grid.addEventListener('focusin', (event) => {
      const cell = event.target.closest('.table-grid-cell');
      if (cell) highlight(Number(cell.dataset.rows), Number(cell.dataset.columns));
    });
    grid.addEventListener('click', (event) => {
      const cell = event.target.closest('.table-grid-cell');
      if (!cell) return;
      insertTable(Number(cell.dataset.rows), Number(cell.dataset.columns));
      hide();
    });
    headingPicker.addEventListener('click', (event) => {
      const option = event.target.closest('[data-heading]');
      if (!option) return;
      format(option.dataset.heading);
      hideHeading();
    });
    document.addEventListener('pointerdown', (event) => {
      if (
        !picker.classList.contains('hidden') &&
        !event.target.closest('#table-picker, [data-fmt="table"]')
      )
        hide();
      if (
        !headingPicker.classList.contains('hidden') &&
        !event.target.closest('#heading-picker, [data-fmt="heading"]')
      )
        hideHeading();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !picker.classList.contains('hidden')) hide();
      if (event.key === 'Escape' && !headingPicker.classList.contains('hidden')) {
        hideHeading();
        headingTrigger.focus();
      }
    });
    window.addEventListener('resize', () => {
      hide();
      hideHeading();
    });
    document.querySelector('.fmt-bar')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-fmt]');
      if (!button) return;
      event.preventDefault();
      if (button.dataset.fmt === 'table') {
        if (picker.classList.contains('hidden')) show(button);
        else hide();
        return;
      }
      if (button.dataset.fmt === 'heading') {
        if (headingPicker.classList.contains('hidden')) showHeading();
        else hideHeading();
        return;
      }
      format(button.dataset.fmt);
    });

    return {format};
  }

  root.VylkFormattingToolbar = {create};
})(typeof window !== 'undefined' ? window : globalThis);
