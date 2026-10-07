'use strict';
// Verifies the framework resolves nothing outside its own directory. Used as an acceptance
// check for the extraction: a framework that serves any application cannot reach into the
// application that happened to host it.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'reports', 'coverage']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const escapes = [];
const specRe = /require\((['"])(\.[^'"]+)\1\)/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = specRe.exec(src)) !== null) {
    const resolved = path.resolve(path.dirname(file), m[2]);
    if (!resolved.startsWith(ROOT)) escapes.push(`${path.relative(ROOT, file)}  ->  ${m[2]}`);
  }
}

console.log(`js files scanned            : ${files.length}`);
console.log(`requires outside the root   : ${escapes.length}`);
for (const e of escapes) console.log(`  ${e}`);
console.log(escapes.length === 0 ? 'PASS (framework is self-contained)' : 'FAIL (parent coupling remains)');
process.exit(escapes.length === 0 ? 0 : 1);
