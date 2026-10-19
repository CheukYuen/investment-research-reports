#!/usr/bin/env node
/** Join manifests/tmp-b64-chunk*.txt → import-cdp-text-parts */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const date = process.argv[2] || '20261017';
const dir = path.join(__dirname, '..', 'manifests');
const parts = [];
for (let i = 0; i < 10; i++) {
  const p = path.join(dir, `tmp-b64-chunk${i}.txt`);
  if (!fs.existsSync(p)) break;
  parts.push(fs.readFileSync(p, 'utf8').trim());
}
if (!parts.length) {
  console.error('no tmp-b64-chunk*.txt');
  process.exit(1);
}
const slice = Buffer.from(parts.join(''), 'base64').toString('utf8');
const j = { p0: slice.slice(0, 2500), p1: slice.slice(2500, 5000), p2: slice.slice(5000) };
const jsonPath = path.join(dir, 'tmp-text-parts.json');
fs.writeFileSync(jsonPath, JSON.stringify(j));
console.log(JSON.stringify({ sliceLen: slice.length, ju: (slice.match(/据该文件/g) || []).length }));
const root = path.join(__dirname, '..');
execFileSync('node', ['scripts/import-cdp-text-parts.cjs', date, jsonPath], { cwd: root, stdio: 'inherit' });
