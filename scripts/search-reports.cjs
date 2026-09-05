#!/usr/bin/env node

// 研报主题检索：把按日期切分的 manifests 合并成可 rg / 可 query 的扁平索引。
// 索引按月分片，历史月份内容稳定，每日重建只有当月分片产生 diff。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const SHARD_PREFIX = 'search-index-';
const SHARD_RE = /^search-index-(\d{6})\.jsonl$/;
const QUEUE_RE = /^ai-ranked-queue-summary-(\d{4})(\d{2})(\d{2})\.jsonl$/;
const SUMMARY_RE = /^report-summaries-(\d{4})(\d{2})(\d{2})\.jsonl$/;

const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'UNREVIEWED'];
const PRIORITY_ORDER = new Map(PRIORITIES.map((priority, index) => [priority, index]));
const REPORT_TYPE_LABELS = {
  company: '公司研究',
  industry: '行业研究',
  strategy: '投资策略',
  macro: '宏观经济',
  commodity: '大宗商品',
  other: '其他研究',
};
const UNCLASSIFIED_LABEL = '未分类';
const UNCLASSIFIED_COMPANY_KEY = '__unclassified__';
const UNCLASSIFIED_COMPANY_LABEL = '未归类公司';
const TICKER_RE = /[（(]([A-Za-z0-9]{1,10}\.[A-Za-z]{1,4})[）)]/;

const ROUTING_NOTE =
  '结果来自 IMA 路由摘要(summary_role=routing_candidate)，仅用于定位 PDF；正式数字/页码/证据须回到 pdf_path 核对。';

// 参与检索的字段，顺序即命中片段的展示优先级。
const SEARCH_FIELDS = [
  ['title', (record) => record.title],
  ['research_subject', (record) => record.research_subject],
  ['executive_summary', (record) => record.executive_summary],
  ['key_findings', (record) => (record.key_findings || []).join(' ')],
  ['entities', (record) => (record.entities || []).join(' ')],
  ['topics', (record) => (record.topics || []).join(' ')],
  ['content_tags', (record) => (record.content_tags || []).join(' ')],
  ['sectors', (record) => (record.sectors_cn || []).join(' ')],
  ['report_type', (record) => [record.report_type_label, record.report_type_reason].filter(Boolean).join(' ')],
  ['company', (record) => record.company_label],
  ['ranking_evidence', (record) => (record.ranking_evidence || []).join(' ')],
  ['data_points', (record) => (record.data_points || [])
    .map((point) => [point.metric, point.value_text, point.period, point.context].filter(Boolean).join(' '))
    .join(' ')],
  ['pdf_path', (record) => record.pdf_path],
];

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSONL: ${error.message}`);
    }
  });
}

function writeJsonlAtomic(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.part`;
  fs.writeFileSync(tempPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  fs.renameSync(tempPath, filePath);
}

