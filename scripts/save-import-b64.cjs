#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const date = process.argv[2];
if (!/^\d{8}$/.test(date || '')) {
  console.error('usage: node scripts/save-import-b64.cjs YYYYMMDD <b64-on-stdin>');
  process.exit(1);
}
let b64 = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { b64 += d; });
process.stdin.on('end', () => {
  const root = path.resolve(__dirname, '..');
  const b64Path = path.join(root, 'manifests', 'tmp-slice.b64');
  const outPath = path.join(root, 'manifests', `tmp-import-${date}.txt`);
  fs.writeFileSync(b64Path, b64.trim());
  const out = execFileSync(
    'node',
    ['scripts/ima-browser-batch-utils.cjs', 'import-b64', date, b64Path, outPath],
    { cwd: root, encoding: 'utf8' },
  );
  console.log(out.trim());
});
