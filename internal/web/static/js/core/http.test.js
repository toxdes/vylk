import {describe, expect, test} from 'bun:test';

await import('./http.js');

const {APIError, errorFromPayload, errorFromTransport, readResponseBody} = globalThis.VylkHTTP;

describe('HTTP response helpers', () => {
  test('reads JSON, text, and empty response bodies', async () => {
    expect(await readResponseBody(new Response('{"ok":true}'))).toEqual({ok: true});
    expect(await readResponseBody(new Response('not json'))).toBe('not json');
    expect(await readResponseBody(new Response(null, {status: 204}))).toBeNull();
  });

  test('preserves server error details and retry policy', () => {
    const error = errorFromPayload({error: 'try later', code: 'busy'}, 503);

    expect(error).toBeInstanceOf(APIError);
    expect(error.message).toBe('try later');
    expect(error.code).toBe('busy');
    expect(error.responseStatus).toBe(503);
    expect(error.retryable).toBe(true);
  });

  test('distinguishes timeout, cancellation, and network failures', () => {
    expect(errorFromTransport(new DOMException('late', 'TimeoutError')).kind).toBe('timeout');
    expect(errorFromTransport(new DOMException('cancelled', 'AbortError')).retryable).toBe(false);
    expect(errorFromTransport(new TypeError('offline')).kind).toBe('network');
  });

  test('does not wrap an existing typed error', () => {
    const original = new APIError('bad response', {kind: 'protocol', retryable: false});
    expect(errorFromTransport(original)).toBe(original);
  });
});
