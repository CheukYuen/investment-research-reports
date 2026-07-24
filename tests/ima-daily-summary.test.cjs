const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeDate,
  pathsForDate,
  renderPrompt,
  commandNext,
  commandIngest,
} = require('../scripts/ima-daily-summary.cjs');

function indexRecord(number) {
  return {
    indexed_at: '2026-07-24T00:00:00.000Z',
    knowledge_base: '环球研报直通车',
    source_path: `环球研报直通车 / 2026年国际顶级投行研报 / 7月 / 7.24 / 报告${number}.pdf`,
    title: `报告${number}.pdf`,
    media_type: 1,
    media_id: `pdf-${number}`,
    parent_folder_id: 'folder-724',
    local_relative_path: `2026/7月/7.24/报告${number}.pdf`,
    saved_path: `/tmp/报告${number}.pdf`,
  };
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
  );
}

function tempPaths(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-daily-summary-'));
  const date = normalizeDate('20260724');
  const paths = {
    date,
    index: path.join(root, 'index.jsonl'),
    progress: path.join(root, 'progress.jsonl'),
    failures: path.join(root, 'failures.jsonl'),
    batches: path.join(root, 'batches.jsonl'),
  };
  writeJsonl(paths.index, Array.from({ length: count }, (_, index) => indexRecord(index + 1)));
  writeJsonl(paths.progress, []);
  writeJsonl(paths.failures, []);
  writeJsonl(paths.batches, []);
  return { root, paths };
}

test('date paths are derived from the requested day rather than a fixed experiment date', () => {
  const date = normalizeDate('2026-08-03');
  assert.equal(date.compact, '20260803');
  assert.equal(date.sourcePath, '2026年国际顶级投行研报/8月/8.3');
  const paths = pathsForDate('20260803');
  assert.match(paths.index, /index-20260803\.jsonl$/);
  assert.match(paths.summaryQueue, /ai-ranked-queue-summary-20260803\.jsonl$/);
  assert.equal(paths.titleQueue, undefined);
  assert.equal(paths.comparison, undefined);
});

test('dynamic batch prompt supports a tail smaller than five reports', () => {
  const prompt = renderPrompt([indexRecord(1), indexRecord(2)]);
  assert.match(prompt, /以下2篇研报/);
  assert.match(prompt, /恰好包含2条记录/);
  assert.match(prompt, /1\.《报告1\.pdf》/);
  assert.match(prompt, /2\.《报告2\.pdf》/);
  assert.doesNotMatch(prompt, /\{\{REPORT_COUNT\}\}|\{\{FILE_LIST\}\}/);
});

test('next creates five-item batches and resumes an open batch without duplicating state', () => {
  const { root, paths } = tempPaths(7);
  try {
    const config = { max_batch_size: 5, max_attempts: 4, model_version: 'ima-app-hy3-fast' };
    const first = commandNext(paths, {}, config);
    assert.equal(first.batch_size, 5);
    assert.equal(first.resumed, false);
    const second = commandNext(paths, {}, config);
    assert.equal(second.batch_id, first.batch_id);
    assert.equal(second.resumed, true);
    assert.equal(fs.readFileSync(paths.batches, 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('browser is preferred and an open batch can switch to the app fallback', () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = {
      max_batch_size: 5,
      max_attempts: 4,
      interaction_order: ['browser', 'app'],
      browser_model_version: 'ima-web-hy3-fast',
      app_model_version: 'ima-app-hy3-fast',
    };
    const browser = commandNext(paths, {}, config);
    assert.equal(browser.interaction_surface, 'browser');
    assert.equal(browser.model_version, 'ima-web-hy3-fast');

    const app = commandNext(paths, { surface: 'app' }, config);
    assert.equal(app.resumed, true);
    assert.equal(app.batch_id, browser.batch_id);
    assert.equal(app.interaction_surface, 'app');
    assert.equal(app.model_version, 'ima-app-hy3-fast');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('next prioritizes retryable failures and leaves terminal failures out', () => {
  const { root, paths } = tempPaths(4);
  try {
    writeJsonl(paths.failures, [
      { media_id: 'pdf-3', attempts: 1, failure_code: 'ANSWER_TIMEOUT' },
      { media_id: 'pdf-4', attempts: 4, failure_code: 'ANSWER_TIMEOUT' },
    ]);
    const result = commandNext(paths, {}, {
      max_batch_size: 5,
      max_attempts: 4,
      model_version: 'ima-app-hy3-fast',
    });
    assert.deepEqual(
      result.records.map((record) => record.media_id),
      ['pdf-3', 'pdf-1', 'pdf-2'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest saves valid reports independently and fails only the missing report', async () => {
  const { root, paths } = tempPaths(3);
  try {
    const config = { max_batch_size: 5, max_attempts: 4, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = JSON.stringify({
      reports: [
        {
          source_title: '报告2.pdf',
          report_type: 'company',
          research_subject: '主体2',
          executive_summary: '报告二分析经营变化、供需关系和未来盈利路径，保留关键数字与原文线索，供下载筛选使用。',
          key_findings: ['结论2'],
          content_tags: ['financials'],
          data_points: [],
          entities: ['主体2'],
          evidence: [],
        },
        {
          source_title: '报告1.pdf',
          report_type: 'industry',
          research_subject: '主体1',
          executive_summary: '报告一分析行业结构、主要变化和影响路径，保留关键结论、相关实体及正文线索，供下载筛选使用。',
          key_findings: ['结论1'],
          content_tags: ['industry_structure'],
          data_points: [],
          entities: ['主体1'],
          evidence: [{ claim: '行业变化', quote: 'Industry structure is changing.' }],
        },
      ],
    });
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(
      readLines(paths.progress).map((record) => record.media_id).sort(),
      ['pdf-1', 'pdf-2'],
    );
    assert.equal(readLines(paths.failures)[0].media_id, 'pdf-3');
    assert.equal(readLines(paths.failures)[0].failure_code, 'BATCH_REPORT_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
