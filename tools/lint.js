'use strict';
// Lint tool: runs eslint across the framework if available.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const result = spawnSync('npx', ['eslint', 'packages', 'tests', '--ext', '.js'], { stdio: 'inherit', cwd: root, shell: true });
process.exit(result.status || 0);