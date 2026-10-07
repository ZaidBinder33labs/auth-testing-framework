'use strict';
// Test runner: discovers *.test.js / *.spec.js files under given directories and
// runs them with node's native test runner.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function findTestFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if ((entry.name.endsWith('.spec.js') || entry.name.endsWith('.test.js')) && !entry.name.endsWith('.dev.spec.js') && !entry.name.endsWith('.dev.test.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function main() {
  const root = path.join(__dirname, '..');
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('Usage: node tools/run-tests.js <dir> [dir ...]');
    process.exit(2);
  }
  const files = [];
  for (const d of dirs) {
    const full = path.isAbsolute(d) ? d : path.join(root, d);
    if (!fs.existsSync(full)) continue;
    // A directory is walked; an explicit file path is taken as-is, so a suite can target a
    // single spec instead of only whole directories.
    if (fs.statSync(full).isDirectory()) files.push(...findTestFiles(full));
    else if (/\.(spec|test)\.js$/.test(full)) files.push(full);
  }
  if (!files.length) {
    console.error(`No test files found under: ${dirs.join(', ')}`);
    process.exit(1);
  }
  const child = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
  process.exit(child.status || 0);
}

main();