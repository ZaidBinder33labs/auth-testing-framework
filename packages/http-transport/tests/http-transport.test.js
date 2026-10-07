'use strict';
/**
 * @atf/http-transport
 *
 * Covers only the generic HTTP behaviour the framework's target adapters depend on. There is
 * deliberately no test here for any single application's error shape: that is a target concern.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  FetchRequestContext,
  HttpResponse,
  HttpStatusError,
  HttpTransport,
  HttpTransportConfigError,
  parseRetryAfter,
  parseSetCookie,
  DEFAULT_TIMEOUT_MS,
} = require('@atf/http-transport');

const BASE = 'https://api.example.test';

// ------------------------------------------------------------------------------------------
// Scripted context
// ------------------------------------------------------------------------------------------

/** A request context that replays a fixed script and records what it was asked to send. */
function scriptedContext(script) {
  const calls = [];
  const ctx = {
    calls,
    async fetch(url, init = {}) {
      calls.push({ url, method: init.method, headers: init.headers, data: init.data, timeout: init.timeout });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step.throw) throw step.throw;
      return {
        status: () => step.status,
        headers: () => step.headers || {},
        text: async () => (step.text === undefined ? JSON.stringify(step.body ?? null) : step.text),
      };
    },
  };
  return { ctx, calls };
}

const noWait = { sleep: async () => {} };

// ------------------------------------------------------------------------------------------
// HTP-01  Construction
// ------------------------------------------------------------------------------------------

test('HTP-01 requires a request context that exposes fetch', () => {
  assert.throws(() => new HttpTransport(null, { base: BASE }), HttpTransportConfigError);
  assert.throws(() => new HttpTransport({}, { base: BASE }), HttpTransportConfigError);
});

test('HTP-02 defaults the per-request timeout and exposes it to the context', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE });
  await t.get('/ping');
  assert.strictEqual(t.timeout, DEFAULT_TIMEOUT_MS);
  assert.strictEqual(calls[0].timeout, DEFAULT_TIMEOUT_MS);
});

test('HTP-03 refuses to resolve a relative path without a base URL', () => {
  const { ctx } = scriptedContext([{ status: 200, body: {} }]);
  assert.throws(() => new HttpTransport(ctx, {}).url('/x'), HttpTransportConfigError);
});

test('HTP-04 passes an absolute URL through unchanged', () => {
  const { ctx } = scriptedContext([{ status: 200, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE });
  assert.strictEqual(t.url('https://other.example.test/v1'), 'https://other.example.test/v1');
  assert.strictEqual(t.url('/v1/x'), `${BASE}/v1/x`);
  assert.strictEqual(t.url('v1/x'), `${BASE}/v1/x`);
});

// ------------------------------------------------------------------------------------------
// HTP-05  Bearer header
// ------------------------------------------------------------------------------------------

test('HTP-05 sends the bearer token on every request', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  await new HttpTransport(ctx, { base: BASE, token: 'tok-1' }).get('/me');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok-1');
});

test('HTP-06 sends no Authorization header when there is no token', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  await new HttpTransport(ctx, { base: BASE }).get('/login');
  assert.ok(!('Authorization' in calls[0].headers));
});

test('HTP-07 a per-call token overrides the transport token and null suppresses the header', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE, token: 'default' });
  await t.get('/me', { token: 'override' });
  await t.get('/public', { token: null });
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer override');
  assert.ok(!('Authorization' in calls[1].headers));
});

test('HTP-08 auth:false suppresses the header even with a token set', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  await new HttpTransport(ctx, { base: BASE, token: 'tok' }).get('/x', { auth: false });
  assert.ok(!('Authorization' in calls[0].headers));
});

test('HTP-09 withToken produces an independent transport bound to the new token', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE, token: 'a' });
  const u = t.withToken('b');
  assert.notStrictEqual(u, t);
  assert.strictEqual(u.token, 'b');
  assert.strictEqual(t.token, 'a');
  await u.get('/me');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer b');
});

// ------------------------------------------------------------------------------------------
// HTP-10  Bodies
// ------------------------------------------------------------------------------------------

test('HTP-10 post sends the JSON body positionally, the way a target adapter calls it', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  await new HttpTransport(ctx, { base: BASE }).post('/login', { a: 1 });
  assert.strictEqual(calls[0].method, 'POST');
  assert.deepStrictEqual(calls[0].data, { a: 1 });
});

test('HTP-11 send with no json sends no body at all, not an empty object', async () => {
  const { ctx, calls } = scriptedContext([{ status: 204, text: '' }]);
  await new HttpTransport(ctx, { base: BASE, token: 't' }).send('POST', '/logout');
  assert.strictEqual(calls[0].data, undefined);
});

test('HTP-12 an empty object body is sent as an object, which is distinct from no body', async () => {
  const { ctx, calls } = scriptedContext([{ status: 200, body: {} }]);
  await new HttpTransport(ctx, { base: BASE }).post('/refresh', {});
  assert.deepStrictEqual(calls[0].data, {});
});

// ------------------------------------------------------------------------------------------
// HTP-13  Response surface
// ------------------------------------------------------------------------------------------

