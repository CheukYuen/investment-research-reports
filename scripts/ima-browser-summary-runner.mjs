import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
delete require.cache[require.resolve('./report-summaries.cjs')];
const {
  readJsonl,
  writeJsonlAtomic,
  validateAndNormalizeSuccess,
  normalizeFailure,
  buildPending,
} = require('./report-summaries.cjs');

const DEFAULTS = {
  root: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  index: 'manifests/index-20260723.jsonl',
  progress: 'manifests/report-summary-browser-progress-20260723.jsonl',
  failures: 'manifests/report-summary-browser-failures-20260723.jsonl',
  prompt: 'prompts/ima-download-screen-summary-v2.txt',
  attemptTimeoutMs: 75000,
  pollMs: 1000,
  maxItems: Infinity,
};

const BATCH3_DEFAULTS = {
  ...DEFAULTS,
  prompt: 'prompts/ima-download-screen-summary-batch3-v1.txt',
  attemptTimeoutMs: 150000,
  maxBatches: Infinity,
};

function absolute(root, value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function upsert(records, record) {
  return [...records.filter((item) => item.media_id !== record.media_id), record];
}

function stripCitationArtifacts(value) {
  return String(value || '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\u200B/g, '')
    .trim();
}

export function parseStrictJson(rawAnswer) {
  let text = stripCitationArtifacts(rawAnswer);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  const sanitize = (value) => {
    if (typeof value === 'string') return stripCitationArtifacts(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    }
    return value;
  };
  const parsed = sanitize(JSON.parse(text));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Answer must be one JSON object');
  }
  return parsed;
}

async function clickExactUnique(tab, text) {
  const locator = tab.playwright.getByText(text, { exact: true });
  const count = await locator.count();
  if (count !== 1) throw new Error(`Expected one "${text}" locator, found ${count}`);
  await locator.click();
}

export async function enterDatedFolder(tab) {
  const snapshot = await tab.playwright.domSnapshot();
  if (!snapshot.includes('7.23')) {
    await clickExactUnique(tab, '2026年国际顶级投行研报');
    await tab.playwright.waitForTimeout(800);
    await clickExactUnique(tab, '7月');
    await tab.playwright.waitForTimeout(800);
    await clickExactUnique(tab, '7.23');
    await tab.playwright.waitForTimeout(1000);
  }
  const dated = await tab.playwright.domSnapshot();
  if (!dated.includes('基于当前文件夹提问') && !dated.includes('基于文件夹问答')) {
    throw new Error('Dated folder Q&A panel not available');
  }
}

export async function startNewConversation(tab) {
  const newChat = tab.playwright.locator('span.icon-start-new-chat-small');
  const count = await newChat.count();
  if (count !== 1) throw new Error(`Expected one new-chat button, found ${count}`);
  await newChat.click();
  await tab.playwright.waitForTimeout(400);
  const answers = await tab.playwright.locator('div[class*="_aiContainer_"]').count();
  if (answers !== 0) throw new Error(`New conversation still contains ${answers} answers`);
}

async function extractAnswer(tab, answerIndex) {
  const answers = tab.playwright.locator('div[class*="_aiContainer_"]');
  const answerContainer = answers.nth(answerIndex);
  return answerContainer.evaluate((root) => {
    const excluded = (element) => {
      const className = typeof element.className === 'string' ? element.className : '';
      return className.includes('system-copy-exclude') || className.includes('table-export-exclude');
    };
    const collect = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE || excluded(node)) return '';
      if (node.tagName === 'BR') return '\n';
      return [...node.childNodes].map(collect).join('');
    };
    const answer = root.querySelector('div[class*="_bubble_"]');
    const header = root.querySelector('div[class*="_referenceHeader_"]');
    const sourceTitles = [...root.querySelectorAll('li')].map((item) =>
      (item.textContent || '').trim().replace(/^\d+\.\s*/, '')
    ).filter(Boolean);
    return {
      answer: answer ? collect(answer).trim() : '',
      header: header ? (header.textContent || '').trim() : '',
      sourceTitles,
      qaText: (root.textContent || '').trim(),
    };
  });
}

