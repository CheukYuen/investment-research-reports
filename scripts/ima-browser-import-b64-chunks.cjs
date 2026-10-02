#!/usr/bin/env node
/** Assemble sliceB64 from chunk files and import. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const date = process.argv[2] || '20261001';
const dir = path.join(__dirname, '..', 'manifests');
const parts = ['tmp-b64-chunk0.txt', 'tmp-b64-chunk1.txt', 'tmp-b64-chunk2.txt']
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim())
  .filter(Boolean);
const b64 = parts.join('');
const slicePath = path.join(dir, 'tmp-slice.b64');
fs.writeFileSync(slicePath, b64);
const root = path.join(__dirname, '..');
execFileSync('node', ['scripts/ima-browser-batch-utils.cjs', 'import-b64', date, slicePath], {
  cwd: root,
  stdio: 'inherit',
});
