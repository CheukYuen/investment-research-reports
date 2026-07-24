#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT_TYPES = new Set(['company', 'industry', 'strategy', 'macro', 'commodity', 'other']);
const CONTENT_TAGS = new Set([
  'financials',
  'guidance',
  'rating_valuation',
  'segment_product',
  'supply_demand',
  'consensus_comparison',
  'catalysts_risks',
  'macro_policy',
  'industry_structure',
]);
const BASIS = new Set(['actual', 'forecast', 'guidance', 'valuation']);
const LIMITS = { key_findings: 4, content_tags: 6, data_points: 6, entities: 10, evidence: 4 };
const BATCH_LIMITS = { key_findings: 3, content_tags: 6, data_points: 4, entities: 8, evidence: 3 };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next == null || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      index += 1;
    }
  }
  return opts;
}

function resolvePath(value, fallback) {
  const selected = value || fallback;
  if (!selected) throw new Error('Missing required path');
  return path.isAbsolute(selected) ? selected : path.join(ROOT, selected);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} invalid JSONL: ${error.message}`);
    }
  });
}

function writeJsonlAtomic(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.part`;
  fs.writeFileSync(tempPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean);
}

function stripCitationArtifacts(value) {
  return String(value || '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\u200B/g, '')
    .trim();
}

function parseStrictJson(rawAnswer) {
  let text = stripCitationArtifacts(rawAnswer);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  const sanitize = (value) => {
    if (typeof value === 'string') return stripCitationArtifacts(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, sanitize(item)]),
      );
    }
    return value;
  };
  const parsed = sanitize(JSON.parse(text));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Answer must be one JSON object');
  }
  return parsed;
}

function applyBatchLimits(report) {
  const warnings = [];
  const limited = { ...report };
  for (const [field, limit] of Object.entries(BATCH_LIMITS)) {
    const values = Array.isArray(report?.[field]) ? report[field] : [];
    if (values.length > limit) warnings.push(`batch_${field}_truncated:${values.length}->${limit}`);
    limited[field] = values.slice(0, limit);
  }
  return { report: limited, warnings };
}

function mapBatchReports(parsed, expectedTitles) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.reports)) {
    throw new Error('Batch answer must contain reports[]');
  }
  if (
    !Array.isArray(expectedTitles) ||
    expectedTitles.length < 1 ||
    new Set(expectedTitles).size !== expectedTitles.length
  ) {
    throw new Error('Batch requires distinct expected titles');
  }
  const byTitle = new Map();
  for (const report of parsed.reports) {
    const title = typeof report?.source_title === 'string' ? report.source_title.trim() : '';
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(report);
  }
  return expectedTitles.map((title) => {
    const matches = byTitle.get(title) || [];
    if (matches.length === 0) return { title, failure_code: 'BATCH_REPORT_MISSING' };
    if (matches.length > 1) return { title, failure_code: 'BATCH_REPORT_DUPLICATE' };
    const limited = applyBatchLimits(matches[0]);
    return {
      title,
      report: limited.report,
      warnings: [
        ...(parsed.reports.length === expectedTitles.length
          ? []
          : [`batch_report_count:${parsed.reports.length}->${expectedTitles.length}`]),
        ...limited.warnings,
      ],
    };
  });
}

function truncate(items, name, warnings) {
  const limit = LIMITS[name];
  if (items.length > limit) warnings.push(`${name}_truncated:${items.length}->${limit}`);
  return items.slice(0, limit);
}

