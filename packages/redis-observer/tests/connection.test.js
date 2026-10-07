'use strict';
// Connection tests using a fake/mock Redis client. No real DEV Redis required.
const test = require('node:test');
const assert = require('node:assert');
const { RedisConnection, RedisConnectionError } = require('../src/connection');
const { load } = require('../src/config');

class FakeClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.connected = false;
    this.closed = false;
    this.calls = [];
    this.failConnect = opts.failConnect || null;
    this.failPing = opts.failPing || null;
    this.pingResult = opts.pingResult || 'PONG';
  }
  async connect() {
    this.calls.push('connect');
    if (this.failConnect) throw this.failConnect;
    this.connected = true;
  }
  async ping() {
    this.calls.push('ping');
    if (this.failPing) throw this.failPing;
    return this.pingResult;
  }
  async quit() {
    this.calls.push('quit');
    this.closed = true;
    this.connected = false;
  }
  async disconnect() {
    this.calls.push('disconnect');
    this.closed = true;
    this.connected = false;
  }
}

function makeConn(opts = {}) {
  const cfg = load({ env: { REDIS_MODE: 'READ_ONLY', ...opts.cfg } });
  const conn = new RedisConnection(cfg);
  // Inject fake client.
  conn._createClient = () => opts.client || new FakeClient(opts);
  return conn;
}

test('TC-REDIS-CONNECTION-001: connection object does not connect automatically', async () => {
  const conn = makeConn();
  assert.strictEqual(conn.isConnected(), false);
  assert.strictEqual(conn.client, null);
});

test('TC-REDIS-CONNECTION-002: connect() invokes the client connection', async () => {
  const fake = new FakeClient();
  const conn = makeConn({ client: fake });
  await conn.connect();
  assert.ok(fake.calls.includes('connect'));
  assert.strictEqual(conn.isConnected(), true);
});

test('TC-REDIS-CONNECTION-003: ping() returns successful PONG', async () => {
  const fake = new FakeClient({ pingResult: 'PONG' });
  const conn = makeConn({ client: fake });
  await conn.connect();
  const r = await conn.ping();
  assert.strictEqual(r, 'PONG');
});

test('TC-REDIS-CONNECTION-004: connection error is converted into a safe deterministic error', async () => {
  const fake = new FakeClient({ failConnect: new Error('connect boom') });
  const conn = makeConn({ client: fake, cfg: { REDIS_URL: 'redis://u:pw@host:6379/0' } });
  await assert.rejects(() => conn.connect(), (e) => {
    assert.ok(e instanceof RedisConnectionError);
    assert.strictEqual(e.code, 'CONNECT_FAILED');
    assert.ok(!e.message.includes('pw'));
    return true;
  });
});

test('TC-REDIS-CONNECTION-005: connection timeout is handled', async () => {
  const fake = new FakeClient({ failConnect: Object.assign(new Error('connect timed out'), { code: 'ECONN Timed Out' }) });
  const conn = makeConn({ client: fake, cfg: { REDIS_CONNECT_TIMEOUT: '50' } });
  await assert.rejects(() => conn.connect(), RedisConnectionError);
});

test('TC-REDIS-CONNECTION-006: disconnect() closes the client cleanly', async () => {
  const fake = new FakeClient();
  const conn = makeConn({ client: fake });
  await conn.connect();
  assert.strictEqual(conn.isConnected(), true);
  await conn.disconnect();
  assert.strictEqual(conn.isConnected(), false);
  assert.ok(fake.closed);
});

test('TC-REDIS-CONNECTION-007: isConnected() reports correct state', async () => {
  const fake = new FakeClient();
  const conn = makeConn({ client: fake });
  assert.strictEqual(conn.isConnected(), false);
  await conn.connect();
  assert.strictEqual(conn.isConnected(), true);
  await conn.disconnect();
  assert.strictEqual(conn.isConnected(), false);
});

test('TC-REDIS-CONNECTION-008: getClient() returns the underlying client only after initialization', async () => {
  const fake = new FakeClient();
  const conn = makeConn({ client: fake });
  assert.throws(() => conn.getClient(), RedisConnectionError);
  await conn.connect();
  assert.strictEqual(conn.getClient(), fake);
});

test('TC-REDIS-CONNECTION-009: cfg.url is set when REDIS_URL env is provided', () => {
  const cfg = load({ env: { REDIS_MODE: 'READ_ONLY', REDIS_URL: 'redis://host:6379/0' } });
  assert.strictEqual(typeof cfg.url, 'string');
});