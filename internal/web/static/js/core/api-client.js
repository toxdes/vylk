(function (root) {
  'use strict';

  function create({
    fetch,
    http,
    logger = console,
    onAuthenticationRequired,
    onDiagnostic,
    onSyncRequestEnd,
    onSyncRequestStart,
    timeoutMs = 15000,
  }) {
    const activeSyncControllers = new Set();
    let cancellationRequested = false;
    let authenticationRevision = 0;

    function assertCurrentAuthentication(response, revision) {
      // A delayed rejection of the old cookie must not undo a newer sign-in.
      if (response.status === 401 && revision !== authenticationRevision)
        throw new http.APIError('Authentication response superseded by a newer sign-in', {
          code: 'authentication_superseded',
          kind: 'aborted',
          retryable: false,
        });
    }

    async function fetchWithTimeout(path, options = {}, {trackSync = false} = {}) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException('request timed out', 'TimeoutError')),
        timeoutMs,
      );
      if (trackSync) activeSyncControllers.add(controller);
      try {
        return await fetch(path, {...options, signal: controller.signal});
      } finally {
        clearTimeout(timer);
        activeSyncControllers.delete(controller);
      }
    }

    function requestOptions(options = {}) {
      return {
        credentials: 'same-origin',
        headers: options.body ? {'Content-Type': 'application/json'} : {},
        ...options,
      };
    }

    async function request(path, options) {
      const method = options?.method || 'GET';
      if (path === '/api/login' && method.toUpperCase() === 'POST') authenticationRevision++;
      const revision = authenticationRevision;
      const syncRequest = options?.syncRequest === true;
      const fetchOptions = {...options};
      delete fetchOptions.syncRequest;
      delete fetchOptions.throwOnError;
      if (syncRequest) onSyncRequestStart();
      try {
        const response = await fetchWithTimeout(path, requestOptions(fetchOptions), {
          trackSync: syncRequest,
        });
        if (response.status === 204) return true;
        const body = await http.readResponseBody(response);
        assertCurrentAuthentication(response, revision);
        if (!response.ok) {
          const error = http.errorFromPayload(body, response.status, response.statusText);
          if (response.status === 401) onAuthenticationRequired();
          throw error;
        }
        if (body === null)
          throw new http.APIError('invalid server response', {
            kind: 'protocol',
            retryable: false,
          });
        return body;
      } catch (cause) {
        const error = http.errorFromTransport(cause);
        if (error.code === 'authentication_superseded') throw error;
        onDiagnostic(
          `${method} ${path} ${error.responseStatus ? `returned HTTP ${error.responseStatus}` : 'failed'}: ${error.message || 'unknown error'}`,
          error.responseStatus,
        );
        logger.error(error);
        throw error;
      } finally {
        if (syncRequest) await onSyncRequestEnd();
      }
    }

    async function syncFetch(path, options) {
      const method = options?.method || 'GET';
      const revision = authenticationRevision;
      onSyncRequestStart();
      try {
        const response = await fetchWithTimeout(path, requestOptions(options), {trackSync: true});
        const data = response.status === 204 ? null : await http.readResponseBody(response);
        assertCurrentAuthentication(response, revision);
        if (!response.ok)
          onDiagnostic(
            `${method} ${path} returned HTTP ${response.status}: ${typeof data === 'string' ? data : response.statusText}`,
            response.status,
          );
        return {response, data};
      } catch (cause) {
        const error = http.errorFromTransport(cause);
        if (error.code === 'authentication_superseded') throw error;
        onDiagnostic(`${method} ${path} failed: ${error.message}`);
        throw error;
      } finally {
        await onSyncRequestEnd();
      }
    }

    function cancelActiveSyncRequests() {
      if (!activeSyncControllers.size) return;
      cancellationRequested = true;
      activeSyncControllers.forEach((controller) => controller.abort());
    }

    function consumeCancellation(error) {
      if (error?.code === 'authentication_superseded') return true;
      const aborted = error?.name === 'AbortError' || error?.kind === 'aborted';
      if (!aborted || !cancellationRequested) return false;
      cancellationRequested = false;
      return true;
    }

    return {
      authenticationRevision: () => authenticationRevision,
      cancelActiveSyncRequests,
      consumeCancellation,
      request,
      syncFetch,
    };
  }

  root.VylkAPIClient = {create};
})(typeof window !== 'undefined' ? window : globalThis);
