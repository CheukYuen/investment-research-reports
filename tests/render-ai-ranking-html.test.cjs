const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeMonth,
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
} = require('../scripts/render-ai-ranking-html.cjs');

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function report(mediaId, priority, rank, title = mediaId) {
  return {
    media_id: mediaId,
    title: `${title}.pdf`,
    priority,
    rank,
    score: 100 - rank,
    source_path: `知识库 / 2026年国际顶级投行研报 / 7月 / 7.24 / ${title}.pdf`,
    local_relative_path: `2026/7月/7.24/${title}.pdf`,
    executive_summary: `${title}摘要`,
    key_findings: [`${title}结论`],
    data_points: [],
    entities: [],
  };
}

test('month validation accepts YYYYMM and rejects invalid months', () => {
  assert.equal(normalizeMonth('2026-07'), '202607');
  assert.throws(() => normalizeMonth('202613'), /Invalid month/);
});

test('monthly collection reads summary queues, keeps P0-P3, and deduplicates by media_id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ranking-html-'));
  try {
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260723.jsonl'), [
      report('same', 'P0', 1, '旧记录'),
      report('p2', 'P2', 3),
    ]);
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260724.jsonl'), [
      report('same', 'P1', 2, '新记录'),
      report('p3', 'P3', 4),
    ]);
    writeJsonl(path.join(root, 'ai-ranked-queue-20260724.jsonl'), [
      report('legacy', 'P0', 1),
    ]);

    const result = collectMonthlyRecords(root, '202607');
    assert.equal(result.sources.length, 2);
    assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map((record) => record.priority), ['P1', 'P3', 'P2']);
    assert.equal(result.records.find((record) => record.media_id === 'same').title, '新记录.pdf');
    assert.equal(result.records.some((record) => record.media_id === 'legacy'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('monthly HTML lists all priority bands and removes manual Top 20 concepts', () => {
  const records = [
    report('p0', 'P0', 1),
    report('p1', 'P1', 2),
    report('p2', 'P2', 3),
    report('p3', 'P3', 4),
  ].map((record) => ({
    ...record,
    snapshot_date: '2026-07-24',
    report_type: 'industry',
    research_subject: '',
    content_tags: [],
    topics: [],
    reasons: [],
    ranking_evidence: [],
    false_positive_checks: [],
    evidence: [],
    failure_code: '',
    downloaded: false,
    download_href: '',
  }));
  const html = renderHtml(records, { month: '202607', sourceCount: 1 });
  assert.match(html, /P2/);
  assert.match(html, /P3/);
  assert.match(html, /月度研报排序/);
  assert.doesNotMatch(html, /手动下载优先|Top 20|manual_rank|manual_tier|二次排序/);
});

test('normalizeRecord shows null report_type as 未分类 and keeps it distinct from other (其他研究)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ranking-html-'));
  try {
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260805.jsonl'), [
      { ...report('unclassified', 'P2', 1), report_type: null, sectors: [] },
      { ...report('other', 'P2', 2), report_type: 'other', sectors: [] },
    ]);
    const { records } = collectMonthlyRecords(root, '202608');
    const unclassified = records.find((record) => record.media_id === 'unclassified');
    const other = records.find((record) => record.media_id === 'other');
    assert.equal(unclassified.report_type, null);
    assert.equal(unclassified.report_type_label, '未分类');
    assert.equal(other.report_type, 'other');
    assert.equal(other.report_type_label, '其他研究');
    assert.notEqual(unclassified.report_type_label, other.report_type_label);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sectors are normalized to an array and default to empty when absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ranking-html-'));
  try {
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260805.jsonl'), [
      { ...report('with-sectors', 'P1', 1), sectors: [{ name_cn: '信息技术', name_en: 'Information Technology' }] },
      { ...report('no-sectors', 'P1', 2) },
    ]);
    const { records } = collectMonthlyRecords(root, '202608');
    const withSectors = records.find((record) => record.media_id === 'with-sectors');
    const noSectors = records.find((record) => record.media_id === 'no-sectors');
    assert.deepEqual(withSectors.sectors, [{ name_cn: '信息技术', name_en: 'Information Technology' }]);
    assert.deepEqual(noSectors.sectors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTML renders a sector filter select and 未分类/其他研究 both appear when both are present', () => {
  const records = [
    { ...report('p0', 'P0', 1), report_type: null, report_type_label: '未分类', report_type_reason: '', sectors: [] },
    { ...report('p1', 'P1', 2), report_type: 'other', report_type_label: '其他研究', report_type_reason: '', sectors: [{ name_cn: '公用事业', name_en: 'Utilities' }] },
  ].map((record) => ({
    ...record,
    snapshot_date: '2026-07-24',
    research_subject: '',
    content_tags: [],
    topics: [],
    reasons: [],
    ranking_evidence: [],
    false_positive_checks: [],
    evidence: [],
    failure_code: '',
    downloaded: false,
    download_href: '',
  }));
  const html = renderHtml(records, { month: '202607', sourceCount: 1 });
  assert.match(html, /id="sector"/);
  assert.match(html, /未分类/);
  assert.match(html, /其他研究/);
  assert.match(html, /打开汇总导航/);
});

