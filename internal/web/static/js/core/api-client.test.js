import {describe, expect, test} from 'bun:test';

await import('./http.js');
await import('./api-client.js');

function response(status, body = '') {
  return new Response(body, {
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 503 ? 'Service Unavailable' : 'OK',
  });
}

function setup(fetchImpl) {
  const diagnostics = [];
  const lifecycle = [];
  let authenticationRequired = false;
  const client = globalThis.VylkAPIClient.create({
    fetch: fetchImpl,
    http: globalThis.VylkHTTP,
    logger: {error() {}},
    onAuthenticationRequired: () => {
      authenticationRequired = true;
    },
    onDiagnostic: (...values) => diagnostics.push(values),
    onSyncRequestEnd: async () => lifecycle.push('end'),
    onSyncRequestStart: () => lifecycle.push('start'),
  });
  return {client, diagnostics, lifecycle, authenticationRequired: () => authenticationRequired};
}

describe('API client', () => {
  test('applies JSON request defaults and balances sync lifecycle callbacks', async () => {
    let captured;
    const context = setup(async (path, options) => {
      captured = {path, options};
      return response(200, '{"ok":true}');
    });

    await expect(
      context.client.request('/api/notes', {
        method: 'POST',
        body: '{}',
        syncRequest: true,
      }),
    ).resolves.toEqual({ok: true});
    expect(captured.path).toBe('/api/notes');
    expect(captured.options.credentials).toBe('same-origin');
    expect(captured.options.headers).toEqual({'Content-Type': 'application/json'});
    expect(captured.options).not.toHaveProperty('syncRequest');
    expect(context.lifecycle).toEqual(['start', 'end']);
  });

  test('preserves typed server failures and requests authentication on 401', async () => {
    const context = setup(async () =>
      response(401, '{"error":"sign in","code":"authentication_required"}'),
    );

    await expect(context.client.request('/api/check')).rejects.toMatchObject({
      code: 'authentication_required',
      responseStatus: 401,
    });
    expect(context.authenticationRequired()).toBe(true);
    expect(context.diagnostics[0][0]).toContain('GET /api/check returned HTTP 401');
  });

  test('returns non-success sync responses for protocol-specific handling', async () => {
    const context = setup(async () => response(503, 'try later'));

    const result = await context.client.syncFetch('/api/sync/push', {method: 'POST', body: '{}'});

    expect(result.response.status).toBe(503);
    expect(result.data).toBe('try later');
    expect(context.diagnostics).toEqual([
      ['POST /api/sync/push returned HTTP 503: try later', 503],
    ]);
    expect(context.lifecycle).toEqual(['start', 'end']);
  });

  test('cancels tracked requests and consumes only the matching abort', async () => {
    const context = setup(
      async (_path, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    const request = context.client.syncFetch('/api/sync');

    context.client.cancelActiveSyncRequests();

    const error = await request.catch((cause) => cause);
    expect(context.client.consumeCancellation(error)).toBe(true);
    expect(context.client.consumeCancellation(error)).toBe(false);
    expect(context.lifecycle).toEqual(['start', 'end']);
  });
});
