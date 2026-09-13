// 一次性脚本：解析 IMA 手动回答并逐条调用 report-summaries.cjs record
// 用法: node import-batch.cjs <rawAnswerFile> <date YYYYMMDD>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [rawFile, date] = process.argv.slice(2);
const root = path.resolve(__dirname, '..', '..');
const indexPath = path.join(root, 'manifests', `index-${date}.jsonl`);
const progressPath = path.join(root, 'manifests', `report-summary-browser-progress-${date}.jsonl`);
const failuresPath = path.join(root, 'manifests', `report-summary-browser-failures-${date}.jsonl`);

const index = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const byTitle = new Map(index.map((r) => [r.title, r]));
// IMA 回答可能把中文弯引号写成英文直引号，建立归一化对照
const curl = (s) => s.replace(/"([^"\n]*)"/g, '“$1”');
const byCurlTitle = new Map(index.map((r) => [curl(r.title), r]));

const raw = fs.readFileSync(rawFile, 'utf8');
const lines = raw.split('\n');
const entries = [];
let cur = null;
const isTitle = (t) => byTitle.has(t) || byTitle.has(curl(t));
let mode = null;
for (const line of lines) {
  const t = line.trim();
  // 优先识别「文件名/核心摘要」分段格式；也兼容直接以标题行开头的格式
  if (t === '文件名') { if (cur) entries.push(cur); cur = { title: '', summary: '' }; mode = 'title'; continue; }
  if (t === '核心摘要') { if (cur) mode = 'summary'; continue; }
  if (isTitle(t)) {
    if (cur) entries.push(cur);
    cur = { title: t, summary: '' };
    mode = 'summary';
    continue;
  }
  if (!cur) continue;
  if (mode === 'title' && t) cur.title = cur.title || t;
  else if (mode === 'summary' && t) cur.summary = cur.summary ? cur.summary + '\n' + line : line;
}
if (cur) entries.push(cur);

// 按清单顺序核对，同一文件名只导入一次
const seen = new Set();
const results = { ok: 0, failed: [] };
for (const e of entries) {
  const title = e.title.trim();
  const summary = e.summary.trim();
  if (!title) { results.failed.push({ title: '(empty)', reason: 'empty_title' }); continue; }
  if (seen.has(title)) { results.failed.push({ title, reason: 'duplicate_in_answer' }); continue; }
  seen.add(title);
  const idx = byTitle.get(title) || byTitle.get(curl(title));
  if (!idx) { results.failed.push({ title, reason: 'title_not_in_index' }); continue; }
  const indexTitle = idx.title;
  if (!summary || summary === 'NO_CONTENT') { results.failed.push({ title, reason: 'no_content_kept_pending' }); continue; }
  const record = {
    media_id: idx.media_id,
    status: 'reviewed',
    source_title: indexTitle,
    research_subject: indexTitle.replace(/-\d{6}\.pdf$/, '').replace(/\.pdf$/, ''),
    executive_summary: summary,
    key_findings: [],
    content_tags: [],
    data_points: [],
    entities: [],
    evidence: [],
    raw_answer: `文件名\n${title}\n核心摘要\n${summary}`,
    prompt_version: 'ima-manual-short-summary-v1',
    model_version: 'ima-web-deepseek-v4-flash',
    generated_at: new Date().toISOString(),
  };
  const tmp = path.join(__dirname, `rec-${idx.media_id.slice(-16)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  try {
    const out = execFileSync('node', [
      path.join(root, 'scripts', 'report-summaries.cjs'), 'record',
      '--index', indexPath, '--progress', progressPath, '--failures', failuresPath,
      '--input', tmp,
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(out.trim());
    if (parsed.status === 'reviewed') results.ok += 1;
    else results.failed.push({ title, reason: out.trim() });
  } catch (err) {
    results.failed.push({ title, reason: String(err.message).slice(0, 300) });
  } finally {
    fs.unlinkSync(tmp);
  }
}
console.log(JSON.stringify({ date, parsed_entries: entries.length, imported: results.ok, failed: results.failed }, null, 2));
