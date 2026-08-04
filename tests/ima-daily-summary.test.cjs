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
  commandFailBatch,
  commandInvalidateReviewed,
  statusReport,
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
  assert.match(paths.summaryHtml, /ai-ranking-analysis-202608\.html$/);
  assert.equal(paths.titleQueue, undefined);
  assert.equal(paths.comparison, undefined);
});

test('dynamic prompt keeps core content requirements and substitutes report titles', () => {
  const prompt = renderPrompt([indexRecord(1), indexRecord(2)]);
  assert.match(prompt, /读这2篇研报/);
  assert.match(prompt, /核心摘要/);
  assert.match(prompt, /关键结论/);
  assert.match(prompt, /重要数字/);
  assert.match(prompt, /关键实体与标签/);
  assert.match(prompt, /NO_CONTENT/);
  assert.match(prompt, /1\.《报告1\.pdf》/);
  assert.match(prompt, /2\.《报告2\.pdf》/);
  assert.doesNotMatch(prompt, /\{\{REPORT_COUNT\}\}|\{\{FILE_LIST\}\}/);
});

test('next exposes the configured fixed IMA knowledge-base browser URL', () => {
  const { root, paths } = tempPaths(1);
  try {
    const browserUrl = 'https://ima.qq.com/wikis?knowledgeBaseId=7442602265681522';
    const result = commandNext(paths, {}, {
      max_batch_size: 1,
      max_attempts: 5,
      browser_url: browserUrl,
    });
    assert.equal(result.browser_url, browserUrl);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sectionAnswer(title = '报告1.pdf') {
  return `文件名
${title}

核心摘要
报告分析测试公司的产品需求、经营变化和盈利传导，认为订单与产能释放将推动未来收入增长，同时提示竞争加剧和价格下行风险。

关键结论
- 核心产品需求持续增长
- 新产能释放构成主要催化剂

重要数字
- 收入增长：2026E 预计增长20%

关键实体与标签
- 测试公司、核心产品、半导体设备
- 需求、产能、订单`;
}

test('ingest parses a standard section answer into structured fields', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const result = await commandIngest(paths, {}, config, sectionAnswer());
    assert.equal(result.reviewed, 1);
    assert.equal(result.failed, 0);
    const saved = readLines(paths.progress)[0];
    assert.equal(saved.source_title, '报告1.pdf');
    assert.ok(saved.key_findings.length >= 2);
    assert.ok(saved.data_points.length >= 1);
    assert.ok(saved.entities.length >= 1);
    assert.doesNotMatch(saved.executive_summary, /核心摘要/);
    assert.ok(saved.validation_warnings.includes('section_answer_parsed'));
    assert.ok(!saved.validation_warnings.includes('natural_language_answer_wrapped'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest accepts markdown heading and bullet variants', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `## 文件名
**报告1.pdf**

## 核心摘要
报告分析测试公司的产品需求、经营变化和盈利传导，认为订单与产能释放将推动未来收入增长，同时提示竞争加剧和价格下行风险。

**关键结论**
1. 核心产品需求持续增长
2. 新产能释放构成主要催化剂

## 重要数字
• 收入增长：2026E 预计增长20%

**关键实体与标签**
• 测试公司、核心产品、半导体设备
• 需求、产能、订单`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 1);
    const saved = readLines(paths.progress)[0];
    assert.equal(saved.key_findings.length, 2);
    assert.equal(saved.data_points.length, 1);
    assert.ok(saved.entities.length >= 1);
    assert.doesNotMatch(saved.executive_summary, /核心摘要/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest rejects NO_CONTENT without writing progress', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const result = await commandIngest(paths, {}, config, 'NO_CONTENT');
    assert.equal(result.failed, 1);
    assert.equal(readLines(paths.progress).length, 0);
    assert.equal(readLines(paths.failures)[0].failure_code, 'CONTENT_UNREADABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest rejects NO_CONTENT inside the core summary section', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `文件名
报告1.pdf

核心摘要
NO_CONTENT`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.failed, 1);
    assert.equal(readLines(paths.progress).length, 0);
    assert.equal(readLines(paths.failures)[0].failure_code, 'CONTENT_UNREADABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest rejects a mismatched source title without writing progress', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const result = await commandIngest(paths, {}, config, sectionAnswer('另一篇报告.pdf'));
    assert.equal(result.failed, 1);
    assert.equal(readLines(paths.progress).length, 0);
    assert.equal(readLines(paths.failures)[0].failure_code, 'SOURCE_TITLE_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest accepts a normalized source title and records a warning', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const result = await commandIngest(paths, {}, config, sectionAnswer('《报告1》'));
    assert.equal(result.reviewed, 1);
    const saved = readLines(paths.progress)[0];
    assert.equal(saved.source_title, '报告1.pdf');
    assert.ok(saved.validation_warnings.includes('source_title_normalized'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest treats straight and curly title quotes as equivalent', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const index = readLines(paths.index);
    index[0].title = '报告“增持”1.pdf';
    fs.writeFileSync(paths.index, `${JSON.stringify(index[0])}\n`);
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const result = await commandIngest(paths, {}, config, sectionAnswer('报告"增持"1.pdf'));
    assert.equal(result.reviewed, 1);
    const saved = readLines(paths.progress)[0];
    assert.equal(saved.source_title, '报告“增持”1.pdf');
    assert.ok(saved.validation_warnings.includes('source_title_normalized'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest maps multi-report section answers by exact source title', async () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = { max_batch_size: 5, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `${sectionAnswer('报告2.pdf')}\n\n${sectionAnswer('报告1.pdf')}`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 2);
    assert.equal(result.failed, 0);
    const saved = readLines(paths.progress);
    assert.deepEqual(new Set(saved.map((record) => record.source_title)), new Set([
      '报告1.pdf',
      '报告2.pdf',
    ]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest maps IMA copied sections when the source title precedes 文件名', async () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = { max_batch_size: 5, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `《报告2.pdf》
文件名
核心摘要
报告二分析独立的云计算需求、资本开支和盈利传导，认为新增订单将推动未来收入增长，同时提示竞争加剧风险。

关键结论
- 报告二结论

重要数字
- 收入增长：2027E 预计增长30%

关键实体与标签
- 报告二公司、云计算

《报告1.pdf》
文件名
核心摘要
报告一分析独立的半导体设备需求、产能和盈利传导，认为订单释放将推动未来收入增长，同时提示价格风险。

关键结论
- 报告一结论

重要数字
- 收入增长：2026E 预计增长20%

关键实体与标签
- 报告一公司、半导体设备`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 2);
    assert.equal(result.failed, 0);
    const saved = readLines(paths.progress);
    const first = saved.find((record) => record.title === '报告1.pdf');
    const second = saved.find((record) => record.title === '报告2.pdf');
    assert.match(first.executive_summary, /半导体设备/);
    assert.match(second.executive_summary, /云计算/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest maps exact titled blocks when IMA omits the 文件名 heading', async () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = { max_batch_size: 5, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `以下为两篇研报摘要：
《报告2.pdf》
核心摘要
报告二分析云计算需求和资本开支，认为新增订单将推动未来收入增长，同时提示竞争风险。

关键结论
- 报告二结论

重要数字
- 收入增长：2027E 预计增长30%

关键实体与标签
- 报告二公司、云计算

《报告1.pdf》
核心摘要
报告一分析半导体设备需求和产能，认为订单释放将推动未来收入增长，同时提示价格风险。

关键结论
- 报告一结论

重要数字
- 收入增长：2026E 预计增长20%

关键实体与标签
- 报告一公司、半导体设备`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 2);
    assert.equal(result.failed, 0);
    const saved = readLines(paths.progress);
    assert.match(saved.find((record) => record.title === '报告1.pdf').executive_summary, /半导体设备/);
    assert.match(saved.find((record) => record.title === '报告2.pdf').executive_summary, /云计算/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest does not reuse a section when its exact source title is missing', async () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = { max_batch_size: 5, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `文件名
核心摘要
这段摘要没有任何可核对的真实文件名，因此不得映射给任一期望报告。

关键结论
- 不应保存`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 0);
    assert.equal(result.failed, 2);
    assert.equal(readLines(paths.progress).length, 0);
    assert.ok(readLines(paths.failures).every((record) =>
      record.failure_code === 'BATCH_REPORT_MISSING'
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest isolates NO_CONTENT in the title-before-heading format', async () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = { max_batch_size: 5, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const answer = `《报告1.pdf》
文件名
NO_CONTENT

《报告2.pdf》
文件名
核心摘要
报告二分析独立的云计算需求、资本开支和盈利传导，认为新增订单将推动未来收入增长，同时提示竞争风险。

关键结论
- 报告二结论

重要数字
- 收入增长：2027E 预计增长30%

关键实体与标签
- 报告二公司、云计算`;
    const result = await commandIngest(paths, {}, config, answer);
    assert.equal(result.reviewed, 1);
    assert.equal(result.failed, 1);
    assert.equal(readLines(paths.progress)[0].title, '报告2.pdf');
    assert.equal(readLines(paths.failures)[0].failure_code, 'CONTENT_UNREADABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest rejects an uncopied answer without consuming a retry', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    const planned = commandNext(paths, {}, config);
    const result = await commandIngest(paths, {}, config, '我没有找到该文件');
    assert.equal(result.accepted, false);
    assert.equal(result.failure_code, 'INPUT_NOT_COPIED');
    assert.equal(readLines(paths.progress).length, 0);
    assert.equal(readLines(paths.failures).length, 0);
    assert.equal(commandNext(paths, {}, config).batch_id, planned.batch_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest reads a complete Browser answer from --input-file', async () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-web-hy3-fast' };
    commandNext(paths, {}, config);
    const inputFile = path.join(root, 'browser-answer.txt');
    fs.writeFileSync(inputFile, sectionAnswer(), 'utf8');
    const result = await commandIngest(paths, { 'input-file': inputFile }, config);
    assert.equal(result.reviewed, 1);
    assert.equal(result.failed, 0);
    assert.equal(readLines(paths.progress)[0].source_title, '报告1.pdf');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('compact next omits prompt and records while preserving the full planned batch', () => {
  const { root, paths } = tempPaths(2);
  try {
    const config = {
      max_batch_size: 5,
      max_attempts: 4,
      browser_url: 'https://ima.qq.com/wikis?knowledgeBaseId=7442602265681522',
    };
    const result = commandNext(paths, { compact: true }, config);
    assert.equal(result.done, false);
    assert.equal(result.batch_size, 2);
    assert.equal(result.browser_url, config.browser_url);
    assert.equal(result.prompt, undefined);
    assert.equal(result.records, undefined);
    const saved = readLines(paths.batches)[0];
    assert.equal(saved.records.length, 2);
    assert.match(saved.prompt, /读这2篇研报/);
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

test('terminal batch failure skips the report without another retry', () => {
  const { root, paths } = tempPaths(1);
  try {
    const config = { max_batch_size: 1, max_attempts: 5, model_version: 'ima-app-hy3-fast' };
    commandNext(paths, {}, config);
    const failed = commandFailBatch(paths, {
      code: 'ANSWER_TIMEOUT',
      terminal: true,
      surface: 'app',
    }, config);
    assert.equal(failed.outcomes[0].attempts, 5);
    assert.equal(commandNext(paths, {}, config).done, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalidate-reviewed removes polluted progress and makes reports pending again', () => {
  const { root, paths } = tempPaths(3);
  try {
    writeJsonl(paths.progress, [
      { ...indexRecord(1), status: 'reviewed' },
      { ...indexRecord(2), status: 'reviewed' },
    ]);
    writeJsonl(paths.failures, [
      { ...indexRecord(2), status: 'UNREVIEWED', attempts: 2, failure_code: 'INVALID_JSON' },
    ]);
    const result = commandInvalidateReviewed(paths, {
      'media-ids': 'pdf-2',
      reason: 'polluted summary',
    });
    assert.equal(result.removed_progress, 1);
    assert.equal(result.removed_failures, 1);
    assert.deepEqual(readLines(paths.progress).map((record) => record.media_id), ['pdf-1']);
    assert.deepEqual(commandNext(paths, {}, {
      max_batch_size: 5,
      max_attempts: 4,
      model_version: 'ima-app-hy3-fast',
    }).records.map((record) => record.media_id), ['pdf-2', 'pdf-3']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status ignores stale failures that are not in the current index', () => {
  const { root, paths } = tempPaths(1);
  try {
    writeJsonl(paths.failures, [
      { media_id: 'pdf-1', attempts: 5, failure_code: 'ANSWER_TIMEOUT' },
      { media_id: 'stale-pdf', attempts: 0, failure_code: 'LOGIN_REQUIRED' },
    ]);
    const status = statusReport(paths, { max_attempts: 5 });
    assert.equal(status.retryable_failures, 0);
    assert.equal(status.terminal_failures, 1);
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