test('HTP-13 exposes status, headers, parsed body and raw text', async () => {
  const { ctx } = scriptedContext([{ status: 200, body: { ok: true }, headers: { 'x-request-id': 'r1' } }]);
  const res = await new HttpTransport(ctx, { base: BASE }).get('/me');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
  assert.strictEqual(res.headers['x-request-id'], 'r1');
  assert.strictEqual(res.text, '{"ok":true}');
});

test('HTP-14 a non-JSON payload leaves body null and keeps the raw text', async () => {
  const { ctx } = scriptedContext([{ status: 200, text: 'not json at all' }]);
  const res = await new HttpTransport(ctx, { base: BASE }).get('/html');

  assert.strictEqual(res.body, null);
  assert.strictEqual(res.text, 'not json at all');
  assert.strictEqual(res.status, 200);
});

test('HTP-15 an empty payload yields a null body and empty text', async () => {
  const { ctx } = scriptedContext([{ status: 204, text: '' }]);
  const res = await new HttpTransport(ctx, { base: BASE }).send('POST', '/logout');
  assert.strictEqual(res.body, null);
  assert.strictEqual(res.text, '');
});

test('HTP-16 the response path is reported relative to the base URL', async () => {
  const { ctx } = scriptedContext([{ status: 200, body: {} }]);
  const res = await new HttpTransport(ctx, { base: BASE }).get('/api/v1/auth/me');
  assert.strictEqual(res.path, '/api/v1/auth/me');
});

// ------------------------------------------------------------------------------------------
// HTP-17  expect()
// ------------------------------------------------------------------------------------------

test('HTP-17 expect passes for an expected status and returns the response', () => {
  const res = new HttpResponse({ method: 'POST', path: '/x', status: 204, headers: {}, body: null, text: '' });
  assert.strictEqual(res.expect(204), res);
  assert.strictEqual(res.expect([200, 204]), res);
});

test('HTP-18 expect throws HttpStatusError carrying the response', () => {
  const res = new HttpResponse({ method: 'GET', path: '/x', status: 503, headers: {}, body: null, text: '' });
  try {
    res.expect(200);
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof HttpStatusError);
    assert.strictEqual(e.response.status, 503);
  }
});

test('HTP-19 the expect message never contains the response body', () => {
  // A body can echo the credentials just sent; the message must not carry it.
  const secret = 'hunter2-in-a-body';
  const res = new HttpResponse({
    method: 'POST', path: '/login', status: 500, headers: {}, body: { detail: secret }, text: JSON.stringify({ detail: secret }),
  });
  try {
    res.expect(200);
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(!e.message.includes(secret), 'the body must not reach the error message');
    assert.ok(e.message.includes('POST /login'));
    assert.ok(e.message.includes('500'));
  }
});

// ------------------------------------------------------------------------------------------
// HTP-20  429 retry
// ------------------------------------------------------------------------------------------

test('HTP-20 retries a 429 and returns the eventual success', async () => {
  const { ctx, calls } = scriptedContext([
    { status: 429, body: { error: 'slow down' } },
    { status: 200, body: { ok: true } },
  ]);
  const slept = [];
  const t = new HttpTransport(ctx, { base: BASE, sleep: async (ms) => slept.push(ms) });

  const res = await t.get('/slow');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(t.retried429, 1);
  assert.strictEqual(slept.length, 1);
});

test('HTP-21 honours Retry-After in seconds', async () => {
  const { ctx } = scriptedContext([
    { status: 429, headers: { 'retry-after': '2' }, body: {} },
    { status: 200, body: {} },
  ]);
  const slept = [];
  await new HttpTransport(ctx, { base: BASE, sleep: async (ms) => slept.push(ms) }).get('/x');
  // 2s of server-requested wait plus the fixed jitter.
  assert.strictEqual(slept[0], 2500);
});

test('HTP-22 honours Retry-After given as an HTTP date', async () => {
  const { ctx } = scriptedContext([
    { status: 429, headers: { 'retry-after': new Date(Date.now() + 3000).toUTCString() }, body: {} },
    { status: 200, body: {} },
  ]);
  const slept = [];
  await new HttpTransport(ctx, { base: BASE, sleep: async (ms) => slept.push(ms) }).get('/x');
  assert.ok(slept[0] >= 2500 && slept[0] <= 3600, `unexpected wait ${slept[0]}`);
});

test('HTP-23 falls back to a default wait when Retry-After is absent', async () => {
  const { ctx } = scriptedContext([{ status: 429, body: {} }, { status: 200, body: {} }]);
  const slept = [];
  await new HttpTransport(ctx, { base: BASE, sleep: async (ms) => slept.push(ms) }).get('/x');
  assert.strictEqual(slept[0], 10500);
});

test('HTP-24 gives up after the retry budget and returns the 429 to the caller', async () => {
  const { ctx, calls } = scriptedContext([{ status: 429, body: { error: 'still limited' } }]);
  const t = new HttpTransport(ctx, { base: BASE, retries: 2, ...noWait });

  const res = await t.get('/x');

  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls.length, 3, 'one initial attempt plus two retries');
  assert.strictEqual(t.retried429, 2);
});

