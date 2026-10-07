'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { RefreshLock, parallelLimit, waitForRace } = require('../src');

test('concurrency: lock is acquired immediately when free', async () => {
  const lock = new RefreshLock();
  const r = await lock.acquire('k', 'owner1');
  assert.strictEqual(r.acquired, true);
  assert.strictEqual(r.waitedMs, 0);
  assert.strictEqual(lock.isHeld('k'), true);
  lock.release('k', 'owner1');
  assert.strictEqual(lock.isHeld('k'), false);
});

test('concurrency: second owner waits for first', async () => {
  const lock = new RefreshLock({ timeoutMs: 5000 });
  // Hold the lock briefly, then release.
  const r1 = await lock.acquire('k', 'a');
  assert.strictEqual(r1.acquired, true);
  const secondPromise = lock.acquire('k', 'b');
  // Let the waiter start polling.
  await new Promise((r) => setTimeout(r, 30));
  lock.release('k', 'a');
  const result = await secondPromise;
  assert.strictEqual(result.acquired, true);
  assert.ok(result.waitedMs >= 0);
  lock.release('k', 'b');
});

test('concurrency: withLock releases on success and failure', async () => {
  const lock = new RefreshLock();
  await lock.withLock('k', 'o', async () => 'ok');
  assert.strictEqual(lock.isHeld('k'), false);
  await assert.rejects(() => lock.withLock('k', 'o', async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(lock.isHeld('k'), false);
});

test('concurrency: parallelLimit respects concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 10 }, (_, i) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return i;
  });
  const results = await parallelLimit(tasks, 3);
  assert.strictEqual(results.length, 10);
  assert.strictEqual(results[0], 0);
  assert.strictEqual(results[9], 9);
  assert.ok(maxActive <= 3, `maxActive=${maxActive}`);
});

test('concurrency: parallelLimit propagates errors', async () => {
  const tasks = [async () => 1, async () => { throw new Error('fail'); }, async () => 3];
  await assert.rejects(() => parallelLimit(tasks, 2), /fail/);
});

test('concurrency: parallelLimit handles empty array', async () => {
  const results = await parallelLimit([], 5);
  assert.deepStrictEqual(results, []);
});

test('concurrency: waitForRace resolves on predicate', async () => {
  let count = 0;
  const result = await waitForRace(async () => { count += 1; return count >= 3 ? 'done' : null; }, { timeout: 2000, pollInterval: 10 });
  assert.strictEqual(result, 'done');
  assert.ok(count >= 3);
});

test('concurrency: waitForRace times out', async () => {
  await assert.rejects(() => waitForRace(async () => null, { timeout: 100, pollInterval: 10 }), /RACE_TIMEOUT/);
});