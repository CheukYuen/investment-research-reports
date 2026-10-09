#!/usr/bin/env node
/** Import browser poll JSON { slice } or { sliceB64 } from file. */
const fs = require('node:fs');
const path = require('node:path');
const { prepareAnswerFile, importAnswer } = require('./ima-browser-batch-utils.cjs');

const date = process.argv[2];
const inPath = process.argv[3];
if (!date || !inPath) {
  console.error('usage: node scripts/import-cdp-poll-file.cjs YYYYMMDD <poll.json>');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const slice =
  j.slice ||
  (j.sliceB64 ? Buffer.from(j.sliceB64, 'base64').toString('utf8') : '');
const out = path.join(path.dirname(inPath), 'tmp-import.txt');
prepareAnswerFile(slice, out);
process.stdout.write(JSON.stringify(importAnswer(out, date)));
