#!/usr/bin/env node
/** Print CDP poll expression for anchor file. usage: node ima-inapp-poll-anchor.cjs <anchor.txt> */
const fs = require('node:fs');
const title = fs.readFileSync(process.argv[2], 'utf8').trim();
const anchor = `${title}\n核心摘要\n据该文件`;
const expr = `(() => {
  const anchor = ${JSON.stringify(anchor)};
  const t = document.body.innerText;
  const i = t.lastIndexOf(anchor);
  const slice = i >= 0 ? t.slice(i, t.indexOf('内容由AI生成仅供参考', i)) : '';
  const span = document.querySelector('._sendBtnWrap_nje4s_23 span');
  return { stopping: /stop/.test(span?.className||''), sliceLen: slice.length, juCount: (slice.match(/据该文件/g)||[]).length, hasQuota: /资料获取次数已达上限|预算不足/.test(t) };
})()`;
process.stdout.write(expr);
