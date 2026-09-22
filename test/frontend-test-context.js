import {afterEach, beforeEach} from 'vitest';
import fs from 'node:fs';
import {deleteOfflineDatabase} from './app-harness.js';

export function installAppLifecycle() {
  let apps = [];

  beforeEach(async () => {
    apps = [];
    await deleteOfflineDatabase();
  });

  afterEach(async () => {
    for (const app of apps.reverse()) await app.close();
    await deleteOfflineDatabase();
  });

  return (app) => {
    apps.push(app);
    return app;
  };
}

export function pointerEvent(window, type, {pointerId = 1, pointerType = 'mouse', ...init} = {}) {
  const event = new window.MouseEvent(type, {bubbles: true, cancelable: true, ...init});
  Object.defineProperties(event, {
    pointerId: {value: pointerId},
    pointerType: {value: pointerType},
    isPrimary: {value: true},
  });
  return event;
}

export const styleSource = fs
  .readFileSync(new URL('../internal/web/static/style.css', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{}:;,>])\s*/g, '$1')
  .replaceAll("'", '"')
  .replaceAll(';}', '}');
