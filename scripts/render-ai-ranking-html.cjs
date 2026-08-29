#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
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
const UNCLASSIFIED_SECTOR_LABEL = '未分类行业';
const UNCLASSIFIED_COMPANY_KEY = '__unclassified__';
const UNCLASSIFIED_COMPANY_LABEL = '未归类公司';
const TICKER_RE = /[（(]([A-Za-z0-9]{1,10}\.[A-Za-z]{1,4})[）)]/;
const TYPE_ORDER = [...Object.values(REPORT_TYPE_LABELS), UNCLASSIFIED_LABEL];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage:
  node scripts/render-ai-ranking-html.cjs --month YYYYMM [--out manifests/ai-ranking-analysis-YYYYMM.html]
  node scripts/render-ai-ranking-html.cjs --hub [--out manifests/ai-ranking-analysis.html]

--month reads that month's non-empty ai-ranked-queue-summary-YYYYMMDD.jsonl files
and rebuilds the rolling monthly HTML snapshot.

--hub reads every dated summary queue, deduplicates by media_id, and rebuilds the
cross-month navigation hub.`);
}

function currentShanghaiMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}`;
}

function normalizeMonth(input) {
  const compact = String(input || currentShanghaiMonth()).replace('-', '');
  if (!/^\d{6}$/.test(compact)) throw new Error(`Invalid month: ${input}`);
  const month = Number(compact.slice(4, 6));
  if (month < 1 || month > 12) throw new Error(`Invalid month: ${input}`);
  return compact;
}

function resolveRootPath(input, fallback) {
  const value = input || fallback;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSONL: ${error.message}`);
    }
  });
}

function snapshotDateFromQueueName(name) {
  const match = String(name || '').match(/^ai-ranked-queue-summary-(\d{4})(\d{2})(\d{2})\.jsonl$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function monthlyQueuePaths(manifestsDir, month) {
  const pattern = new RegExp(`^ai-ranked-queue-summary-${month}\\d{2}\\.jsonl$`);
  return fs.readdirSync(manifestsDir)
    .map((name) => (pattern.test(name) ? {
      path: path.join(manifestsDir, name),
      name,
      snapshotDate: snapshotDateFromQueueName(name),
    } : null))
    .filter((source) => source && source.snapshotDate)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function allQueuePaths(manifestsDir) {
  return fs.readdirSync(manifestsDir)
    .map((name) => {
      const snapshotDate = snapshotDateFromQueueName(name);
      return snapshotDate ? {
        path: path.join(manifestsDir, name),
        name,
        snapshotDate,
      } : null;
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

function parseCompanyFromTitle(title, reportType = 'company') {
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

function primarySectorLabel(record) {
  const first = Array.isArray(record.sectors) ? record.sectors[0] : null;
  return (first && first.name_cn) || record.sector || UNCLASSIFIED_SECTOR_LABEL;
}

function snapshotMonth(snapshotDate) {
  return String(snapshotDate || '').replace(/-/g, '').slice(0, 6);
}

function slimDataPoints(points) {
  return (Array.isArray(points) ? points : []).map((point) => ({
    metric: point.metric || '',
    value_text: point.value_text || '',
    period: point.period || '',
    basis: point.basis || '',
    context: point.context || '',
  }));
}

function toHubRecord(record) {
  const company = parseCompanyFromTitle(record.title, record.report_type);
  return {
    media_id: record.media_id || '',
    title: record.title || '',
    snapshot_date: record.snapshot_date || '',
    snapshot_month: snapshotMonth(record.snapshot_date),
    priority: record.priority || 'UNREVIEWED',
    rank: record.rank ?? null,
    score: record.score ?? null,
    report_type: record.report_type || null,
    report_type_label: record.report_type_label || UNCLASSIFIED_LABEL,
    report_type_reason: record.report_type_reason || '',
    sector: primarySectorLabel(record),
    company_key: company.key,
    company_label: company.label,
    executive_summary: record.executive_summary || '',
    key_findings: Array.isArray(record.key_findings) ? record.key_findings : [],
    data_points: slimDataPoints(record.data_points),
    downloaded: Boolean(record.downloaded),
    download_href: record.download_href || '',
    local_relative_path: record.local_relative_path || '',
  };
}

function compareLabels(a, b, unclassified) {
  if (a === unclassified && b !== unclassified) return 1;
  if (b === unclassified && a !== unclassified) return -1;
  return String(a).localeCompare(String(b), 'zh-Hans-CN');
}

function buildNavTree(records) {
  const types = new Map();
  for (const record of records) {
    const typeLabel = record.report_type_label || UNCLASSIFIED_LABEL;
    if (!types.has(typeLabel)) {
      types.set(typeLabel, {
        key: record.report_type || 'unclassified',
        label: typeLabel,
        count: 0,
        sectors: new Map(),
      });
    }
    const typeNode = types.get(typeLabel);
    typeNode.count += 1;
    const sectorLabel = primarySectorLabel(record);
    if (!typeNode.sectors.has(sectorLabel)) {
      typeNode.sectors.set(sectorLabel, {
        label: sectorLabel,
        count: 0,
        companies: record.report_type === 'company' ? new Map() : null,
      });
    }
    const sectorNode = typeNode.sectors.get(sectorLabel);
    sectorNode.count += 1;
    if (sectorNode.companies) {
      const companyKey = record.company_key || UNCLASSIFIED_COMPANY_KEY;
      const companyLabel = record.company_label || UNCLASSIFIED_COMPANY_LABEL;
      const existing = sectorNode.companies.get(companyKey);
      if (!existing) {
        sectorNode.companies.set(companyKey, { key: companyKey, label: companyLabel, count: 0 });
      } else if (companyLabel.length > existing.label.length) {
        existing.label = companyLabel;
      }
      sectorNode.companies.get(companyKey).count += 1;
    }
  }

  return {
    count: records.length,
    types: TYPE_ORDER
      .filter((label) => types.has(label))
      .concat([...types.keys()].filter((label) => !TYPE_ORDER.includes(label)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
      .map((label) => {
        const typeNode = types.get(label);
        const sectors = [...typeNode.sectors.values()]
          .sort((a, b) => compareLabels(a.label, b.label, UNCLASSIFIED_SECTOR_LABEL))
          .map((sector) => ({
            label: sector.label,
            count: sector.count,
            companies: sector.companies
              ? [...sector.companies.values()].sort((a, b) => {
                if (a.key === UNCLASSIFIED_COMPANY_KEY) return 1;
                if (b.key === UNCLASSIFIED_COMPANY_KEY) return -1;
                return b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN');
              })
              : null,
          }));
        return {
          key: typeNode.key,
          label: typeNode.label,
          count: typeNode.count,
          sectors,
        };
      }),
  };
}

function fileHref(filePath) {
  return `file://${encodeURI(filePath).replace(/#/g, '%23')}`;
}

