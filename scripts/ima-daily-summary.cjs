#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'ima-daily-summary.json');
const {
  readJsonl,
  writeJsonlAtomic,
  validateAndNormalizeSuccess,
  normalizeFailure,
  buildSnapshot,
  buildPending,
  audit,
  parseStrictJson,
  mapBatchReports,
  parseSectionAnswer,
} = require('./report-summaries.cjs');

const DEFAULT_KB = '环球研报直通车';
const DEFAULT_BROWSER_URL = 'https://ima.qq.com/wikis?knowledgeBaseId=7442602265681522';
const PROMPT_PATH = path.join(ROOT, 'prompts', 'ima-download-screen-summary-batch-v6.txt');
const PROMPT_VERSION = 'ima-download-screen-summary-batch-v6';
const BROWSER_MODEL_VERSION = 'ima-web-deepseek-v4-flash';
const APP_MODEL_VERSION = 'ima-app-deepseek-v4-flash';
const INTERACTION_SURFACES = new Set(['browser', 'app']);
const MAX_BATCH_SIZE = 10;
const MAX_ATTEMPTS = 4;
const GLOBAL_STOP_CODES = new Set(['GLOBAL_LIMIT', 'LOGIN_REQUIRED']);

function loadConfig() {
  const defaults = {
    knowledge_base: DEFAULT_KB,
    browser_url: DEFAULT_BROWSER_URL,
    interaction_order: ['browser', 'app'],
    browser_model_version: BROWSER_MODEL_VERSION,
    app_model_version: APP_MODEL_VERSION,
    max_batch_size: MAX_BATCH_SIZE,
    max_attempts: MAX_ATTEMPTS,
    daily_budget: 30,
    download_priorities: ['P0', 'P1', 'P2'],
    quota_probe_extra: 1,
    auto_download: true,
    auto_git_commit: false,
  };
  if (!fs.existsSync(CONFIG_PATH)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
}

function usage() {
  console.log(`Usage:
  node scripts/ima-daily-summary.cjs prepare [--date YYYYMMDD] [--skip-index]
  node scripts/ima-daily-summary.cjs next [--date YYYYMMDD] [--batch-size 5] [--surface browser|app] [--compact]
  node scripts/ima-daily-summary.cjs ingest [--date YYYYMMDD] [--elapsed-ms N] [--surface browser|app] [--input-file PATH]
  node scripts/ima-daily-summary.cjs fail-batch [--date YYYYMMDD] --code <CODE> [--message <text>] [--surface browser|app] [--terminal]
  node scripts/ima-daily-summary.cjs invalidate-reviewed [--date YYYYMMDD] --media-ids <id,id,...> [--reason <text>]
  node scripts/ima-daily-summary.cjs finalize [--date YYYYMMDD] [--skip-rank]
  node scripts/ima-daily-summary.cjs status [--date YYYYMMDD]

The default date is today in Asia/Shanghai. ingest reads --input-file when provided, otherwise stdin.`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
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

function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function normalizeDate(input) {
  const compact = String(input || todayShanghai()).replaceAll('-', '');
  if (!/^\d{8}$/.test(compact)) throw new Error(`Invalid date: ${input}`);
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${input}`);
  }
  return {
    compact,
    iso: `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`,
    year,
    month,
    day,
    monthFolder: `${month}月`,
    dayFolder: `${month}.${day}`,
    sourcePath: `${year}年国际顶级投行研报/${month}月/${month}.${day}`,
    localPrefix: String(year),
  };
}

function pathsForDate(input) {
  const date = normalizeDate(input);
  const inManifests = (name) => path.join(ROOT, 'manifests', `${name}-${date.compact}`);
  const monthCompact = date.compact.slice(0, 6);
  return {
    date,
    index: `${inManifests('index')}.jsonl`,
    progress: `${inManifests('report-summary-browser-progress')}.jsonl`,
    failures: `${inManifests('report-summary-browser-failures')}.jsonl`,
    summaries: `${inManifests('report-summaries')}.jsonl`,
    batches: `${inManifests('report-summary-batches')}.jsonl`,
    summaryQueue: `${inManifests('ai-ranked-queue-summary')}.jsonl`,
    summaryHtml: path.join(ROOT, 'manifests', `ai-ranking-analysis-${monthCompact}.html`),
  };
}

function relative(filePath) {
  return path.relative(ROOT, filePath);
}

function ensureEmptyJsonl(filePath) {
  if (!fs.existsSync(filePath)) writeJsonlAtomic(filePath, []);
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  const stdout = String(result.stdout || '').trim();
  return stdout ? JSON.parse(stdout) : {};
}

function readInputs(paths) {
  if (!fs.existsSync(paths.index)) {
    throw new Error(`Missing dated index: ${relative(paths.index)}. Run prepare first.`);
  }
  const index = readJsonl(paths.index);
  if (index.length === 0) throw new Error(`Dated index is empty: ${relative(paths.index)}`);
  const duplicateIds = index
    .map((record) => record.media_id)
    .filter((id, position, values) => id && values.indexOf(id) !== position);
  if (duplicateIds.length) throw new Error(`Dated index contains duplicate media_id: ${duplicateIds[0]}`);
  ensureEmptyJsonl(paths.progress);
  ensureEmptyJsonl(paths.failures);
  ensureEmptyJsonl(paths.batches);
  return {
    index,
    progress: readJsonl(paths.progress),
    failures: readJsonl(paths.failures),
    batches: readJsonl(paths.batches),
  };
}

function renderPrompt(records) {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8');
  const fileList = records.map((record, index) => `${index + 1}.《${record.title}》`).join('\n');
  return template
    .replaceAll('{{REPORT_COUNT}}', String(records.length))
    .replaceAll('{{FILE_LIST}}', fileList);
}

function latestOpenBatch(batches) {
  const states = new Map();
  for (const record of batches) states.set(record.batch_id, record);
  return [...states.values()].reverse().find((record) => record.status === 'planned') || null;
}

function safeBatchSize(value, configuredMaximum = MAX_BATCH_SIZE) {
  const maximum = Math.min(MAX_BATCH_SIZE, Number(configuredMaximum || MAX_BATCH_SIZE));
  const parsed = Number(value || maximum);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`--batch-size must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function interactionSurface(value, config = loadConfig()) {
  const configured = Array.isArray(config.interaction_order) && config.interaction_order.length > 0
    ? config.interaction_order[0]
    : 'browser';
  const surface = String(value || configured).trim().toLowerCase();
  if (!INTERACTION_SURFACES.has(surface)) {
    throw new Error('--surface must be browser or app');
  }
  return surface;
}

function surfaceModelVersion(surface, config = loadConfig()) {
  if (!Array.isArray(config.interaction_order) && config.model_version) {
    return String(config.model_version);
  }
  if (surface === 'browser') {
    return String(config.browser_model_version || BROWSER_MODEL_VERSION);
  }
  return String(config.app_model_version || APP_MODEL_VERSION);
}

function batchPayload(batch, resumed = false, config = loadConfig()) {
  return {
    done: false,
    resumed,
    batch_id: batch.batch_id,
    batch_size: batch.records.length,
    prompt_version: batch.prompt_version,
    model_version: batch.model_version,
    interaction_surface: batch.interaction_surface,
    browser_url: String(config.browser_url || DEFAULT_BROWSER_URL),
    folder_path: batch.folder_path,
    records: batch.records,
    prompt: batch.prompt,
  };
}

function compactNextPayload(payload) {
  if (payload.done) {
    return {
      done: true,
      indexed: payload.indexed,
      reviewed: payload.reviewed,
      terminal_failures: payload.terminal_failures,
    };
  }
  return {
    done: false,
    batch_id: payload.batch_id,
    batch_size: payload.batch_size,
    browser_url: payload.browser_url,
    folder_path: payload.folder_path,
  };
}

function nextPayload(payload, opts) {
  return opts.compact ? compactNextPayload(payload) : payload;
}

function commandPrepare(paths, opts, config = loadConfig()) {
  if (!opts['skip-index']) {
    runNode([
      'scripts/sync-kb-pdfs.cjs',
      'index',
      '--kb', opts.kb || config.knowledge_base,
      '--source-path', paths.date.sourcePath,
      '--strip-source-prefix', `${paths.date.year}年国际顶级投行研报`,
      '--local-prefix', paths.date.localPrefix,
      '--snapshot', relative(paths.index),
    ]);
  }
  const inputs = readInputs(paths);
  return {
    command: 'prepare',
    date: paths.date.iso,
    folder_path: paths.date.sourcePath,
    indexed: inputs.index.length,
    reviewed: inputs.progress.filter((record) => record.status === 'reviewed').length,
    failures: inputs.failures.length,
    files: Object.fromEntries(
      Object.entries(paths)
        .filter(([key, value]) => key !== 'date' && typeof value === 'string')
        .map(([key, value]) => [key, relative(value)]),
    ),
  };
}

function commandNext(paths, opts, config = loadConfig()) {
  const inputs = readInputs(paths);
  const reviewedIds = new Set(
    inputs.progress.filter((record) => record.status === 'reviewed').map((record) => record.media_id),
  );
  const open = latestOpenBatch(inputs.batches);
  if (open) {
    const remaining = open.records.filter((record) => !reviewedIds.has(record.media_id));
    if (remaining.length > 0) {
      const requestedSurface = interactionSurface(opts.surface || open.interaction_surface, config);
      const resumedBatch = {
        ...open,
        prompt_version: PROMPT_VERSION,
        interaction_surface: requestedSurface,
        model_version: surfaceModelVersion(requestedSurface, config),
        records: remaining,
        prompt: renderPrompt(remaining),
      };
      if (
        resumedBatch.interaction_surface !== open.interaction_surface ||
        resumedBatch.model_version !== open.model_version
      ) {
        appendJsonl(paths.batches, {
          ...resumedBatch,
          status: 'planned',
          surface_switched_at: new Date().toISOString(),
          previous_interaction_surface: open.interaction_surface || null,
        });
      }
      return nextPayload(batchPayload(resumedBatch, true, config), opts);
    }
    appendJsonl(paths.batches, {
      ...open,
      status: 'superseded',
      closed_at: new Date().toISOString(),
      reason: 'all_records_already_reviewed',
    });
  }

  const pending = buildPending(
    inputs.index,
    inputs.progress,
    inputs.failures,
    Number(config.max_attempts || MAX_ATTEMPTS),
  );
  if (pending.length === 0) {
    return nextPayload({
      done: true,
      indexed: inputs.index.length,
      reviewed: reviewedIds.size,
      terminal_failures: inputs.failures.filter((record) =>
        Number(record.attempts || 0) >= Number(config.max_attempts || MAX_ATTEMPTS)
      ).length,
    }, opts);
  }
  const size = Math.min(
    safeBatchSize(opts['batch-size'], config.max_batch_size),
    pending.length,
  );
  const selected = pending.slice(0, size);
  const now = new Date().toISOString();
  const selectedSurface = interactionSurface(opts.surface, config);
  const batchId = `${paths.date.compact}-${Date.now()}-${crypto
    .createHash('sha1')
    .update(selected.map((record) => record.media_id).join('\n'))
    .digest('hex')
    .slice(0, 8)}`;
  const batch = {
    batch_id: batchId,
    status: 'planned',
    planned_at: now,
    date: paths.date.iso,
    folder_path: paths.date.sourcePath,
    prompt_version: PROMPT_VERSION,
    model_version: surfaceModelVersion(selectedSurface, config),
    interaction_surface: selectedSurface,
    records: selected.map((record) => ({
      media_id: record.media_id,
      title: record.title,
      source_path: record.source_path,
      local_relative_path: record.local_relative_path,
    })),
    prompt: renderPrompt(selected),
  };
  appendJsonl(paths.batches, batch);
  return nextPayload(batchPayload(batch, false, config), opts);
}

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function readIngestAnswer(opts, suppliedAnswer) {
  if (opts['input-file']) {
    if (suppliedAnswer != null) {
      throw new Error('Use either --input-file or a supplied answer, not both');
    }
    const inputPath = path.resolve(String(opts['input-file']));
    if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
    return fs.readFileSync(inputPath, 'utf8').trim();
  }
  return suppliedAnswer == null ? readStdin() : String(suppliedAnswer).trim();
}

function normalizeBatchTitle(value) {
  return String(value || '')
    .replace(/[《》"'“”‘’\s]/g, '')
    .replace(/\.pdf$/i, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[，,]/g, ',')
    .toLowerCase();
}

function isFilenameHeading(line) {
  return String(line || '')
    .replace(/^\s*[#>*\-•·]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[：:]\s*$/, '')
    .trim() === '文件名';
}

function isCoreSummaryHeading(line) {
  return String(line || '')
    .replace(/^\s*[#>*\-•·]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[：:]\s*$/, '')
    .trim() === '核心摘要';
}

function parseSectionBatchAnswer(rawAnswer, titles) {
  const lines = String(rawAnswer || '').split(/\r?\n/);
  const titleByNormalized = new Map(titles.map((title) => [normalizeBatchTitle(title), title]));
  const headingIndexes = lines
    .map((line, index) => (isFilenameHeading(line) ? index : -1))
    .filter((index) => index >= 0);

  const matched = new Map();
  if (headingIndexes.length === 0) {
    const titleIndexes = lines
      .map((line, index) => {
        const title = titleByNormalized.get(normalizeBatchTitle(line));
        if (!title) return null;
        const firstContentLine = lines.slice(index + 1).find((candidate) => candidate.trim())?.trim() || '';
        if (!isCoreSummaryHeading(firstContentLine) && !/^NO_CONTENT$/i.test(firstContentLine)) return null;
        return { index, title };
      })
      .filter(Boolean);
    if (!titleIndexes.length) throw new Error('Batch section answer has no exact titled blocks');
    for (let position = 0; position < titleIndexes.length; position += 1) {
      const { index, title } = titleIndexes[position];
      const nextTitleIndex = titleIndexes[position + 1]?.index ?? lines.length;
      const contentLines = lines.slice(index + 1, nextTitleIndex);
      const nonEmptyContent = contentLines.map((line) => line.trim()).filter(Boolean);
      const parsed = nonEmptyContent.length === 1 && /^NO_CONTENT$/i.test(nonEmptyContent[0])
        ? parseSectionAnswer('NO_CONTENT', title)
        : parseSectionAnswer(`文件名\n${title}\n${contentLines.join('\n').trim()}`, title);
      const entries = matched.get(title) || [];
      entries.push(parsed);
      matched.set(title, entries);
    }
  }

  for (let position = 0; position < headingIndexes.length; position += 1) {
    const headingIndex = headingIndexes[position];
    const nextHeadingIndex = headingIndexes[position + 1] ?? lines.length;
    const previousHeadingIndex = headingIndexes[position - 1] ?? -1;
    const beforeLines = lines.slice(previousHeadingIndex + 1, headingIndex)
      .map((line) => line.trim())
      .filter(Boolean);
    const afterLines = lines.slice(headingIndex + 1, nextHeadingIndex);
    const firstAfter = afterLines.find((line) => line.trim())?.trim() || '';
    const lastBefore = beforeLines.at(-1) || '';
    const afterTitle = titleByNormalized.get(normalizeBatchTitle(firstAfter));
    const beforeTitle = titleByNormalized.get(normalizeBatchTitle(lastBefore));
    const title = afterTitle || beforeTitle;
    if (!title) continue;

    let payloadLines = [...afterLines];
    if (beforeTitle && position + 1 < headingIndexes.length) {
      const trailingTitle = payloadLines.findLastIndex((line) => line.trim());
      if (trailingTitle >= 0 && titleByNormalized.has(normalizeBatchTitle(payloadLines[trailingTitle]))) {
        payloadLines = payloadLines.slice(0, trailingTitle);
      }
    }
    const contentLines = afterTitle
      ? payloadLines.slice(payloadLines.indexOf(firstAfter) + 1)
      : payloadLines;
    const nonEmptyContent = contentLines.map((line) => line.trim()).filter(Boolean);
    const parsed = nonEmptyContent.length === 1 && /^NO_CONTENT$/i.test(nonEmptyContent[0])
      ? parseSectionAnswer('NO_CONTENT', title)
      : parseSectionAnswer(`文件名\n${title}\n${contentLines.join('\n').trim()}`, title);
    const entries = matched.get(title) || [];
    entries.push(parsed);
    matched.set(title, entries);
  }

  return titles.map((title) => {
    const entries = matched.get(title) || [];
    if (entries.length === 1) return entries[0];
    if (entries.length > 1) {
      return {
        title,
        failure_code: 'BATCH_REPORT_DUPLICATE',
        error: 'duplicate 文件名 sections',
      };
    }
    return {
      title,
      failure_code: 'BATCH_REPORT_MISSING',
      error: 'no exact matching 文件名 section',
    };
  });
}

function parseBatchAnswer(rawAnswer, titles) {
  try {
    return mapBatchReports(parseStrictJson(rawAnswer), titles);
  } catch (error) {
    if (titles.length === 1) return [parseSectionAnswer(rawAnswer, titles[0])];
    return parseSectionBatchAnswer(rawAnswer, titles);
  }
}

function validateAnswerTransport(rawAnswer, expectedTitles) {
  const text = String(rawAnswer || '').trim();
  if (expectedTitles.length === 1 && /^NO_CONTENT$/i.test(text)) return null;
  const normalizedAnswer = normalizeBatchTitle(text);
  const matchedTitle = expectedTitles.some((title) =>
    normalizedAnswer.includes(normalizeBatchTitle(title))
  );
  const hasAnswerStructure = /核心摘要|executive_summary|NO_CONTENT/i.test(text);
  if (matchedTitle || hasAnswerStructure) return null;
  return {
    failure_code: 'INPUT_NOT_COPIED',
    message: '输入中未发现本批报告标题或任何摘要结构',
  };
}

function upsert(records, record) {
  return [...records.filter((item) => item.media_id !== record.media_id), record];
}

async function commandIngest(paths, opts, config = loadConfig(), suppliedAnswer = null) {
  const inputs = readInputs(paths);
  const open = latestOpenBatch(inputs.batches);
  if (!open) throw new Error('No planned batch. Run next before ingest.');
  const rawAnswer = readIngestAnswer(opts, suppliedAnswer);
  if (!rawAnswer) throw new Error('ingest requires the complete IMA answer on stdin');
  const expected = open.records.map((record) => record.title);
  const transportFailure = validateAnswerTransport(rawAnswer, expected);
  if (transportFailure) {
    return {
      command: 'ingest',
      accepted: false,
      batch_id: open.batch_id,
      ...transportFailure,
    };
  }
  let mapped;
  try {
    mapped = parseBatchAnswer(rawAnswer, expected);
  } catch (error) {
    mapped = open.records.map((record) => ({
      title: record.title,
      failure_code: 'INVALID_JSON',
      error: error && error.message ? error.message : String(error),
    }));
  }

  let progress = inputs.progress;
  let failures = inputs.failures;
  const indexById = new Map(inputs.index.map((record) => [record.media_id, record]));
  const previousFailures = new Map(failures.map((record) => [record.media_id, record]));
  const generatedAt = new Date().toISOString();
  const actualSurface = interactionSurface(opts.surface || open.interaction_surface, config);
  const actualModelVersion = surfaceModelVersion(actualSurface, config);
  const elapsedMs = Number.isFinite(Number(opts['elapsed-ms']))
    ? Number(opts['elapsed-ms'])
    : Math.max(0, Date.now() - Date.parse(open.planned_at));
  const outcomes = [];

  for (let position = 0; position < open.records.length; position += 1) {
    const planned = open.records[position];
    const indexRecord = indexById.get(planned.media_id);
    if (!indexRecord) throw new Error(`Batch contains unknown media_id: ${planned.media_id}`);
    const item = mapped[position];
    const attempts = Number(previousFailures.get(planned.media_id)?.attempts || 0) + 1;
    const shared = {
      media_id: planned.media_id,
      source_count: null,
      source_titles: [],
      attempts,
      prompt_version: PROMPT_VERSION,
      model_version: actualModelVersion,
      interaction_surface: actualSurface,
      generated_at: generatedAt,
      elapsed_ms: elapsedMs,
      raw_answer: rawAnswer,
    };

    if (item && item.report) {
      const normalized = validateAndNormalizeSuccess({
        ...item.report,
        ...shared,
        status: 'reviewed',
        source_title: item.report.source_title,
        summary_role: 'routing_candidate',
      }, indexRecord);
      normalized.validation_warnings = [...new Set([
        ...normalized.validation_warnings,
        ...(item.warnings || []),
      ])];
      if (normalized.status === 'reviewed') {
        progress = upsert(progress, normalized);
        writeJsonlAtomic(paths.progress, progress);
        failures = failures.filter((record) => record.media_id !== planned.media_id);
        writeJsonlAtomic(paths.failures, failures);
        outcomes.push({
          media_id: planned.media_id,
          title: planned.title,
          status: 'reviewed',
          warnings: normalized.validation_warnings,
        });
        continue;
      }
      item.failure_code = normalized.failure_code;
      item.validation_errors = normalized.validation_errors;
      item.warnings = normalized.validation_warnings;
    }

    const failure = normalizeFailure({
      ...shared,
      failure_code: item?.failure_code || 'BATCH_REPORT_MISSING',
      validation_errors: item?.validation_errors || [],
      validation_warnings: [
        ...(item?.warnings || []),
        ...(item?.error ? [`parse_error:${item.error}`] : []),
      ],
      raw_answer: rawAnswer,
    }, indexRecord);
    failures = upsert(failures, failure);
    writeJsonlAtomic(paths.failures, failures);
    outcomes.push({
      media_id: planned.media_id,
      title: planned.title,
      status: 'UNREVIEWED',
      failure_code: failure.failure_code,
      attempts: failure.attempts,
    });
  }

  appendJsonl(paths.batches, {
    ...open,
    status: 'completed',
    interaction_surface: actualSurface,
    model_version: actualModelVersion,
    completed_at: generatedAt,
    answer_sha256: crypto.createHash('sha256').update(rawAnswer).digest('hex'),
    elapsed_ms: elapsedMs,
    reviewed: outcomes.filter((item) => item.status === 'reviewed').length,
    failed: outcomes.filter((item) => item.status !== 'reviewed').length,
  });
  return {
    command: 'ingest',
    batch_id: open.batch_id,
    reviewed: outcomes.filter((item) => item.status === 'reviewed').length,
    failed: outcomes.filter((item) => item.status !== 'reviewed').length,
    outcomes,
  };
}

function commandFailBatch(paths, opts, config = loadConfig()) {
  const inputs = readInputs(paths);
  const open = latestOpenBatch(inputs.batches);
  if (!open) throw new Error('No planned batch. Run next before fail-batch.');
  const code = String(opts.code || '').trim();
  if (!code) throw new Error('--code is required');
  const indexById = new Map(inputs.index.map((record) => [record.media_id, record]));
  const previousFailures = new Map(inputs.failures.map((record) => [record.media_id, record]));
  const reviewedIds = new Set(
    inputs.progress.filter((record) => record.status === 'reviewed').map((record) => record.media_id),
  );
  let failures = inputs.failures;
  const outcomes = [];
  const actualSurface = interactionSurface(opts.surface || open.interaction_surface, config);
  const actualModelVersion = surfaceModelVersion(actualSurface, config);
  const increment = GLOBAL_STOP_CODES.has(code) ? 0 : 1;
  const maxAttempts = Number(config.max_attempts || MAX_ATTEMPTS);
  for (const planned of open.records) {
    if (reviewedIds.has(planned.media_id)) continue;
    const indexRecord = indexById.get(planned.media_id);
    const previousFailure = previousFailures.get(planned.media_id);
    const attempts = opts.terminal && increment > 0
      ? maxAttempts
      : Number(previousFailure?.attempts || 0) + increment;
    const failure = normalizeFailure({
      ...previousFailure,
      media_id: planned.media_id,
      failure_code: code,
      attempts,
      validation_warnings: [
        ...(previousFailure?.validation_warnings || []),
        ...(opts.message ? [String(opts.message)] : []),
      ],
      generated_at: new Date().toISOString(),
      prompt_version: PROMPT_VERSION,
      model_version: actualModelVersion,
      interaction_surface: actualSurface,
    }, indexRecord);
    failures = upsert(failures, failure);
    writeJsonlAtomic(paths.failures, failures);
    outcomes.push({ media_id: planned.media_id, status: 'UNREVIEWED', failure_code: code, attempts });
  }
  appendJsonl(paths.batches, {
    ...open,
    status: GLOBAL_STOP_CODES.has(code) ? 'stopped' : 'failed',
    interaction_surface: actualSurface,
    model_version: actualModelVersion,
    closed_at: new Date().toISOString(),
    failure_code: code,
    message: opts.message ? String(opts.message) : '',
  });
  return {
    command: 'fail-batch',
    batch_id: open.batch_id,
    failure_code: code,
    stop: GLOBAL_STOP_CODES.has(code),
    outcomes,
  };
}

function commandInvalidateReviewed(paths, opts) {
  const inputs = readInputs(paths);
  const mediaIds = String(opts['media-ids'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!mediaIds.length) throw new Error('--media-ids is required');
  const requested = new Set(mediaIds);
  const indexIds = new Set(inputs.index.map((record) => record.media_id));
  const unknown = mediaIds.filter((mediaId) => !indexIds.has(mediaId));
  if (unknown.length) throw new Error(`Unknown media_id: ${unknown.join(', ')}`);

  const removedProgress = inputs.progress.filter((record) => requested.has(record.media_id));
  const removedFailures = inputs.failures.filter((record) => requested.has(record.media_id));
  writeJsonlAtomic(paths.progress, inputs.progress.filter((record) => !requested.has(record.media_id)));
  writeJsonlAtomic(paths.failures, inputs.failures.filter((record) => !requested.has(record.media_id)));
  appendJsonl(paths.batches, {
    batch_id: `invalidate-${paths.date.compact}-${Date.now()}`,
    status: 'invalidated',
    date: paths.date.iso,
    invalidated_at: new Date().toISOString(),
    media_ids: mediaIds,
    reason: String(opts.reason || '').trim(),
  });
  return {
    command: 'invalidate-reviewed',
    date: paths.date.iso,
    invalidated: mediaIds.length,
    removed_progress: removedProgress.length,
    removed_failures: removedFailures.length,
  };
}

function statusReport(paths, config = loadConfig()) {
  const inputs = readInputs(paths);
  const snapshot = buildSnapshot(inputs.index, inputs.progress, inputs.failures);
  const report = audit(inputs.index, snapshot, inputs.progress, inputs.failures);
  const maxAttempts = Number(config.max_attempts || MAX_ATTEMPTS);
  const currentFailures = snapshot.filter((record) =>
    record.status !== 'reviewed' && record.failure_code !== 'MISSING'
  );
  return {
    date: paths.date.iso,
    folder_path: paths.date.sourcePath,
    ...report,
    retryable_failures: currentFailures.filter((record) =>
      Number(record.attempts || 0) < maxAttempts
    ).length,
    terminal_failures: currentFailures.filter((record) =>
      Number(record.attempts || 0) >= maxAttempts
    ).length,
    open_batch: latestOpenBatch(inputs.batches)?.batch_id || null,
  };
}

function commandFinalize(paths, opts) {
  const inputs = readInputs(paths);
  const snapshot = buildSnapshot(inputs.index, inputs.progress, inputs.failures);
  writeJsonlAtomic(paths.summaries, snapshot);
  const report = audit(inputs.index, snapshot, inputs.progress, inputs.failures);
  let ranking = null;
  let html = null;
  if (!opts['skip-rank']) {
    const args = [
      'scripts/sync-kb-pdfs.cjs',
      'rank-ai',
      '--summary-source', relative(paths.summaries),
      '--queue', relative(paths.summaryQueue),
      '--progress',
    ];
    ranking = runNode(args);
    html = runNode([
      'scripts/render-ai-ranking-html.cjs',
      '--month', paths.date.compact.slice(0, 6),
      '--out', relative(paths.summaryHtml),
    ]);
  }
  return {
    command: 'finalize',
    date: paths.date.iso,
    snapshot: relative(paths.summaries),
    ...report,
    ranking,
    html,
  };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || ![
    'prepare',
    'next',
    'ingest',
    'fail-batch',
    'invalidate-reviewed',
    'finalize',
    'status',
  ].includes(opts.command)) {
    usage();
    if (!opts.help && opts.command) process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const paths = pathsForDate(opts.date);
  let result;
  if (opts.command === 'prepare') result = commandPrepare(paths, opts, config);
  if (opts.command === 'next') result = commandNext(paths, opts, config);
  if (opts.command === 'ingest') result = await commandIngest(paths, opts, config);
  if (opts.command === 'fail-batch') result = commandFailBatch(paths, opts, config);
  if (opts.command === 'invalidate-reviewed') result = commandInvalidateReviewed(paths, opts);
  if (opts.command === 'finalize') result = commandFinalize(paths, opts);
  if (opts.command === 'status') result = statusReport(paths, config);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  MAX_BATCH_SIZE,
  MAX_ATTEMPTS,
  normalizeDate,
  loadConfig,
  pathsForDate,
  renderPrompt,
  interactionSurface,
  surfaceModelVersion,
  latestOpenBatch,
  commandNext,
  commandIngest,
  commandFailBatch,
  commandInvalidateReviewed,
  statusReport,
  main,
};
