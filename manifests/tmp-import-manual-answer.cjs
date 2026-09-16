// 一次性脚本：把用户交回的 IMA 手动批回答导入 report-summaries 进度。
// 用法: node manifests/tmp-import-manual-answer.cjs <answer.txt> <YYYYMMDD>
// 兼容两种块格式：
//   A) 文件名\n<title>\n核心摘要\n<summary>
//   B) <title.pdf>\n核心摘要\n<summary>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const [, , answerFile, date] = process.argv;
if (!answerFile || !date) {
  console.error('usage: node tmp-import-manual-answer.cjs <answer.txt> <YYYYMMDD>');
  process.exit(1);
}

const indexPath = path.join(ROOT, 'manifests', `index-${date}.jsonl`);
const progressPath = path.join(ROOT, 'manifests', `report-summary-browser-progress-${date}.jsonl`);
const failuresPath = path.join(ROOT, 'manifests', `report-summary-browser-failures-${date}.jsonl`);

const index = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byTitle = new Map(index.map((r) => [r.title, r]));
const norm = (s) => s.replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
const byNorm = new Map(index.map((r) => [norm(r.title), r]));

const text = fs.readFileSync(answerFile, 'utf8');
const blocks = [];

// 格式 A：带「文件名」头
const reA = /文件名\s*\n([^\n]+)\n核心摘要\s*\n([\s\S]*?)(?=\n文件名\s*\n|$)/g;
let m;
while ((m = reA.exec(text)) !== null) blocks.push({ title: m[1].trim(), summary: m[2].trim() });

// 格式 B：标题行直接跟「核心摘要」（仅当格式 A 没有覆盖时补充）
if (blocks.length === 0) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || !line.endsWith('.pdf')) continue;
    if ((lines[i + 1] || '').trim() !== '核心摘要') continue;
    const summaryLines = [];
    let j = i + 2;
    while (j < lines.length) {
      const next = lines[j].trim();
      const isNextTitle = next.endsWith('.pdf') && (lines[j + 1] || '').trim() === '核心摘要';
      if (isNextTitle) break;
      summaryLines.push(lines[j]);
      j += 1;
    }
    blocks.push({ title: line, summary: summaryLines.join('\n').trim() });
    i = j - 1;
  }
}

const seen = new Set();
const results = { recorded: 0, skipped_no_content: [], unmatched: [], duplicate: [], failed: [] };
const tmpJson = path.join(ROOT, 'manifests', `tmp-record-${date}.json`);

for (const block of blocks) {
  const key = norm(block.title);
  if (seen.has(key)) { results.duplicate.push(block.title); continue; }
  seen.add(key);

  const idx = byTitle.get(block.title) || byNorm.get(key);
  if (!idx) { results.unmatched.push(block.title); continue; }
  if (!block.summary || block.summary === 'NO_CONTENT') { results.skipped_no_content.push(block.title); continue; }

  const record = {
    media_id: idx.media_id,
    source_title: idx.title,
    source_count: 1,
    source_titles: [idx.title],
    status: 'reviewed',
    research_subject: idx.title.replace(/\.pdf$/i, ''),
    executive_summary: block.summary,
    prompt_version: 'ima-manual-short-summary-v1',
    model_version: 'ima-web-deepseek-v4-flash',
    generated_at: new Date().toISOString(),
    raw_answer: `文件名\n${block.title}\n核心摘要\n${block.summary}`,
  };
  fs.writeFileSync(tmpJson, JSON.stringify(record, null, 2), 'utf8');
  try {
    const out = execFileSync('node', [
      path.join(ROOT, 'scripts', 'report-summaries.cjs'), 'record',
      '--index', indexPath, '--progress', progressPath, '--failures', failuresPath,
      '--input', tmpJson,
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    if (parsed.status === 'reviewed') results.recorded += 1;
    else results.failed.push({ title: block.title, out });
  } catch (e) {
    results.failed.push({ title: block.title, error: String(e.message).slice(0, 300) });
  }
}

try { fs.unlinkSync(tmpJson); } catch {}
console.log(JSON.stringify({
  date,
  blocks: blocks.length,
  recorded: results.recorded,
  skipped_no_content: results.skipped_no_content,
  unmatched: results.unmatched,
  duplicate: results.duplicate.length,
  failed: results.failed,
}, null, 2));
