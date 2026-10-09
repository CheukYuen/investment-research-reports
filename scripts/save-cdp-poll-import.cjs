#!/usr/bin/env node
/** Write CDP poll JSON (stdin) to tmp-poll.json and run import-poll-json. */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const date = process.argv[2];
if (!date || !/^\d{8}$/.test(date)) {
  console.error('usage: node scripts/save-cdp-poll-import.cjs YYYYMMDD < poll.json');
  process.exit(1);
}
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const j = JSON.parse(s);
  const root = path.resolve(__dirname, '..');
  const pollPath = path.join(root, 'manifests', 'tmp-poll.json');
  fs.writeFileSync(pollPath, JSON.stringify({ sliceB64: j.sliceB64 || '' }));
  const out = execFileSync(
    'node',
    ['scripts/ima-browser-batch-utils.cjs', 'import-poll-json', date, pollPath],
    { cwd: root, encoding: 'utf8' },
  );
  process.stdout.write(out);
});
