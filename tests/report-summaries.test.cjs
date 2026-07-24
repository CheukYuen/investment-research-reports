const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAndNormalizeSuccess,
  buildSnapshot,
  buildPending,
  audit,
} = require('../scripts/report-summaries.cjs');

function indexRecord(number = 1) {
  return {
    indexed_at: '2026-07-23T00:00:00.000Z',
    knowledge_base: '环球研报直通车',
    source_path: `环球研报直通车 / 7.23 / 报告${number}.pdf`,
    title: `报告${number}.pdf`,
    media_type: 1,
    media_id: `pdf-${number}`,
    parent_folder_id: 'folder-723',
    local_relative_path: `2026/7月/7.23/报告${number}.pdf`,
    saved_path: `/tmp/报告${number}.pdf`,
  };
}

function validRecord(number = 1) {
  return {
    media_id: `pdf-${number}`,
    status: 'reviewed',
    source_count: 1,
    source_titles: [`报告${number}.pdf`],
    report_type: 'company',
    research_subject: '测试公司',
    executive_summary: '本报告分析测试公司的经营变化与行业供需，指出核心产品需求增长、产能释放及价格变化共同影响未来盈利。报告结合历史业绩、管理层指引和估值假设，给出主要预测、潜在催化剂与风险，并说明关键变量变化对收入、利润率和市场份额的传导路径，供后续主题筛选和原文定位使用。',
    key_findings: ['结论一'],
    content_tags: ['financials', 'supply_demand'],
    data_points: [{ metric: '收入增长', value_text: '10%', period: '2026E', basis: 'forecast', context: '预计收入增长10%' }],
    entities: ['测试公司'],
    evidence: [{ claim: '需求增长', quote: 'Demand is expected to grow 10% in 2026.' }],
    raw_answer: '{}',
  };
}

test('accepts a non-exclusive folder answer when target source is present', () => {
  const raw = { ...validRecord(), source_count: 72, source_titles: ['其他报告.pdf', '报告1.pdf'] };
  const result = validateAndNormalizeSuccess(raw, indexRecord());
  assert.equal(result.status, 'reviewed');
  assert.equal(result.source_match, true);
  assert.equal(result.source_exclusive, false);
  assert.ok(result.validation_warnings.includes('non_exclusive_sources:72'));
});

test('accepts a routing answer when target source is absent and records warning', () => {
  const raw = { ...validRecord(), source_count: 72, source_titles: ['其他报告.pdf'] };
  const result = validateAndNormalizeSuccess(raw, indexRecord());
  assert.equal(result.status, 'reviewed');
  assert.equal(result.source_match, false);
  assert.ok(result.validation_warnings.includes('target_not_in_source_list'));
});

test('rejects an answer with no source metadata', () => {
  const raw = { ...validRecord(), source_count: null, source_titles: [] };
  const result = validateAndNormalizeSuccess(raw, indexRecord());
  assert.equal(result.status, 'UNREVIEWED');
  assert.equal(result.failure_code, 'NO_SOURCE_METADATA');
});

test('accepts valid v2 and preserves download identity', () => {
  const result = validateAndNormalizeSuccess(validRecord(), indexRecord());
  assert.equal(result.status, 'reviewed');
  assert.equal(result.summary_role, 'routing_candidate');
  assert.equal(result.knowledge_base, '环球研报直通车');
  assert.equal(result.media_type, 1);
  assert.equal(result.saved_path, '/tmp/报告1.pdf');
});

test('rejects invalid report type and content tag', () => {
  const raw = { ...validRecord(), report_type: 'equity', content_tags: ['financials', 'ai_theme'] };
  const result = validateAndNormalizeSuccess(raw, indexRecord());
  assert.equal(result.status, 'UNREVIEWED');
  assert.deepEqual(result.validation_errors, ['INVALID_REPORT_TYPE', 'INVALID_CONTENT_TAG']);
});

test('deterministically truncates capped arrays and records warnings', () => {
  const raw = {
    ...validRecord(),
    key_findings: Array.from({ length: 7 }, (_, index) => `结论${index}`),
    entities: Array.from({ length: 12 }, (_, index) => `实体${index}`),
    evidence: Array.from({ length: 6 }, (_, index) => ({ claim: `结论${index}`, quote: `Evidence ${index}` })),
  };
  const result = validateAndNormalizeSuccess(raw, indexRecord());
  assert.equal(result.status, 'reviewed');
  assert.equal(result.key_findings.length, 4);
  assert.equal(result.entities.length, 10);
  assert.equal(result.evidence.length, 4);
  assert.deepEqual(result.validation_warnings.filter((item) => item.includes('truncated')), [
    'key_findings_truncated:7->4',
    'entities_truncated:12->10',
    'evidence_truncated:6->4',
  ]);
});