function datedSources(manifestsDir, pattern) {
  return fs.readdirSync(manifestsDir)
    .map((name) => {
      const match = name.match(pattern);
      if (!match) return null;
      return {
        name,
        path: path.join(manifestsDir, name),
        snapshotDate: `${match[1]}-${match[2]}-${match[3]}`,
        snapshotMonth: `${match[1]}${match[2]}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stripPdfSuffix(title) {
  return String(title || '').replace(/\.pdf$/i, '').trim();
}

function brokerBody(title) {
  const dash = title.indexOf('-');
  return dash >= 0 ? title.slice(dash + 1).trim() : title;
}

// 与 render-ai-ranking-html.cjs 的 parseCompanyFromTitle 保持一致，
// 保证脚本检索完整覆盖 hub 页搜索框能命中的内容。
function parseCompanyFromTitle(title, reportType) {
  if (reportType !== 'company') return { key: '', label: '' };
  const stripped = stripPdfSuffix(title);
  if (!stripped) return { key: UNCLASSIFIED_COMPANY_KEY, label: UNCLASSIFIED_COMPANY_LABEL };
  const body = brokerBody(stripped);
  const match = body.match(TICKER_RE) || stripped.match(TICKER_RE);
  if (match) {
    const ticker = match[1].toUpperCase();
    const before = body.slice(0, match.index).trim().replace(/[-–—:：|｜]+$/g, '').trim();
    const label = before && before.toUpperCase() !== ticker ? `${before} (${ticker})` : ticker;
    return { key: ticker, label };
  }
  const colon = body.search(/[：:]/);
  if (colon > 0) {
    const name = body.slice(0, colon).trim();
    if (name) return { key: name.toLowerCase(), label: name };
  }
  return { key: UNCLASSIFIED_COMPANY_KEY, label: UNCLASSIFIED_COMPANY_LABEL };
}

function monthFromLocalPath(localRelativePath) {
  const match = String(localRelativePath || '').match(/^(\d{4})\/(\d{1,2})月\//);
  return match ? `${match[1]}${String(match[2]).padStart(2, '0')}` : '';
}

function monthFromIso(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}${match[2]}` : '';
}

function slimDataPoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => ({
      metric: point.metric || '',
      value_text: point.value_text || '',
      period: point.period || '',
      context: point.context || '',
    }))
    .filter((point) => point.metric || point.value_text || point.period || point.context);
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function toIndexRecord(record, { tier, snapshotDate, snapshotMonth, downloadedIds }) {
  const localRelativePath = record.local_relative_path || '';
  const reportType = record.report_type || null;
  const company = parseCompanyFromTitle(record.title, reportType);
  const sectorsCn = Array.isArray(record.sectors)
    ? record.sectors.map((sector) => sector && sector.name_cn).filter(Boolean)
    : [];
  return {
    media_id: record.media_id || '',
    tier,
    title: record.title || '',
    snapshot_date: snapshotDate,
    snapshot_month: snapshotMonth,
    priority: record.priority || 'UNREVIEWED',
    rank: record.rank ?? null,
    score: record.score ?? null,
    report_type: reportType,
    report_type_label: reportType ? (REPORT_TYPE_LABELS[reportType] || UNCLASSIFIED_LABEL) : UNCLASSIFIED_LABEL,
    report_type_reason: record.report_type_reason || '',
    sectors_cn: sectorsCn,
    company_label: company.label,
    downloaded: downloadedIds.has(record.media_id),
    pdf_path: localRelativePath ? path.posix.join('downloads', localRelativePath) : '',
    summary_role: record.summary_role || '',
    research_subject: record.research_subject || '',
    executive_summary: record.executive_summary || '',
    key_findings: stringArray(record.key_findings),
    content_tags: stringArray(record.content_tags),
    topics: stringArray(record.topics),
    entities: stringArray(record.entities),
    // 不收 reasons：DeepSeek 排序理由会逐字复制排序 prompt 里的判据样板句
    //（如"…也包括强相关半导体设备材料、PCB、光纤光缆、工业自动化"），
    // 会让无关研报在主题检索里假命中。真实证据走 ranking_evidence。
    ranking_evidence: stringArray(record.ranking_evidence),
    data_points: slimDataPoints(record.data_points),
  };
}

function recordKey(record) {
  return record.media_id || record.local_relative_path || record.source_path || record.title;
}

function buildIndex(manifestsDir) {
  const downloadedIds = new Set(readJsonl(path.join(manifestsDir, 'downloaded.jsonl'))
    .map((event) => event.media_id)
    .filter(Boolean));

  const byKey = new Map();
  const stats = { ranked: 0, summary_only: 0, index_only: 0, sources: 0 };

  // tier: ranked -- 唯一有分类和优先级的来源。文件名升序，后出现的快照覆盖先前的。
  for (const source of datedSources(manifestsDir, QUEUE_RE)) {
    const rows = readJsonl(source.path);
    if (rows.length === 0) continue;
    stats.sources += 1;
    for (const row of rows) {
      const key = recordKey(row);
      if (!key) continue;
      byKey.set(key, toIndexRecord(row, {
        tier: 'ranked',
        snapshotDate: source.snapshotDate,
        snapshotMonth: source.snapshotMonth,
        downloadedIds,
      }));
    }
  }

  // tier: summary_only -- 有摘要但没进排序队列（UNREVIEWED / source_match=false）。
  // report-summaries 的 report_type/sectors/topics 恒为空，是 migrate-classification-fields.cjs 的刻意设计。
  for (const source of datedSources(manifestsDir, SUMMARY_RE)) {
    const rows = readJsonl(source.path);
    if (rows.length === 0) continue;
    stats.sources += 1;
    for (const row of rows) {
      const key = recordKey(row);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, toIndexRecord(row, {
        tier: 'summary_only',
        snapshotDate: source.snapshotDate,
        snapshotMonth: source.snapshotMonth,
        downloadedIds,
      }));
    }
  }

  // tier: index_only -- 知识库里有、但从未进入摘要管线，只有标题可搜。
  for (const row of readJsonl(path.join(manifestsDir, 'index.jsonl'))) {
    const key = recordKey(row);
    if (!key || byKey.has(key)) continue;
    const month = monthFromLocalPath(row.local_relative_path) || monthFromIso(row.indexed_at);
    if (!month) continue;
    byKey.set(key, toIndexRecord(row, {
      tier: 'index_only',
      snapshotDate: '',
      snapshotMonth: month,
      downloadedIds,
    }));
  }

  const shards = new Map();
  for (const record of byKey.values()) {
    stats[record.tier] += 1;
    if (!shards.has(record.snapshot_month)) shards.set(record.snapshot_month, []);
    shards.get(record.snapshot_month).push(record);
  }

  const written = [];
  for (const [month, records] of [...shards.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    records.sort((a, b) => (
      a.snapshot_date.localeCompare(b.snapshot_date) ||
      (PRIORITY_ORDER.get(a.priority) ?? 99) - (PRIORITY_ORDER.get(b.priority) ?? 99) ||
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      String(a.media_id).localeCompare(String(b.media_id))
    ));
    const shardPath = path.join(manifestsDir, `${SHARD_PREFIX}${month}.jsonl`);
    writeJsonlAtomic(shardPath, records);
    written.push({ month, path: shardPath, count: records.length });
  }
  return { stats, written, total: byKey.size };
}

function shardPaths(manifestsDir, month) {
  return fs.readdirSync(manifestsDir)
    .map((name) => {
      const match = name.match(SHARD_RE);
      if (!match) return null;
      if (month && match[1] !== month) return null;
      return { month: match[1], path: path.join(manifestsDir, name) };
    })
    .filter(Boolean)
    .sort((a, b) => b.month.localeCompare(a.month));
}

function loadIndex(manifestsDir, month) {
  const shards = shardPaths(manifestsDir, month);
  if (shards.length === 0) return null;
  const records = [];
  for (const shard of shards) records.push(...readJsonl(shard.path));
  return records;
}

function indexIsStale(manifestsDir) {
  const shards = shardPaths(manifestsDir);
  if (shards.length === 0) return true;
  const newestShard = Math.max(...shards.map((shard) => fs.statSync(shard.path).mtimeMs));
  const sources = [
    ...datedSources(manifestsDir, QUEUE_RE),
    ...datedSources(manifestsDir, SUMMARY_RE),
    // downloaded.jsonl 决定 downloaded 标记：手工 download（而非 download-queue）
    // 只追加这个文件、不刷新索引，不检查它会让已下载的 PDF 一直显示 NOT_DOWNLOADED。
    { path: path.join(manifestsDir, 'downloaded.jsonl') },
  ];
  return sources.some((source) => fs.existsSync(source.path) && fs.statSync(source.path).mtimeMs > newestShard);
}

function haystackFields(record) {
  return SEARCH_FIELDS
    .map(([field, pick]) => [field, String(pick(record) || '')])
    .filter(([, text]) => text.length > 0);
}

function snippet(text, term, radius = 40) {
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return '';
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + term.length + radius);
  const head = start > 0 ? '...' : '';
  const tail = end < text.length ? '...' : '';
  return `${head}${text.slice(start, end).replace(/\s+/g, ' ')}${tail}`;
}

function matchRecord(record, terms, anyMode) {
  const fields = haystackFields(record);
  const joined = fields.map(([, text]) => text).join('  ').toLowerCase();
  const hit = (term) => joined.includes(term);
  if (terms.length > 0 && !(anyMode ? terms.some(hit) : terms.every(hit))) return null;
  const snippets = [];
  for (const term of terms) {
    for (const [field, text] of fields) {
      if (field === 'title') continue;
      const piece = snippet(text, term);
      if (piece && !snippets.some((entry) => entry.text === piece)) {
        snippets.push({ field, text: piece });
        break;
      }
    }
    if (snippets.length >= 2) break;
  }
  return { record, snippets };
}

function csv(value) {
  return typeof value === 'string'
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
}

function facetCounts(hits, pick, limit = 12) {
  const counts = new Map();
  for (const hit of hits) {
    for (const value of pick(hit.record) || []) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, limit);
}

// 索引里存仓库相对路径，保持机器无关、可跨机器提交。
// 但被别的项目从另一个 cwd 调用时，相对路径读不到，所以在输出阶段解析成可用路径。
function resolvedPdfPath(record, cwd = process.cwd()) {
  if (!record.pdf_path) return '';
  const absolute = path.join(ROOT, record.pdf_path);
  const insideRepo = !path.relative(ROOT, cwd).startsWith('..') && !path.isAbsolute(path.relative(ROOT, cwd));
  return insideRepo ? record.pdf_path : absolute;
}

function formatHit(hit) {
  const record = hit.record;
  const head = [
    `[${record.priority}]`,
    record.snapshot_date || record.snapshot_month,
    record.title,
  ].filter(Boolean).join(' ');
  const meta = [
    record.sectors_cn.length ? record.sectors_cn.join('/') : null,
    record.report_type_label !== UNCLASSIFIED_LABEL ? record.report_type_label : null,
    record.topics.length ? record.topics.slice(0, 6).join('·') : null,
    record.tier !== 'ranked' ? `tier=${record.tier}` : null,
  ].filter(Boolean).join(' | ');
  const lines = [head];
  if (meta) lines.push(`  ${meta}`);
  for (const entry of hit.snippets) lines.push(`  ${entry.field}: ${entry.text}`);
  const location = resolvedPdfPath(record) || '(no local path)';
  lines.push(record.downloaded
    ? `  ${location}`
    : `  ${location}  NOT_DOWNLOADED media_id=${record.media_id}`);
  return lines.join('\n');
}

function runBuild(argv) {
  const result = buildIndex(MANIFESTS_DIR);
  const { stats } = result;
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      total: result.total,
      sources: stats.sources,
      ranked: stats.ranked,
      summary_only: stats.summary_only,
      index_only: stats.index_only,
      shards: result.written.map((shard) => ({
        month: shard.month,
        path: path.relative(ROOT, shard.path),
        count: shard.count,
      })),
    }));
    return;
  }
  console.log(`search index rebuilt from ${stats.sources} dated manifests`);
  for (const shard of result.written) {
    console.log(`  ${path.relative(ROOT, shard.path)}  ${shard.count}`);
  }
  console.log(`total ${result.total} (ranked ${stats.ranked}, summary_only ${stats.summary_only}, index_only ${stats.index_only})`);
}

