#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { prepareAnswerFile, importAnswer } = require('./ima-browser-batch-utils.cjs');

const date = process.argv[2] || '20261011';
const inPath = process.argv[3];
if (!inPath) {
  console.error('usage: import-cdp-text-parts.cjs YYYYMMDD <parts.json>');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(inPath, 'utf8'));
let slice = `${j.p0 || ''}${j.p1 || ''}${j.p2 || ''}`;
if (!slice.startsWith('文件名') && /^[^\n]+\.pdf\r?\n核心摘要/m.test(slice)) {
  slice = slice.replace(/^([^\n]+\.pdf)\r?\n核心摘要/, '文件名\n$1\n核心摘要');
}
const dir = path.join(__dirname, '..', 'manifests');
const index = fs.readFileSync(path.join(dir, `index-${date}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const emFull = index.find((r) => r.title.includes('MSCI新兴市场指数周度持平'))?.title;
const emShort = '高盛-新兴市场周报：MSCI新兴市场集中度难题-261009.pdf';
if (emFull) {
  slice = slice.replaceAll(emShort, emFull);
}
const ju = (slice.match(/核心摘要/g) || []).length;
const out = path.join(dir, 'tmp-import-text.txt');
prepareAnswerFile(slice, out);
const result = importAnswer(out, date);
console.log(JSON.stringify({ sliceLen: slice.length, juCount: ju, ...result }));
