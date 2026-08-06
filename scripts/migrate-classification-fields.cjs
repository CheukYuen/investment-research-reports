#!/usr/bin/env node

// One-off migration: zero out the classification fields (report_type, report_type_reason,
// sectors) across all historical dated manifests, so the DeepSeek rank-ai stage can rebuild
// them from scratch as the sole classification authority. See docs/data-catalog.md and
// AGENTS.md for the classification contract this migration prepares the data for.
//
// Scope is intentionally narrow:
//   - manifests/report-summaries-YYYYMMDD.jsonl   (summary stage: also adds topics: [])
//   - manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl (queue stage: topics left untouched)
// report-summary-browser-progress-*.jsonl is NOT migrated: report-summaries.cjs now forces
// report_type/sectors to null unconditionally, so `ima-daily-summary.cjs finalize` already
// rebuilds progress records with the new contract on every snapshot; migrating progress too
// would be a no-op that risks drifting from the real IMA-recoverable record.

const fs = require('fs');
const path = require('path');
const { readJsonl, writeJsonlAtomic } = require('./report-summaries.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

function usage() {
  console.log(`Usage:
  node scripts/migrate-classification-fields.cjs [--dry-run]

Zeroes report_type / report_type_reason / sectors across all dated
manifests/report-summaries-YYYYMMDD.jsonl and manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl
files. Idempotent; --dry-run prints the plan without writing.`);
}

function findDatedFiles(manifestsDir, prefix) {
  const pattern = new RegExp(`^${prefix}(\\d{8})\\.jsonl$`);
  return fs.readdirSync(manifestsDir)
    .map((name) => {
      const match = name.match(pattern);
      return match ? { name, date: match[1], path: path.join(manifestsDir, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function migrateSummaryRecord(record) {
  return {
    ...record,
    report_type: null,
    report_type_reason: null,
    sectors: [],
    topics: [],
  };
}

function migrateQueueRecord(record) {
  return {
    ...record,
    report_type: null,
    report_type_reason: null,
    sectors: [],
    classification_source: null,
    classification_warnings: [],
  };
}

function isAlreadyMigrated(record, kind) {
  const base = record.report_type === null &&
    record.report_type_reason === null &&
    Array.isArray(record.sectors) && record.sectors.length === 0;
  if (kind === 'summary') {
    return base && Array.isArray(record.topics) && record.topics.length === 0;
  }
  return base &&
    record.classification_source === null &&
    Array.isArray(record.classification_warnings) && record.classification_warnings.length === 0;
}

function migrateFileSet(files, kind, transform, dryRun) {
  const results = [];
  for (const file of files) {
    const before = readJsonl(file.path);
    const changed = before.filter((record) => !isAlreadyMigrated(record, kind)).length;
    const after = before.map(transform);
    if (!dryRun) writeJsonlAtomic(file.path, after);
    results.push({ file: file.name, records: after.length, changed });
  }
  return results;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return;
  }

  const summaryFiles = findDatedFiles(MANIFESTS_DIR, 'report-summaries-');
  const queueFiles = findDatedFiles(MANIFESTS_DIR, 'ai-ranked-queue-summary-');

  const summaryResults = migrateFileSet(summaryFiles, 'summary', migrateSummaryRecord, opts.dryRun);
  const queueResults = migrateFileSet(queueFiles, 'queue', migrateQueueRecord, opts.dryRun);

  const totalRecords = (results) => results.reduce((sum, item) => sum + item.records, 0);
  const totalChanged = (results) => results.reduce((sum, item) => sum + item.changed, 0);

  console.log(JSON.stringify({
    dry_run: Boolean(opts.dryRun),
    summaries: {
      files: summaryResults.length,
      records: totalRecords(summaryResults),
      changed: totalChanged(summaryResults),
    },
    queue: {
      files: queueResults.length,
      records: totalRecords(queueResults),
      changed: totalChanged(queueResults),
    },
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

module.exports = {
  findDatedFiles,
  migrateSummaryRecord,
  migrateQueueRecord,
  isAlreadyMigrated,
  migrateFileSet,
  main,
};
