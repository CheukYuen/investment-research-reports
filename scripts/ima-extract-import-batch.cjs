#!/usr/bin/env node
/** Extract IMA answer blocks from page innerText file and import via tmp-import-manual-answer.cjs */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , innerTextFile, date, titlesJson] = process.argv;
if (!innerTextFile || !date || !titlesJson) {
  console.error('usage: node scripts/ima-extract-import-batch.cjs <page-inner.txt> <YYYYMMDD> <titles.json>');
  process.exit(1);
}

const text = fs.readFileSync(innerTextFile, 'utf8');
const titles = JSON.parse(fs.readFileSync(titlesJson, 'utf8'));
const titleSet = new Set(titles);

const re = /文件名\s+([^\n]+\.pdf)\s*\n核心摘要\s+([\s\S]*?)(?=\n文件名\s+|\n内容由AI生成|$)/g;
const blocks = [];
let m;
while ((m = re.exec(text)) !== null) {
  let summary = m[2].trim().replace(/\[\d+\]/g, '').trim();
  blocks.push({ title: m[1].trim(), summary });
}

const batchBlocks = [];
const seen = new Set();
for (const b of blocks) {
  if (!titleSet.has(b.title) || seen.has(b.title)) continue;
  seen.add(b.title);
  batchBlocks.push(b);
}

let out = '';
for (const b of batchBlocks) {
  out += `文件名\n${b.title}\n核心摘要\n${b.summary}\n\n`;
}

const tmpAnswer = path.join(__dirname, '..', 'manifests', `tmp-manual-answer-${date}-batch.txt`);
fs.writeFileSync(tmpAnswer, out, 'utf8');
const importScript = path.join(__dirname, '..', 'manifests', 'tmp-import-manual-answer.cjs');
const importOut = execFileSync('node', [importScript, tmpAnswer, date], { encoding: 'utf8' });
try { fs.unlinkSync(tmpAnswer); } catch {}
const parsed = JSON.parse(importOut);
console.log(JSON.stringify({ matched: batchBlocks.length, expected: titles.length, ...parsed }, null, 2));
