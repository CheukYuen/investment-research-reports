#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stripCitationArtifacts } = require('./report-summaries.cjs');

const [, , sliceFile, date] = process.argv;
if (!sliceFile || !date) {
  console.error('usage: node scripts/ima-inapp-import-slice.cjs <slice.txt> <YYYYMMDD>');
  process.exit(1);
}

let text = fs.readFileSync(sliceFile, 'utf8').trim().replace(/\n+DS 快速\s*$/i, '');
text = text.replace(/([。！？.!?])\s*\d+\s*(?=\n\n[^\n]+\.pdf)/g, '$1');
text = text.replace(/\n\n(?=([^\n]+\.pdf)\n核心摘要)/g, '\n\n文件名\n');
if (!text.startsWith('文件名\n')) {
  const nl = text.indexOf('\n');
  text = `文件名\n${text.slice(0, nl)}\n${text.slice(nl + 1)}`;
}
text = stripCitationArtifacts(text);
const tmp = path.join('manifests', `tmp-manual-answer-${date}-slice.txt`);
fs.writeFileSync(tmp, `${text}\n`);
try {
  execFileSync('node', ['manifests/tmp-import-manual-answer.cjs', tmp, date], { stdio: 'inherit' });
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}
