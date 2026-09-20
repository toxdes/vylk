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

    function show(trigger) {
      picker.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      const rect = trigger.getBoundingClientRect();
      const gutter = 8;
      const left = Math.min(
        Math.max(gutter, rect.left),
        window.innerWidth - picker.offsetWidth - gutter,
      );
      const top = Math.min(rect.bottom + gutter, window.innerHeight - picker.offsetHeight - gutter);
      picker.style.left = `${left}px`;
      picker.style.top = `${top}px`;
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
    document.addEventListener('pointerdown', (event) => {
      if (
        !picker.classList.contains('hidden') &&
        !event.target.closest('#table-picker, [data-fmt="table"]')
      )
        hide();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !picker.classList.contains('hidden')) hide();
    });
    window.addEventListener('resize', hide);
    document.querySelector('.fmt-bar')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-fmt]');
      if (!button) return;
      event.preventDefault();
      if (button.dataset.fmt === 'table') {
        if (picker.classList.contains('hidden')) show(button);
        else hide();
        return;
      }
      format(button.dataset.fmt);
    });

    return {format};
  }

  root.VylkFormattingToolbar = {create};
})(typeof window !== 'undefined' ? window : globalThis);
