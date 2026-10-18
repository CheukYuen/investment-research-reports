#!/usr/bin/env node
/** Build Format B answer file from IMA prose (pdf_N) summaries + batch title list. */
const fs = require('node:fs');
const { nextBatch, prepareAnswerFile, importAnswer } = require('./ima-browser-batch-utils.cjs');

const date = process.argv[2];
const bodyPath = process.argv[3];
if (!date || !bodyPath) {
  console.error('usage: ima-browser-import-prose.cjs YYYYMMDD <body.txt> [out.txt]');
  process.exit(1);
}
const body = fs.readFileSync(bodyPath, 'utf8');
const b = nextBatch(date);
if (b.done) {
  console.log(JSON.stringify({ skipped: true, reason: 'no pending batch' }));
  process.exit(0);
}
const titles = b.prompt.split('\n').filter((l) => l.endsWith('.pdf'));

function findProseSummary(text, title) {
  const base = title.replace(/\.pdf$/i, '');
  const markers = [
    base,
    base.split('：')[0],
    base.replace(/（[^）]+）/, ''),
    base.split('（')[0],
  ].filter(Boolean);
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx < 0) continue;
    const colon = text.indexOf('：', idx);
    if (colon < 0 || colon > idx + m.length + 40) continue;
    let end = text.length;
    const nextPara = text.indexOf('\n\n', colon + 1);
    if (nextPara > colon) end = nextPara;
    let summary = text.slice(colon + 1, end).trim().replace(/\s+/g, ' ');
    if (summary.length < 20) continue;
    if (!/^据该文件/.test(summary)) summary = `据该文件正文，${summary}`;
    return summary;
  }
  const pdfTag = /（pdf_\d+）/.exec(text.slice(text.indexOf(base.split('（')[0])));
  if (pdfTag) {
    const idx = text.indexOf(pdfTag[0]);
    const colon = text.indexOf('：', idx);
    if (colon > 0) {
      let end = text.indexOf('\n\n', colon + 1);
      if (end < 0) end = text.length;
      let summary = text.slice(colon + 1, end).trim().replace(/\s+/g, ' ');
      if (summary.length >= 20) {
        if (!/^据该文件/.test(summary)) summary = `据该文件正文，${summary}`;
        return summary;
      }
    }
  }
  return null;
}

const blocks = [];
for (const title of titles) {
  const summary = findProseSummary(body, title);
  if (summary) blocks.push(`${title}\n核心摘要\n${summary}`);
}
const out = process.argv[4] || 'manifests/tmp-manual-answer-prose.txt';
if (!blocks.length) {
  console.log(JSON.stringify({ recorded: 0, blocks: 0, titles: titles.length }));
  process.exit(1);
}
prepareAnswerFile(blocks.join('\n\n'), out);
console.log(JSON.stringify(importAnswer(out, date)));
