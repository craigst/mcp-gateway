/**
 * Fake remote observer harness for delegation tests.
 *
 * Plain ESM JavaScript on purpose: it is a test fixture, not production code.
 * Listens on an ephemeral loopback port so suites can run in parallel.
 *
 * Usage:
 *   const harness = await startObserverHarness({ behavior: 'approve' });
 *   // harness.url → http://127.0.0.1:<port>
 *   // harness.requests → [{ headers, body }, ...] in arrival order
 *   await harness.close();
 *
 * Options:
 *   behavior     - 'approve' (default) | 'deny' | 'error' | 'slow' | 'badjson' | 'capture'
 *   delayMs      - response delay; defaults to 1000 for 'slow', 0 otherwise
 *   requiresAuth - when true, requests without `Authorization: Bearer secret-token` get 401
 *   approvalToken- `approval_token` returned by the 'approve' behavior (default 'apr_test_token')
 *   httpStatus   - force an HTTP status code for the JSON response (e.g. 500)
 *   responseBody - override the JSON payload for the response
 */
import { createServer } from 'node:http';

/**
 * @typedef {Object} ObserverHarnessOptions
 * @property {'approve'|'deny'|'error'|'slow'|'badjson'|'capture'} [behavior]
 * @property {number} [delayMs]
 * @property {boolean} [requiresAuth]
 * @property {string} [approvalToken]
 * @property {number} [httpStatus]
 * @property {unknown} [responseBody]
 */

/**
 * @typedef {Object} ObserverHarnessRequest
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {unknown} body
 */

/**
 * @typedef {Object} ObserverHarness
 * @property {string} url
 * @property {number} port
 * @property {ObserverHarnessRequest[]} requests
 * @property {() => Promise<void>} close
 */

/** @type {Record<string, unknown>} */
const STATIC_RESPONSES = {
  approve: { status: 'approved', verdict: 'payload safe', approval_token: 'apr_test_token', output: { ok: true } },
  deny: { status: 'denied', verdict: 'payload rejected by observer', approval_token: null, output: null },
  error: { status: 'error', verdict: 'observer failure', approval_token: null, output: null },
  capture: { status: 'approved', verdict: 'captured', approval_token: null, output: null },
};

/**
 * Start the observer harness on 127.0.0.1 with an ephemeral port.
 * @param {ObserverHarnessOptions} [options]
 * @returns {Promise<ObserverHarness>}
 */
export async function startObserverHarness(options = {}) {
  const behavior = options.behavior ?? 'approve';
  const requiresAuth = options.requiresAuth === true;
  const approvalToken = options.approvalToken ?? 'apr_test_token';
  const delayMs = options.delayMs ?? (behavior === 'slow' ? 1000 : 0);

  /** @type {ObserverHarnessRequest[]} */
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          // Keep the raw string so tests can assert on malformed payloads.
        }
      }
      requests.push({ headers: req.headers, body });
      void respond(req, res);
    });
  });

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function respond(req, res) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (res.destroyed) return;

    if (requiresAuth) {
      const header = req.headers.authorization;
      if (header !== 'Bearer secret-token') {
        sendJson(res, 401, { status: 'error', verdict: 'unauthorized', approval_token: null, output: null });
        return;
      }
    }

    if (behavior === 'badjson') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('{ this is not json');
      return;
    }

    if (behavior === 'slow') {
      sendJson(res, options.httpStatus ?? 200, { ...STATIC_RESPONSES.approve, approval_token: approvalToken });
      return;
    }

    const payload =
      options.responseBody !== undefined
        ? options.responseBody
        : { ...(STATIC_RESPONSES[behavior] ?? STATIC_RESPONSES.approve) };

    if (behavior === 'approve' || behavior === 'slow') payload.approval_token = approvalToken;

    sendJson(res, options.httpStatus ?? 200, payload);
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} statusCode
   * @param {unknown} payload
   */
  function sendJson(res, statusCode, payload) {
    if (res.destroyed) return;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(body);
  }

  server.keepAliveTimeout = 1_000;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('observer harness failed to bind an ephemeral port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // Break keep-alive sockets so afterEach never hangs.
        server.closeAllConnections?.();
      }),
  };
}
