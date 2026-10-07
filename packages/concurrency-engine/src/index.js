'use strict';
// Concurrency primitives: shared refresh lock and controlled parallel execution.
// The lock is per-key, reentrant-safe for the same owner, and always released.

class RefreshLock {
  constructor(opts = {}) {
    this.timeoutMs = Number(opts.timeoutMs || 5000);
    this._locks = new Map(); // key -> { owner, heldAt }
  }

  async acquire(key, owner) {
    const id = owner || `owner_${Math.random().toString(36).slice(2, 8)}`;
    const existing = this._locks.get(key);
    if (!existing || existing.owner === id) {
      this._locks.set(key, { owner: id, heldAt: Date.now() });
      return { acquired: true, owner: id, waitedMs: 0 };
    }
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const cur = this._locks.get(key);
        const elapsed = Date.now() - start;
        if (!cur || cur.owner === id) {
          this._locks.set(key, { owner: id, heldAt: Date.now() });
          resolve({ acquired: true, owner: id, waitedMs: elapsed });
          return;
        }
        if (elapsed >= this.timeoutMs) {
          resolve({ acquired: false, owner: id, waitedMs: elapsed, reason: 'TIMEOUT' });
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  release(key, owner) {
    const cur = this._locks.get(key);
    if (cur && cur.owner === owner) {
      this._locks.delete(key);
      return true;
    }
    return false;
  }

  isHeld(key) {
    return this._locks.has(key);
  }

  async withLock(key, owner, fn) {
    const got = await this.acquire(key, owner);
    if (!got.acquired) {
      const err = new Error(`refresh lock timeout for ${key}`);
      err.code = 'LOCK_TIMEOUT';
      throw err;
    }
    try {
      return await fn();
    } finally {
      this.release(key, owner);
    }
  }
}

/** Run N async operations with a concurrency limit. */
async function parallelLimit(tasks, limit, opts = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const max = Math.max(1, Math.min(Number(limit) || 1, tasks.length));
  const results = new Array(tasks.length);
  let next = 0;
  let firstError = null;

  await new Promise((resolve, reject) => {
    let inFlight = 0;
    let done = false;
    const pump = () => {
      if (done) return;
      while (inFlight < max && next < tasks.length && !firstError) {
        const i = next++;
        inFlight += 1;
        tasks[i]().then((v) => {
          results[i] = v;
        }).catch((e) => {
          if (firstError === null) firstError = e;
        }).finally(() => {
          inFlight -= 1;
          if (firstError || next >= tasks.length) {
            if (firstError) { done = true; return resolve(); }
            if (inFlight === 0) { done = true; return resolve(); }
          }
          pump();
        });
      }
      if (inFlight === 0 || firstError) {
        if (firstError) return resolve();
        if (next >= tasks.length && inFlight === 0) return resolve();
      }
    };
    pump();
  });

  if (firstError) throw firstError;
  return results;
}

/** Controlled race: resolve when the first predicate matches or timeout. */
async function waitForRace(predicate, opts = {}) {
  const { timeout = 5000, pollInterval = 100 } = opts;
  const start = Date.now();
  while (true) {
    const r = await predicate();
    if (r) return r;
    if (Date.now() - start >= timeout) {
      const err = new Error(`waitForRace timed out (code RACE_TIMEOUT)`);
      err.code = 'RACE_TIMEOUT';
      throw err;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

module.exports = { RefreshLock, parallelLimit, waitForRace };