test('HTP-25 retries:0 means a single attempt', async () => {
  const { ctx, calls } = scriptedContext([{ status: 429, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE, retries: 0, ...noWait });
  const res = await t.get('/x');
  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls.length, 1);
});

test('HTP-26 a 429 is not retried when the caller passes its own budget', async () => {
  const { ctx, calls } = scriptedContext([{ status: 429, body: {} }, { status: 200, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE, ...noWait });
  const res = await t.get('/x', { retries: 0 });
  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls.length, 1);
});

test('HTP-27 only 429 is retried; a 500 is returned immediately', async () => {
  const { ctx, calls } = scriptedContext([{ status: 500, body: {} }, { status: 200, body: {} }]);
  const t = new HttpTransport(ctx, { base: BASE, ...noWait });
  const res = await t.get('/x');
  assert.strictEqual(res.status, 500);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(t.retried429, 0);
});

test('HTP-28 parseRetryAfter covers seconds, dates and rubbish', () => {
  assert.strictEqual(parseRetryAfter('3'), 3000);
  assert.strictEqual(parseRetryAfter('0'), 0);
  assert.strictEqual(parseRetryAfter(''), null);
  assert.strictEqual(parseRetryAfter(null), null);
  assert.strictEqual(parseRetryAfter(undefined), null);
  assert.strictEqual(parseRetryAfter('soon-ish'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.strictEqual(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  // A date already in the past must not produce a negative wait.
  assert.strictEqual(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now + 10000), 0);
});

// ------------------------------------------------------------------------------------------
// HTP-29  Transport failure
// ------------------------------------------------------------------------------------------

test('HTP-29 a transport failure propagates; the transport does not invent a status', async () => {
  const boom = Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' });
  const { ctx } = scriptedContext([{ throw: boom }]);
  await assert.rejects(new HttpTransport(ctx, { base: BASE }).get('/x'), (e) => e === boom);
});

// ------------------------------------------------------------------------------------------
// HTP-30  Cookie jar
// ------------------------------------------------------------------------------------------

test('HTP-30 parseSetCookie reads the first name/value pair and ignores attributes', () => {
  assert.deepStrictEqual(parseSetCookie('rt=abc123; Path=/; HttpOnly; SameSite=Strict'), { name: 'rt', value: 'abc123' });
  assert.deepStrictEqual(parseSetCookie('rt=abc'), { name: 'rt', value: 'abc' });
  assert.strictEqual(parseSetCookie('novalue'), null);
});

test('HTP-31 the cookie jar replays cookies on the next request and clears on dispose', async () => {
  // Exercised through the real context against a local server, because the jar is the reason
  // this class exists and a fake fetch would not prove it.
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.cookie || null);
    res.setHeader('Set-Cookie', 'rt=secret-refresh; Path=/; HttpOnly');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const ctx = new FetchRequestContext();
    const t = new HttpTransport(ctx, { base: `http://127.0.0.1:${port}` });

    await t.get('/first');
    await t.get('/second');

    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0], null, 'no cookie is sent before the server sets one');
    assert.strictEqual(seen[1], 'rt=secret-refresh', 'the cookie set by the first response is replayed');

    await ctx.dispose();
    await t.get('/third');
    assert.strictEqual(seen[2], null, 'dispose forgets every cookie');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTP-32 a JSON request body is serialised and typed', async () => {
  const http = require('node:http');
  let received = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { raw: Buffer.concat(chunks).toString('utf8'), type: req.headers['content-type'] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const t = new HttpTransport(new FetchRequestContext(), { base: `http://127.0.0.1:${port}` });
    await t.post('/login', { email: 'a@b.test', password: 'x' });
    assert.deepStrictEqual(JSON.parse(received.raw), { email: 'a@b.test', password: 'x' });
    assert.match(received.type, /application\/json/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTP-33 a request with no body sends no body and no content type', async () => {
  const http = require('node:http');
  let bytes = 0;
  let type = null;
  const server = http.createServer((req, res) => {
    req.on('data', (c) => { bytes += c.length; });
    req.on('end', () => {
      type = req.headers['content-type'] || null;
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const t = new HttpTransport(new FetchRequestContext(), { base: `http://127.0.0.1:${port}`, token: 'tok' });
    const res = await t.send('POST', '/logout');
    assert.strictEqual(res.status, 204);
    // A Content-Length of 0 is what Node's server reports for a bodyless request; the point is
    // that no payload bytes and no content type were sent.
    assert.strictEqual(bytes, 0, 'no body bytes may be sent');
    assert.strictEqual(type, null, 'a bodyless request must not claim a content type');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTP-34 a real 429 with Retry-After is retried end to end', async () => {
  const http = require('node:http');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
      res.end('{"error":"rate limited"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const t = new HttpTransport(new FetchRequestContext(), { base: `http://127.0.0.1:${port}` });
    const res = await t.get('/limited');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hits, 2);
    assert.strictEqual(t.retried429, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
