'use strict';
// Minimal generic Redis configuration layer.
// Reads values from environment variables only. Never exposes credentials.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  REDIS_MODE: 'MOCK_REDIS',
  REDIS_DB: 0,
  REDIS_TLS: true,
  REDIS_CONNECT_TIMEOUT: 5000,
  REDIS_COMMAND_TIMEOUT: 3000,
};

const ALLOWED_COMMANDS = Object.freeze([
  'PING', 'SCAN', 'EXISTS', 'TYPE', 'GET', 'HGETALL', 'LLEN', 'SCARD', 'ZCARD', 'TTL', 'PTTL',
]);

const BLOCKED_COMMANDS = Object.freeze([
  'SET', 'SETEX', 'SETEX', 'SETEX', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST',
  'RENAME', 'RENAMENX', 'FLUSHDB', 'FLUSHALL', 'EVAL', 'EVALSHA', 'SCRIPT',
  'HSET', 'HDEL', 'RPUSH', 'LPUSH', 'LPOP', 'RPOP', 'SADD', 'SREM', 'ZADD', 'ZREM',
  'KEYS', 'RANDOMKEY', 'MOVE', 'OBJECT', 'SORT',
]);

function readEnvFile(dir) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

class RedisConfigError extends Error {
  constructor(message, { code, field } = {}) {
    super(message);
    this.name = 'RedisConfigError';
    this.code = code || 'REDIS_CONFIG_ERROR';
    this.field = field || null;
  }
}

function validateDb(db, field = 'REDIS_DB') {
  if (typeof db !== 'number' || !Number.isInteger(db) || db < 0 || db > 15) {
    throw new RedisConfigError(`invalid ${field}: ${db} (must be integer 0-15)`, { code: 'INVALID_DB', field });
  }
  return db;
}

function parseDb(v, field = 'REDIS_DB') {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return validateDb(v, field);
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) {
    throw new RedisConfigError(`invalid ${field}: ${v} (must be integer 0-15)`, { code: 'INVALID_DB', field });
  }
  return validateDb(Number.parseInt(s, 10), field);
}

function parseTimeout(v, d, field) {
  const n = int(v, d);
  if (!Number.isFinite(n) || n < 0) {
    throw new RedisConfigError(`invalid ${field}: ${v} (must be >= 0)`, { code: 'INVALID_TIMEOUT', field });
  }
  return n;
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch (_) {
    return 'redis://***';
  }
}

function hasAuth(url) {
  if (!url) return false;
  try { return !!(new URL(url).password || new URL(url).username); } catch (_) { return false; }
}

function load(opts = {}) {
  const root = path.join(__dirname, '..', '..', '..');
  const envFile = readEnvFile(root);
  const env = opts.env || { ...envFile, ...process.env };

  const mode = String(env.REDIS_MODE || DEFAULTS.REDIS_MODE).toUpperCase();
  const validModes = ['MOCK_REDIS', 'READ_ONLY', 'DEDICATED_TEST_REDIS', 'TEST_NAMESPACE'];
  if (!validModes.includes(mode)) {
    throw new RedisConfigError(`invalid REDIS_MODE: ${env.REDIS_MODE} (expected one of ${validModes.join(', ')})`, { code: 'INVALID_MODE', field: 'REDIS_MODE' });
  }

  const db = parseDb(env.REDIS_DB, 'REDIS_DB');
  const tlsEnabled = bool(env.REDIS_TLS, DEFAULTS.REDIS_TLS);
  const connectTimeout = parseTimeout(env.REDIS_CONNECT_TIMEOUT, DEFAULTS.REDIS_CONNECT_TIMEOUT, 'REDIS_CONNECT_TIMEOUT');
  const commandTimeout = parseTimeout(env.REDIS_COMMAND_TIMEOUT, DEFAULTS.REDIS_COMMAND_TIMEOUT, 'REDIS_COMMAND_TIMEOUT');
  const url = env.REDIS_URL || null;
  const username = env.REDIS_USERNAME || null;
  const password = env.REDIS_PASSWORD || null;
  const ca = env.REDIS_CA || null;
  const namespace = env.REDIS_NAMESPACE || null;

  const cfg = Object.freeze({
    mode,
    db,
    tlsEnabled,
    hasCA: !!ca,
    connectTimeout,
    commandTimeout,
    namespace,
    hasUrl: !!url,
    hasUsername: !!username,
    hasPassword: !!password,
    readOnly: mode === 'READ_ONLY',
    allowMutations: mode !== 'READ_ONLY' && mode !== 'MOCK_REDIS',
    isMock: mode === 'MOCK_REDIS',
    sanitizedUrl: sanitizeUrl(url),
    url,
    ca,
    allowedCommands: ALLOWED_COMMANDS,
    blockedCommands: BLOCKED_COMMANDS,
  });

  return cfg;
}

function isAllowedCommand(cfg, command) {
  if (!cfg.readOnly) return true;
  return ALLOWED_COMMANDS.includes(String(command).toUpperCase());
}

function isBlockedCommand(cfg, command) {
  if (!cfg.readOnly) return false;
  return !ALLOWED_COMMANDS.includes(String(command).toUpperCase());
}

module.exports = {
  load,
  sanitizeUrl,
  hasAuth,
  isAllowedCommand,
  isBlockedCommand,
  validateDb,
  parseDb,
  RedisConfigError,
  DEFAULTS,
  ALLOWED_COMMANDS,
  BLOCKED_COMMANDS,
};