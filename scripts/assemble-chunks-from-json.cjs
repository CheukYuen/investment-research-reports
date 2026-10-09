#!/usr/bin/env node
const fs = require('node:fs');
const path = process.argv[2] || 'manifests/tmp-chunks.json';
const raw = fs.readFileSync(path, 'utf8');
let b64;
if (raw.trim().startsWith('[')) {
  b64 = JSON.parse(raw).join('');
} else {
  b64 = '';
  for (let i = 0; ; i++) {
    const p = `manifests/tmp-chunk-${i}.b64`;
    if (!fs.existsSync(p)) break;
    b64 += fs.readFileSync(p, 'utf8');
  }
}
fs.writeFileSync('manifests/tmp-slice.b64', b64);
fs.writeFileSync(
  'manifests/tmp-poll.json',
  JSON.stringify({ sliceB64: b64, generating: false, juCount: 24 }),
);
console.log(JSON.stringify({ b64Len: b64.length }));
