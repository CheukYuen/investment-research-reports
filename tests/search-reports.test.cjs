const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildIndex,
  loadIndex,
  matchRecord,
  parseCompanyFromTitle,
  parseQueryArgs,
  resolvedPdfPath,
  toIndexRecord,
} = require('../scripts/search-reports.cjs');

const ROOT = path.resolve(__dirname, '..');

function tempManifests(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-reports-'));
  for (const [name, records] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, name),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
  }
  return dir;
}

function rankedRow(overrides = {}) {
  return {
    media_id: 'pdf_a',
    title: '大摩-长飞光纤光缆（6869.HK）：2026年上半年营收利润强劲增长-260823.pdf',
    local_relative_path: '2026/8月/8.25/大摩-长飞光纤光缆.pdf',
    priority: 'P0',
    rank: 1,
    score: 95,
    report_type: 'company',
    report_type_reason: '单一公司评级与目标价',
    sectors: [{ name_cn: '通信服务', name_en: 'Communication Services' }],
    summary_role: 'routing_candidate',
    research_subject: '长飞光纤光缆',
    executive_summary: 'AI 数据中心需求驱动光纤涨价。',
    key_findings: ['1H26 营收同比 +53.6%'],
    content_tags: ['financials'],
    topics: ['光纤光缆', '数据中心'],
    entities: ['长飞光纤光缆', '中国移动'],
    reasons: ['正文有明确证据；也包括强相关半导体设备材料、PCB、光纤光缆、工业自动化'],
    ranking_evidence: ['空芯光纤累计交付超 10,000 光纤公里'],
    data_points: [{ metric: '营收', value_text: 'Rmb9,809mn', period: '1H26', basis: 'actual', context: '同比 +53.6%' }],
    raw_answer: '{"reports": [...]}',
    ...overrides,
  };
}

test('index records keep queue classification and drop prompt-echoing reasons', () => {
  const record = toIndexRecord(rankedRow(), {
    tier: 'ranked',
    snapshotDate: '2026-08-25',
    snapshotMonth: '202608',
    downloadedIds: new Set(['pdf_a']),
  });

  assert.equal(record.tier, 'ranked');
  assert.equal(record.report_type_label, '公司研究');
  assert.deepEqual(record.sectors_cn, ['通信服务']);
  assert.equal(record.pdf_path, 'downloads/2026/8月/8.25/大摩-长飞光纤光缆.pdf');
  assert.equal(record.downloaded, true);
  assert.equal(record.summary_role, 'routing_candidate');
  // reasons 会逐字复制排序 prompt 的判据样板句，收进索引就会造成主题假命中。
  assert.equal('reasons' in record, false);
  // raw_answer / evidence / saved_path 同样不入索引。
  assert.equal('raw_answer' in record, false);
  assert.equal('saved_path' in record, false);
  assert.deepEqual(record.data_points, [
    { metric: '营收', value_text: 'Rmb9,809mn', period: '1H26', context: '同比 +53.6%' },
  ]);
});

test('summary-tier records carry no classification because the summary stage never assigns one', () => {
  const record = toIndexRecord(
    { media_id: 'pdf_b', title: '某券商-未审研报.pdf', report_type: null, sectors: [], topics: [], status: 'UNREVIEWED' },
    { tier: 'summary_only', snapshotDate: '2026-09-01', snapshotMonth: '202609', downloadedIds: new Set() },
  );

  assert.equal(record.report_type, null);
  assert.equal(record.report_type_label, '未分类');
  assert.deepEqual(record.sectors_cn, []);
  assert.equal(record.priority, 'UNREVIEWED');
  assert.equal(record.downloaded, false);
});

test('matching is AND by default, OR with --any, and reports the hit field', () => {
  const record = toIndexRecord(rankedRow(), {
    tier: 'ranked',
    snapshotDate: '2026-08-25',
    snapshotMonth: '202608',
    downloadedIds: new Set(),
  });

  assert.ok(matchRecord(record, ['光纤'], false));
  assert.equal(matchRecord(record, ['光纤', '氢能'], false), null);
  assert.ok(matchRecord(record, ['光纤', '氢能'], true));
  assert.equal(matchRecord(record, [], false).snippets.length, 0);

  const hit = matchRecord(record, ['中国移动'], false);
  assert.equal(hit.snippets[0].field, 'entities');
  assert.match(hit.snippets[0].text, /中国移动/);
});

test('prompt boilerplate inside reasons no longer produces a false topic hit', () => {
  const unrelated = rankedRow({
    media_id: 'pdf_c',
    title: '摩根大通-零售观察周报-260805.pdf',
    local_relative_path: '2026/8月/8.5/摩根大通-零售观察周报.pdf',
    research_subject: '美国零售',
    executive_summary: '零售销售数据回顾。',
    key_findings: ['同店销售回暖'],
    topics: ['零售'],
    entities: ['沃尔玛'],
    ranking_evidence: ['同店销售 +3%'],
    data_points: [],
  });
  const record = toIndexRecord(unrelated, {
    tier: 'ranked',
    snapshotDate: '2026-08-05',
    snapshotMonth: '202608',
    downloadedIds: new Set(),
  });

  assert.equal(matchRecord(record, ['光纤'], false), null);
});