function sourceCountFromHeader(header) {
  const match = String(header || '').match(/找到(?:了)?\s*(\d+)\s*篇知识库资料/);
  return match ? Number(match[1]) : null;
}

function detectGlobalStop(text) {
  if (/资料获取次数已达上限|请求过于频繁|提问太快|系统繁忙.*稍后|今日.*上限/.test(text)) return 'GLOBAL_LIMIT';
  if (/微信扫码登录|手机号登录|请登录后|登录后继续/.test(text)) return 'LOGIN_REQUIRED';
  return null;
}

const BATCH_LIMITS = {
  key_findings: 3,
  content_tags: 6,
  data_points: 4,
  entities: 8,
  evidence: 3,
};

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

export function mapBatchReports(parsed, expectedTitles) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.reports)) {
    throw new Error('Batch answer must contain reports[]');
  }
  if (!Array.isArray(expectedTitles) || expectedTitles.length !== 3 || new Set(expectedTitles).size !== 3) {
    throw new Error('Batch requires exactly three distinct expected titles');
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
        ...(parsed.reports.length === 3 ? [] : [`batch_report_count:${parsed.reports.length}`]),
        ...limited.warnings,
      ],
    };
  });
}

function buildBatchPrompt(promptTemplate, indexRecords) {
  return indexRecords.reduce(
    (prompt, record, index) => prompt.replaceAll(`{{FILE_NAME_${index + 1}}}`, record.title),
    promptTemplate,
  );
}

async function processBatch3(tab, indexRecords, promptTemplate, options) {
  const startedAt = Date.now();
  const before = await tab.playwright.locator('div[class*="_aiContainer_"]').count();
  await submitPrompt(tab, buildBatchPrompt(promptTemplate, indexRecords));
  const result = await waitForCompleteAnswer(tab, before, options.attemptTimeoutMs, options.pollMs);
  const extracted = result.extracted || { answer: '', header: '', sourceTitles: [], qaText: '' };
  const sourceCount = sourceCountFromHeader(extracted.header);
  const shared = {
    attempts: 1,
    source_count: sourceCount,
    source_titles: extracted.sourceTitles,
    prompt_version: 'ima-download-screen-summary-batch3-v1',
    model_version: 'ima-web-hy3-fast',
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    raw_answer: extracted.answer,
  };
  if (result.failureCode || !sourceCount) {
    const failureCode = result.failureCode || 'NO_SOURCE_METADATA';
    return {
      failure_code: failureCode,
      outcomes: indexRecords.map((indexRecord) => ({
        failure: normalizeFailure({ ...shared, media_id: indexRecord.media_id, failure_code: failureCode }, indexRecord),
      })),
    };
  }

  const mapped = mapBatchReports(result.parsed, indexRecords.map((record) => record.title));
  const outcomes = mapped.map((item, index) => {
    const indexRecord = indexRecords[index];
    if (item.failure_code) {
      return {
        failure: normalizeFailure({ ...shared, media_id: indexRecord.media_id, failure_code: item.failure_code }, indexRecord),
      };
    }
    const candidate = {
      ...item.report,
      ...shared,
      media_id: indexRecord.media_id,
      status: 'reviewed',
      source_match: extracted.sourceTitles.includes(indexRecord.title),
      source_exclusive: false,
      summary_role: 'routing_candidate',
    };
    const normalized = validateAndNormalizeSuccess(candidate, indexRecord);
    normalized.validation_warnings = [...new Set([
      ...normalized.validation_warnings,
      ...(item.warnings || []),
    ])];
    if (normalized.status === 'reviewed') return { record: normalized };
    return {
      failure: normalizeFailure({
        ...shared,
        media_id: indexRecord.media_id,
        failure_code: normalized.failure_code,
        validation_errors: normalized.validation_errors,
        validation_warnings: normalized.validation_warnings,
      }, indexRecord),
    };
  });
  return { outcomes };
}

