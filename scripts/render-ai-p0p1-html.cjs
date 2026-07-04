#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_QUEUE_PATH = path.join(ROOT, 'manifests', 'ai-ranked-queue.jsonl');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'manifests', 'ai-p0p1-analysis.html');

const BUCKETS = [
  {
    id: 'aidc-capex',
    name: 'AIDC / Cloud Capex',
    match: ['aidc_capex', 'cloud_capex', 'data_center_capex', 'ai_infrastructure', 'data_center'],
    keywords: ['AIDC', 'AI基础设施', '人工智能基础设施', '数据中心资本开支', '资本开支', 'capex', '云资本开支'],
  },
  {
    id: 'ai-compute',
    name: 'AI Server / GPU / ASIC / HBM',
    match: ['ai_server', 'gpu', 'asic', 'hbm_memory', 'storage', 'data_center_storage'],
    keywords: ['AI服务器', '英伟达', 'NVIDIA', 'NVDA', 'GPU', 'ASIC', 'TPU', 'HBM', 'DRAM', '存储芯片', '希捷', '西部数据'],
  },
  {
    id: 'optical-network',
    name: 'Optical / DC Network',
    match: ['optical_interconnect', 'data_center_network', 'cpo'],
    keywords: ['光互联', '光通信', '光模块', 'CPO', '数据中心网络', '园区网络', '交换机', '以太网'],
  },
  {
    id: 'power-cooling',
    name: 'Power / Cooling / Energy',
    match: ['data_center_power', 'data_center_cooling', 'liquid_cooling'],
    keywords: ['电力', '供电', '冷却', '液冷', '散热', '能源', '燃气', '电网', 'HVDC'],
  },
  {
    id: 'semi-upstream',
    name: 'Semi Upstream / Packaging / Equipment',
    match: [
      'semiconductor_upstream',
      'semiconductor_equipment',
      'advanced_packaging',
      'cowos',
      'wafer_fab_expansion',
      'abf_substrate',
      'abf',
      'pcb',
      'mlcc',
      'ai_semiconductor',
    ],
    keywords: ['半导体', '晶圆', '晶圆厂', '设备', '材料', 'CoWoS', '先进封装', 'ABF', 'PCB', 'MLCC', '台积电', 'ASML'],
  },
  {
    id: 'robotics',
    name: 'Humanoid / Embodied AI',
    match: ['humanoid_robotics', 'embodied_ai', 'industrial_automation'],
    keywords: ['人形机器人', '具身智能', 'Physical AI', '机器人', '自动化'],
  },
  {
    id: 'ai-pc-it',
    name: 'AI PC / IT Spend',
    match: ['ai_pc', 'it_spending', 'cloud_computing'],
    keywords: ['AI PC', '个人电脑', 'IT支出', 'IT服务', '云支出', '企业IT'],
  },
];

const PRIORITY_WEIGHT = { P0: 1000, P1: 700 };

function usage() {
  console.log(`Usage:
  node scripts/render-ai-p0p1-html.cjs [--queue manifests/ai-ranked-queue.jsonl] [--out manifests/ai-p0p1-analysis.html]`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
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
  return opts;
}

function resolveRootPath(input, defaultPath) {
  const value = input || defaultPath;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`${filePath}:${index + 1} is not valid JSONL: ${err.message}`);
    }
  });
}

