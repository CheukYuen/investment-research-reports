const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyQuotaSlot,
  compareDownloadPriority,
  rankingSystemPrompt,
  runRankAi,
  shanghaiDateKey,
  REPORT_TYPES,
  SECTORS_CN_TO_EN,
  MAX_SECTORS,
  normalizeClassification,
  normalizeRanking,
  classifyBatchWithDeepSeek,
} = require('../scripts/sync-kb-pdfs.cjs');

test('AI ranking directly uses body summaries without a second-stage rerank', async () => {
  const source = require('node:fs').readFileSync(
    require.resolve('../scripts/sync-kb-pdfs.cjs'),
    'utf8',
  );
  const prompt = rankingSystemPrompt();
  assert.match(prompt, /通用摘要/);
  assert.match(prompt, /正文证据/);
  assert.doesNotMatch(prompt, /第一轮|第二轮|只根据研报 PDF 标题和路径/);
  assert.match(source, /defaultModel:\s*'deepseek-v4-flash'/);
  assert.doesNotMatch(source, /deepseek-v4-pro/);
  await assert.rejects(runRankAi({}), /requires --summary-source/);
});

test('ranking prompt defines all six report types and eleven sectors, and no longer claims report_type as input', () => {
  const prompt = rankingSystemPrompt();
  for (const type of REPORT_TYPES) assert.match(prompt, new RegExp(type));
  for (const nameCn of SECTORS_CN_TO_EN.keys()) assert.match(prompt, new RegExp(nameCn));
  assert.doesNotMatch(prompt, /只根据输入中的研报标题、报告类型/);
});

test('classification: valid report_type with reason is kept as-is', () => {
  const result = normalizeClassification({
    report_type: 'company',
    report_type_reason: '正文以单一公司评级和目标价为核心结论',
    sectors_cn: ['信息技术'],
  });
  assert.equal(result.report_type, 'company');
  assert.equal(result.report_type_reason, '正文以单一公司评级和目标价为核心结论');
  assert.deepEqual(result.sectors, [{ name_cn: '信息技术', name_en: 'Information Technology' }]);
  assert.deepEqual(result.classification_warnings, []);
});

test('classification: invalid report_type degrades to null with a warning, never other', () => {
  const result = normalizeClassification({ report_type: 'industy', report_type_reason: '拼写错误' });
  assert.equal(result.report_type, null);
  assert.ok(result.classification_warnings.includes('invalid_report_type:industy'));
});

test('classification: valid report_type without a reason degrades to null with a warning', () => {
  const result = normalizeClassification({ report_type: 'macro', report_type_reason: '' });
  assert.equal(result.report_type, null);
  assert.ok(result.classification_warnings.includes('missing_report_type_reason'));
});

test('classification: sectors outside the controlled 11-value list are dropped, valid ones keep the mapped English name', () => {
  const result = normalizeClassification({ sectors_cn: ['信息技术', '光模块'] });
  assert.deepEqual(result.sectors, [{ name_cn: '信息技术', name_en: 'Information Technology' }]);
  assert.ok(result.classification_warnings.includes('invalid_sector_removed:光模块'));
});

test('classification: sectors beyond the cap are truncated and warned, main sector stays first', () => {
  const result = normalizeClassification({
    sectors_cn: ['信息技术', '公用事业', '工业', '能源'],
  });
  assert.equal(result.sectors.length, MAX_SECTORS);
  assert.equal(result.sectors[0].name_cn, '信息技术');
  assert.ok(result.classification_warnings.some((warning) => warning.startsWith('sectors_truncated:4->3')));
});

test('classification: empty sectors_cn on a macro/strategy report is accepted with no warning', () => {
  const result = normalizeClassification({ report_type: 'macro', report_type_reason: '央行政策', sectors_cn: [] });
  assert.deepEqual(result.sectors, []);
  assert.deepEqual(result.classification_warnings, []);
});

test('normalizeRanking still throws on invalid priority/score regardless of classification validity', () => {
  assert.throws(
    () => normalizeRanking({ priority: 'P9', score: 50 }, { title: '报告.pdf' }),
    /invalid priority/,
  );
  assert.throws(
    () => normalizeRanking({ priority: 'P0', score: 'high' }, { title: '报告.pdf' }),
    /invalid score/,
  );
});

function fakeConfig() {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://fake.deepseek.local',
    model: 'deepseek-v4-flash',
    requestTimeoutMs: 5000,
    maxTokens: 4000,
  };
}

function fakeDeepSeekResponse(resultsPayload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify(resultsPayload) } }],
      });
    },
  };
}

test('classifyBatchWithDeepSeek payload never includes report_type or research_subject', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return fakeDeepSeekResponse({
      results: [{ priority: 'P1', score: 70, report_type: 'industry', report_type_reason: '行业供需比较', sectors_cn: [], topics: [] }],
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const batch = [{ media_id: 'm1', title: '报告.pdf', report_type: null, research_subject: '', executive_summary: '摘要', key_findings: [], content_tags: [], data_points: [], entities: [], evidence: [] }];
  await classifyBatchWithDeepSeek(fakeConfig(), batch);

  assert.equal(calls.length, 1);
  const userMessage = calls[0].messages.find((message) => message.role === 'user');
  const sentInputs = JSON.parse(userMessage.content.slice(userMessage.content.indexOf('[')));
  assert.equal('report_type' in sentInputs[0], false);
  assert.equal('research_subject' in sentInputs[0], false);
});

test('classifyBatchWithDeepSeek retries the whole batch once on invalid priority, then throws without a third attempt', async (t) => {
  let callCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    callCount += 1;
    return fakeDeepSeekResponse({ results: [{ priority: 'NOT_A_PRIORITY', score: 50 }] });
  };
  t.after(() => { global.fetch = originalFetch; });

  const batch = [{ media_id: 'm1', title: '报告.pdf', executive_summary: '摘要' }];
  await assert.rejects(classifyBatchWithDeepSeek(fakeConfig(), batch), /invalid priority/);
  assert.equal(callCount, 2);
});

test('daily quota allows normal attempts through 30, then exactly one probe', () => {
  assert.equal(classifyQuotaSlot(0, 30, 1), 'budget');
  assert.equal(classifyQuotaSlot(29, 30, 1), 'budget');
  assert.equal(classifyQuotaSlot(30, 30, 1), 'probe');
  assert.equal(classifyQuotaSlot(31, 30, 1), 'stop');
});

test('zero probe preserves the hard daily budget', () => {
  assert.equal(classifyQuotaSlot(29, 30, 0), 'budget');
  assert.equal(classifyQuotaSlot(30, 30, 0), 'stop');
});

test('download ordering always prefers P0 and P1 before P2', () => {
  const records = [
    { priority: 'P2', rank: 1 },
    { priority: 'P1', rank: 20 },
    { priority: 'P0', rank: 30 },
    { priority: 'P1', rank: 10 },
  ];
  records.sort(compareDownloadPriority);
  assert.deepEqual(
    records.map((record) => `${record.priority}:${record.rank}`),
    ['P0:30', 'P1:10', 'P1:20', 'P2:1'],
  );
});

test('quota dates use Asia/Shanghai rather than UTC', () => {
  assert.equal(shanghaiDateKey('2026-07-23T15:59:59.000Z'), '20260723');
  assert.equal(shanghaiDateKey('2026-07-23T16:00:00.000Z'), '20260724');
});
