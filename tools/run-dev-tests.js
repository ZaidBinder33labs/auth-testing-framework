'use strict';
// Explicitly-invoked runner for real DEV Redis tests.
// These tests require REDIS_MODE=READ_ONLY and REDIS_URL set in the environment.
// They are NOT part of `npm run test:all`.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function findDevFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.dev.spec.js') || entry.name.endsWith('.dev.test.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function main() {
  const root = path.join(__dirname, '..');
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('Usage: node tools/run-dev-tests.js <dir> [dir ...]');
    process.exit(2);
  }
  const files = [];
  for (const d of dirs) {
    const full = path.isAbsolute(d) ? d : path.join(root, d);
    if (fs.existsSync(full)) files.push(...findDevFiles(full));
  }
  if (!files.length) {
    console.error(`No DEV test files found under: ${dirs.join(', ')}`);
    process.exit(1);
  }
  const child = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
  process.exit(child.status || 0);
}

main();