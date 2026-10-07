'use strict';
// Rate-limit configuration.
// Defaults come from the environment; per-environment overrides are loaded from
// config/environments/<ENV>.json when RATE_LIMIT_ENV is set.
// Nothing here exposes secrets.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  USER_RATE_LIMIT_PER_MIN: 300,
  OFFICE_RATE_LIMIT_PER_MIN: 1200,
  LOGIN_RATE_LIMIT_PER_MIN: 60,
  PASSWORD_RESET_RATE_LIMIT_PER_MIN: 30,
  PUBLIC_FORM_RATE_LIMIT_PER_MIN: 60,
  WINDOW_MS: 60000,
  TTL_TOLERANCE_MS: 3000,
  RATE_LIMIT_ENV: 'dev',
  RATE_LIMIT_MODE: 'MOCK_REDIS',
  RATE_LIMIT_KEY_PREFIX: 'rl',
  RATE_LIMIT_IP_NORMALIZE_V6: '/64',
};

function int(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function loadEnvFile(dir) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function load() {
  const root = path.join(__dirname, '..', '..');
  const envFile = loadEnvFile(root);
  const env = { ...envFile, ...process.env };
  const cfg = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    cfg[k] = env[k] !== undefined && env[k] !== '' ? env[k] : def;
  }
  // Numeric fields
  for (const k of [
    'USER_RATE_LIMIT_PER_MIN', 'OFFICE_RATE_LIMIT_PER_MIN', 'LOGIN_RATE_LIMIT_PER_MIN',
    'PASSWORD_RESET_RATE_LIMIT_PER_MIN', 'PUBLIC_FORM_RATE_LIMIT_PER_MIN', 'WINDOW_MS', 'TTL_TOLERANCE_MS',
  ]) cfg[k] = int(cfg[k], DEFAULTS[k]);
  cfg.RATE_LIMIT_ENV = String(cfg.RATE_LIMIT_ENV).toLowerCase();
  cfg.RATE_LIMIT_MODE = String(cfg.RATE_LIMIT_MODE).toUpperCase();
  cfg.RATE_LIMIT_KEY_PREFIX = String(cfg.RATE_LIMIT_KEY_PREFIX).replace(/[^a-z0-9:_-]/gi, '').toLowerCase() || 'rl';
  cfg.RATE_LIMIT_IP_NORMALIZE_V6 = String(cfg.RATE_LIMIT_IP_NORMALIZE_V6 || '/64').toLowerCase();

  // Per-environment overrides
  const envPath = path.join(root, 'config', 'environments', `${cfg.RATE_LIMIT_ENV}.json`);
  if (fs.existsSync(envPath)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (overrides[k] !== undefined) cfg[k] = overrides[k];
      }
      for (const k of ['USER_RATE_LIMIT_PER_MIN', 'OFFICE_RATE_LIMIT_PER_MIN', 'LOGIN_RATE_LIMIT_PER_MIN',
        'PASSWORD_RESET_RATE_LIMIT_PER_MIN', 'PUBLIC_FORM_RATE_LIMIT_PER_MIN', 'WINDOW_MS', 'TTL_TOLERANCE_MS']) {
        cfg[k] = int(cfg[k], DEFAULTS[k]);
      }
    } catch (_) { /* ignore malformed env file */ }
  }
  return Object.freeze(cfg);
}

module.exports = { load, DEFAULTS };