#!/usr/bin/env node
/** stdin: IMA innerText slice; stdout: tmp-import format (文件名 blocks) */
const fs = require('fs');
const text = fs.readFileSync(0, 'utf8').replace(/\nDS 快速\s*$/,'').trim();
const patterns = [
  /(?:^|\n)(?:文件名\s*)?([^\n]+\.pdf)\s*\n核心摘要[：:\s]+\s*([\s\S]*?)(?=\n\n(?:文件名\s*)?[^\n]+\.pdf|$)/g,
  /(?:^|\n)(?:文件名\s*)?([^\n]+\.pdf)\s*\n(据该文件[\s\S]*?)(?=\n\n(?:文件名\s*)?[^\n]+\.pdf|$)/g,
];
const blocks = [];
for (const re of patterns) {
let m;
while ((m = re.exec(text)) !== null) {
  let summary = m[2].trim().replace(/\n+/g, '\n');
  summary = summary.replace(/[\s\u00a0]*[\[【]?\d+[\]】]?\s*$/u, '').trim();
  summary = summary.replace(/(\S)[。.]?(\d{1,2})\s*$/u, '$1').trim();
  if (!summary.startsWith('据该文件')) continue;
  blocks.push({ title: m[1].trim(), summary });
}
if (blocks.length) break;
}
if (!blocks.length) {
  console.error('No blocks parsed');
  process.exit(1);
}
const out = blocks.map((b, i) => {
  const head = i === 0 ? '文件名\n' : '\n文件名\n';
  return `${head}${b.title}\n核心摘要\n${b.summary}`;
}).join('');
process.stdout.write(out);
