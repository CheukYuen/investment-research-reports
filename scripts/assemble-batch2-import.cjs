#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const p0 = JSON.parse(fs.readFileSync(path.join(root, 'manifests/tmp-p0-chunks.json'), 'utf8')).join('');
const p1 = JSON.parse(fs.readFileSync(path.join(root, 'manifests/tmp-p1-chunks.json'), 'utf8')).join('');
const p2 = fs.readFileSync(path.join(root, 'manifests/tmp-p2.txt'), 'utf8');
const slice = p0 + p1 + p2;
const j = { p0: slice.slice(0, 2500), p1: slice.slice(2500, 5000), p2: slice.slice(5000) };
const out = path.join(root, 'manifests/tmp-text-parts.json');
fs.writeFileSync(out, JSON.stringify(j));
console.log(JSON.stringify({ sliceLen: slice.length, ju: (slice.match(/核心摘要/g) || []).length }));
