'use strict';
// @atf/http-transport — application-agnostic HTTP transport for the framework.
//
// It exists because a framework that serves any application cannot depend on one
// application's API client. Three pieces, all generic HTTP behaviour:
//
//   FetchRequestContext  an APIRequestContext-compatible object over global fetch that keeps a
//                        cookie jar, because a refresh token delivered in an HttpOnly cookie
//                        cannot be re-sent by a client that forgets cookies.
//   HttpTransport        bearer header, 429 retry honouring Retry-After, JSON parse with text
//                        fallback, and a status/headers/text response surface.
//   HttpResponse         the response, plus expect() for asserting a status.
//
// Deliberately absent: any single application's error envelope, URL-prefix conventions,
// idempotency/conditional-request headers, multipart bodies, and configuration reads. Those
// belong to a target adapter or a transport policy, not to a transport.

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_RETRIES = 3;
const RETRY_AFTER_FALLBACK_SECONDS = 10;
const RETRY_AFTER_JITTER_MS = 500;
const JSON_CONTENT_TYPE = 'application/json';

/** Parse a Set-Cookie header value into { name, value }. */
function parseSetCookie(header) {
  const [pair] = String(header).split(';');
  const idx = pair.indexOf('=');
  if (idx < 0) return null;
  return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry-After is either a delay in seconds or an HTTP date. Returns milliseconds, or null when
 * the header is absent or unparseable so the caller can apply its own fallback.
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(String(value));
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - now);
}

/** APIRequestContext-compatible wrapper around global fetch. */
class FetchRequestContext {
  constructor({ timeout = 30000 } = {}) {
    this.timeout = timeout;
    this.cookies = new Map();
    this.requestCount = 0;
    this.redirect = 'manual';
  }

  cookieHeader() {
    if (!this.cookies.size) return null;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async fetch(url, init = {}) {
    this.requestCount += 1;
    const method = init.method || 'GET';
    const headers = { ...(init.headers || {}) };

    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;

    let body;
    if (init.data !== undefined && init.data !== null && method !== 'GET' && method !== 'HEAD') {
      body = typeof init.data === 'string' ? init.data : JSON.stringify(init.data);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = JSON_CONTENT_TYPE;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), init.timeout || this.timeout);
    let res;
    try {
      res = await fetch(url, { method, headers, body, redirect: this.redirect, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }

    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const parsed = parseSetCookie(raw);
      if (parsed) this.cookies.set(parsed.name, parsed.value);
    }

    const text = await res.text();
    const status = res.status;
    const headerObj = {};
    for (const [k, v] of res.headers.entries()) headerObj[k.toLowerCase()] = v;

    return {
      status: () => status,
      headers: () => headerObj,
      text: async () => text,
    };
  }

  /** Forget every stored cookie. */
  async dispose() {
    this.cookies.clear();
  }
}

/**
 * A response, already parsed. `body` is null when the payload was not JSON; `text` always holds
 * the raw payload so a caller that must inspect a non-JSON body can, without the transport
 * deciding what a body means.
 */
class HttpResponse {
  constructor({ method, path, status, headers, body, text }) {
    Object.assign(this, { method, path, status, headers, body, text });
  }

  /**
   * Throw unless the status is one of `expected`.
   * The message carries only the method, path and status. The response body is never included:
   * a body can echo the credentials that were just sent.
   */
  expect(expected) {
    const ok = [].concat(expected);
    if (!ok.includes(this.status)) {
      throw new HttpStatusError(`Expected HTTP ${ok.join('/')} but got ${this.status} for ${this.method} ${this.path}`, this);
    }
    return this;
  }
}

/** Thrown by HttpResponse.expect(). Carries the response on `.response`. */
class HttpStatusError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'HttpStatusError';
    this.response = response;
  }
}

class HttpTransport {
  /**
   * @param {Object}   ctx              anything exposing fetch(url, init).
   * @param {Object}   [opts]
   * @param {string}   [opts.base]      absolute base URL. Required: the transport never guesses.
   * @param {string}   [opts.token]     bearer token sent on every request unless overridden.
   * @param {number}   [opts.timeout]   per-request timeout in ms.
   * @param {number}   [opts.retries]   how many times a 429 may be retried.
   * @param {Function} [opts.sleep]     await-seam, so tests need not actually wait.
   */
  constructor(ctx, opts = {}) {
    if (!ctx || typeof ctx.fetch !== 'function') {
      throw new HttpTransportConfigError('HttpTransport requires a request context exposing fetch(url, init)');
    }
    this.ctx = ctx;
    this.base = opts.base || null;
    this.token = opts.token || null;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries === undefined ? DEFAULT_RETRIES : opts.retries;
    this.sleep = opts.sleep || defaultSleep;
    this.retried429 = 0;
  }

  /** A copy of this transport bound to a different bearer token. */
  withToken(token) {
    const t = new HttpTransport(this.ctx, {
      base: this.base, token, timeout: this.timeout, retries: this.retries, sleep: this.sleep,
    });
    t.retried429 = this.retried429;
    return t;
  }

  /**
   * Resolve a path against the base URL. An absolute URL passes through unchanged, which is how
   * a target adapter can point one call at a different host. A leading path is appended as-is:
   * prefix conventions belong to the target, not here.
   */
  url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    if (!this.base) throw new HttpTransportConfigError('HttpTransport requires a base URL');
    return this.base + (path.startsWith('/') ? path : `/${path}`);
  }

  /**
   * Issue one request, retrying 429 up to `retries` times.
   * @param {string} method
   * @param {string} path
   * @param {Object} [options]
   * @param {*}      [options.json]     JSON body. Omitted entirely when undefined.
   * @param {Object} [options.headers]
   * @param {string} [options.token]    per-call token; `null` sends no Authorization header.
   * @param {number} [options.retries]
   * @param {boolean}[options.auth]     set false to suppress the bearer header.
   */
  async send(method, path, options = {}) {
    const url = this.url(path);
    const headers = { Accept: JSON_CONTENT_TYPE, ...(options.headers || {}) };
    const bearer = options.token === undefined ? this.token : options.token;
    if (options.auth !== false && bearer) headers.Authorization = `Bearer ${bearer}`;

    const retries = options.retries === undefined ? this.retries : options.retries;

    for (let attempt = 0; ; attempt += 1) {
      const res = await this.ctx.fetch(url, {
        method,
        data: options.json,
        headers,
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: this.timeout,
      });

      const status = res.status();
      const outHeaders = res.headers();

      if (status === 429 && attempt < retries) {
        this.retried429 += 1;
        const wait = (parseRetryAfter(outHeaders['retry-after']) ?? RETRY_AFTER_FALLBACK_SECONDS * 1000) + RETRY_AFTER_JITTER_MS;
        await this.sleep(wait);
        continue;
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {
        // Not JSON. `body` stays null and `text` remains available; the transport does not
        // guess whether a non-JSON payload is an error.
        body = null;
      }

      return new HttpResponse({
        method,
        path: this.base && url.startsWith(this.base) ? url.slice(this.base.length) : url,
        status,
        headers: outHeaders,
        body,
        text,
      });
    }
  }

  get(path, options) { return this.send('GET', path, options); }
  post(path, json, options = {}) { return this.send('POST', path, { ...options, json }); }
}

/** Thrown when the transport is configured in a way that cannot produce a request. */
class HttpTransportConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HttpTransportConfigError';
  }
}

module.exports = {
  FetchRequestContext,
  HttpResponse,
  HttpStatusError,
  HttpTransport,
  HttpTransportConfigError,
  parseRetryAfter,
  parseSetCookie,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
};
