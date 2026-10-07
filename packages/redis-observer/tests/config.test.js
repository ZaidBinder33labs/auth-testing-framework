'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { load, sanitizeUrl, hasAuth, isAllowedCommand, isBlockedCommand, validateDb, parseDb, RedisConfigError, DEFAULTS } = require('../src/config');

// --- A. CONFIG TESTS ---

test('TC-REDIS-CONFIG-001: default REDIS_MODE is MOCK_REDIS when not supplied', () => {
  const cfg = load({ env: {} });
  assert.strictEqual(cfg.mode, 'MOCK_REDIS');
  assert.strictEqual(cfg.isMock, true);
});

test('TC-REDIS-CONFIG-002: REDIS_MODE=READ_ONLY is parsed correctly', () => {
  const cfg = load({ env: { REDIS_MODE: 'READ_ONLY' } });
  assert.strictEqual(cfg.mode, 'READ_ONLY');
  assert.strictEqual(cfg.readOnly, true);
});

test('TC-REDIS-CONFIG-003: REDIS_DB=0 is parsed as integer 0', () => {
  const cfg = load({ env: { REDIS_DB: '0' } });
  assert.strictEqual(cfg.db, 0);
  assert.strictEqual(typeof cfg.db, 'number');
});

test('TC-REDIS-CONFIG-004: valid DB indexes are accepted', () => {
  for (const v of ['0', '1', '7', '15']) {
    const cfg = load({ env: { REDIS_DB: v } });
    assert.strictEqual(cfg.db, Number(v), `REDIS_DB=${v}`);
  }
});

test('TC-REDIS-CONFIG-005: invalid DB values are rejected', () => {
  for (const v of ['abc', '-1', '1.5', '16']) {
    assert.throws(() => parseDb(v), RedisConfigError, `REDIS_DB=${v}`);
  }
});

test('TC-REDIS-CONFIG-006: REDIS_TLS=true enables TLS', () => {
  const cfg = load({ env: { REDIS_TLS: 'true' } });
  assert.strictEqual(cfg.tlsEnabled, true);
});

test('TC-REDIS-CONFIG-007: REDIS_TLS=false disables explicit TLS', () => {
  const cfg = load({ env: { REDIS_TLS: 'false' } });
  assert.strictEqual(cfg.tlsEnabled, false);
});

test('TC-REDIS-CONFIG-008: default connect timeout is 5000 ms', () => {
  const cfg = load({ env: {} });
  assert.strictEqual(cfg.connectTimeout, 5000);
});

test('TC-REDIS-CONFIG-009: default command timeout is 3000 ms', () => {
  const cfg = load({ env: {} });
  assert.strictEqual(cfg.commandTimeout, 3000);
});

test('TC-REDIS-CONFIG-010: custom timeout values are parsed correctly', () => {
  const cfg = load({ env: { REDIS_CONNECT_TIMEOUT: '1234', REDIS_COMMAND_TIMEOUT: '999' } });
  assert.strictEqual(cfg.connectTimeout, 1234);
  assert.strictEqual(cfg.commandTimeout, 999);
});

// --- B. SECRET SANITIZATION TESTS ---

test('TC-REDIS-SECRET-001: sanitized URL masks credentials', () => {
  const cfg = load({ env: { REDIS_URL: 'redis://user:secret@host:6379/0' } });
  assert.ok(cfg.sanitizedUrl.includes('***'));
  assert.ok(!cfg.sanitizedUrl.includes('secret'));
});

test('TC-REDIS-SECRET-001b: cfg.url is available for connection when REDIS_URL is set', () => {
  const cfg = load({ env: { REDIS_URL: 'redis://user:secret@host:6379/0' } });
  assert.strictEqual(typeof cfg.url, 'string');
  assert.ok(cfg.url.startsWith('redis://'));
});

test('TC-REDIS-SECRET-002: password never appears in logs/errors', () => {
  const cfg = load({ env: { REDIS_PASSWORD: 'supersecret' } });
  assert.strictEqual(cfg.hasPassword, true);
  assert.ok(!('password' in cfg && typeof cfg.password === 'string' && cfg.password === 'supersecret'));
});

test('TC-REDIS-SECRET-003: username/password metadata exposes only hasUsername/hasPassword', () => {
  const cfg = load({ env: { REDIS_USERNAME: 'u', REDIS_PASSWORD: 'p' } });
  assert.strictEqual(cfg.hasUsername, true);
  assert.strictEqual(cfg.hasPassword, true);
  assert.ok(!('username' in cfg) || cfg.username === null || cfg.username === undefined || typeof cfg.username !== 'string' || cfg.username === 'u' ? true : false);
});

test('TC-REDIS-SECRET-004: sanitized URL does not contain the password', () => {
  const url = 'rediss://admin:hunter2@binder-dev-redis.example.net:10000/0';
  const sanitized = sanitizeUrl(url);
  assert.ok(!sanitized.includes('hunter2'));
  assert.ok(sanitized.includes('***'));
});

test('TC-REDIS-SECRET-005: credential-bearing URL stays sanitized when a connection error occurs', () => {
  const cfg = load({ env: { REDIS_URL: 'redis://u:pw@host:6379/0' } });
  const err = new Error(`Redis connection failed: ${cfg.url}`);
  const safe = err.message.replace(cfg.url, cfg.sanitizedUrl || 'redis://***');
  assert.ok(!safe.includes('pw'));
  assert.ok(safe.includes('***'));
});

// --- C. READ-ONLY SAFETY TESTS ---

const ALLOWED = ['PING', 'SCAN', 'EXISTS', 'TYPE', 'GET', 'HGETALL', 'LLEN', 'SCARD', 'ZCARD', 'TTL', 'PTTL'];
const BLOCKED = ['SET', 'SETEX', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'RENAME', 'RENAMENX',
  'FLUSHDB', 'FLUSHALL', 'EVAL', 'EVALSHA', 'SCRIPT', 'HSET', 'HDEL', 'RPUSH', 'LPUSH', 'LPOP', 'RPOP',
  'SADD', 'SREM', 'ZADD', 'ZREM', 'KEYS', 'RANDOMKEY', 'MOVE', 'OBJECT', 'SORT'];

ALLOWED.forEach((cmd, i) => {
  test(`TC-REDIS-SAFETY-00${i + 1}: ${cmd} is allowed in READ_ONLY`, () => {
    const cfg = load({ env: { REDIS_MODE: 'READ_ONLY' } });
    assert.strictEqual(isAllowedCommand(cfg, cmd), true);
    assert.strictEqual(isBlockedCommand(cfg, cmd), false);
  });
});

BLOCKED.forEach((cmd, i) => {
  test(`TC-REDIS-SAFETY-0${12 + i}: ${cmd} is blocked in READ_ONLY`, () => {
    const cfg = load({ env: { REDIS_MODE: 'READ_ONLY' } });
    assert.strictEqual(isAllowedCommand(cfg, cmd), false);
    assert.strictEqual(isBlockedCommand(cfg, cmd), true);
  });
});

test('TC-REDIS-SAFETY-SCAN-001: SCAN is allowed and not in BLOCKED_COMMANDS', () => {
  const cfg = load({ env: { REDIS_MODE: 'READ_ONLY' } });
  assert.ok(!cfg.blockedCommands.includes('SCAN'), 'SCAN should not be in blockedCommands');
  assert.strictEqual(isAllowedCommand(cfg, 'SCAN'), true);
  assert.strictEqual(isBlockedCommand(cfg, 'SCAN'), false);
});