async function submitPrompt(tab, prompt) {
  const input = tab.playwright.locator('[contenteditable="true"]');
  const inputCount = await input.count();
  if (inputCount !== 1) throw new Error(`Expected one Q&A input, found ${inputCount}`);
  await input.fill(prompt);
  const send = tab.playwright.locator('span.icon-send-enable-big');
  const sendCount = await send.count();
  if (sendCount !== 1) throw new Error(`Expected one enabled send button, found ${sendCount}`);
  await send.click();
}

async function waitForCompleteAnswer(tab, originalCount, timeoutMs, pollMs) {
  const startedAt = Date.now();
  let previousAnswer = '';
  let stablePolls = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const answers = tab.playwright.locator('div[class*="_aiContainer_"]');
    const count = await answers.count();
    if (count > originalCount) {
      const extracted = await extractAnswer(tab, count - 1);
      const globalStop = detectGlobalStop(`${extracted.qaText}\n${extracted.answer}`);
      if (globalStop) return { failureCode: globalStop, extracted };
      if (extracted.answer && extracted.answer === previousAnswer) stablePolls += 1;
      else stablePolls = 0;
      previousAnswer = extracted.answer;
      if (stablePolls >= 2) {
        try {
          return { extracted, parsed: parseStrictJson(extracted.answer) };
        } catch {
          // The answer may still be streaming even when the visible tail pauses briefly.
        }
      }
    }
    await tab.playwright.waitForTimeout(pollMs);
  }
  return { failureCode: 'ANSWER_TIMEOUT', extracted: originalCount < await tab.playwright.locator('div[class*="_aiContainer_"]').count()
    ? await extractAnswer(tab, (await tab.playwright.locator('div[class*="_aiContainer_"]').count()) - 1)
    : { answer: '', header: '', sourceTitles: [], qaText: '' } };
}

async function processOne(tab, indexRecord, promptTemplate, options) {
  let lastFailure = null;
  const overallStart = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const answers = tab.playwright.locator('div[class*="_aiContainer_"]');
    const before = await answers.count();
    const prompt = promptTemplate.replaceAll('{{FILE_NAME}}', indexRecord.title);
    await submitPrompt(tab, prompt);
    const result = await waitForCompleteAnswer(tab, before, options.attemptTimeoutMs, options.pollMs);
    const extracted = result.extracted || { answer: '', header: '', sourceTitles: [], qaText: '' };
    const sourceCount = sourceCountFromHeader(extracted.header);
    const sourceTitles = extracted.sourceTitles;

    if (result.failureCode) {
      lastFailure = {
        failure_code: result.failureCode,
        attempts: attempt,
        source_count: sourceCount,
        source_titles: sourceTitles,
        raw_answer: extracted.answer,
      };
      if (['GLOBAL_LIMIT', 'LOGIN_REQUIRED'].includes(result.failureCode)) break;
      continue;
    }

    if (!sourceCount) {
      lastFailure = {
        failure_code: 'NO_SOURCE_METADATA',
        attempts: attempt,
        source_count: sourceCount,
        source_titles: sourceTitles,
        raw_answer: extracted.answer,
      };
      continue;
    }

    const candidate = {
      ...result.parsed,
      media_id: indexRecord.media_id,
      status: 'reviewed',
      attempts: attempt,
      source_count: sourceCount,
      source_titles: sourceTitles,
      source_match: true,
      source_exclusive: sourceCount === 1 && sourceTitles.length === 1,
      summary_role: 'routing_candidate',
      prompt_version: 'ima-download-screen-summary-v2',
      model_version: 'ima-web-hy3-fast',
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - overallStart,
      raw_answer: extracted.answer,
    };
    const normalized = validateAndNormalizeSuccess(candidate, indexRecord);
    if (normalized.status === 'reviewed') return { record: normalized };
    lastFailure = {
      failure_code: normalized.failure_code,
      validation_errors: normalized.validation_errors,
      validation_warnings: normalized.validation_warnings,
      attempts: attempt,
      source_count: sourceCount,
      source_titles: sourceTitles,
      raw_answer: extracted.answer,
    };
  }
  return {
    failure: normalizeFailure({
      ...lastFailure,
      media_id: indexRecord.media_id,
      failed_at: new Date().toISOString(),
      elapsed_ms: Date.now() - overallStart,
      prompt_version: 'ima-download-screen-summary-v2',
      model_version: 'ima-web-hy3-fast',
    }, indexRecord),
  };
}