function normalizeRecord(record, snapshotDate) {
  const savedPath = record.saved_path ||
    (record.local_relative_path ? path.join(ROOT, 'downloads', record.local_relative_path) : '');
  const downloaded = Boolean(savedPath && fs.existsSync(savedPath));
  const priority = PRIORITY_ORDER.has(record.priority) ? record.priority : 'UNREVIEWED';
  return {
    media_id: record.media_id || '',
    title: record.title || record.source_title || '',
    source_path: record.source_path || '',
    local_relative_path: record.local_relative_path || '',
    saved_path: savedPath,
    snapshot_date: snapshotDate,
    priority,
    rank: Number.isFinite(Number(record.rank)) ? Number(record.rank) : null,
    score: Number.isFinite(Number(record.score)) ? Number(record.score) : null,
    report_type: record.report_type || null,
    report_type_label: REPORT_TYPE_LABELS[record.report_type] || UNCLASSIFIED_LABEL,
    report_type_reason: record.report_type_reason || '',
    sectors: Array.isArray(record.sectors) ? record.sectors : [],
    research_subject: record.research_subject || '',
    executive_summary: record.executive_summary || '',
    key_findings: Array.isArray(record.key_findings) ? record.key_findings : [],
    content_tags: Array.isArray(record.content_tags) ? record.content_tags : [],
    topics: Array.isArray(record.topics) ? record.topics : [],
    data_points: Array.isArray(record.data_points) ? record.data_points : [],
    entities: Array.isArray(record.entities) ? record.entities : [],
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
    reasons: Array.isArray(record.reasons) ? record.reasons : [],
    ranking_evidence: Array.isArray(record.ranking_evidence) ? record.ranking_evidence : [],
    false_positive_checks: Array.isArray(record.false_positive_checks) ? record.false_positive_checks : [],
    failure_code: record.failure_code || '',
    downloaded,
    download_href: downloaded ? fileHref(savedPath) : '',
    llm_model: record.llm_model || '',
    ranked_at: record.ranked_at || '',
  };
}

function recordKey(record) {
  return record.media_id || record.local_relative_path || record.source_path || record.title;
}

function collectRecordsFromSources(sources) {
  const usedSources = [];
  const recordsByKey = new Map();
  for (const source of sources) {
    const sourceRecords = readJsonl(source.path);
    if (sourceRecords.length === 0) continue;
    usedSources.push(source);
    for (const record of sourceRecords) {
      const normalized = normalizeRecord(record, source.snapshotDate);
      const key = recordKey(normalized);
      if (!key) continue;
      recordsByKey.set(key, normalized);
    }
  }
  const records = [...recordsByKey.values()].sort((a, b) => {
    return (
      b.snapshot_date.localeCompare(a.snapshot_date) ||
      (PRIORITY_ORDER.get(a.priority) ?? 99) - (PRIORITY_ORDER.get(b.priority) ?? 99) ||
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      (b.score ?? -1) - (a.score ?? -1) ||
      a.title.localeCompare(b.title, 'zh-Hans-CN')
    );
  });
  return { records, sources: usedSources };
}

function collectMonthlyRecords(manifestsDir, month) {
  return collectRecordsFromSources(monthlyQueuePaths(manifestsDir, month));
}

