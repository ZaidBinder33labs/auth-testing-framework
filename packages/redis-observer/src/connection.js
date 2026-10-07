'use strict';
// Generic Redis connection abstraction.
// - TLS support via rediss:// or explicit REDIS_TLS
// - REDIS_URL support (credentials parsed, never logged)
// - optional username/password
// - DB selection
// - connect/command timeouts
// - safe error messages (no credentials)
// - NO automatic reconnect loop during tests
// - NO connection during module import
let Redis;
  try { Redis = require('ioredis'); } catch (_) { Redis = null; }

  const { load: loadConfig, sanitizeUrl, RedisConfigError, isAllowedCommand } = require('./config');

  const READ_ONLY_COMMANDS = new Set([
    'PING', 'SCAN', 'EXISTS', 'TYPE', 'GET', 'HGETALL', 'LLEN', 'SCARD', 'ZCARD', 'TTL', 'PTTL',
  ]);

class RedisConnectionError extends Error {
  constructor(message, { code, sanitizedUrl } = {}) {
    super(message);
    this.name = 'RedisConnectionError';
    this.code = code || 'REDIS_CONNECTION_ERROR';
    this.sanitizedUrl = sanitizedUrl || null;
  }
}

function safeErrorMessage(err, cfg) {
  const base = err && err.message ? err.message : String(err);
  // Never include credentials.
  if (cfg && cfg.url) {
    return base.replace(cfg.url, cfg.sanitizedUrl || 'redis://***');
  }
  return base;
}

class RedisConnection {
  constructor(cfg, opts = {}) {
    if (!cfg) throw new RedisConnectionError('RedisConfig is required', { code: 'NO_CONFIG' });
    this.cfg = cfg;
    this.opts = opts;
    this.client = null;
    this._connected = false;
    this._connectPromise = null;
  }

  _buildOptions() {
    const o = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // no automatic reconnect
      connectTimeout: this.cfg.connectTimeout,
      commandTimeout: this.cfg.commandTimeout,
      db: this.cfg.db,
    };
    if (this.cfg.tlsEnabled) {
      o.tls = {};
      if (this.cfg.hasCA) {
        try { o.tls.ca = require('fs').readFileSync(this.cfg.ca, 'utf8'); } catch (_) { /* ignore */ }
      }
    }
    return o;
  }

  _createClient() {
    if (!Redis) throw new RedisConnectionError('ioredis is not installed', { code: 'NO_IOREDIS' });
    const url = this.cfg.url;
    if (url) {
      const c = new Redis(url, this._buildOptions());
      return c;
    }
    throw new RedisConnectionError('REDIS_URL is required', { code: 'NO_URL' });
  }

  async connect() {
    if (this._connected) return this.client;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = (async () => {
      try {
        this.client = this._createClient();
        // ioredis with lazyConnect: connect explicitly.
        if (typeof this.client.connect === 'function') {
          await this.client.connect();
        }
        this._connected = true;
        return this.client;
      } catch (err) {
        this._connected = false;
        this.client = null;
        throw new RedisConnectionError(
          safeErrorMessage(err, this.cfg),
          { code: 'CONNECT_FAILED', sanitizedUrl: this.cfg.sanitizedUrl }
        );
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  async ping() {
    if (!this._connected) await this.connect();
    try {
      const r = await this.client.ping();
      return r === 'PONG' ? 'PONG' : r;
    } catch (err) {
      throw new RedisConnectionError(safeErrorMessage(err, this.cfg), { code: 'PING_FAILED', sanitizedUrl: this.cfg.sanitizedUrl });
    }
  }

  async disconnect() {
    if (!this.client) { this._connected = false; return true; }
    try {
      if (typeof this.client.quit === 'function') await this.client.quit();
      else if (typeof this.client.disconnect === 'function') await this.client.disconnect();
    } catch (err) {
      // Ignore disconnect errors; force closed.
    }
    this._connected = false;
    this.client = null;
    return true;
  }

  isConnected() {
    return this._connected && !!this.client;
  }

  getClient() {
    if (!this.client) {
      throw new RedisConnectionError('Redis client not initialized; call connect() first', { code: 'NOT_INITIALIZED' });
    }
    return this.client;
  }

  /** Run a command after READ_ONLY enforcement. Throws REDIS_MUTATION_BLOCKED for disallowed commands. */
  async command(name, ...args) {
    if (this.cfg.readOnly && !isAllowedCommand(this.cfg, String(name).toUpperCase())) {
      const err = new Error(`Redis mutation blocked: ${name} (REDIS_MODE=READ_ONLY)`);
      err.code = 'REDIS_MUTATION_BLOCKED';
      throw err;
    }
    if (!this._connected) await this.connect();
    return this.client[name](...args);
  }

  static create(cfg) {
    return new RedisConnection(cfg || loadConfig());
  }

  static load(opts = {}) {
    return loadConfig(opts);
  }
}

module.exports = { RedisConnection, RedisConnectionError, safeErrorMessage };