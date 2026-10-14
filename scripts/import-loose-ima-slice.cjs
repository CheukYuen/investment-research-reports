#!/usr/bin/env node
/** Import IMA folder-QA answer where blocks are <title.pdf> then summary (no 核心摘要 line). */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [, , date, inPath] = process.argv;
if (!date || !inPath) {
  console.error('usage: import-loose-ima-slice.cjs YYYYMMDD <raw-slice.txt>');
  process.exit(1);
}

let raw = fs.readFileSync(inPath, 'utf8').trim();
raw = raw.replace(/\n+DS 快速[\s\S]*$/, '').trim();
raw = raw.replace(/\[\d+\]/g, '');

const lines = raw.split('\n');
let out = '';
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line.endsWith('.pdf')) continue;
  const summaryLines = [];
  let j = i + 1;
  while (j < lines.length) {
    const t = lines[j].trim();
    if (t.endsWith('.pdf') && j > i + 1) break;
    summaryLines.push(lines[j]);
    j++;
  }
  const summary = summaryLines.join('\n').trim();
  out += `文件名\n${line}\n核心摘要\n${summary}\n\n`;
  i = j - 1;
}

const tmpAnswer = path.join(__dirname, '..', 'manifests', `_import-answer-${date}.txt`);
fs.writeFileSync(tmpAnswer, out, 'utf8');
const importScript = path.join(__dirname, '..', 'manifests', 'tmp-import-manual-answer.cjs');
const result = JSON.parse(execFileSync('node', [importScript, tmpAnswer, date], { encoding: 'utf8' }));
try {
  fs.unlinkSync(tmpAnswer);
} catch {}
console.log(JSON.stringify({ blocks: out.split('文件名\n').length - 1, ...result }));
