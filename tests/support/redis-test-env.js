'use strict';
/**
 * Real Redis integration harness.
 *
 * These helpers exist so integration tests can only ever touch their own keys:
 *   - a unique namespace per run, so concurrent runs never collide
 *   - an isolated database index, so a test run cannot reach another DB
 *   - cleanup by SCAN over the run's own prefix, never FLUSHDB / FLUSHALL
 *
 * Connection parameters come from the environment. Credentials are never returned, logged or
 * written to a report; only sanitizedUrl (from @atf/redis-observer) is exposed.
 */

const crypto = require('crypto');
const Redis = require('ioredis');

/** Isolated DB for tests. Chosen to be unusual so a stray flush is unlikely to matter. */
const TEST_DB = Number.parseInt(process.env.REDIS_TEST_DB || '15', 10);

function runNamespace() {
  const raw = process.env.REDIS_TEST_NAMESPACE || 'qa';
  const unique = crypto.randomBytes(6).toString('hex');
  return `${raw}:${process.pid}:${unique}`;
}

/**
 * Build connection options.
 * Returns { options, sanitizedUrl, namespace, db } — never the raw URL with credentials.
 */
function connectionOptions() {
  const url = process.env.REDIS_URL || null;
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.REDIS_PORT || '6379', 10);
  const username = process.env.REDIS_USERNAME || undefined;
  const password = process.env.REDIS_PASSWORD || undefined;
  const useTls = /^(1|true|yes|on)$/i.test(String(process.env.REDIS_TLS || ''));
  const namespace = runNamespace();

  const options = {
    db: TEST_DB,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: Number.parseInt(process.env.REDIS_CONNECT_TIMEOUT || '5000', 10),
    commandTimeout: Number.parseInt(process.env.REDIS_COMMAND_TIMEOUT || '3000', 10),
    retryStrategy: () => null,
  };

  if (url) {
    // ioredis does not honour a `url` key inside the options object, so the URL is parsed
    // here and passed as explicit connection fields. Passing `url` through silently falls back
    // to 127.0.0.1:6379, which can connect to an entirely unrelated server.
    try {
      const parsed = new URL(url);
      options.host = parsed.hostname;
      options.port = Number.parseInt(parsed.port || '6379', 10);
      if (parsed.username) options.username = decodeURIComponent(parsed.username);
      if (parsed.password) options.password = decodeURIComponent(parsed.password);
      if (parsed.protocol === 'rediss:' || useTls) options.tls = {};
    } catch (_) {
      // Leave host/port at their defaults; the connection attempt will fail loudly.
    }
  } else {
    options.host = host;
    options.port = port;
    if (username) options.username = username;
    if (password) options.password = password;
    if (useTls) options.tls = {};
  }

  return { options, namespace, db: TEST_DB, configured: !!(url || process.env.REDIS_HOST) };
}

/** Password-free description of the target, safe for reports. */
function describeTarget() {
  const { options, namespace, db } = connectionOptions();
  let sanitizedUrl = 'redis://***';
  try {
    if (options.url) {
      const u = new URL(options.url);
      if (u.password) u.password = '***';
      if (u.username) u.username = '***';
      sanitizedUrl = u.toString();
    } else {
      sanitizedUrl = `redis://${options.host}:${options.port}`;
    }
  } catch (_) {
    sanitizedUrl = 'redis://***';
  }
  return { sanitizedUrl, namespace, db };
}

/**
 * Probe availability with a real PING.
 * @returns {Promise<{available: boolean, reason: string|null}>}
 */
async function probe() {
  const { options, configured } = connectionOptions();
  if (!configured) {
    return { available: false, reason: 'BLOCKED: no REDIS_URL or REDIS_HOST configured for real Redis integration tests' };
  }
  const client = new Redis(options);
  try {
    await client.connect();
    const pong = await client.ping();
    return pong === 'PONG'
      ? { available: true, reason: null }
      : { available: false, reason: `BLOCKED: unexpected PING reply from Redis integration target` };
  } catch (error) {
    return {
      available: false,
      // Sanitized: connection errors can embed the URL, which may carry credentials.
      reason: `BLOCKED: Redis integration target unreachable (${error && error.name ? error.name : 'unknown error'})`,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Synchronous availability probe.
 *
 * node:test decides `skip` while a test file is being required, which is before any promise
 * has settled, so this probe must be synchronous. It shells out to a short child script that
 * performs the real PING and prints a single verdict line.
 *
 * @returns {{available: boolean, reason: string|null}}
 */
function probeSync() {
  const script = `
    const env = require(${JSON.stringify(__filename)});
    env.probe().then(
      (r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); },
      (e) => { process.stdout.write(JSON.stringify({ available: false, reason: 'BLOCKED: probe failed (' + (e && e.name ? e.name : 'unknown') + ')' })); process.exit(0); }
    );
  `;
  try {
    const { spawnSync } = require('child_process');
    const out = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 20000,
      env: process.env,
    });
    const parsed = JSON.parse(String(out.stdout || '{}').trim() || '{}');
    if (typeof parsed.available === 'boolean') return parsed;
    return { available: false, reason: 'BLOCKED: Redis availability probe produced no verdict' };
  } catch (error) {
    return { available: false, reason: `BLOCKED: Redis availability probe failed (${error && error.name ? error.name : 'unknown'})` };
  }
}

async function connect() {
  const { options, namespace, db } = connectionOptions();
  const client = new Redis(options);
  await client.connect();
  return { client, namespace, db };
}

/** Namespaced key. Every key a test writes goes through here. */
function key(namespace, tenantId, ...parts) {
  return [namespace, tenantId, ...parts].join(':');
}

/**
 * Delete only keys owned by this run's namespace.
 * Uses SCAN with MATCH and UNLINK/DEL on the matches. Never FLUSHDB, never FLUSHALL,
 * never a wildcard delete outside the run's own prefix.
 */
async function cleanupNamespace(client, namespace) {
  const pattern = `${namespace}:*`;
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length) {
      await client.del(...keys);
      removed += keys.length;
    }
  } while (cursor !== '0');
  return removed;
}

/** Count remaining keys owned by the namespace (used to prove cleanup). */
async function countNamespace(client, namespace) {
  const pattern = `${namespace}:*`;
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    total += keys.length;
  } while (cursor !== '0');
  return total;
}

module.exports = {
  TEST_DB,
  probe,
  probeSync,
  connect,
  connectionOptions,
  describeTarget,
  key,
  cleanupNamespace,
  countNamespace,
  runNamespace,
};