function parseQueryArgs(argv) {
  const terms = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      terms.push(...arg.split(/\s+/).filter(Boolean));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return { terms, opts };
}

function runQuery(argv) {
  const { terms, opts } = parseQueryArgs(argv);

  const records = loadIndex(MANIFESTS_DIR, typeof opts.month === 'string' ? opts.month : '');
  if (records === null) {
    console.error('未找到 manifests/search-index-YYYYMM.jsonl，请先运行：node scripts/search-reports.cjs build');
    process.exit(2);
  }
  if (indexIsStale(MANIFESTS_DIR)) {
    console.error('警告：检索索引早于最新的 manifests，建议先运行：node scripts/search-reports.cjs build');
  }

  const lowered = terms.map((term) => term.toLowerCase());
  const priorities = new Set(csv(opts.priority));
  const tiers = new Set(csv(opts.tier));
  const types = new Set(csv(opts.type));
  const sectors = csv(opts.sector);
  const limit = typeof opts.limit === 'string' ? Number(opts.limit) : 30;

  const hits = [];
  for (const record of records) {
    if (priorities.size && !priorities.has(record.priority)) continue;
    if (tiers.size && !tiers.has(record.tier)) continue;
    if (types.size && !types.has(record.report_type)) continue;
    if (sectors.length && !sectors.some((sector) => record.sectors_cn.includes(sector))) continue;
    if (typeof opts.date === 'string' && record.snapshot_date !== opts.date) continue;
    if (opts.downloaded && !record.downloaded) continue;
    if (opts['not-downloaded'] && record.downloaded) continue;
    const hit = matchRecord(record, lowered, Boolean(opts.any));
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => (
    (PRIORITY_ORDER.get(a.record.priority) ?? 99) - (PRIORITY_ORDER.get(b.record.priority) ?? 99) ||
    b.record.snapshot_date.localeCompare(a.record.snapshot_date) ||
    (b.record.score ?? -1) - (a.record.score ?? -1) ||
    a.record.title.localeCompare(b.record.title, 'zh-Hans-CN')
  ));

  const shown = Number.isFinite(limit) && limit > 0 ? hits.slice(0, limit) : hits;

  if (opts.json) {
    for (const hit of shown) {
      // abs_path 是查询期字段，不落入索引：索引保持机器无关，调用方拿到的是可直接打开的路径。
      const absPath = hit.record.pdf_path ? path.join(ROOT, hit.record.pdf_path) : '';
      console.log(JSON.stringify({ ...hit.record, abs_path: absPath, repo_root: ROOT }));
    }
    return;
  }

  console.log(`命中 ${hits.length} 篇${hits.length > shown.length ? `，显示前 ${shown.length}` : ''}（关键词：${terms.join(' ') || '(无)'}）`);
  console.log('');
  for (const hit of shown) {
    console.log(formatHit(hit));
    console.log('');
  }

  if (opts.facets) {
    const render = (label, entries) => {
      if (entries.length === 0) return;
      console.log(`${label}: ${entries.map(([name, count]) => `${name}(${count})`).join('  ')}`);
    };
    console.log('--- facets（命中集合里这批数据实际用的词，可据此换词重查）---');
    render('topics', facetCounts(hits, (record) => record.topics));
    render('entities', facetCounts(hits, (record) => record.entities));
    render('sectors', facetCounts(hits, (record) => record.sectors_cn));
    render('content_tags', facetCounts(hits, (record) => record.content_tags));
    console.log('');
  }

  console.log(ROUTING_NOTE);
}

