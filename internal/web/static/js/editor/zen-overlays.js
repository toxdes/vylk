(function (root) {
  'use strict';

  function create({document, getPanelState, getPreferences, getSource, window}) {
    let wordCountHandle = null;
    let countedSource = null;
    let countedWords = 0;

    function countWords(source) {
      const matcher = /\S+/g;
      let count = 0;
      while (matcher.exec(source)) count++;
      return count;
    }

    function cancelWordCount() {
      if (!wordCountHandle) return;
      if (wordCountHandle.idle) window.cancelIdleCallback(wordCountHandle.id);
      else window.clearTimeout(wordCountHandle.id);
      wordCountHandle = null;
    }

    function updateWordCount() {
      wordCountHandle = null;
      const element = document.querySelector('#zen-word-count');
      if (!element) return;
      const preferences = getPreferences();
      element.hidden = !preferences.zenWordCount;
      if (!preferences.zenWordCount) return;
      const source = getSource();
      if (source !== countedSource) {
        countedSource = source;
        countedWords = countWords(source);
      }
      const label = `${countedWords} ${countedWords === 1 ? 'word' : 'words'}`;
      if (element.textContent !== label) element.textContent = label;
    }

    function scheduleWordCount() {
      cancelWordCount();
      if (!getPreferences().zenWordCount || getPanelState() !== 'zen') return;
      if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(updateWordCount, {timeout: 400});
        wordCountHandle = {id, idle: true};
      } else {
        const id = window.setTimeout(updateWordCount, 120);
        wordCountHandle = {id, idle: false};
      }
    }

    function updateTitle() {
      const title = document.querySelector('#zen-note-title');
      if (!title) return;
      const label = document.querySelector('#note-title')?.value.trim() || 'Untitled note';
      if (title.textContent !== label) title.textContent = label;
      title.hidden = !getPreferences().zenShowTitle;
    }

    function update() {
      const title = document.querySelector('#zen-note-title');
      const count = document.querySelector('#zen-word-count');
      const controls = document.querySelector('.zen-controls');
      if (!title || !count || !controls) return;
      const preferences = getPreferences();
      updateTitle();
      cancelWordCount();
      updateWordCount();
      controls.classList.toggle('is-minimal', !preferences.zenShowControls);
      document
        .querySelector('#zen-exit-icon')
        ?.setAttribute('href', preferences.zenShowControls ? '#icon-minimize' : '#icon-x');
    }

    return {cancelWordCount, countWords, scheduleWordCount, update, updateTitle};
  }

  root.VylkZenOverlays = {create};
})(typeof window !== 'undefined' ? window : globalThis);
