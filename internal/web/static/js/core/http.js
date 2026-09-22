(function (root) {
  'use strict';

  class APIError extends Error {
    constructor(
      message,
      {status = 0, code = '', kind = 'http', retryable = null, cause = null} = {},
    ) {
      super(message);
      this.name = 'APIError';
      this.kind = kind;
      this.code = code;
      this.responseStatus = status;
      this.retryable = retryable ?? (!status || status === 408 || status === 429 || status >= 500);
      if (cause) this.cause = cause;
    }
  }

  async function readResponseBody(response) {
    const text = await response.text();
    if (typeof text !== 'string') return text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  function errorFromPayload(payload, status, statusText = '') {
    const message =
      typeof payload === 'string' ? payload : payload?.error || statusText || 'request failed';
    const code = typeof payload === 'object' && payload ? String(payload.code || '') : '';
    return new APIError(message, {status, code});
  }

  function errorFromTransport(error) {
    if (error instanceof APIError) return error;
    const timedOut = error?.name === 'TimeoutError';
    const aborted = error?.name === 'AbortError';
    return new APIError(
      timedOut ? 'request timed out' : aborted ? 'request aborted' : 'network request failed',
      {
        kind: timedOut ? 'timeout' : aborted ? 'aborted' : 'network',
        retryable: !aborted,
        cause: error,
      },
    );
  }

  root.VylkHTTP = Object.freeze({
    APIError,
    errorFromPayload,
    errorFromTransport,
    readResponseBody,
  });
})(globalThis);
