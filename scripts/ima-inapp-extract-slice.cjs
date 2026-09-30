#!/usr/bin/env node
/** Write CDP slice-chunk expression for browser_cdp (offset/limit). */
const fs = require('node:fs');
const [, , anchorFile, offset, limit] = process.argv;
if (!anchorFile || offset === undefined || limit === undefined) {
  console.error('usage: node ima-inapp-extract-slice.cjs <anchor.txt> <offset> <limit>');
  process.exit(1);
}
const title = fs.readFileSync(anchorFile, 'utf8').trim();
const anchor = `${title}\n核心摘要\n据该文件`;
const expr = `(() => {
  const anchor = ${JSON.stringify(anchor)};
  const t = document.body.innerText;
  const i = t.lastIndexOf(anchor);
  if (i < 0) return { err: 'no anchor', anchor: anchor.slice(0, 40) };
  const end = t.indexOf('内容由AI生成仅供参考', i);
  let slice = t.slice(i, end > i ? end : undefined).replace(/\\n+DS 快速\\s*$/,'').trim();
  return slice.slice(${Number(offset)}, ${Number(offset)} + ${Number(limit)});
})()`;
process.stdout.write(expr);
