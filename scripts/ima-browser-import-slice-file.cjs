#!/usr/bin/env node
const fs = require('node:fs');
const { prepareAnswerFile, importAnswer } = require('./ima-browser-batch-utils.cjs');
const date = process.argv[2];
const slicePath = process.argv[3];
if (!/^\d{8}$/.test(date || '') || !slicePath) {
  console.error('usage: node scripts/ima-browser-import-slice-file.cjs YYYYMMDD <slice.txt>');
  process.exit(1);
}
let slice = fs.readFileSync(slicePath, 'utf8');
slice = slice.replace(/(.+\.pdf)\n核心摘要：/g, '$1\n核心摘要\n');
slice = slice.replace(/\n核心摘要：/g, '\n核心摘要\n');
slice = slice.replace(/\[\d+\]/g, '');
slice = slice.replace(/\n+Let me verify[\s\S]*$/i, '');
slice = slice.replace(/\n+DS 快速[\s\S]*$/, '').trim();
const out = process.argv[4] || `manifests/tmp-import-${date}.txt`;
prepareAnswerFile(slice, out);
console.log(JSON.stringify(importAnswer(out, date)));
