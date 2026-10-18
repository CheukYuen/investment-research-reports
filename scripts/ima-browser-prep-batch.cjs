#!/usr/bin/env node
/** Prepare chunked fill CDP steps for current next batch. */
const fs = require('node:fs');
const path = require('node:path');
const { nextBatch } = require('./ima-browser-batch-utils.cjs');

const date = process.argv[2];
if (!date) {
  console.error('usage: ima-browser-prep-batch.cjs YYYYMMDD');
  process.exit(1);
}
const b = nextBatch(date);
if (b.done) {
  console.log(JSON.stringify({ done: true, pending: b.pending }));
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const b64 = Buffer.from(b.prompt, 'utf8').toString('base64');
fs.writeFileSync(path.join(root, 'manifests/tmp-prompt.b64'), b64);
fs.writeFileSync(path.join(root, 'manifests/tmp-batch-meta.json'), JSON.stringify({
  anchorTitle: b.anchorTitle,
  batchPdfCount: b.batchPdfCount,
  pending: b.pending,
}));
require('child_process').execFileSync(
  'node',
  ['scripts/ima-browser-make-fill-steps.cjs', path.join(root, 'manifests/tmp-prompt.b64'), path.join(root, 'manifests/tmp-fill-steps.json')],
  { cwd: root, stdio: 'inherit' },
);
const steps = require(path.join(root, 'manifests/tmp-fill-steps.json'));
steps.forEach((s, i) => {
  fs.writeFileSync(path.join(root, `manifests/tmp-cdp-step-${i}.js`), s);
  const expr =
    i < steps.length - 1
      ? `(()=>{${s}return window.__pb64.length;})()`
      : s;
  fs.writeFileSync(path.join(root, `manifests/tmp-eval-${i}.txt`), expr);
});
console.log(
  JSON.stringify({
    done: false,
    pending: b.pending,
    anchorTitle: b.anchorTitle,
    batchPdfCount: b.batchPdfCount,
    stepCount: steps.length,
  }),
);
