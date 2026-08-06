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

The renderer reads all non-empty manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl
files for the month and rebuilds one rolling monthly HTML dashboard.`);
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

function monthlyQueuePaths(manifestsDir, month) {
  const pattern = new RegExp(`^ai-ranked-queue-summary-${month}(\\d{2})\\.jsonl$`);
  return fs.readdirSync(manifestsDir)
    .map((name) => {
      const match = name.match(pattern);
      return match ? {
        path: path.join(manifestsDir, name),
        name,
        snapshotDate: `${month.slice(0, 4)}-${month.slice(4, 6)}-${match[1]}`,
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
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

function collectMonthlyRecords(manifestsDir, month) {
  const sources = monthlyQueuePaths(manifestsDir, month);
  const usedSources = [];
  const recordsByKey = new Map();
  for (const source of sources) {
    const sourceRecords = readJsonl(source.path);
    if (sourceRecords.length > 0) usedSources.push(source);
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
    <div class="subhead">${htmlEscape(monthLabel)} · 汇总 ${meta.sourceCount} 个日期化摘要排序队列。页面直接展示 DeepSeek 单轮排序结果。更新时间：${htmlEscape(generatedAt)}</div>
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

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return;
  }
  const month = normalizeMonth(opts.month);
  const manifestsDir = resolveRootPath(opts['manifests-dir'], MANIFESTS_DIR);
  const outputPath = resolveRootPath(
    opts.out,
    path.join(MANIFESTS_DIR, `ai-ranking-analysis-${month}.html`),
  );
  const { records, sources } = collectMonthlyRecords(manifestsDir, month);
  const html = renderHtml(records, { month, sourceCount: sources.length }).replace(/[ \t]+$/gm, '');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
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
  renderHtml,
  main,
};
