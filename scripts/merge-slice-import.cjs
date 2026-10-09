#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { prepareAnswerFile, importAnswer } = require('./ima-browser-batch-utils.cjs');

const date = process.argv[2] || '20261007';
const dir = path.join(__dirname, '..', 'manifests');
const parts = ['c0.txt', 'c1.txt', 'c2.txt'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
const slice = parts.join('');
const ju = (slice.match(/据该文件/g) || []).length;
console.log(JSON.stringify({ sliceLen: slice.length, juCount: ju }));
const out = path.join(dir, 'tmp-import.txt');
prepareAnswerFile(slice, out);
process.stdout.write(JSON.stringify(importAnswer(out, date)));