function collectAllRecords(manifestsDir) {
  return collectRecordsFromSources(allQueuePaths(manifestsDir));
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countPriority(records, priority) {
  return records.filter((record) => record.priority === priority).length;
}

function renderHtml(records, meta) {
  const embedded = JSON.stringify(records).replace(/</g, '\\u003c');
  const generatedAt = new Date().toISOString();
  const dates = [...new Set(records.map((record) => record.snapshot_date))].sort().reverse();
  const downloaded = records.filter((record) => record.downloaded).length;
  const monthLabel = `${meta.month.slice(0, 4)}年${Number(meta.month.slice(4, 6))}月`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Infrastructure 月度研报排序 · ${htmlEscape(monthLabel)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #fff;
      --ink: #182230;
      --muted: #667085;
      --line: #d9e0e7;
      --p0: #b42318;
      --p1: #b54708;
      --p2: #175cd3;
      --p3: #475467;
      --unreviewed: #6941c6;
      --green: #067647;
      --shadow: 0 8px 24px rgba(16, 24, 40, .07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    header {
      padding: 30px clamp(18px, 4vw, 58px);
      background: #101828;
      color: #fff;
    }
    h1 { margin: 0 0 8px; font-size: clamp(26px, 4vw, 42px); line-height: 1.1; }
    .subhead { max-width: 1050px; color: #d0d5dd; font-size: 14px; }
    header a { color: #84caff; }
    main { padding: 22px clamp(16px, 4vw, 58px) 52px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric {
      padding: 13px 15px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { margin-top: 4px; font-size: 26px; font-weight: 800; }
    .layout {
      display: grid;
      grid-template-columns: minmax(230px, 290px) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    aside, .day-group {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    aside { position: sticky; top: 12px; padding: 15px; }
    .filter { margin-top: 12px; }
    .filter:first-child { margin-top: 0; }
    label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    .result-note { margin-top: 14px; color: var(--muted); font-size: 13px; }
    #groups { display: grid; gap: 16px; }
    .day-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: #f8fafc;
    }
    .day-head h2 { margin: 0; font-size: 18px; }
    .day-stats { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .cards { display: grid; gap: 10px; padding: 12px; }
    .card {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 12px;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 9px;
    }
    .rank {
      padding-right: 12px;
      border-right: 1px solid var(--line);
      text-align: center;
    }
    .rank strong { display: block; font-size: 21px; }
    .rank span { color: var(--muted); font-size: 11px; }
    .meta, .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .badge, .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
    }
    .badge { color: #fff; font-weight: 800; }
    .badge.p0 { background: var(--p0); }
    .badge.p1 { background: var(--p1); }
    .badge.p2 { background: var(--p2); }
    .badge.p3 { background: var(--p3); }
    .badge.unreviewed { background: var(--unreviewed); }
    .badge.local { background: var(--green); }
    .tag { border: 1px solid #ccd6e0; background: #f8fafc; color: #344054; }
    .title { margin: 7px 0 4px; font-size: 16px; overflow-wrap: anywhere; }
    .subject, .reason, .path, .evidence { margin-top: 7px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .summary {
      margin: 10px 0 0;
      padding: 10px 12px;
      border-left: 3px solid #1570ef;
      background: #f5f9ff;
      font-size: 13px;
      line-height: 1.65;
    }
    .findings { margin: 8px 0 0 18px; padding: 0; color: #344054; font-size: 12px; }
    .numbers {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 7px;
      margin-top: 9px;
    }
    .number {
      padding: 8px 9px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fcfcfd;
      font-size: 12px;
    }
    .number strong { display: block; margin-bottom: 2px; }
    a { color: #175cd3; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { padding: 40px; text-align: center; color: var(--muted); }
    @media (max-width: 850px) {
      .layout { grid-template-columns: 1fr; }
      aside { position: static; }
      .card { grid-template-columns: 1fr; }
      .rank { display: flex; gap: 7px; align-items: baseline; border: 0; padding: 0; text-align: left; }
    }
  </style>
</head>
<body>
  <header>
    <h1>AI Infrastructure 月度研报排序</h1>
    <div class="subhead">${htmlEscape(monthLabel)} · 汇总 ${meta.sourceCount} 个日期化摘要排序队列。页面直接展示 DeepSeek 单轮排序结果。更新时间：${htmlEscape(generatedAt)} · <a href="ai-ranking-analysis.html">打开汇总导航</a></div>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><div class="label">全部研报</div><div class="value">${records.length}</div></div>
      <div class="metric"><div class="label">P0</div><div class="value">${countPriority(records, 'P0')}</div></div>
      <div class="metric"><div class="label">P1</div><div class="value">${countPriority(records, 'P1')}</div></div>
      <div class="metric"><div class="label">P2</div><div class="value">${countPriority(records, 'P2')}</div></div>
      <div class="metric"><div class="label">P3</div><div class="value">${countPriority(records, 'P3')}</div></div>
      <div class="metric"><div class="label">UNREVIEWED</div><div class="value">${countPriority(records, 'UNREVIEWED')}</div></div>
      <div class="metric"><div class="label">本地已有</div><div class="value">${downloaded}</div></div>
      <div class="metric"><div class="label">日期</div><div class="value">${dates.length}</div></div>
    </div>
    <div class="layout">
      <aside>
        <div class="filter">
          <label for="search">搜索</label>
          <input id="search" type="search" placeholder="标题、摘要、实体、数据、理由">
        </div>
        <div class="filter">
          <label for="priority">优先级</label>
          <select id="priority"><option value="">P0–P3 + UNREVIEWED</option></select>
        </div>
        <div class="filter">
          <label for="date">日期</label>
          <select id="date"><option value="">当月全部日期</option></select>
        </div>
        <div class="filter">
          <label for="reportType">报告类型</label>
          <select id="reportType"><option value="">全部类型</option></select>
        </div>
        <div class="filter">
          <label for="sector">行业</label>
          <select id="sector"><option value="">全部行业</option></select>
        </div>
        <div class="filter">
          <label for="local">本地 PDF</label>
          <select id="local">
            <option value="">全部</option>
            <option value="yes">本地已有</option>
            <option value="no">尚未下载</option>
          </select>
        </div>
        <div class="result-note">当前显示 <strong id="result-count">${records.length}</strong> 篇</div>
      </aside>
      <div id="groups"></div>
    </div>
  </main>
  <script id="records" type="application/json">${embedded}</script>
  <script>
    const records = JSON.parse(document.getElementById('records').textContent);
    const priorities = ${JSON.stringify(PRIORITIES)};
    const state = { search: '', priority: '', date: '', reportType: '', sector: '', local: '' };
    const els = {
      search: document.getElementById('search'),
      priority: document.getElementById('priority'),
      date: document.getElementById('date'),
      reportType: document.getElementById('reportType'),
      sector: document.getElementById('sector'),
      local: document.getElementById('local'),
      groups: document.getElementById('groups'),
      resultCount: document.getElementById('result-count'),
    };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
    const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
    const addOptions = (el, values) => values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      el.appendChild(option);
    });
    addOptions(els.priority, priorities.filter((priority) => records.some((record) => record.priority === priority)));
    addOptions(els.date, unique(records.map((record) => record.snapshot_date)).reverse());
    addOptions(els.reportType, unique(records.map((record) => record.report_type_label)));
    addOptions(els.sector, unique(records.flatMap((record) => (record.sectors || []).map((sector) => sector.name_cn))));

    function textBlob(record) {
      return [
        record.title, record.research_subject, record.executive_summary, record.source_path,
        record.report_type_reason,
        ...(record.key_findings || []), ...(record.content_tags || []), ...(record.topics || []),
        ...(record.entities || []), ...(record.reasons || []), ...(record.ranking_evidence || []),
        ...(record.sectors || []).flatMap((sector) => [sector.name_cn, sector.name_en]),
        ...(record.data_points || []).flatMap((point) => [point.metric, point.value_text, point.period, point.context]),
      ].join(' ').toLowerCase();
    }
    function filtered() {
      const query = state.search.trim().toLowerCase();
      return records.filter((record) => {
        if (state.priority && record.priority !== state.priority) return false;
        if (state.date && record.snapshot_date !== state.date) return false;
        if (state.reportType && record.report_type_label !== state.reportType) return false;
        if (state.sector && !(record.sectors || []).some((sector) => sector.name_cn === state.sector)) return false;
        if (state.local === 'yes' && !record.downloaded) return false;
        if (state.local === 'no' && record.downloaded) return false;
        return !query || textBlob(record).includes(query);
      });
    }
    function renderTags(items) {
      return (items || []).map((item) => '<span class="tag">' + escapeHtml(item) + '</span>').join('');
    }
    function renderCard(record) {
      const local = record.downloaded ? '<span class="badge local">本地已有</span>' : '';
      const link = record.download_href ? '<a href="' + escapeHtml(record.download_href) + '">打开本地 PDF</a>' : '尚未下载';
      const findings = record.key_findings.length
        ? '<ul class="findings">' + record.key_findings.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
        : '';
      const numbers = record.data_points.length
        ? '<div class="numbers">' + record.data_points.map((point) =>
            '<div class="number"><strong>' + escapeHtml(point.metric) + '</strong>' +
            escapeHtml([point.value_text, point.period, point.basis].filter(Boolean).join(' · ')) +
            (point.context ? '<div>' + escapeHtml(point.context) + '</div>' : '') + '</div>'
          ).join('') + '</div>'
        : '';
      const evidence = record.ranking_evidence.length
        ? '<div class="evidence">排序证据：' + escapeHtml(record.ranking_evidence.join(' / ')) + '</div>'
        : '';
      const failure = record.failure_code ? '<div class="evidence">状态：' + escapeHtml(record.failure_code) + '</div>' : '';
      const sectorNames = (record.sectors || []).map((sector) => sector.name_cn);
      return '<article class="card">' +
        '<div class="rank"><strong>#' + escapeHtml(record.rank ?? '-') + '</strong><span>当日排序</span></div>' +
        '<div><div class="meta"><span class="badge ' + record.priority.toLowerCase() + '">' + escapeHtml(record.priority) + '</span>' +
        local + '<span class="tag">score ' + escapeHtml(record.score ?? '-') + '</span><span class="tag">' + escapeHtml(record.report_type_label) + '</span></div>' +
        '<h3 class="title">' + escapeHtml(record.title) + '</h3>' +
        (record.research_subject ? '<div class="subject">研究主体：' + escapeHtml(record.research_subject) + '</div>' : '') +
        (sectorNames.length ? '<div class="tags">' + renderTags(sectorNames) + '</div>' : '') +
        (record.report_type_reason ? '<div class="reason">类型依据：' + escapeHtml(record.report_type_reason) + '</div>' : '') +
        '<div class="tags">' + renderTags([...(record.content_tags || []), ...(record.topics || [])]) + '</div>' +
        (record.reasons.length ? '<div class="reason">排序理由：' + escapeHtml(record.reasons.join('；')) + '</div>' : '') +
        (record.executive_summary ? '<p class="summary"><strong>IMA 摘要：</strong>' + escapeHtml(record.executive_summary) + '</p>' : '') +
        findings + numbers +
        (record.entities.length ? '<div class="tags">' + renderTags(record.entities) + '</div>' : '') +
        evidence + failure +
        '<div class="path">IMA 路径：' + escapeHtml(record.source_path) + '</div>' +
        '<div class="path">本地路径：' + escapeHtml(record.local_relative_path) + ' · ' + link + '</div></div></article>';
    }
    function render() {
      const rows = filtered();
      els.resultCount.textContent = rows.length;
      const groups = new Map();
      for (const record of rows) {
        if (!groups.has(record.snapshot_date)) groups.set(record.snapshot_date, []);
        groups.get(record.snapshot_date).push(record);
      }
      els.groups.innerHTML = [...groups.entries()].map(([date, dayRows]) => {
        const stats = priorities
          .map((priority) => [priority, dayRows.filter((record) => record.priority === priority).length])
          .filter(([, count]) => count)
          .map(([priority, count]) => '<span class="badge ' + priority.toLowerCase() + '">' + priority + ' ' + count + '</span>')
          .join('');
        return '<section class="day-group"><div class="day-head"><h2>' + escapeHtml(date) + '</h2>' +
          '<div class="day-stats">' + stats + '<span class="tag">合计 ' + dayRows.length + '</span></div></div>' +
          '<div class="cards">' + dayRows.map(renderCard).join('') + '</div></section>';
      }).join('') || '<div class="day-group empty">没有符合筛选条件的研报</div>';
    }
    for (const key of Object.keys(state)) {
      els[key].addEventListener(key === 'search' ? 'input' : 'change', () => {
        state[key] = els[key].value;
        render();
      });
    }
    render();
  </script>
</body>
</html>`;
}

function monthChipLabel(compact) {
  if (!/^\d{6}$/.test(compact)) return compact;
  return `${compact.slice(0, 4)}年${Number(compact.slice(4, 6))}月`;
}

function renderHubHtml(records, meta) {
  const embedded = JSON.stringify(records).replace(/</g, '\\u003c');
  const generatedAt = new Date().toISOString();
  const months = [...new Set(records.map((record) => record.snapshot_month).filter(Boolean))].sort().reverse();
  const downloaded = records.filter((record) => record.downloaded).length;
  const monthChips = months.map((month) => (
    `<button type="button" class="month-chip" data-month="${htmlEscape(month)}">${htmlEscape(monthChipLabel(month))}</button>`
  )).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Infrastructure 研报导航</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #fff;
      --ink: #182230;
      --muted: #667085;
      --line: #d9e0e7;
      --p0: #b42318;
      --p1: #b54708;
      --p2: #175cd3;
      --p3: #475467;
      --unreviewed: #6941c6;
      --green: #067647;
      --accent: #1570ef;
      --shadow: 0 8px 24px rgba(16, 24, 40, .07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    header {
      padding: 28px clamp(18px, 4vw, 58px);
      background: #101828;
      color: #fff;
    }
    h1 { margin: 0 0 8px; font-size: clamp(24px, 4vw, 38px); line-height: 1.1; }
    .subhead { max-width: 1100px; color: #d0d5dd; font-size: 14px; }
    header a { color: #84caff; }
    .month-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .month-chip {
      border: 1px solid #344054;
      background: #1d2939;
      color: #e4e7ec;
      border-radius: 999px;
      min-height: 30px;
      padding: 2px 12px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .month-chip.active, .month-chip:hover { background: #175cd3; border-color: #175cd3; color: #fff; }
    main { padding: 22px clamp(16px, 4vw, 58px) 52px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric {
      padding: 13px 15px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { margin-top: 4px; font-size: 24px; font-weight: 800; }
    .layout {
      display: grid;
      grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    aside, .panel {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    aside { position: sticky; top: 12px; padding: 15px; max-height: calc(100vh - 24px); overflow: auto; }
    .filter { margin-top: 12px; }
    .filter:first-child { margin-top: 0; }
    label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    .result-note { margin-top: 12px; color: var(--muted); font-size: 13px; }
    .tree { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
    .tree-node {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 8px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      padding: 6px 8px;
      border-radius: 7px;
      cursor: pointer;
    }
    .tree-node:hover { background: #f2f4f7; }
    .tree-node.active { background: #eff8ff; color: var(--accent); font-weight: 700; }
    .tree-node .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .tree-node .count {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .tree-node.active .count { color: var(--accent); }
    .tree-children { padding-left: 12px; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: #f8fafc;
    }
    .panel-head h2 { margin: 0; font-size: 16px; }
    .rows { display: grid; }
    .row { border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    .row-head {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      width: 100%;
      padding: 11px 14px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row-head:hover { background: #f8fafc; }
    .row.open .row-head { background: #f5f9ff; }
    .row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .row-date { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .detail { display: none; padding: 0 14px 14px; }
    .row.open .detail { display: block; }
    .meta, .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .badge, .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
    }
    .badge { color: #fff; font-weight: 800; }
    .badge.p0 { background: var(--p0); }
    .badge.p1 { background: var(--p1); }
    .badge.p2 { background: var(--p2); }
    .badge.p3 { background: var(--p3); }
    .badge.unreviewed { background: var(--unreviewed); }
    .badge.local { background: var(--green); }
    .tag { border: 1px solid #ccd6e0; background: #f8fafc; color: #344054; }
    .title { margin: 8px 0 4px; font-size: 16px; overflow-wrap: anywhere; }
    .reason, .path { margin-top: 7px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .summary {
      margin: 10px 0 0;
      padding: 10px 12px;
      border-left: 3px solid var(--accent);
      background: #f5f9ff;
      font-size: 13px;
      line-height: 1.65;
    }
    .findings { margin: 8px 0 0 18px; padding: 0; color: #344054; font-size: 12px; }
    .numbers {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 7px;
      margin-top: 9px;
    }
    .number {
      padding: 8px 9px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fcfcfd;
      font-size: 12px;
    }
    .number strong { display: block; margin-bottom: 2px; }
    a { color: #175cd3; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { padding: 40px; text-align: center; color: var(--muted); }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      aside { position: static; max-height: none; }
      .row-head { grid-template-columns: auto minmax(0, 1fr); }
      .row-date, .row-head .badge.local { grid-column: 2; }
    }
  </style>
</head>
<body>
  <header>
    <h1>AI Infrastructure 研报导航</h1>
    <div class="subhead">跨月份汇总入口 · ${htmlEscape(String(meta.sourceCount))} 个日期化摘要排序队列 · 左侧按类型 / 行业 / 公司看篇数，右侧点开详情。月度快照仍按月生成。更新时间：${htmlEscape(generatedAt)}</div>
    <div class="month-row" id="month-chips">${monthChips}</div>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><div class="label">全部研报</div><div class="value">${records.length}</div></div>
      <div class="metric"><div class="label">P0</div><div class="value">${countPriority(records, 'P0')}</div></div>
      <div class="metric"><div class="label">P1</div><div class="value">${countPriority(records, 'P1')}</div></div>
      <div class="metric"><div class="label">P2</div><div class="value">${countPriority(records, 'P2')}</div></div>
      <div class="metric"><div class="label">P3</div><div class="value">${countPriority(records, 'P3')}</div></div>
      <div class="metric"><div class="label">UNREVIEWED</div><div class="value">${countPriority(records, 'UNREVIEWED')}</div></div>
      <div class="metric"><div class="label">本地已有</div><div class="value">${downloaded}</div></div>
      <div class="metric"><div class="label">月份</div><div class="value">${months.length}</div></div>
    </div>
    <div class="layout">
      <aside>
        <div class="filter">
          <label for="search">搜索</label>
          <input id="search" type="search" placeholder="标题、公司、摘要、行业">
        </div>
        <div class="filter">
          <label for="month">月份</label>
          <select id="month"><option value="">全部月份</option></select>
        </div>
        <div class="filter">
          <label for="priority">优先级</label>
          <select id="priority"><option value="">P0–P3 + UNREVIEWED</option></select>
        </div>
        <div class="filter">
          <label for="local">本地 PDF</label>
          <select id="local">
            <option value="">全部</option>
            <option value="yes">本地已有</option>
            <option value="no">尚未下载</option>
          </select>
        </div>
        <div class="result-note">当前显示 <strong id="result-count">${records.length}</strong> 篇</div>
        <nav class="tree" id="tree" aria-label="类型行业公司导航"></nav>
      </aside>
      <div class="panel">
        <div class="panel-head">
          <h2 id="panel-title">全部研报</h2>
          <span class="tag" id="panel-count">${records.length}</span>
        </div>
        <div class="rows" id="rows"></div>
      </div>
    </div>
  </main>
  <script id="records" type="application/json">${embedded}</script>
  <script>
    const records = JSON.parse(document.getElementById('records').textContent);
    const priorities = ${JSON.stringify(PRIORITIES)};
    const unclassifiedSector = ${JSON.stringify(UNCLASSIFIED_SECTOR_LABEL)};
    const unclassifiedCompanyKey = ${JSON.stringify(UNCLASSIFIED_COMPANY_KEY)};
    const unclassifiedCompanyLabel = ${JSON.stringify(UNCLASSIFIED_COMPANY_LABEL)};
    const typeOrder = ${JSON.stringify(TYPE_ORDER)};
    const state = { search: '', month: '', priority: '', local: '', type: '', sector: '', company: '', expanded: '' };
    const els = {
      search: document.getElementById('search'),
      month: document.getElementById('month'),
      priority: document.getElementById('priority'),
      local: document.getElementById('local'),
      tree: document.getElementById('tree'),
      rows: document.getElementById('rows'),
      resultCount: document.getElementById('result-count'),
      panelTitle: document.getElementById('panel-title'),
      panelCount: document.getElementById('panel-count'),
    };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
    const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    const addOptions = (el, values, labels) => values.forEach((value, index) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = labels ? labels[index] : value;
      el.appendChild(option);
    });
    const monthLabel = (compact) => compact.slice(0, 4) + '年' + Number(compact.slice(4, 6)) + '月';
    addOptions(els.priority, priorities.filter((priority) => records.some((record) => record.priority === priority)));
    const monthValues = unique(records.map((record) => record.snapshot_month)).reverse();
    addOptions(els.month, monthValues, monthValues.map(monthLabel));

    function compareLabels(a, b, unclassified) {
      if (a === unclassified && b !== unclassified) return 1;
      if (b === unclassified && a !== unclassified) return -1;
      return String(a).localeCompare(String(b), 'zh-Hans-CN');
    }
    function buildNavTree(rows) {
      const types = new Map();
      for (const record of rows) {
        const typeLabel = record.report_type_label || '未分类';
        if (!types.has(typeLabel)) {
          types.set(typeLabel, { key: record.report_type || 'unclassified', label: typeLabel, count: 0, sectors: new Map() });
        }
        const typeNode = types.get(typeLabel);
        typeNode.count += 1;
        const sectorLabel = record.sector || unclassifiedSector;
        if (!typeNode.sectors.has(sectorLabel)) {
          typeNode.sectors.set(sectorLabel, {
            label: sectorLabel,
            count: 0,
            companies: record.report_type === 'company' ? new Map() : null,
          });
        }
        const sectorNode = typeNode.sectors.get(sectorLabel);
        sectorNode.count += 1;
        if (sectorNode.companies) {
          const companyKey = record.company_key || unclassifiedCompanyKey;
          const companyLabel = record.company_label || unclassifiedCompanyLabel;
          const existing = sectorNode.companies.get(companyKey);
          if (!existing) sectorNode.companies.set(companyKey, { key: companyKey, label: companyLabel, count: 0 });
          else if (companyLabel.length > existing.label.length) existing.label = companyLabel;
          sectorNode.companies.get(companyKey).count += 1;
        }
      }
      const ordered = typeOrder.filter((label) => types.has(label))
        .concat([...types.keys()].filter((label) => !typeOrder.includes(label)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
      return {
        count: rows.length,
        types: ordered.map((label) => {
          const typeNode = types.get(label);
          return {
            key: typeNode.key,
            label: typeNode.label,
            count: typeNode.count,
            sectors: [...typeNode.sectors.values()]
              .sort((a, b) => compareLabels(a.label, b.label, unclassifiedSector))
              .map((sector) => ({
                label: sector.label,
                count: sector.count,
                companies: sector.companies
                  ? [...sector.companies.values()].sort((a, b) => {
                    if (a.key === unclassifiedCompanyKey) return 1;
                    if (b.key === unclassifiedCompanyKey) return -1;
                    return b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN');
                  })
                  : null,
              })),
          };
        }),
      };
    }
    function textBlob(record) {
      return [
        record.title, record.company_label, record.sector, record.executive_summary,
        record.report_type_label, record.report_type_reason, record.local_relative_path,
        ...(record.key_findings || []),
        ...(record.data_points || []).flatMap((point) => [point.metric, point.value_text, point.period, point.context]),
      ].join(' ').toLowerCase();
    }
    function globallyFiltered() {
      const query = state.search.trim().toLowerCase();
      return records.filter((record) => {
        if (state.month && record.snapshot_month !== state.month) return false;
        if (state.priority && record.priority !== state.priority) return false;
        if (state.local === 'yes' && !record.downloaded) return false;
        if (state.local === 'no' && record.downloaded) return false;
        return !query || textBlob(record).includes(query);
      });
    }
    function listed(rows) {
      return rows.filter((record) => {
        if (state.type && record.report_type_label !== state.type) return false;
        if (state.sector && record.sector !== state.sector) return false;
        if (state.company && (record.company_key || unclassifiedCompanyKey) !== state.company) return false;
        return true;
      });
    }
    function nodeClass(active) {
      return 'tree-node' + (active ? ' active' : '');
    }
    function treeButton(label, count, active, attrs) {
      return '<button type="button" class="' + nodeClass(active) + '" ' + attrs + '><span class="name">' +
        escapeHtml(label) + '</span><span class="count">' + count + '</span></button>';
    }
    function renderTree(rows) {
      const tree = buildNavTree(rows);
      let html = treeButton('全部', tree.count, !state.type, 'data-type="" data-sector="" data-company=""');
      for (const typeNode of tree.types) {
        html += treeButton(typeNode.label, typeNode.count, state.type === typeNode.label && !state.sector,
          'data-type="' + escapeHtml(typeNode.label) + '" data-sector="" data-company=""');
        html += '<div class="tree-children">';
        for (const sector of typeNode.sectors) {
          const sectorActive = state.type === typeNode.label && state.sector === sector.label && !state.company;
          html += treeButton(sector.label, sector.count, sectorActive,
            'data-type="' + escapeHtml(typeNode.label) + '" data-sector="' + escapeHtml(sector.label) + '" data-company=""');
          const showCompanies = sector.companies && state.type === typeNode.label && state.sector === sector.label;
          if (showCompanies) {
            html += '<div class="tree-children">';
            for (const company of sector.companies) {
              html += treeButton(company.label, company.count, state.company === company.key,
                'data-type="' + escapeHtml(typeNode.label) + '" data-sector="' + escapeHtml(sector.label) +
                '" data-company="' + escapeHtml(company.key) + '"');
            }
            html += '</div>';
          }
        }
        html += '</div>';
      }
      els.tree.innerHTML = html;
    }
    function panelHeading() {
      if (state.company) return state.company === unclassifiedCompanyKey ? unclassifiedCompanyLabel : (listed(globallyFiltered())[0]?.company_label || state.company);
      if (state.sector) return state.type + ' · ' + state.sector;
      if (state.type) return state.type;
      return '全部研报';
    }
    function renderDetail(record) {
      const local = record.downloaded ? '<span class="badge local">本地已有</span>' : '';
      const link = record.download_href ? '<a href="' + escapeHtml(record.download_href) + '">打开本地 PDF</a>' : '尚未下载';
      const findings = (record.key_findings || []).length
        ? '<ul class="findings">' + record.key_findings.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
        : '';
      const numbers = (record.data_points || []).length
        ? '<div class="numbers">' + record.data_points.map((point) =>
            '<div class="number"><strong>' + escapeHtml(point.metric) + '</strong>' +
            escapeHtml([point.value_text, point.period, point.basis].filter(Boolean).join(' · ')) +
            (point.context ? '<div>' + escapeHtml(point.context) + '</div>' : '') + '</div>'
          ).join('') + '</div>'
        : '';
      return '<div class="meta">' + local + '<span class="tag">score ' + escapeHtml(record.score ?? '-') +
        '</span><span class="tag">' + escapeHtml(record.report_type_label) + '</span>' +
        (record.company_label ? '<span class="tag">' + escapeHtml(record.company_label) + '</span>' : '') +
        '<span class="tag">' + escapeHtml(record.sector) + '</span></div>' +
        '<h3 class="title">' + escapeHtml(record.title) + '</h3>' +
        (record.report_type_reason ? '<div class="reason">类型依据：' + escapeHtml(record.report_type_reason) + '</div>' : '') +
        (record.executive_summary ? '<p class="summary"><strong>IMA 摘要：</strong>' + escapeHtml(record.executive_summary) + '</p>' : '') +
        findings + numbers +
        '<div class="path">本地路径：' + escapeHtml(record.local_relative_path) + ' · ' + link + '</div>';
    }
    function renderRows(rows) {
      els.resultCount.textContent = rows.length;
      els.panelCount.textContent = rows.length;
      els.panelTitle.textContent = panelHeading();
      if (!rows.length) {
        els.rows.innerHTML = '<div class="empty">没有符合筛选条件的研报</div>';
        return;
      }
      els.rows.innerHTML = rows.map((record) => {
        const open = state.expanded === record.media_id;
        const local = record.downloaded ? '<span class="badge local">本地</span>' : '';
        return '<article class="row' + (open ? ' open' : '') + '" data-id="' + escapeHtml(record.media_id) + '">' +
          '<button type="button" class="row-head">' +
          '<span class="badge ' + record.priority.toLowerCase() + '">' + escapeHtml(record.priority) + '</span>' +
          '<span class="row-date">' + escapeHtml(record.snapshot_date) + '</span>' +
          '<span class="row-title">' + escapeHtml(record.title) + '</span>' + local +
          '</button>' +
          (open ? '<div class="detail">' + renderDetail(record) + '</div>' : '') +
          '</article>';
      }).join('');
    }
    function render() {
      const scoped = globallyFiltered();
      renderTree(scoped);
      renderRows(listed(scoped));
      document.querySelectorAll('.month-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.month === state.month);
      });
      els.month.value = state.month;
    }
    els.tree.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-type]');
      if (!button) return;
      state.type = button.dataset.type || '';
      state.sector = button.dataset.sector || '';
      state.company = button.dataset.company || '';
      state.expanded = '';
      render();
    });
    els.rows.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      const row = event.target.closest('.row');
      if (!row) return;
      const id = row.dataset.id;
      if (state.expanded === id) {
        state.expanded = '';
        row.classList.remove('open');
        const detail = row.querySelector('.detail');
        if (detail) detail.remove();
        return;
      }
      const prev = els.rows.querySelector('.row.open');
      if (prev) {
        prev.classList.remove('open');
        const oldDetail = prev.querySelector('.detail');
        if (oldDetail) oldDetail.remove();
      }
      state.expanded = id;
      row.classList.add('open');
      const record = records.find((item) => item.media_id === id);
      if (record) row.insertAdjacentHTML('beforeend', '<div class="detail">' + renderDetail(record) + '</div>');
    });
    document.getElementById('month-chips').addEventListener('click', (event) => {
      const chip = event.target.closest('.month-chip');
      if (!chip) return;
      state.month = state.month === chip.dataset.month ? '' : chip.dataset.month;
      render();
    });
    for (const key of ['search', 'month', 'priority', 'local']) {
      els[key].addEventListener(key === 'search' ? 'input' : 'change', () => {
        state[key] = els[key].value;
        render();
      });
    }
    render();
  </script>
</body>
</html>`;
}

function writeHtml(outputPath, html) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html.replace(/[ \t]+$/gm, ''), 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return;
  }
  const manifestsDir = resolveRootPath(opts['manifests-dir'], MANIFESTS_DIR);
  if (opts.hub) {
    const outputPath = resolveRootPath(opts.out, path.join(MANIFESTS_DIR, 'ai-ranking-analysis.html'));
    const { records, sources } = collectAllRecords(manifestsDir);
    const hubRecords = records.map(toHubRecord);
    writeHtml(outputPath, renderHubHtml(hubRecords, { sourceCount: sources.length }));
    const months = [...new Set(hubRecords.map((record) => record.snapshot_month).filter(Boolean))].sort();
    console.log(JSON.stringify({
      output: outputPath,
      hub: true,
      source_files: sources.map((source) => source.name),
      records: hubRecords.length,
      months,
      downloaded: hubRecords.filter((record) => record.downloaded).length,
    }, null, 2));
    return;
  }
  const month = normalizeMonth(opts.month);
  const outputPath = resolveRootPath(
    opts.out,
    path.join(MANIFESTS_DIR, `ai-ranking-analysis-${month}.html`),
  );
  const { records, sources } = collectMonthlyRecords(manifestsDir, month);
  writeHtml(outputPath, renderHtml(records, { month, sourceCount: sources.length }));
  const byPriority = Object.fromEntries(PRIORITIES.map((priority) => [priority, countPriority(records, priority)]));
  console.log(JSON.stringify({
    output: outputPath,
    month,
    source_files: sources.map((source) => source.name),
    records: records.length,
    by_priority: byPriority,
    downloaded: records.filter((record) => record.downloaded).length,
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  normalizeMonth,
  monthlyQueuePaths,
  collectMonthlyRecords,
  collectAllRecords,
  parseCompanyFromTitle,
  toHubRecord,
  buildNavTree,
  renderHtml,
  renderHubHtml,
  UNCLASSIFIED_COMPANY_KEY,
  UNCLASSIFIED_COMPANY_LABEL,
  UNCLASSIFIED_SECTOR_LABEL,
  main,
};
