#!/usr/bin/env node
/** Append one CDP b64 part from argv file (avoids shell escaping). */
const fs = require('node:fs');
const part = fs.readFileSync(process.argv[2], 'utf8').trim();
fs.appendFileSync('manifests/tmp-slice.b64', part);
console.log(JSON.stringify({ partLen: part.length, total: fs.statSync('manifests/tmp-slice.b64').size }));
