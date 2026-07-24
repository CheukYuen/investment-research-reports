const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyQuotaSlot,
  compareDownloadPriority,
  rankingSystemPrompt,
  runRankAi,
  shanghaiDateKey,
} = require('../scripts/sync-kb-pdfs.cjs');

test('AI ranking is a single summary-based pass', async () => {
  const prompt = rankingSystemPrompt();
  assert.match(prompt, /通用摘要/);
  assert.match(prompt, /正文证据/);
  assert.doesNotMatch(prompt, /第一轮|第二轮|只根据研报 PDF 标题和路径/);
  await assert.rejects(runRankAi({}), /requires --summary-source/);
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