test('parseCompanyFromTitle prefers ticker and groups by normalized symbol', () => {
  assert.deepEqual(
    parseCompanyFromTitle('花旗-Marvell Technology Inc(MRVL.O)：再次上调2027、2028财年展望.pdf'),
    { key: 'MRVL.O', label: 'Marvell Technology Inc (MRVL.O)' },
  );
  assert.deepEqual(
    parseCompanyFromTitle('伯恩斯坦-IREN（IREN.US）二季度业绩：IREN每兆瓦价值几何'),
    { key: 'IREN.US', label: 'IREN (IREN.US)' },
  );
  assert.deepEqual(
    parseCompanyFromTitle('高盛-东京精密（7729.T）话会议纪要：SPE订单强劲'),
    { key: '7729.T', label: '东京精密 (7729.T)' },
  );
  assert.deepEqual(
    parseCompanyFromTitle('野村-启明星辰（002439.SZ）：业务复苏缓慢'),
    { key: '002439.SZ', label: '启明星辰 (002439.SZ)' },
  );
});

test('parseCompanyFromTitle falls back to colon name then 未归类公司', () => {
  assert.deepEqual(
    parseCompanyFromTitle('高盛-NVIDIA：数据中心展望-260801.pdf'),
    { key: 'nvidia', label: 'NVIDIA' },
  );
  assert.deepEqual(
    parseCompanyFromTitle('花旗-美国半导体Hot Chips大会核心主题'),
    { key: UNCLASSIFIED_COMPANY_KEY, label: UNCLASSIFIED_COMPANY_LABEL },
  );
  assert.deepEqual(
    parseCompanyFromTitle('花旗-Marvell Technology Inc(MRVL.O)：上调展望', 'industry'),
    { key: '', label: '' },
  );
});

