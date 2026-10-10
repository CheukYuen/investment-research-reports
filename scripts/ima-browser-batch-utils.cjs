#!/usr/bin/env node
/** Helpers for InAppBrowser manual batch loop (prompt build + answer file prep). */
const fs = require('node:fs');
const path = require('node:path');

const BROWSER_TMP_KEEP = new Set(['tmp-import-manual-answer.cjs']);

function cleanupBrowserTmp() {
  const dir = path.join(__dirname, '..', 'manifests');
  if (!fs.existsSync(dir)) return { removed: 0, kept: [...BROWSER_TMP_KEEP] };
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('tmp-') || BROWSER_TMP_KEEP.has(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed += 1;
  }
  return { removed, kept: [...BROWSER_TMP_KEEP] };
}
const { buildPrompts } = require('./ima-manual-prompts.cjs');
const { pathsForDate, loadConfig } = require('./ima-daily-summary.cjs');
const { readJsonl } = require('./report-summaries.cjs');

function batchSizeFromEnv(cfg) {
  const env = Number(process.env.MANUAL_BATCH_SIZE);
  if (Number.isInteger(env) && env >= 1 && env <= 30) return env;
  return cfg.manual_batch_size ?? 25;
}

function nextBatch(date) {
  const paths = pathsForDate(date);
  const cfg = loadConfig();
  const r = buildPrompts(
    readJsonl(paths.index),
    readJsonl(paths.progress),
    readJsonl(paths.summaries),
    batchSizeFromEnv(cfg),
    paths.date.sourcePath,
  );
  if (!r.prompts.length) return { pending: r.pending, done: true };
  const prompt = r.prompts[0];
  const anchorTitle = prompt.split('\n').find((l) => l.endsWith('.pdf'));
  return { pending: r.pending, done: false, prompt, anchorTitle, batchPdfCount: prompt.split('\n').filter((l) => l.endsWith('.pdf')).length };
}

function prepareAnswerFile(slice, outPath) {
  let raw = String(slice || '').replace(/\n+DS 快速[\s\S]*$/, '').trim();
  raw = raw.replace(/\[\d+\]/g, '');
  const formatB = /^[^\n]+\.pdf\n核心摘要/m.test(raw);
  if (!formatB && !raw.startsWith('文件名\n')) raw = `文件名\n${raw}`;
  fs.writeFileSync(outPath, `${raw}\n`);
}

function importAnswer(outPath, date) {
  const { execFileSync } = require('node:child_process');
  const root = require('node:path').resolve(__dirname, '..');
  const out = execFileSync('node', ['manifests/tmp-import-manual-answer.cjs', outPath, date], {
    cwd: root,
    encoding: 'utf8',
  });
  fs.unlinkSync(outPath);
  const result = JSON.parse(out);
  cleanupBrowserTmp();
  return result;
}

function makeFillExpression(prompt) {
  return `(() => {
  const editor = document.querySelector('.tiptap.ProseMirror');
  if (!editor) return JSON.stringify({error:'no-editor'});
  editor.focus();
  const text = ${JSON.stringify(prompt)};
  editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
  document.execCommand('insertText', false, text);
  editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: 'x'}));
  const span = document.querySelector('._sendBtnWrap_nje4s_23 span');
  return JSON.stringify({len: editor.innerText.length, disabled: span?.className?.includes('_disable')});
})()`;
}

function makePollExpression(anchorTitle) {
  const t = anchorTitle.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `(() => {
  const title = '${t}';
  const body = document.body.innerText;
  const idx = body.lastIndexOf(title);
  let slice = '';
  if (idx >= 0) {
    const end = body.indexOf('内容由AI生成仅供参考', idx);
    slice = body.slice(idx, end > idx ? end : undefined);
  }
  const span = document.querySelector('._sendBtnWrap_nje4s_23 span');
  const ju = (slice.match(/据该文件/g) || []).length;
  return JSON.stringify({
    generating: /stop/.test(span?.className || ''),
    juCount: ju,
    sliceLen: slice.length,
    sliceB64: slice ? btoa(unescape(encodeURIComponent(slice))) : ''
  });
})()`;
}

function makeSendCoordsExpression() {
  return `(() => {
  const el = document.querySelector('._sendBtnWrap_nje4s_23');
  const r = el?.getBoundingClientRect();
  if (!r) return JSON.stringify({error:'no-send'});
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const scaleX = 631 / 742;
  const scaleY = 797 / 937;
  return JSON.stringify({cx, cy, shotX: Math.round(cx / scaleX), shotY: Math.round(cy / scaleY), disabled: el.innerHTML.includes('_disable')});
})()`;
}

function makeExtractExpression(anchorTitle) {
  const t = anchorTitle.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `(() => {
  const title = '${t}';
  const body = document.body.innerText;
  const idx = body.lastIndexOf(title);
  if (idx < 0) return '';
  const end = body.indexOf('内容由AI生成仅供参考', idx);
  const slice = body.slice(idx, end > idx ? end : body.length);
  return btoa(unescape(encodeURIComponent(slice)));
})()`;
}

