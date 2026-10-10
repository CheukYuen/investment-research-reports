#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const date = process.argv[2];
const root = path.resolve(__dirname, '..');
let b64 = '';
for (let i = 0; ; i++) {
  const p = path.join(root, 'manifests', `b64-c${i}.txt`);
  if (!fs.existsSync(p)) break;
  b64 += fs.readFileSync(p, 'utf8');
}
if (!b64) {
  console.error('no manifests/b64-c*.txt');
  process.exit(1);
}
const b64Path = path.join(root, 'manifests', 'tmp-slice.b64');
const outPath = path.join(root, 'manifests', `tmp-import-${date}.txt`);
fs.writeFileSync(b64Path, b64);
const out = execFileSync(
  'node',
  ['scripts/ima-browser-batch-utils.cjs', 'import-b64', date, b64Path, outPath],
  { cwd: root, encoding: 'utf8' },
);
console.log(out.trim());