function usage() {
  console.log(`Usage:
  node scripts/search-reports.cjs build
  node scripts/search-reports.cjs query '<关键词>' [flags]

build   从 ai-ranked-queue-summary-*.jsonl、report-summaries-*.jsonl、index.jsonl
        和 downloaded.jsonl 幂等重建 manifests/search-index-YYYYMM.jsonl 分片。
  --json               输出机器可读的重建统计（供每日流程调用）

query   在索引上做大小写无关子串匹配。多个关键词默认 AND。
  --any                关键词改为 OR
  --priority P0,P1     按优先级过滤
  --type company       按 report_type 过滤
  --sector 信息技术    按一级行业过滤
  --month 202609       只查某月分片
  --date 2026-09-03    只查某天快照
  --tier ranked        只查某个数据层（ranked/summary_only/index_only）
  --downloaded         只看已下载
  --not-downloaded     只看未下载
  --limit 30           输出条数上限（默认 30，0 表示不限）
  --facets             额外打印命中集合的 topics/entities/sectors 词频
  --json               输出结构化索引行

跨项目调用：可从任意 cwd 运行本脚本的绝对路径，输出会自动给出绝对 pdf_path；
--json 额外带 abs_path 和 repo_root。

兜底：rg '<关键词>' manifests/search-index-*.jsonl。
注意 rg 匹配整行（含 media_id、summary_role 等非检索字段），召回范围比 query 宽。`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    return;
  }
  if (command === 'build') return runBuild(rest);
  if (command === 'query') return runQuery(rest);
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  buildIndex,
  resolvedPdfPath,
  loadIndex,
  matchRecord,
  parseCompanyFromTitle,
  toIndexRecord,
  parseQueryArgs,
  SHARD_RE,
};