test('build dedupes by media_id, tiers the sources, and shards by month', () => {
  const dir = tempManifests({
    'ai-ranked-queue-summary-20260825.jsonl': [rankedRow()],
    'ai-ranked-queue-summary-20260826.jsonl': [rankedRow({ priority: 'P1', score: 70 })],
    'report-summaries-20260901.jsonl': [
      rankedRow(),
      { media_id: 'pdf_b', title: '未审研报.pdf', local_relative_path: '2026/9月/9.1/未审研报.pdf', status: 'UNREVIEWED' },
    ],
    'index.jsonl': [
      { media_id: 'pdf_a', title: '大摩-长飞光纤光缆.pdf', local_relative_path: '2026/8月/8.25/大摩-长飞光纤光缆.pdf' },
      { media_id: 'pdf_z', title: '从未摘要的研报.pdf', local_relative_path: '2026/7月/7.9/从未摘要的研报.pdf' },
    ],
    'downloaded.jsonl': [{ media_id: 'pdf_a' }],
    // 历史遗留产物必须被文件名门禁挡住。
    'ai-ranked-queue-optical-20260710.jsonl': [rankedRow({ media_id: 'pdf_legacy', title: '旧版光模块队列.pdf' })],
    'ai-ranked-queue-20260715.jsonl': [rankedRow({ media_id: 'pdf_legacy2', title: '旧版标题排序.pdf' })],
  });

  const result = buildIndex(dir);
  assert.equal(result.total, 3);
  assert.deepEqual(result.stats.ranked, 1);
  assert.deepEqual(result.stats.summary_only, 1);
  assert.deepEqual(result.stats.index_only, 1);

  const records = loadIndex(dir, '');
  const byId = new Map(records.map((record) => [record.media_id, record]));
  assert.equal(byId.size, 3);
  // 后出现的日期快照覆盖先前的。
  assert.equal(byId.get('pdf_a').priority, 'P1');
  assert.equal(byId.get('pdf_a').snapshot_date, '2026-08-26');
  assert.equal(byId.get('pdf_b').tier, 'summary_only');
  assert.equal(byId.get('pdf_z').tier, 'index_only');
  // index_only 的月份从 local_relative_path 推导。
  assert.equal(byId.get('pdf_z').snapshot_month, '202607');
  assert.equal(byId.has('pdf_legacy'), false);
  assert.equal(byId.has('pdf_legacy2'), false);

  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith('search-index-')).sort(),
    ['search-index-202607.jsonl', 'search-index-202608.jsonl', 'search-index-202609.jsonl'],
  );
  assert.deepEqual(loadIndex(dir, '202607').map((record) => record.media_id), ['pdf_z']);

  const first = fs.readFileSync(path.join(dir, 'search-index-202608.jsonl'), 'utf8');
  buildIndex(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'search-index-202608.jsonl'), 'utf8'), first);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('query flags parse into terms and options', () => {
  const { terms, opts } = parseQueryArgs(['光纤 800G', '--priority', 'P0,P1', '--facets', '--limit', '5']);
  assert.deepEqual(terms, ['光纤', '800G']);
  assert.equal(opts.priority, 'P0,P1');
  assert.equal(opts.facets, true);
  assert.equal(opts.limit, '5');
});

test('company labels match the hub page so CLI search covers the human search box', () => {
  assert.deepEqual(
    parseCompanyFromTitle('大摩-戴尔科技(DELL.N)：2027财年二季报-260902.pdf', 'company'),
    { key: 'DELL.N', label: '戴尔科技 (DELL.N)' },
  );
  assert.deepEqual(parseCompanyFromTitle('高盛-中国宏观经济展望-260703.pdf', 'industry'), { key: '', label: '' });
});

test('pdf paths resolve to absolute when called from outside the repo', () => {
  const record = { pdf_path: 'downloads/2026/8月/8.25/大摩-长飞光纤光缆.pdf' };

  // 仓库内调用保持仓库相对路径，跟索引里存的一致。
  assert.equal(resolvedPdfPath(record, ROOT), record.pdf_path);
  assert.equal(resolvedPdfPath(record, path.join(ROOT, 'scripts')), record.pdf_path);

  // 跨项目调用必须给出能直接打开的绝对路径，否则调用方读不到文件。
  assert.equal(resolvedPdfPath(record, '/tmp'), path.join(ROOT, record.pdf_path));
  assert.equal(resolvedPdfPath({ pdf_path: '' }, '/tmp'), '');
});
