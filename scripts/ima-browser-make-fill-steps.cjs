#!/usr/bin/env node
const fs = require('node:fs');
const b64 = fs.readFileSync(process.argv[2], 'utf8').trim();
const parts = [];
for (let i = 0; i < b64.length; i += 1200) parts.push(b64.slice(i, i + 1200));
const exprs = parts.map((p, i) =>
  i === 0 ? `window.__pb64=${JSON.stringify(p)};` : `window.__pb64+=${JSON.stringify(p)};`,
);
exprs.push(
  `(()=>{const editor=document.querySelector('.tiptap.ProseMirror');if(!editor)return JSON.stringify({error:'no-editor'});editor.focus();const text=decodeURIComponent(escape(atob(window.__pb64)));editor.innerHTML='<p><br class="ProseMirror-trailingBreak"></p>';document.execCommand('insertText',false,text);editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'}));const span=document.querySelector('._sendBtnWrap_nje4s_23 span');return JSON.stringify({len:editor.innerText.length,disabled:span?.className?.includes('_disable')});})()`,
);
fs.writeFileSync(process.argv[3], JSON.stringify(exprs, null, 2));
