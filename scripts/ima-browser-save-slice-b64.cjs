#!/usr/bin/env node
/** Read base64 slice from stdin, write manifests/tmp-slice.b64 and tmp-text-parts.json */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let b64 = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { b64 += d; });
process.stdin.on('end', () => {
  b64 = b64.trim();
  const slice = Buffer.from(b64, 'base64').toString('utf8');
  const dir = path.join(root, 'manifests');
  fs.writeFileSync(path.join(dir, 'tmp-slice.b64'), b64);
  const j = { p0: slice.slice(0, 2500), p1: slice.slice(2500, 5000), p2: slice.slice(5000) };
  fs.writeFileSync(path.join(dir, 'tmp-text-parts.json'), JSON.stringify(j));
  console.log(JSON.stringify({ sliceLen: slice.length, ju: (slice.match(/据该文件/g) || []).length }));
});