export async function runBrowserSummaries(tab, supplied = {}) {
  const options = { ...DEFAULTS, ...supplied };
  const root = options.root;
  const indexPath = absolute(root, options.index);
  const progressPath = absolute(root, options.progress);
  const failurePath = absolute(root, options.failures);
  const promptPath = absolute(root, options.prompt);
  const index = readJsonl(indexPath);
  let progress = readJsonl(progressPath);
  let failures = readJsonl(failurePath);
  if (!fs.existsSync(progressPath)) writeJsonlAtomic(progressPath, progress);
  if (!fs.existsSync(failurePath)) writeJsonlAtomic(failurePath, failures);
  const promptTemplate = fs.readFileSync(promptPath, 'utf8');
  if (index.length !== 72) throw new Error(`Expected 72 index records, found ${index.length}`);
  if (!promptTemplate.includes('{{FILE_NAME}}')) throw new Error('Prompt template is missing {{FILE_NAME}}');

  if (options.newConversation) await startNewConversation(tab);
  await enterDatedFolder(tab);
  const pending = buildPending(index, progress, failures).slice(0, options.maxItems);
  const result = { pending_before: pending.length, reviewed: 0, failed: 0, stopped: null, processed: [] };
  let systematicFailures = 0;

  for (const indexRecord of pending) {
    const previousAttempts = Number(failures.find((item) => item.media_id === indexRecord.media_id)?.attempts || 0);
    let outcome;
    try {
      outcome = await processOne(tab, indexRecord, promptTemplate, options);
    } catch (error) {
      outcome = {
        failure: normalizeFailure({
          media_id: indexRecord.media_id,
          failure_code: 'DOM_ERROR',
          attempts: 1,
          failed_at: new Date().toISOString(),
          raw_answer: error && error.message ? error.message : String(error),
        }, indexRecord),
      };
    }
    if (outcome.record) {
      outcome.record.attempts += previousAttempts;
      progress = upsert(progress, outcome.record);
      writeJsonlAtomic(progressPath, progress);
      failures = failures.filter((item) => item.media_id !== outcome.record.media_id);
      writeJsonlAtomic(failurePath, failures);
      result.reviewed += 1;
      result.processed.push({ media_id: outcome.record.media_id, title: outcome.record.title, status: 'reviewed' });
      systematicFailures = 0;
      if (typeof options.onProgress === 'function') await options.onProgress(result.processed.at(-1));
      continue;
    }

    outcome.failure.attempts += previousAttempts;
    failures = upsert(failures, outcome.failure);
    writeJsonlAtomic(failurePath, failures);
    result.failed += 1;
    result.processed.push({
      media_id: outcome.failure.media_id,
      title: outcome.failure.title,
      status: 'UNREVIEWED',
      failure_code: outcome.failure.failure_code,
    });
    if (typeof options.onProgress === 'function') await options.onProgress(result.processed.at(-1));

    if (['GLOBAL_LIMIT', 'LOGIN_REQUIRED'].includes(outcome.failure.failure_code)) {
      result.stopped = outcome.failure.failure_code;
      break;
    }
    if (['SOURCE_MISMATCH', 'ANSWER_TIMEOUT', 'DOM_ERROR'].includes(outcome.failure.failure_code)) systematicFailures += 1;
    else systematicFailures = 0;
    if (systematicFailures >= 3) {
      result.stopped = 'SYSTEMATIC_SOURCE_OR_DOM_ERRORS';
      break;
    }
  }
  return result;
}

