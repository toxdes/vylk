(function (global) {
  'use strict';

  function create({document, getDocumentLength, getPanelState, line, textarea, window, wrap}) {
    let cueFrame = null;
    let zenFrame = null;
    let measurementCache = null;
    let mirror = null;
    let mirrorText = null;
    let marker = null;
    let range = null;
    let mirrorSource = null;
    let mirrorMetricsKey = '';
    let delayTimer = null;

    function measure() {
      if (!textarea) return null;
      const textareaRect = textarea.getBoundingClientRect();
      if (!textareaRect.width || !textareaRect.height) return null;
      const computed = window.getComputedStyle(textarea);
      const source = textarea.value;
      const position =
        textarea.selectionDirection === 'backward'
          ? textarea.selectionStart
          : textarea.selectionEnd;
      const safePosition = Math.min(position, source.length);
      const metricsKey = [
        textarea.clientWidth,
        computed.font,
        computed.letterSpacing,
        computed.lineHeight,
        computed.padding,
        computed.border,
        computed.whiteSpace,
        computed.overflowWrap,
        computed.wordBreak,
        computed.tabSize,
        computed.textIndent,
        computed.direction,
        computed.unicodeBidi,
        computed.wordSpacing,
      ].join('\u0000');
      const lineHeight =
        Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.5 || 24;
      if (source.length > 250_000) {
        const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
        const contentHeight = Math.max(
          lineHeight,
          textarea.scrollHeight - paddingTop - (Number.parseFloat(computed.paddingBottom) || 0),
        );
        const offsetTop =
          paddingTop +
          (source.length
            ? (safePosition / source.length) * Math.max(0, contentHeight - lineHeight)
            : 0);
        return {
          top: textareaRect.top + offsetTop - textarea.scrollTop,
          height: lineHeight,
          lineHeight,
        };
      }
      if (
        measurementCache?.source === source &&
        measurementCache.position === position &&
        measurementCache.metricsKey === metricsKey
      ) {
        return {
          top: textareaRect.top + measurementCache.offsetTop - textarea.scrollTop,
          height: measurementCache.height,
          lineHeight: measurementCache.lineHeight,
        };
      }
      if (
        !mirror ||
        !range ||
        (!mirrorText && !marker) ||
        mirrorSource !== source ||
        mirrorMetricsKey !== metricsKey
      ) {
        if (!mirror) {
          if (!wrap) return null;
          mirror = document.createElement('div');
          mirror.className = 'editor-caret-measure';
          mirror.setAttribute('aria-hidden', 'true');
          wrap.append(mirror);
          range = document.createRange();
        }
        mirror.style.width = `${textarea.clientWidth}px`;
        mirror.style.boxSizing = 'border-box';
        mirror.style.border = computed.border;
        mirror.style.padding = computed.padding;
        mirror.style.font = computed.font;
        mirror.style.letterSpacing = computed.letterSpacing;
        mirror.style.lineHeight = computed.lineHeight;
        mirror.style.tabSize = computed.tabSize;
        mirror.style.whiteSpace = computed.whiteSpace;
        mirror.style.overflowWrap = computed.overflowWrap;
        mirror.style.wordBreak = computed.wordBreak;
        mirror.style.textIndent = computed.textIndent;
        mirror.style.direction = computed.direction;
        mirror.style.unicodeBidi = computed.unicodeBidi;
        mirror.style.wordSpacing = computed.wordSpacing;
        mirror.textContent = source || '\u200b';
        mirrorText = mirror.firstChild;
        marker = null;
        mirrorSource = source;
        mirrorMetricsKey = metricsKey;
      }
      const lineStart = safePosition === 0 || source[safePosition - 1] === '\n';
      let caretRect;
      if (lineStart) {
        if (!marker) {
          const before = document.createTextNode('');
          marker = document.createElement('span');
          marker.textContent = '\u200b';
          const after = document.createTextNode('');
          mirror.replaceChildren(before, marker, after);
          mirrorText = null;
        }
        const children = mirror.childNodes;
        children[0].data = source.slice(0, safePosition);
        children[2].data = source.slice(safePosition);
        caretRect = marker.getBoundingClientRect();
      } else {
        if (marker) {
          mirror.textContent = source || '\u200b';
          mirrorText = mirror.firstChild;
          marker = null;
        }
        range.setStart(mirrorText, safePosition);
        range.collapse(true);
        caretRect = range.getBoundingClientRect();
        if (safePosition < source.length && source[safePosition] !== '\n') {
          range.setEnd(mirrorText, safePosition + 1);
          const characterRect = range.getBoundingClientRect();
          if (characterRect.height && Math.abs(characterRect.top - caretRect.top) > 0.5)
            caretRect = characterRect;
          range.collapse(true);
        }
        if (!caretRect.height && safePosition > 0) {
          range.setStart(mirrorText, safePosition - 1);
          range.setEnd(mirrorText, safePosition);
          caretRect = range.getBoundingClientRect();
        }
      }
      const mirrorRect = mirror.getBoundingClientRect();
      const offsetTop = caretRect.top - mirrorRect.top;
      measurementCache = {
        source,
        position,
        metricsKey,
        offsetTop,
        height: caretRect.height || lineHeight,
        lineHeight,
      };
      return {
        top: textareaRect.top + offsetTop - textarea.scrollTop,
        height: caretRect.height || lineHeight,
        lineHeight,
      };
    }

    function updateCue() {
      cueFrame = null;
      if (!textarea || !wrap || !line) return;
      const focused =
        getPanelState() !== 'zen' && document.activeElement === textarea && !textarea.readOnly;
      wrap.classList.toggle('is-caret-visible', focused);
      if (!focused) return;
      const caret = measure();
      if (!caret) return;
      const textareaRect = textarea.getBoundingClientRect();
      wrap.style.setProperty(
        '--editor-caret-top',
        `${Math.max(0, caret.top - textareaRect.top)}px`,
      );
      wrap.style.setProperty('--editor-caret-height', `${Math.max(1, caret.height)}px`);
    }

    function cancelDelay() {
      if (delayTimer === null) return;
      window.clearTimeout(delayTimer);
      delayTimer = null;
    }

    function schedule({afterTyping = false} = {}) {
      if (getPanelState() === 'zen') {
        wrap?.classList.remove('is-caret-visible');
        if (cueFrame !== null) window.cancelAnimationFrame(cueFrame);
        cueFrame = null;
        cancelDelay();
        return;
      }
      if (afterTyping && getDocumentLength() > 250_000) {
        if (cueFrame !== null) window.cancelAnimationFrame(cueFrame);
        cueFrame = null;
        cancelDelay();
        delayTimer = window.setTimeout(() => {
          delayTimer = null;
          schedule();
        }, 180);
        return;
      }
      cancelDelay();
      if (cueFrame !== null) return;
      cueFrame = window.requestAnimationFrame(updateCue);
    }

    function center(targetRatio = 0.38, {defer = true} = {}) {
      if (!textarea) return;
      const apply = () => {
        const caret = measure();
        if (!caret) return;
        const textareaRect = textarea.getBoundingClientRect();
        const caretOffset = caret.top - textareaRect.top + textarea.scrollTop + caret.height / 2;
        const targetOffset = textarea.clientHeight * targetRatio;
        const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
        const nextScrollTop = Math.max(0, Math.min(maxScrollTop, caretOffset - targetOffset));
        if (Math.abs(textarea.scrollTop - nextScrollTop) > 2) textarea.scrollTop = nextScrollTop;
      };
      if (defer) window.requestAnimationFrame(apply);
      else apply();
    }

    function cancelZenCenter() {
      if (zenFrame === null) return;
      window.cancelAnimationFrame(zenFrame);
      zenFrame = null;
    }

    function centerZen({defer = true} = {}) {
      if (getPanelState() !== 'zen' || document.activeElement !== textarea) return;
      const apply = () => {
        zenFrame = null;
        if (getPanelState() === 'zen' && document.activeElement === textarea) {
          center(0.48, {defer: false});
        }
      };
      if (!defer) {
        cancelZenCenter();
        apply();
        return;
      }
      if (zenFrame !== null) return;
      zenFrame = window.requestAnimationFrame(apply);
    }

    return {cancelZenCenter, center, centerZen, measure, schedule};
  }

  global.VylkCaretController = {create};
})(typeof window !== 'undefined' ? window : globalThis);
