import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BROWSER_BINARY} from './server-fixture.js';

// Build once; every worker starts its own server from this binary.
export default function globalSetup() {
  execFileSync('go', ['build', '-buildvcs=false', '-o', BROWSER_BINARY, './cmd/vylk'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE || path.join(tmpdir(), 'vylk-browser-go-cache'),
    },
  });
}
