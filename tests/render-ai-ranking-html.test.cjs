const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeMonth,
  collectMonthlyRecords,
  renderHtml,
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