function duplicateValues(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = record[key];
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function latestByMediaId(records) {
  const map = new Map();
  for (const record of records) if (record.media_id) map.set(record.media_id, record);
  return map;
}

function identity(indexRecord) {
  return {
    indexed_at: indexRecord.indexed_at || null,
    knowledge_base: indexRecord.knowledge_base || null,
    source_path: indexRecord.source_path || null,
    title: indexRecord.title || '',
    media_type: indexRecord.media_type ?? null,
    media_id: indexRecord.media_id || '',
    parent_folder_id: indexRecord.parent_folder_id || null,
    local_relative_path: indexRecord.local_relative_path || null,
    saved_path: indexRecord.saved_path || null,
  };
}

function validateAndNormalizeSuccess(record, indexRecord) {
  const warnings = [];
  const errors = [];
  const sourceTitles = normalizeStringArray(record.source_titles);
  const sourceCount = record.source_count == null || record.source_count === ''
    ? null
    : Number(record.source_count);
  const answerSourceTitle = normalizeText(record.source_title);
  const hasSourceCount = Number.isFinite(sourceCount) && sourceCount >= 1;
  const sourceMetadataMatch = hasSourceCount && sourceTitles.includes(indexRecord.title);
  const exactAnswerTitleMatch = answerSourceTitle === indexRecord.title;
  const sourceMetadataMissing = !hasSourceCount || sourceTitles.length === 0;
  const sourceMatch = sourceMetadataMatch || (sourceMetadataMissing && exactAnswerTitleMatch);
  const sourceExclusive = sourceCount === 1 && sourceTitles.length === 1 && sourceMetadataMatch;
  if (sourceMetadataMissing && exactAnswerTitleMatch) {
    warnings.push('source_metadata_missing_exact_source_title_used');
  } else if (!hasSourceCount) {
    errors.push('NO_SOURCE_METADATA');
  }
  if (!sourceMatch) warnings.push('target_not_in_source_list');
  if (sourceMetadataMatch && !sourceExclusive) warnings.push(`non_exclusive_sources:${sourceCount}`);

  const rawReportType = normalizeText(record.report_type);
  const reportType = REPORT_TYPES.has(rawReportType) ? rawReportType : 'other';
  if (!REPORT_TYPES.has(rawReportType)) {
    warnings.push(`report_type_normalized_to_other:${rawReportType || 'empty'}`);
  }

  const researchSubject = normalizeText(record.research_subject);
  const executiveSummary = normalizeText(record.executive_summary);
  if (!researchSubject) warnings.push('empty_research_subject');
  if (!executiveSummary) errors.push('EMPTY_EXECUTIVE_SUMMARY');
  if (executiveSummary && (executiveSummary.length < 120 || executiveSummary.length > 200)) {
    warnings.push(`executive_summary_length:${executiveSummary.length}`);
  }

  const contentTagsRaw = normalizeStringArray(record.content_tags);
  const unknownContentTags = contentTagsRaw.filter((tag) => !CONTENT_TAGS.has(tag));
  if (unknownContentTags.length) {
    warnings.push(`unknown_content_tags_preserved:${unknownContentTags.join('|')}`);
  }
  const keyFindings = truncate(normalizeStringArray(record.key_findings), 'key_findings', warnings);
  const contentTags = truncate(contentTagsRaw, 'content_tags', warnings);
  const entities = truncate(normalizeStringArray(record.entities), 'entities', warnings);

  const dataPointsRaw = Array.isArray(record.data_points) ? record.data_points : [];
  const dataPoints = truncate(dataPointsRaw.map((item) => ({
    metric: normalizeText(item && item.metric),
    value_text: normalizeText(item && item.value_text),
    period: normalizeText(item && item.period),
    basis: normalizeText(item && item.basis),
    context: normalizeText(item && item.context),
  })).filter((item) => item.metric || item.value_text || item.context), 'data_points', warnings);
  if (dataPoints.some((item) => !BASIS.has(item.basis))) warnings.push('invalid_basis_preserved');

  const evidenceRaw = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence = truncate(evidenceRaw.map((item) => ({
    claim: normalizeText(item && item.claim),
    quote: normalizeText(item && item.quote),
  })).filter((item) => item.claim || item.quote), 'evidence', warnings);
  if (!evidence.some((item) => item.quote)) warnings.push('no_evidence');

  const status = errors.length === 0 && record.status === 'reviewed' ? 'reviewed' : 'UNREVIEWED';
  return {
    ...identity(indexRecord),
    status,
    failure_code: status === 'reviewed' ? null : errors[0] || normalizeText(record.failure_code) || 'INCOMPLETE',
    validation_errors: errors,
    validation_warnings: warnings,
    attempts: Number.isFinite(Number(record.attempts)) ? Number(record.attempts) : 1,
    source_count: Number.isFinite(sourceCount) ? sourceCount : null,
    source_title: answerSourceTitle || null,
    source_titles: sourceTitles,
    source_match: sourceMatch,
    source_exclusive: sourceExclusive,
    summary_role: 'routing_candidate',
    report_type: reportType,
    research_subject: researchSubject,
    executive_summary: executiveSummary,
    key_findings: keyFindings,
    content_tags: contentTags,
    data_points: dataPoints,
    entities,
    evidence,
    prompt_version: normalizeText(record.prompt_version || 'ima-download-screen-summary-batch-v2'),
    model_version: normalizeText(record.model_version || 'ima-web-hy3-fast'),
    generated_at: normalizeText(record.generated_at || new Date().toISOString()),
    elapsed_ms: Number.isFinite(Number(record.elapsed_ms)) ? Number(record.elapsed_ms) : null,
    raw_answer: normalizeText(record.raw_answer),
  };
}

function normalizeFailure(record, indexRecord) {
  const sourceTitles = normalizeStringArray(record && record.source_titles);
  const sourceCount = Number(record && record.source_count);
  const sourceMatch = sourceCount >= 1 && sourceTitles.includes(indexRecord.title);
  return {
    ...identity(indexRecord),
    status: 'UNREVIEWED',
    failure_code: normalizeText(record && (record.failure_code || record.error)) || 'MISSING',
    validation_errors: normalizeStringArray(record && record.validation_errors),
    validation_warnings: normalizeStringArray(record && record.validation_warnings),
    attempts: Number.isFinite(Number(record && record.attempts)) ? Number(record.attempts) : 0,
    source_count: Number.isFinite(sourceCount) ? sourceCount : null,
    source_title: normalizeText(record && record.source_title) || null,
    source_titles: sourceTitles,
    source_match: sourceMatch,
    source_exclusive: sourceCount === 1 && sourceTitles.length === 1,
    summary_role: 'routing_candidate',
    report_type: '',
    research_subject: '',
    executive_summary: '',
    key_findings: [],
    content_tags: [],
    data_points: [],
    entities: [],
    evidence: [],
    prompt_version: normalizeText(record && record.prompt_version) || 'ima-download-screen-summary-batch-v2',
    model_version: normalizeText(record && record.model_version) || 'ima-web-hy3-fast',
    generated_at: normalizeText(record && (record.generated_at || record.failed_at)),
    elapsed_ms: Number.isFinite(Number(record && record.elapsed_ms)) ? Number(record.elapsed_ms) : null,
    raw_answer: normalizeText(record && record.raw_answer),
  };
}

function buildSnapshot(index, progress, failures) {
  const progressMap = latestByMediaId(progress);
  const failureMap = latestByMediaId(failures);
  return index.map((indexRecord) => {
    const success = progressMap.get(indexRecord.media_id);
    if (success) return validateAndNormalizeSuccess(success, indexRecord);
    return normalizeFailure(failureMap.get(indexRecord.media_id), indexRecord);
  });
}

function buildPending(index, progress, failures, maxAttempts = 4) {
  const successful = new Set(progress.filter((record) => record.status === 'reviewed').map((record) => record.media_id));
  const failed = new Set(failures.filter((record) => Number(record.attempts || 0) < maxAttempts).map((record) => record.media_id));
  const terminalFailed = new Set(failures.filter((record) => Number(record.attempts || 0) >= maxAttempts).map((record) => record.media_id));
  return [
    ...index.filter((record) => failed.has(record.media_id) && !successful.has(record.media_id)),
    ...index.filter((record) => !failed.has(record.media_id) && !terminalFailed.has(record.media_id) && !successful.has(record.media_id)),
  ];
}

function audit(index, snapshot, progress, failures) {
  const indexIds = new Set(index.map((record) => record.media_id));
  const reviewed = snapshot.filter((record) => record.status === 'reviewed');
  const unreviewed = snapshot.filter((record) => record.status !== 'reviewed');
  return {
    indexed: index.length,
    snapshot_records: snapshot.length,
    reviewed: reviewed.length,
    unreviewed: unreviewed.length,
    success_rate: index.length ? reviewed.length / index.length : 0,
    structured_parse_rate: index.length ? reviewed.filter((record) =>
      record.report_type && record.executive_summary && record.source_match
    ).length / index.length : 0,
    duplicate_index_media_ids: duplicateValues(index, 'media_id'),
    duplicate_index_titles: duplicateValues(index, 'title'),
    duplicate_progress_media_ids: duplicateValues(progress, 'media_id'),
    duplicate_failure_media_ids: duplicateValues(failures, 'media_id'),
    unknown_progress_media_ids: progress.map((record) => record.media_id).filter((id) => id && !indexIds.has(id)),
    missing_media_ids: snapshot.filter((record) => record.failure_code === 'MISSING').map((record) => record.media_id),
    source_mismatches: snapshot.filter((record) => record.failure_code === 'SOURCE_MISMATCH').map((record) => record.media_id),
    complete_accounting: snapshot.length === index.length &&
      duplicateValues(snapshot, 'media_id').length === 0 &&
      snapshot.every((record) => record.status === 'reviewed' || record.failure_code !== 'MISSING'),
  };
}

function loadInputs(opts) {
  const indexPath = resolvePath(opts.index);
  const progressPath = resolvePath(opts.progress);
  const failurePath = resolvePath(opts.failures);
  return {
    indexPath,
    progressPath,
    failurePath,
    index: readJsonl(indexPath),
    progress: readJsonl(progressPath),
    failures: readJsonl(failurePath),
  };
}

function findIndexRecord(index, mediaId) {
  const match = index.find((record) => record.media_id === mediaId);
  if (!match) throw new Error(`Unknown media_id: ${mediaId}`);
  return match;
}

function upsert(records, record) {
  return [...records.filter((item) => item.media_id !== record.media_id), record];
}

function usage() {
  console.log(`Usage:
  node scripts/report-summaries.cjs pending --index <index.jsonl> --progress <progress.jsonl> --failures <failures.jsonl> [--output <pending.jsonl>]
  node scripts/report-summaries.cjs record --index <index.jsonl> --progress <progress.jsonl> --failures <failures.jsonl> --input <record.json>
  node scripts/report-summaries.cjs fail --index <index.jsonl> --progress <progress.jsonl> --failures <failures.jsonl> --input <failure.json>
  node scripts/report-summaries.cjs finalize --index <index.jsonl> --progress <progress.jsonl> --failures <failures.jsonl> --output <snapshot.jsonl>
  node scripts/report-summaries.cjs audit --index <index.jsonl> --progress <progress.jsonl> --failures <failures.jsonl> [--snapshot <snapshot.jsonl>]`);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!['pending', 'record', 'fail', 'finalize', 'audit'].includes(opts.command)) {
    usage();
    if (opts.command) process.exitCode = 1;
    return;
  }
  const inputs = loadInputs(opts);
  const { index, progress, failures } = inputs;

  if (opts.command === 'pending') {
    const pending = buildPending(index, progress, failures);
    if (opts.output) writeJsonlAtomic(resolvePath(opts.output), pending);
    console.log(JSON.stringify({ indexed: index.length, reviewed: progress.length, pending: pending.length, records: opts.output ? undefined : pending }));
    return;
  }

  if (opts.command === 'record') {
    const raw = readJsonFile(resolvePath(opts.input));
    const indexRecord = findIndexRecord(index, raw.media_id);
    const normalized = validateAndNormalizeSuccess(raw, indexRecord);
    if (normalized.status !== 'reviewed') throw new Error(`Record rejected: ${normalized.validation_errors.join(',') || normalized.failure_code}`);
    writeJsonlAtomic(inputs.progressPath, upsert(progress, normalized));
    writeJsonlAtomic(inputs.failurePath, failures.filter((record) => record.media_id !== normalized.media_id));
    console.log(JSON.stringify({ status: 'reviewed', media_id: normalized.media_id, warnings: normalized.validation_warnings }));
    return;
  }

  if (opts.command === 'fail') {
    const raw = readJsonFile(resolvePath(opts.input));
    const indexRecord = findIndexRecord(index, raw.media_id);
    const normalized = normalizeFailure(raw, indexRecord);
    if (!progress.some((record) => record.media_id === normalized.media_id && record.status === 'reviewed')) {
      writeJsonlAtomic(inputs.failurePath, upsert(failures, normalized));
    }
    console.log(JSON.stringify({ status: 'UNREVIEWED', media_id: normalized.media_id, failure_code: normalized.failure_code }));
    return;
  }

  const snapshot = opts.snapshot ? readJsonl(resolvePath(opts.snapshot)) : buildSnapshot(index, progress, failures);
  if (opts.command === 'finalize') writeJsonlAtomic(resolvePath(opts.output), snapshot);
  console.log(JSON.stringify({
    command: opts.command,
    ...(opts.command === 'finalize' ? { output: path.relative(ROOT, resolvePath(opts.output)) } : {}),
    ...audit(index, snapshot, progress, failures),
  }));
}

if (require.main === module) main();

module.exports = {
  REPORT_TYPES,
  CONTENT_TAGS,
  BASIS,
  LIMITS,
  BATCH_LIMITS,
  readJsonl,
  writeJsonlAtomic,
  stripCitationArtifacts,
  parseStrictJson,
  mapBatchReports,
  validateAndNormalizeSuccess,
  normalizeFailure,
  buildSnapshot,
  buildPending,
  audit,
  main,
};
