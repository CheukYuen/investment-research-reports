#!/usr/bin/env node
const fs = require('node:fs');
const [, , b64File, outFile] = process.argv;
if (!b64File || !outFile) {
  console.error('usage: node ima-decode-b64-to-slice.cjs <b64.txt> <out.txt>');
  process.exit(1);
}
const b64 = fs.readFileSync(b64File, 'utf8').replace(/\s/g, '');
fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
console.log('wrote', outFile, fs.statSync(outFile).size, 'bytes');