test('resume skips successes and prioritizes failures', () => {
  const index = [indexRecord(1), indexRecord(2), indexRecord(3)];
  const progress = [validateAndNormalizeSuccess(validRecord(2), index[1])];
  const failures = [{ media_id: 'pdf-3', failure_code: 'ANSWER_TIMEOUT' }];
  assert.deepEqual(buildPending(index, progress, failures).map((item) => item.media_id), ['pdf-3', 'pdf-1']);
});

test('resume skips terminal failures after four attempts', () => {
  const index = [indexRecord(1), indexRecord(2)];
  const failures = [{ media_id: 'pdf-1', failure_code: 'ANSWER_TIMEOUT', attempts: 4 }];
  assert.deepEqual(buildPending(index, [], failures).map((item) => item.media_id), ['pdf-2']);
});

test('snapshot has one authoritative row per index record', () => {
  const index = Array.from({ length: 72 }, (_, item) => indexRecord(item + 1));
  const progress = [validateAndNormalizeSuccess(validRecord(1), index[0])];
  const failures = index.slice(1).map((item) => ({ media_id: item.media_id, failure_code: 'ANSWER_TIMEOUT', attempts: 2 }));
  const snapshot = buildSnapshot(index, progress, failures);
  const report = audit(index, snapshot, progress, failures);
  assert.equal(snapshot.length, 72);
  assert.equal(new Set(snapshot.map((item) => item.media_id)).size, 72);
  assert.equal(report.reviewed, 1);
  assert.equal(report.complete_accounting, true);
});

test('browser parser accepts complete fenced JSON and strips citation glyphs', async () => {
  const { parseStrictJson } = await import('../scripts/ima-browser-summary-runner.mjs');
  const parsed = parseStrictJson('```json\n{"report_type":"company","evidence":[{"quote":"原文\\uE001"}]}\n```');
  assert.equal(parsed.report_type, 'company');
  assert.equal(parsed.evidence[0].quote, '原文');
});

test('browser parser rejects trailing prose', async () => {
  const { parseStrictJson } = await import('../scripts/ima-browser-summary-runner.mjs');
  assert.throws(() => parseStrictJson('{"report_type":"company"}\n完成'), SyntaxError);
});

test('batch parser maps reports by exact source_title rather than array order', async () => {
  const { mapBatchReports } = await import('../scripts/ima-browser-summary-runner.mjs');
  const result = mapBatchReports({
    reports: [
      { source_title: '报告3.pdf', research_subject: '主体3' },
      { source_title: '报告1.pdf', research_subject: '主体1' },
      { source_title: '报告2.pdf', research_subject: '主体2' },
    ],
  }, ['报告1.pdf', '报告2.pdf', '报告3.pdf']);
  assert.deepEqual(result.map((item) => item.report.research_subject), ['主体1', '主体2', '主体3']);
});

test('batch parser isolates missing and duplicate titles to affected reports', async () => {
  const { mapBatchReports } = await import('../scripts/ima-browser-summary-runner.mjs');
  const result = mapBatchReports({
    reports: [
      { source_title: '报告1.pdf' },
      { source_title: '报告1.pdf' },
      { source_title: '报告2.pdf' },
    ],
  }, ['报告1.pdf', '报告2.pdf', '报告3.pdf']);
  assert.equal(result[0].failure_code, 'BATCH_REPORT_DUPLICATE');
  assert.ok(result[1].report);
  assert.equal(result[2].failure_code, 'BATCH_REPORT_MISSING');
});

test('batch parser enforces per-report caps without blocking other reports', async () => {
  const { mapBatchReports } = await import('../scripts/ima-browser-summary-runner.mjs');
  const reports = [1, 2, 3].map((number) => ({
    source_title: `报告${number}.pdf`,
    key_findings: Array.from({ length: 5 }, (_, index) => `结论${index}`),
    data_points: Array.from({ length: 6 }, (_, index) => ({ metric: `指标${index}` })),
    entities: Array.from({ length: 10 }, (_, index) => `实体${index}`),
    evidence: Array.from({ length: 4 }, (_, index) => ({ quote: `证据${index}` })),
  }));
  const result = mapBatchReports({ reports }, ['报告1.pdf', '报告2.pdf', '报告3.pdf']);
  assert.equal(result[0].report.key_findings.length, 3);
  assert.equal(result[0].report.data_points.length, 4);
  assert.equal(result[0].report.entities.length, 8);
  assert.equal(result[0].report.evidence.length, 3);
  assert.ok(result[0].warnings.includes('batch_data_points_truncated:6->4'));
  assert.ok(result[1].report);
  assert.ok(result[2].report);
});
