#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, '..', 'manifests', 'tmp-slice.b64');
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    fs.writeFileSync(out, body);
    res.writeHead(200);
    res.end(String(body.length));
    server.close();
  });
});
server.listen(18765, '127.0.0.1', () => {
  console.log('ready');
});
