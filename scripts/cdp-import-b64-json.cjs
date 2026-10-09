#!/usr/bin/env node
/** Import from CDP poll JSON file: {"b64":"..."} or raw {"sliceB64":"..."}. */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const date = process.argv[2];
const inPath = process.argv[3];
if (!date || !inPath) {
  console.error('usage: node scripts/cdp-import-b64-json.cjs YYYYMMDD <cdp-poll.json>');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const sliceB64 = j.b64 || j.sliceB64 || '';
const root = path.resolve(__dirname, '..');
const pollPath = path.join(root, 'manifests', 'tmp-poll.json');
fs.writeFileSync(pollPath, JSON.stringify({ sliceB64 }));
const out = execFileSync(
  'node',
  ['scripts/ima-browser-batch-utils.cjs', 'import-poll-json', date, pollPath],
  { cwd: root, encoding: 'utf8' },
);
process.stdout.write(out);
