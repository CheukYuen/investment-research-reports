#!/usr/bin/env node
const fs = require('node:fs');
const part = process.argv[2];
if (!part) {
  console.error('usage: cdp-append-b64-chunk.cjs <b64-part>');
  process.exit(1);
}
fs.appendFileSync('manifests/tmp-slice.b64', part);
console.log(JSON.stringify({ appended: part.length, total: fs.statSync('manifests/tmp-slice.b64').size }));
