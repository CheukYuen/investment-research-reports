const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findDatedFiles,
  migrateSummaryRecord,
  migrateQueueRecord,
  migrateFileSet,
} = require('../scripts/migrate-classification-fields.cjs');

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('migrateSummaryRecord zeroes classification fields and adds topics without touching unrelated fields', () => {
  const record = {
    media_id: 'pdf-1',
    report_type: 'company',
    research_subject: '测试公司',
    content_tags: ['financials'],
    executive_summary: '摘要',
  };
  const migrated = migrateSummaryRecord(record);
  assert.equal(migrated.report_type, null);
  assert.equal(migrated.report_type_reason, null);
  assert.deepEqual(migrated.sectors, []);
  assert.deepEqual(migrated.topics, []);
  assert.equal(migrated.research_subject, '测试公司');
  assert.deepEqual(migrated.content_tags, ['financials']);
  assert.equal(migrated.executive_summary, '摘要');
});

test('migrateQueueRecord zeroes classification fields but never touches existing topics', () => {
  const record = {
    media_id: 'pdf-1',
    report_type: 'other',
    priority: 'P1',
    score: 70,
    rank: 3,
    reasons: ['理由'],
    ranking_evidence: ['证据'],
    topics: ['ai_server', 'liquid_cooling'],
  };
  const migrated = migrateQueueRecord(record);
  assert.equal(migrated.report_type, null);
  assert.equal(migrated.report_type_reason, null);
  assert.deepEqual(migrated.sectors, []);
  assert.equal(migrated.classification_source, null);
  assert.deepEqual(migrated.classification_warnings, []);
  assert.deepEqual(migrated.topics, ['ai_server', 'liquid_cooling']);
  assert.equal(migrated.priority, 'P1');
  assert.equal(migrated.score, 70);
  assert.equal(migrated.rank, 3);
  assert.deepEqual(migrated.reasons, ['理由']);
  assert.deepEqual(migrated.ranking_evidence, ['证据']);
});

test('findDatedFiles only matches the exact YYYYMMDD naming pattern for the given prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-classification-'));
  try {
    fs.writeFileSync(path.join(root, 'report-summaries-20260805.jsonl'), '');
    fs.writeFileSync(path.join(root, 'report-summaries-2026080X.jsonl'), '');
    fs.writeFileSync(path.join(root, 'ai-ranked-queue-summary-20260805.jsonl'), '');
    fs.writeFileSync(path.join(root, 'ai-ranked-queue-20260805.jsonl'), '');
    const summaryFiles = findDatedFiles(root, 'report-summaries-');
    const queueFiles = findDatedFiles(root, 'ai-ranked-queue-summary-');
    assert.deepEqual(summaryFiles.map((file) => file.name), ['report-summaries-20260805.jsonl']);
    assert.deepEqual(queueFiles.map((file) => file.name), ['ai-ranked-queue-summary-20260805.jsonl']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration is idempotent: running twice yields byte-identical files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-classification-'));
  try {
    const summaryPath = path.join(root, 'report-summaries-20260805.jsonl');
    writeJsonl(summaryPath, [
      { media_id: 'pdf-1', report_type: 'company', research_subject: '主体1', priority: undefined },
      { media_id: 'pdf-2', report_type: 'other', research_subject: '' },
    ]);
    const files = findDatedFiles(root, 'report-summaries-');
    migrateFileSet(files, 'summary', migrateSummaryRecord, false);
    const firstPass = fs.readFileSync(summaryPath, 'utf8');
    migrateFileSet(findDatedFiles(root, 'report-summaries-'), 'summary', migrateSummaryRecord, false);
    const secondPass = fs.readFileSync(summaryPath, 'utf8');
    assert.equal(firstPass, secondPass);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run reports the plan without writing any file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-classification-'));
  try {
    const summaryPath = path.join(root, 'report-summaries-20260805.jsonl');
    const original = [{ media_id: 'pdf-1', report_type: 'company' }];
    writeJsonl(summaryPath, original);
    const before = fs.readFileSync(summaryPath, 'utf8');
    const results = migrateFileSet(findDatedFiles(root, 'report-summaries-'), 'summary', migrateSummaryRecord, true);
    const after = fs.readFileSync(summaryPath, 'utf8');
    assert.equal(before, after);
    assert.equal(results[0].changed, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration preserves record count and leaves untouched fields exactly as before', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-classification-'));
  try {
    const queuePath = path.join(root, 'ai-ranked-queue-summary-20260805.jsonl');
    writeJsonl(queuePath, [
      { media_id: 'pdf-1', priority: 'P0', score: 90, rank: 1, research_subject: '主体', topics: ['ai_server'] },
      { media_id: 'pdf-2', priority: 'P3', score: 10, rank: 2, research_subject: '', topics: [] },
    ]);
    migrateFileSet(findDatedFiles(root, 'ai-ranked-queue-summary-'), 'queue', migrateQueueRecord, false);
    const after = readJsonl(queuePath);
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((record) => record.media_id), ['pdf-1', 'pdf-2']);
    assert.deepEqual(after.map((record) => record.topics), [['ai_server'], []]);
    assert.deepEqual(after.map((record) => record.rank), [1, 2]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
