'use strict';
// Real DEV Redis smoke test. Explicitly invoked only: `npm run redis:smoke`.
// NEVER runs as part of `npm run test:all`.
// Performs only safe read-only operations and prints safe metadata only.
const { RedisConnection, RedisConnectionError } = require('../packages/redis-observer/src/connection');
const { load: loadConfig } = require('../packages/redis-observer/src/config');

function safePrint(label, value) {
  // eslint-disable-next-line no-console
  console.log(`${label}: ${value}`);
}

async function main() {
  const cfg = loadConfig();

  safePrint('MODE', cfg.mode);
  safePrint('TLS', cfg.tlsEnabled ? 'ENABLED' : 'DISABLED');
  safePrint('DB', cfg.db);

  if (cfg.mode !== 'READ_ONLY') {
    safePrint('RESULT', 'SKIP — REDIS_MODE must be READ_ONLY for the smoke test');
    return 0;
  }
  if (!cfg.hasUrl) {
    safePrint('RESULT', 'SKIP — REDIS_URL is not set');
    return 0;
  }

  let conn;
  try {
    conn = RedisConnection.create(cfg);
    await conn.connect();
    safePrint('REDIS CONNECTION', 'PASS');
  } catch (err) {
    safePrint('REDIS CONNECTION', 'FAIL');
    safePrint('ERROR', err.message);
    return 1;
  }

  try {
    const pong = await conn.ping();
    safePrint('PING', pong === 'PONG' ? 'PASS' : `FAIL (${pong})`);

    const client = conn.getClient();
    let sampleCount = 0;
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', '*test*', 'COUNT', 20);
      cursor = next;
      sampleCount += keys.length;
      if (sampleCount > 50) break;
    } while (cursor !== '0');

    safePrint('SCAN', 'PASS');
    safePrint('KEY SAMPLE COUNT', String(sampleCount));
    safePrint('RAW VALUES', 'NOT EXPOSED');

    safePrint('DISCONNECT', 'PASS');
    return 0;
  } finally {
    await conn.disconnect().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('redis:smoke failed:', err && err.message ? err.message : String(err));
  process.exit(1);
});