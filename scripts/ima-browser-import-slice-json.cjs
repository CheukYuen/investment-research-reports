#!/usr/bin/env node
/** Import IMA slice from CDP JSON {slice} using format B parser. */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const jsonPath = process.argv[2];
const date = process.argv[3];
if (!jsonPath || !date) {
  console.error('usage: node ima-browser-import-slice-json.cjs <slice.json> YYYYMMDD');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let slice = String(j.slice || '').replace(/\n+DS 快速[\s\S]*$/, '').trim();
const out = 'manifests/tmp-slice.txt';
fs.writeFileSync(out, slice);
execFileSync('node', ['manifests/tmp-import-manual-answer.cjs', out, date], {
  cwd: require('node:path').resolve(__dirname, '..'),
  stdio: 'inherit',
});
