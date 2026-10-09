#!/usr/bin/env node
const fs = require('node:fs');
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const b64 = s.trim();
  fs.writeFileSync('manifests/tmp-slice.b64', b64);
  fs.writeFileSync(
    'manifests/tmp-poll.json',
    JSON.stringify({ sliceB64: b64, generating: false, juCount: 24 }),
  );
  console.log(JSON.stringify({ b64Len: b64.length }));
});