function countBy(records, getKey) {
  const counts = new Map();
  for (const record of records) {
    const key = getKey(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'));
}

function includesAny(haystack, needles) {
  const source = haystack.toLowerCase();
  return needles.some((needle) => source.includes(String(needle).toLowerCase()));
}

function classifyBucket(record) {
  const topics = new Set((record.topics || []).map((topic) => String(topic).toLowerCase()));
  const text = [record.title, record.source_path, record.local_relative_path].filter(Boolean).join(' ');
  const matches = BUCKETS.filter((bucket) => {
    return bucket.match.some((topic) => topics.has(topic.toLowerCase())) || includesAny(text, bucket.keywords);
  });
  return matches.length > 0 ? matches[0] : { id: 'other', name: 'Other P0/P1' };
}

function topicBoost(record) {
  const topics = new Set((record.topics || []).map((topic) => String(topic).toLowerCase()));
  const highIntent = [
    'aidc_capex',
    'cloud_capex',
    'data_center_capex',
    'ai_server',
    'gpu',
    'asic',
    'hbm_memory',
    'advanced_packaging',
    'cowos',
    'optical_interconnect',
    'data_center_network',
    'data_center_power',
    'data_center_cooling',
    'liquid_cooling',
    'humanoid_robotics',
    'embodied_ai',
  ];
  return highIntent.reduce((sum, topic) => sum + (topics.has(topic) ? 12 : 0), 0);
}

function deriveManualScore(record) {
  const base = PRIORITY_WEIGHT[record.priority] || 0;
  const llmScore = Number(record.score) || 0;
  const rankPenalty = Number.isFinite(Number(record.rank)) ? Math.min(Number(record.rank) / 20, 40) : 0;
  return Math.round(base + llmScore + topicBoost(record) - rankPenalty);
}

function deriveTier(record, manualScore) {
  if (record.priority === 'P0' && manualScore >= 1135) return 'Must read';
  if (record.priority === 'P0') return 'Core';
  if (manualScore >= 850) return 'Strong P1';
  return 'Watchlist';
}

function monthFromPath(localPath) {
  const match = String(localPath || '').match(/^(\d{4}\/\d+月)\//);
  return match ? match[1] : 'unknown';
}

function dayFromPath(localPath) {
  const match = String(localPath || '').match(/^(\d{4})\/(\d+)月\/([^/]+)\//);
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3]}`;
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fileHref(filePath) {
  return `file://${encodeURI(filePath).replace(/#/g, '%23')}`;
}

function renderHtml(records, meta) {
  const embedded = JSON.stringify(records).replace(/</g, '\\u003c');
  const generatedAt = new Date().toISOString();
  const byPriority = countBy(records, (record) => record.priority);
  const byBucket = countBy(records, (record) => record.manual_bucket);
  const byMonth = countBy(records, (record) => record.month);
  const changedCount = records.filter((record) => record.rerank_changed).length;
  const byTopic = countBy(
    records.flatMap((record) => (record.topics || []).map((topic) => ({ topic }))),
    (record) => record.topic,
  ).slice(0, 24);
  const top20 = records.slice(0, 20);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Infrastructure P0/P1 Analysis</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #5e6a75;
      --line: #d9e0e7;
      --p0: #b42318;
      --p1: #8a6116;
      --blue: #155eef;
      --green: #067647;
      --violet: #6941c6;
      --shadow: 0 10px 30px rgba(21, 28, 38, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.45;
    }
    header {
      background: #111827;
      color: #fff;
      padding: 28px clamp(18px, 4vw, 56px);
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1.1;
      letter-spacing: 0;
    }
    .subhead {
      max-width: 980px;
      color: #cdd5df;
      font-size: 15px;
    }
    main {
      padding: 24px clamp(16px, 4vw, 56px) 52px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
      box-shadow: var(--shadow);
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .metric .value {
      margin-top: 6px;
      font-size: 28px;
      font-weight: 760;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    aside, section.panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    aside {
      position: sticky;
      top: 14px;
      padding: 14px;
    }
    .filter-group {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      margin-top: 12px;
    }
    .filter-group:first-child {
      border-top: 0;
      padding-top: 0;
      margin-top: 0;
    }
    label {
      display: block;
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    .quick {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }
    button {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }
    button.active {
      border-color: #111827;
      background: #111827;
      color: #fff;
    }
    .panel {
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
      align-items: center;
    }
    .panel-title {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
    }
    .small {
      color: var(--muted);
      font-size: 13px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 12px;
      padding: 16px 18px 18px;
    }
    .summary-block {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
    }
    .summary-block h3 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: minmax(88px, 1fr) 52px;
      gap: 8px;
      align-items: center;
      margin: 7px 0;
      color: var(--muted);
      font-size: 13px;
    }
    .bar {
      height: 8px;
      margin-top: 3px;
      background: #e7ebf0;
      border-radius: 999px;
      overflow: hidden;
    }
    .bar span {
      display: block;
      height: 100%;
      background: #2e90fa;
    }
    .top-list {
      display: grid;
      gap: 10px;
      padding: 0 18px 18px;
    }
    .item {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fff;
    }
    .rankbox {
      text-align: center;
      border-right: 1px solid var(--line);
      padding-right: 12px;
    }
    .rankbox .rank {
      font-size: 20px;
      font-weight: 800;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      min-height: 22px;
      padding: 2px 8px;
      border-radius: 999px;
      color: #fff;
      font-size: 12px;
      font-weight: 800;
    }
    .badge.p0 { background: var(--p0); }
    .badge.p1 { background: var(--p1); }
    .badge.tier { background: var(--green); }
    .badge.downloaded { background: var(--blue); }
    .title {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0;
    }
    .tag {
      border: 1px solid #ccd6e0;
      border-radius: 999px;
      padding: 2px 8px;
      color: #334155;
      background: #f8fafc;
      font-size: 12px;
    }
    .reason {
      color: #344054;
      font-size: 13px;
      margin: 6px 0 0;
    }
    .path {
      color: var(--muted);
      font-size: 12px;
      margin-top: 8px;
      overflow-wrap: anywhere;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border-top: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f3f6f9;
      color: #344054;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    td:nth-child(4) {
      min-width: 320px;
    }
    a {
      color: #155eef;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .hidden { display: none; }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      aside { position: static; }
      .item { grid-template-columns: 1fr; }
      .rankbox {
        border-right: 0;
        border-bottom: 1px solid var(--line);
        padding: 0 0 8px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>AI Infrastructure P0/P1 Analysis</h1>
    <div class="subhead">来源：${htmlEscape(meta.queuePath)}。仅使用 PDF 标题和路径排序；若 queue 包含二轮复核字段，将展示证据与降权理由。生成时间：${htmlEscape(generatedAt)}</div>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><div class="label">P0/P1</div><div class="value">${records.length}</div></div>
      <div class="metric"><div class="label">P0</div><div class="value">${byPriority.find(([key]) => key === 'P0')?.[1] || 0}</div></div>
      <div class="metric"><div class="label">P1</div><div class="value">${byPriority.find(([key]) => key === 'P1')?.[1] || 0}</div></div>
      <div class="metric"><div class="label">二轮调整</div><div class="value">${changedCount}</div></div>
      <div class="metric"><div class="label">已在本地</div><div class="value">${records.filter((record) => record.downloaded).length}</div></div>
    </div>

    <div class="layout">
      <aside>
        <div class="filter-group">
          <label for="search">Search</label>
          <input id="search" type="search" placeholder="标题、路径、topic、理由">
        </div>
        <div class="filter-group">
          <label for="priority">Priority</label>
          <select id="priority"><option value="">P0 + P1</option></select>
        </div>
        <div class="filter-group">
          <label for="bucket">Theme</label>
          <select id="bucket"><option value="">All themes</option></select>
        </div>
        <div class="filter-group">
          <label for="topic">Topic</label>
          <select id="topic"><option value="">All topics</option></select>
        </div>
        <div class="filter-group">
          <label for="month">Month</label>
          <select id="month"><option value="">All months</option></select>
        </div>
        <div class="filter-group">
          <label>Quick Focus</label>
          <div class="quick">
            <button data-focus="aidc_capex">AIDC</button>
            <button data-focus="optical_interconnect">光互联</button>
            <button data-focus="hbm_memory">HBM</button>
            <button data-focus="humanoid_robotics">机器人</button>
          </div>
        </div>
      </aside>

      <div>
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">主题分布</h2>
            <div class="small">按 P0/P1 记录数统计</div>
          </div>
          <div class="summary-grid">
            ${renderBars('Priority', byPriority)}
            ${renderBars('Month', byMonth)}
            ${renderBars('Theme', byBucket)}
            ${renderBars('Top Topics', byTopic)}
          </div>
        </section>

        <section class="panel" style="margin-top:18px">
          <div class="panel-head">
            <h2 class="panel-title">手动下载优先 Top 20</h2>
            <div class="small">综合二轮 priority、score、AI 基建核心 topic 派生排序</div>
          </div>
          <div class="top-list">
            ${top20.map(renderItem).join('\n')}
          </div>
        </section>

        <section class="panel" style="margin-top:18px">
          <div class="panel-head">
            <h2 class="panel-title">全部 P0/P1</h2>
            <div class="small"><span id="result-count">${records.length}</span> 条匹配</div>
          </div>
          <div id="list" class="top-list"></div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>手动序</th>
                  <th>优先级</th>
                  <th>得分</th>
                  <th>标题</th>
                  <th>主题</th>
                  <th>路径 / 理由</th>
                </tr>
              </thead>
              <tbody id="rows"></tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </main>
  <script id="records" type="application/json">${embedded}</script>
  <script>
    const records = JSON.parse(document.getElementById('records').textContent);
    const state = { search: '', priority: '', bucket: '', topic: '', month: '' };
    const els = {
      search: document.getElementById('search'),
      priority: document.getElementById('priority'),
      bucket: document.getElementById('bucket'),
      topic: document.getElementById('topic'),
      month: document.getElementById('month'),
      rows: document.getElementById('rows'),
      resultCount: document.getElementById('result-count'),
    };

    function uniq(values) {
      return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
    }
    function fillSelect(el, values) {
      for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        el.appendChild(option);
      }
    }
    fillSelect(els.priority, uniq(records.map((record) => record.priority)));
    fillSelect(els.bucket, uniq(records.map((record) => record.manual_bucket)));
    fillSelect(els.topic, uniq(records.flatMap((record) => record.topics || [])));
    fillSelect(els.month, uniq(records.map((record) => record.month)));

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function textBlob(record) {
      return [
        record.title,
        record.source_path,
        record.local_relative_path,
        record.manual_bucket,
        ...(record.topics || []),
        ...(record.reasons || []),
        ...(record.evidence_keywords || []),
        ...(record.downgrade_reasons || []),
      ].join(' ').toLowerCase();
    }
    function filtered() {
      const q = state.search.trim().toLowerCase();
      return records.filter((record) => {
        if (state.priority && record.priority !== state.priority) return false;
        if (state.bucket && record.manual_bucket !== state.bucket) return false;
        if (state.topic && !(record.topics || []).includes(state.topic)) return false;
        if (state.month && record.month !== state.month) return false;
        if (q && !textBlob(record).includes(q)) return false;
        return true;
      });
    }
    function renderRows() {
      const rows = filtered();
      els.resultCount.textContent = rows.length;
      els.rows.innerHTML = rows.map((record) => {
        const tags = (record.topics || []).map((topic) => '<span class="tag">' + escapeHtml(topic) + '</span>').join('');
        const link = record.download_href ? '<a href="' + escapeHtml(record.download_href) + '">打开本地 PDF</a>' : '';
        const evidence = (record.evidence_keywords || []).map((keyword) => '<span class="tag">' + escapeHtml(keyword) + '</span>').join('');
        const downgrade = (record.downgrade_reasons || []).join('；');
        const recall = record.recall_priority ? 'Recall ' + record.recall_priority + ' / ' + record.recall_score : '';
        return '<tr>' +
          '<td><strong>' + record.manual_rank + '</strong><div class="small">' + escapeHtml(record.manual_tier) + '</div></td>' +
          '<td><span class="badge ' + record.priority.toLowerCase() + '">' + escapeHtml(record.priority) + '</span></td>' +
          '<td>' + escapeHtml(record.score) + '<div class="small">LLM #' + escapeHtml(record.rank) + '</div><div class="small">' + escapeHtml(recall) + '</div></td>' +
          '<td><strong>' + escapeHtml(record.title) + '</strong><div class="small">' + escapeHtml(record.day) + '</div></td>' +
          '<td><div class="tags">' + tags + '</div><div class="small">' + escapeHtml(record.manual_bucket) + '</div><div class="small">' + escapeHtml(record.evidence_level || '') + '</div></td>' +
          '<td><div>' + escapeHtml((record.reasons || []).join('；')) + '</div><div class="tags">' + evidence + '</div><div class="small">' + escapeHtml(downgrade) + '</div><div class="path">IMA: ' + escapeHtml(record.source_path) + '</div><div class="path">Local: ' + escapeHtml(record.local_relative_path) + '</div><div class="small">' + link + '</div></td>' +
          '</tr>';
      }).join('');
    }
    for (const key of ['priority', 'bucket', 'topic', 'month']) {
      els[key].addEventListener('change', () => {
        state[key] = els[key].value;
        renderRows();
      });
    }
    els.search.addEventListener('input', () => {
      state.search = els.search.value;
      renderRows();
    });
    document.querySelectorAll('[data-focus]').forEach((button) => {
      button.addEventListener('click', () => {
        const active = button.classList.toggle('active');
        document.querySelectorAll('[data-focus]').forEach((other) => {
          if (other !== button) other.classList.remove('active');
        });
        state.topic = active ? button.dataset.focus : '';
        els.topic.value = state.topic;
        renderRows();
      });
    });
    renderRows();
  </script>
</body>
</html>`;
}

function renderBars(title, entries) {
  const max = Math.max(1, ...entries.map((entry) => entry[1]));
  return `<div class="summary-block">
    <h3>${htmlEscape(title)}</h3>
    ${entries
      .map(([name, count]) => {
        const width = Math.max(4, Math.round((count / max) * 100));
        return `<div class="bar-row"><div>${htmlEscape(name)}<div class="bar"><span style="width:${width}%"></span></div></div><strong>${count}</strong></div>`;
      })
      .join('\n')}
  </div>`;
}

function renderItem(record) {
  const tags = (record.topics || []).slice(0, 8).map((topic) => `<span class="tag">${htmlEscape(topic)}</span>`).join('');
  const localLink = record.download_href ? `<a href="${htmlEscape(record.download_href)}">打开本地 PDF</a>` : '';
  const downloaded = record.downloaded ? '<span class="badge downloaded">本地已有</span>' : '';
  const recallMeta = record.recall_priority ? `<span>recall ${htmlEscape(record.recall_priority)} / ${htmlEscape(record.recall_score)}</span>` : '';
  const evidence = record.evidence_keywords && record.evidence_keywords.length
    ? `<div class="path">Evidence: ${htmlEscape(record.evidence_keywords.join(' / '))}</div>`
    : '';
  const review = record.downgrade_reasons && record.downgrade_reasons.length
    ? `<div class="path">Review: ${htmlEscape(record.downgrade_reasons.join('；'))}</div>`
    : '';
  return `<article class="item">
    <div class="rankbox">
      <div class="rank">#${record.manual_rank}</div>
      <div class="small">LLM #${htmlEscape(record.rank)}</div>
    </div>
    <div>
      <div class="meta">
        <span class="badge ${record.priority.toLowerCase()}">${htmlEscape(record.priority)}</span>
        <span class="badge tier">${htmlEscape(record.manual_tier)}</span>
        ${downloaded}
        <span>${htmlEscape(record.manual_bucket)}</span>
        <span>score ${htmlEscape(record.score)}</span>
        ${recallMeta}
      </div>
      <h3 class="title">${htmlEscape(record.title)}</h3>
      <div class="tags">${tags}</div>
      <p class="reason">${htmlEscape((record.reasons || []).join('；'))}</p>
      ${evidence}
      ${review}
      <div class="path">IMA: ${htmlEscape(record.source_path)}</div>
      <div class="path">Local: ${htmlEscape(record.local_relative_path)}</div>
      <div class="small">${localLink}</div>
    </div>
  </article>`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  const queuePath = resolveRootPath(opts.queue, DEFAULT_QUEUE_PATH);
  const outputPath = resolveRootPath(opts.out, DEFAULT_OUTPUT_PATH);
  const allRecords = readJsonl(queuePath);
  const records = allRecords
    .filter((record) => record.priority === 'P0' || record.priority === 'P1')
    .map((record) => {
      const bucket = classifyBucket(record);
      const manualScore = deriveManualScore(record);
      const savedPath = record.saved_path || path.join(ROOT, 'downloads', record.local_relative_path || '');
      const downloaded = Boolean(savedPath && fs.existsSync(savedPath));
      return {
        indexed_at: record.indexed_at,
        knowledge_base: record.knowledge_base,
        source_path: record.source_path,
        title: record.title,
        local_relative_path: record.local_relative_path,
        priority: record.priority,
        rank: record.rank,
        score: record.score,
        topics: record.topics || [],
        reasons: record.reasons || [],
        evidence_keywords: record.evidence_keywords || [],
        evidence_level: record.evidence_level || '',
        downgrade_reasons: record.downgrade_reasons || [],
        rerank_changed: Boolean(record.rerank_changed),
        recall_priority: record.recall_priority || '',
        recall_score: record.recall_score ?? '',
        recall_topics: record.recall_topics || [],
        recall_reasons: record.recall_reasons || [],
        llm_provider: record.llm_provider,
        llm_model: record.llm_model,
        recall_llm_model: record.recall_llm_model,
        rerank_llm_model: record.rerank_llm_model,
        ranked_at: record.ranked_at,
        month: monthFromPath(record.local_relative_path),
        day: dayFromPath(record.local_relative_path),
        manual_bucket: bucket.name,
        manual_score: manualScore,
        manual_tier: deriveTier(record, manualScore),
        downloaded,
        download_href: downloaded ? fileHref(savedPath) : '',
      };
    })
    .sort((a, b) => {
      return (
        b.manual_score - a.manual_score ||
        String(a.priority).localeCompare(String(b.priority)) ||
        Number(a.rank || 0) - Number(b.rank || 0) ||
        String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
      );
    })
    .map((record, index) => ({ ...record, manual_rank: index + 1 }));

  const html = renderHtml(records, {
    queuePath: path.relative(ROOT, queuePath),
  }).replace(/[ \t]+$/gm, '');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(JSON.stringify({
    output: outputPath,
    records: records.length,
    p0: records.filter((record) => record.priority === 'P0').length,
    p1: records.filter((record) => record.priority === 'P1').length,
    downloaded: records.filter((record) => record.downloaded).length,
  }, null, 2));
}

main();