export async function runBrowserSummaryBatches3(tab, supplied = {}) {
  const options = { ...BATCH3_DEFAULTS, ...supplied };
  const root = options.root;
  const indexPath = absolute(root, options.index);
  const progressPath = absolute(root, options.progress);
  const failurePath = absolute(root, options.failures);
  const promptPath = absolute(root, options.prompt);
  const index = readJsonl(indexPath);
  let progress = readJsonl(progressPath);
  let failures = readJsonl(failurePath);
  if (!fs.existsSync(progressPath)) writeJsonlAtomic(progressPath, progress);
  if (!fs.existsSync(failurePath)) writeJsonlAtomic(failurePath, failures);
  const promptTemplate = fs.readFileSync(promptPath, 'utf8');
  if (index.length !== 72) throw new Error(`Expected 72 index records, found ${index.length}`);
  for (let number = 1; number <= 3; number += 1) {
    if (!promptTemplate.includes(`{{FILE_NAME_${number}}}`)) {
      throw new Error(`Prompt template is missing {{FILE_NAME_${number}}}`);
    }
  }

  const pending = buildPending(index, progress, failures);
  const completeBatches = Math.min(Math.floor(pending.length / 3), Number(options.maxBatches));
  const result = {
    pending_before: pending.length,
    batches_planned: completeBatches,
    batches_completed: 0,
    reviewed: 0,
    failed: 0,
    stopped: null,
    processed: [],
  };

  for (let batchIndex = 0; batchIndex < completeBatches; batchIndex += 1) {
    const batch = pending.slice(batchIndex * 3, batchIndex * 3 + 3);
    await startNewConversation(tab);
    await enterDatedFolder(tab);
    let batchOutcome;
    try {
      batchOutcome = await processBatch3(tab, batch, promptTemplate, options);
    } catch (error) {
      batchOutcome = {
        outcomes: batch.map((indexRecord) => ({
          failure: normalizeFailure({
            media_id: indexRecord.media_id,
            failure_code: 'DOM_ERROR',
            attempts: 1,
            generated_at: new Date().toISOString(),
            raw_answer: error && error.message ? error.message : String(error),
            prompt_version: 'ima-download-screen-summary-batch3-v1',
            model_version: 'ima-web-hy3-fast',
          }, indexRecord),
        })),
      };
    }

    for (const outcome of batchOutcome.outcomes) {
      const mediaId = outcome.record?.media_id || outcome.failure.media_id;
      const previousAttempts = Number(failures.find((item) => item.media_id === mediaId)?.attempts || 0);
      if (outcome.record) {
        outcome.record.attempts += previousAttempts;
        progress = upsert(progress, outcome.record);
        writeJsonlAtomic(progressPath, progress);
        failures = failures.filter((item) => item.media_id !== mediaId);
        writeJsonlAtomic(failurePath, failures);
        result.reviewed += 1;
        result.processed.push({ media_id: mediaId, title: outcome.record.title, status: 'reviewed' });
      } else {
        outcome.failure.attempts += previousAttempts;
        failures = upsert(failures, outcome.failure);
        writeJsonlAtomic(failurePath, failures);
        result.failed += 1;
        result.processed.push({
          media_id: mediaId,
          title: outcome.failure.title,
          status: 'UNREVIEWED',
          failure_code: outcome.failure.failure_code,
        });
      }
      if (typeof options.onProgress === 'function') await options.onProgress(result.processed.at(-1));
    }
    result.batches_completed += 1;
    if (['GLOBAL_LIMIT', 'LOGIN_REQUIRED'].includes(batchOutcome.failure_code)) {
      result.stopped = batchOutcome.failure_code;
      break;
    }
  }
  return result;
}