const cmd = require.main === module ? process.argv[2] : null;
const dateArg = process.argv[3];
const date = dateArg && /^\d{8}$/.test(dateArg) ? dateArg : '20261001';
if (cmd === 'next') {
  console.log(JSON.stringify(nextBatch(date)));
} else if (cmd === 'fill-expr') {
  const b = nextBatch(date);
  if (b.done) process.exit(2);
  const outExpr = process.argv[4];
  const outPrompt = process.argv[5] || null;
  fs.writeFileSync(outExpr, makeFillExpression(b.prompt));
  if (outPrompt) fs.writeFileSync(outPrompt, b.prompt);
  console.log(JSON.stringify({ anchorTitle: b.anchorTitle, batchPdfCount: b.batchPdfCount, pending: b.pending }));
} else if (cmd === 'b64-fill-expr') {
  const b = nextBatch(date);
  if (b.done) process.exit(2);
  const b64 = Buffer.from(b.prompt, 'utf8').toString('base64');
  const expr = `(() => {
  const editor = document.querySelector('.tiptap.ProseMirror');
  if (!editor) return JSON.stringify({error:'no-editor'});
  editor.focus();
  const text = decodeURIComponent(escape(atob('${b64}')));
  editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
  document.execCommand('insertText', false, text);
  editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: 'x'}));
  const span = document.querySelector('._sendBtnWrap_nje4s_23 span');
  return JSON.stringify({len: editor.innerText.length, disabled: span?.className?.includes('_disable')});
})()`;
  fs.writeFileSync(process.argv[4], expr);
  if (process.argv[5]) {
    fs.writeFileSync(process.argv[5], JSON.stringify({ anchorTitle: b.anchorTitle, batchPdfCount: b.batchPdfCount, pending: b.pending }));
  }
  console.log(JSON.stringify({ anchorTitle: b.anchorTitle, batchPdfCount: b.batchPdfCount, pending: b.pending }));
} else if (cmd === 'import-poll-parts-stdin') {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    s += d;
  });
  process.stdin.on('end', () => {
    const j = JSON.parse(s);
    const slice = [j.p0, j.p1, j.p2, ...(j.parts || [])].filter(Boolean).join('');
    const out = process.argv[4] || 'manifests/tmp-import.txt';
    prepareAnswerFile(slice, out);
    console.log(JSON.stringify(importAnswer(out, date)));
  });
} else if (cmd === 'import-poll-json') {
  const j = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const out = process.argv[5] || 'manifests/tmp-import.txt';
  fs.writeFileSync('manifests/tmp-slice.b64', j.sliceB64 || '');
  prepareAnswerFile(Buffer.from(j.sliceB64 || '', 'base64').toString('utf8'), out);
  console.log(JSON.stringify(importAnswer(out, date)));
} else if (cmd === 'import-b64') {
  const b64 = fs.readFileSync(process.argv[4], 'utf8').trim();
  let slice = Buffer.from(b64, 'base64').toString('utf8');
  slice = slice.replace(/\.pdf\n\n核心摘要/g, '.pdf\n核心摘要');
  const out = process.argv[5];
  prepareAnswerFile(slice, out);
  console.log(JSON.stringify(importAnswer(out, date)));
} else if (cmd === 'write-load-fe') {
  const b = nextBatch(date);
  if (b.done) process.exit(2);
  const fillPath = process.argv[4] || 'manifests/tmp-cdp-fill-expr.js';
  fs.writeFileSync(fillPath, makeFillExpression(b.prompt));
  const b64 = Buffer.from(fs.readFileSync(fillPath, 'utf8')).toString('base64');
  const loadExpr = `(()=>{window.__fe=${JSON.stringify(b64)};return window.__fe.length;})()`;
  const runExpr = `(()=>{return eval(decodeURIComponent(escape(atob(window.__fe))));})()`;
  fs.writeFileSync(process.argv[5] || 'manifests/tmp-load-fe.js', loadExpr);
  fs.writeFileSync(process.argv[6] || 'manifests/tmp-run-fe.js', runExpr);
  if (process.argv[7]) {
    fs.writeFileSync(process.argv[7], JSON.stringify({ anchorTitle: b.anchorTitle, batchPdfCount: b.batchPdfCount, pending: b.pending }));
  }
  console.log(JSON.stringify({ anchorTitle: b.anchorTitle, batchPdfCount: b.batchPdfCount, pending: b.pending }));
} else if (cmd === 'send-coords-expr') {
  console.log(makeSendCoordsExpression());
} else if (cmd === 'poll-expr') {
  console.log(makePollExpression(process.argv[4]));
} else if (cmd === 'extract-expr') {
  console.log(makeExtractExpression(process.argv[4]));
} else if (cmd === 'prepare-import') {
  const slice = fs.readFileSync(process.argv[4], 'utf8');
  prepareAnswerFile(slice, process.argv[5]);
  console.log(JSON.stringify(importAnswer(process.argv[5], date)));
} else if (cmd === 'cleanup-tmp') {
  console.log(JSON.stringify(cleanupBrowserTmp()));
} else if (cmd) {
  console.error('usage: next|fill-expr|poll-expr|extract-expr|prepare-import|cleanup-tmp');
  process.exit(1);
}

module.exports = {
  nextBatch,
  prepareAnswerFile,
  importAnswer,
  cleanupBrowserTmp,
  makeFillExpression,
  makePollExpression,
  makeExtractExpression,
};
