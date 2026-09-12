const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompts } = require('../scripts/ima-manual-prompts.cjs');
const { parseSectionAnswer, validateAndNormalizeSuccess } = require('../scripts/report-summaries.cjs');
const records = Array.from({ length: 99 }, (_, i) => ({ media_id: String(i), title: `报告${i}.pdf` }));
test('99 reports yield 30/30/30/9, preserving every filename exactly once', () => {
  const result = buildPrompts(records, [], [], 30, '2026年国际顶级投行研报/9月/9.11');
  assert.equal(result.prompts.length, 4);
  assert.match(result.prompts[3], /以下 9 篇/);
  for (const r of records) assert.equal(result.prompts.join('\n').split('\n').filter(line => line === r.title).length, 1);
});
test('only valid summaries are skipped; current failed progress overrides older success', () => {
  const valid = { ...records[0], status: 'reviewed', source_match: true, executive_summary: '短摘要。' };
  assert.equal(buildPrompts(records, [], [valid], 30, '目录').pending, 98);
  assert.equal(buildPrompts(records, [{ ...valid, status: 'UNREVIEWED' }], [valid], 30, '目录').pending, 99);
  assert.equal(buildPrompts(records, [{ ...valid, source_match: false }], [], 30, '目录').pending, 99);
});
test('reject invalid batch sizes and duplicate identities', () => {
  for (const size of [0, 31, 38, 1.5, NaN]) assert.throws(() => buildPrompts(records, [], [], size, '目录'));
  assert.throws(() => buildPrompts([records[0], records[0]], [], [], 30, '目录'), /Duplicate/);
  assert.deepEqual(buildPrompts([], [], [], 30, '目录').prompts, []);
});
test('short summary source attribution survives existing parsing and validation', () => {
  const summary = '据该文件已有AI摘要，公司光通信订单增长，需求来自AI数据中心。';
  const parsed = parseSectionAnswer(`文件名\n报告0.pdf\n核心摘要\n${summary}`, '报告0.pdf');
  const normalized = validateAndNormalizeSuccess({ ...parsed.report, status: 'reviewed' }, records[0]);
  assert.equal(normalized.executive_summary, summary);
  assert.equal(normalized.status, 'reviewed');
  assert.equal(normalized.source_match, true);
  assert.equal(normalized.summary_role, 'routing_candidate');
  assert.equal(parseSectionAnswer('文件名\n报告0.pdf\n核心摘要\nNO_CONTENT', '报告0.pdf').failure_code, 'CONTENT_UNREADABLE');
});