test('nav tree nests companies only under 公司研究 and counts add up', () => {
  const records = [
    toHubRecord({
      ...report('m1', 'P0', 1, '花旗-Marvell Technology Inc(MRVL.O)：上调展望'),
      snapshot_date: '2026-08-29',
      report_type: 'company',
      report_type_label: '公司研究',
      sectors: [{ name_cn: '信息技术', name_en: 'Information Technology' }, { name_cn: '工业', name_en: 'Industrials' }],
    }),
    toHubRecord({
      ...report('m2', 'P1', 2, '伯恩斯坦-IREN（IREN.US）二季度业绩'),
      snapshot_date: '2026-08-28',
      report_type: 'company',
      report_type_label: '公司研究',
      sectors: [{ name_cn: '信息技术', name_en: 'Information Technology' }],
    }),
    toHubRecord({
      ...report('m3', 'P1', 3, '花旗-无名公司没有票符也没有冒号'),
      snapshot_date: '2026-08-27',
      report_type: 'company',
      report_type_label: '公司研究',
      sectors: [],
    }),
    toHubRecord({
      ...report('i1', 'P0', 1, '花旗-美国半导体：Hot Chips大会'),
      snapshot_date: '2026-08-29',
      report_type: 'industry',
      report_type_label: '行业研究',
      sectors: [{ name_cn: '信息技术', name_en: 'Information Technology' }],
    }),
  ];
  const tree = buildNavTree(records);
  assert.equal(tree.count, 4);
  const companyType = tree.types.find((node) => node.label === '公司研究');
  const industryType = tree.types.find((node) => node.label === '行业研究');
  assert.equal(companyType.count, 3);
  assert.equal(industryType.count, 1);
  assert.equal(companyType.count, companyType.sectors.reduce((sum, sector) => sum + sector.count, 0));
  const itSector = companyType.sectors.find((sector) => sector.label === '信息技术');
  assert.equal(itSector.count, 2);
  assert.equal(itSector.count, itSector.companies.reduce((sum, company) => sum + company.count, 0));
  assert.ok(itSector.companies.some((company) => company.key === 'MRVL.O' && company.count === 1));
  assert.ok(itSector.companies.some((company) => company.key === 'IREN.US' && company.count === 1));
  const unclassifiedSector = companyType.sectors.find((sector) => sector.label === UNCLASSIFIED_SECTOR_LABEL);
  assert.equal(unclassifiedSector.companies[0].key, UNCLASSIFIED_COMPANY_KEY);
  assert.equal(industryType.sectors[0].companies, null);
  assert.equal(records[0].sector, '信息技术');
});

test('hub collection merges months and later files win on media_id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ranking-hub-'));
  try {
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260724.jsonl'), [
      { ...report('same', 'P0', 1, '七月旧记录'), report_type: 'company' },
    ]);
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260801.jsonl'), [
      { ...report('same', 'P1', 2, '八月新记录'), report_type: 'company' },
      { ...report('aug', 'P2', 3, '八月独有'), report_type: 'industry' },
    ]);
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260802.jsonl'), []);
    const result = collectAllRecords(root);
    assert.equal(result.records.length, 2);
    assert.equal(result.records.find((record) => record.media_id === 'same').title, '八月新记录.pdf');
    assert.equal(result.sources.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hub HTML is a compact navigation page and omits ranking evidence fields', () => {
  const records = [
    toHubRecord({
      ...report('m1', 'P0', 1, '花旗-Marvell Technology Inc(MRVL.O)：上调展望'),
      snapshot_date: '2026-08-29',
      report_type: 'company',
      report_type_label: '公司研究',
      report_type_reason: '公司研究',
      sectors: [{ name_cn: '信息技术', name_en: 'Information Technology' }],
      reasons: ['should-not-embed'],
      ranking_evidence: ['should-not-embed'],
      entities: ['should-not-embed'],
    }),
  ];
  const html = renderHubHtml(records, { sourceCount: 2 });
  assert.match(html, /研报导航/);
  assert.match(html, /类型 \/ 行业 \/ 公司/);
  assert.match(html, /id="tree"/);
  assert.match(html, /row-head/);
  assert.doesNotMatch(html, /should-not-embed/);
  assert.doesNotMatch(html, /ranking_evidence/);
});

test('main --hub writes the undated hub file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ranking-hub-main-'));
  try {
    writeJsonl(path.join(root, 'ai-ranked-queue-summary-20260829.jsonl'), [
      { ...report('m1', 'P0', 1, '花旗-Marvell Technology Inc(MRVL.O)：上调展望'), report_type: 'company' },
    ]);
    const out = path.join(root, 'ai-ranking-analysis.html');
    main(['--hub', '--manifests-dir', root, '--out', out]);
    assert.equal(fs.existsSync(out), true);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /研报导航/);
    assert.match(html, /MRVL\.O/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
