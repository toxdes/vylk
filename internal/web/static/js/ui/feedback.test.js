import {describe, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';

await import('./feedback.js');

function setup({version = '', revision = '', shellRevision = ''} = {}) {
  const dom = new JSDOM(
    `
    <span id="sync-status"><span class="sync-indicator-label"></span></span>
    <span id="editor-status"><span class="sync-indicator-label"></span></span>
    <div class="offline-notice hidden">
      <span class="offline-notice-message"></span>
      <button class="offline-retry">Retry</button>
    </div>
    <div id="toast-region"></div>
    <span id="app-version"></span>
  `,
    {url: 'http://localhost/'},
  );
  if (version) dom.window.localStorage.setItem('vylk-version', version);
  if (revision) dom.window.localStorage.setItem('vylk-revision', revision);
  if (shellRevision) {
    const meta = dom.window.document.createElement('meta');
    meta.name = 'vylk-revision';
    meta.content = shellRevision;
    dom.window.document.head.append(meta);
  }
  const registered = [];
  const feedback = globalThis.VylkFeedback.create({
    document: dom.window.document,
    isSyncInFlight: () => false,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    registerServiceWorker: (value) => registered.push(value),
    requestFrame: (callback) => callback(),
    window: dom.window,
  });
  return {document: dom.window.document, feedback, registered};
}

describe('feedback controller', () => {
  test('compares updates against the loaded shell rather than another tab’s cached version', () => {
    const {document, feedback} = setup({revision: 'new', shellRevision: 'old'});
    feedback.cacheVersion({revision: 'new'});
    expect(document.querySelectorAll('.toast.update')).toHaveLength(1);
    const fresh = setup({version: '1.0', revision: 'old', shellRevision: 'new'});
    fresh.feedback.cacheVersion({version: '2.0', revision: 'new'});
    expect(fresh.document.querySelectorAll('.toast.update')).toHaveLength(0);
  });
  test('presents sync and offline state consistently', () => {
    const {document, feedback} = setup();

    feedback.setStatus('local');
    expect(document.querySelector('#sync-status').dataset.state).toBe('local');
    expect(document.querySelector('#editor-status .sync-indicator-label').textContent).toBe(
      'Saving',
    );

    feedback.setStatus('saving');
    expect(document.querySelector('#sync-status .sync-indicator-label').textContent).toBe('Saving');
    expect(document.querySelector('#editor-status').getAttribute('aria-label')).toBe(
      'Saving on this device',
    );

    feedback.setStatus('unsaved');
    expect(document.querySelector('#sync-status .sync-indicator-label').textContent).toBe(
      'Not saved',
    );

    feedback.showOfflineNotice(true);
    expect(document.querySelector('.offline-notice').classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.offline-notice-message').textContent).toBe('Checking…');
    expect(document.querySelector('.offline-retry').disabled).toBe(true);

    feedback.hideOfflineNotice();
    expect(document.querySelector('.offline-notice').classList.contains('hidden')).toBe(true);
  });

  test('normalizes diagnostics without leaking mutable state', () => {
    const {feedback} = setup();
    feedback.setDiagnostic('  request\n failed  ', 503);
    expect(feedback.getDiagnostic()).toEqual({detail: 'request failed', responseStatus: 503});
    feedback.clearDiagnostic();
    expect(feedback.getDiagnostic()).toEqual({detail: '', responseStatus: 0});
  });

  test('caches versions, registers revisions, and announces an update once', () => {
    const {document, feedback, registered} = setup({version: '1.0', revision: 'old'});

    feedback.cacheVersion({version: '1.1', revision: 'new'});
    feedback.cacheVersion({version: '1.2', revision: 'newer'});

    expect(document.querySelector('#app-version').textContent).toBe('v1.2');
    expect(document.querySelectorAll('.toast.update')).toHaveLength(1);
    expect(registered).toEqual(['new', 'newer']);
  });
});
