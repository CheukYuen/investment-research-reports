#!/usr/bin/env node
/** Write sliceB64 from argv or stdin JSON {sliceB64} and import. */
const fs = require('node:fs');
const path = require('node:path');
const { prepareAnswerFile, importAnswer } = require('./ima-browser-batch-utils.cjs');

const date = process.argv[2];
const out = process.argv[3] || path.join(__dirname, '..', 'manifests', 'tmp-manual-answer-import.txt');
if (!date || !/^\d{8}$/.test(date)) {
  console.error('usage: ima-browser-import-slice.cjs YYYYMMDD [out.txt] < slice.json');
  process.exit(1);
}
let b64 = process.argv[4];
if (!b64) {
  const raw = fs.readFileSync(0, 'utf8');
  const j = JSON.parse(raw);
  b64 = j.sliceB64 || j;
}
const slice = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
prepareAnswerFile(slice, out);
console.log(JSON.stringify(importAnswer(out, date)));
