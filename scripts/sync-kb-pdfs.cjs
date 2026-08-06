#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IMA_API = path.join(ROOT, 'ima-skills', 'ima_api.cjs');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const INDEX_PATH = path.join(MANIFESTS_DIR, 'index.jsonl');
const DOWNLOADED_PATH = path.join(MANIFESTS_DIR, 'downloaded.jsonl');
const FAILED_PATH = path.join(MANIFESTS_DIR, 'failed.jsonl');
const DOWNLOAD_ATTEMPTS_PATH = path.join(MANIFESTS_DIR, 'download-attempts.jsonl');
const PDF_MEDIA_TYPE = 1;
const FOLDER_MEDIA_TYPE = 99;
const PRIORITY_ORDER = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);
const REPORT_TYPES = new Set(['company', 'industry', 'strategy', 'macro', 'commodity', 'other']);
const SECTORS_CN_TO_EN = new Map([
  ['能源', 'Energy'],
  ['原材料', 'Materials'],
  ['工业', 'Industrials'],
  ['可选消费', 'Consumer Discretionary'],
  ['主要消费', 'Consumer Staples'],
  ['医药卫生', 'Health Care'],
  ['金融', 'Financials'],
  ['信息技术', 'Information Technology'],
  ['通信服务', 'Communication Services'],
  ['公用事业', 'Utilities'],
  ['房地产', 'Real Estate'],
]);
const MAX_SECTORS = 3;

function usage() {
  console.log(`Usage:
  node scripts/sync-kb-pdfs.cjs index --kb <name> [--source-path <path>] [--strip-source-prefix <path>] [--local-prefix <path>] [--snapshot <path>]
  node scripts/sync-kb-pdfs.cjs download --kb <name> [--source-path <path>] [--limit <n>]
  node scripts/sync-kb-pdfs.cjs sync --kb <name> [--source-path <path>] [--strip-source-prefix <path>] [--local-prefix <path>] [--limit <n>]
  node scripts/sync-kb-pdfs.cjs rank-ai --summary-source <summaries.jsonl> --queue <queue.jsonl> [--batch-size <n>]
  node scripts/sync-kb-pdfs.cjs download-queue --kb <name> --queue <path> [--priorities <P0,P1,P2>] [--daily-budget <n>] [--quota-probe-extra <n>]

Examples:
  node scripts/sync-kb-pdfs.cjs sync --kb "环球研报直通车" --source-path "2026年国际顶级投行研报/7月" --strip-source-prefix "2026年国际顶级投行研报" --local-prefix "2026"
  node scripts/sync-kb-pdfs.cjs download --kb "环球研报直通车" --source-path "环球研报直通车 / 2026年国际顶级投行研报 / 7月"
  node scripts/sync-kb-pdfs.cjs rank-ai --summary-source manifests/report-summaries-20260724.jsonl --queue manifests/ai-ranked-queue-summary-20260724.jsonl
  node scripts/sync-kb-pdfs.cjs download-queue --kb "环球研报直通车" --queue manifests/ai-ranked-queue-summary-20260724.jsonl --priorities P0,P1,P2 --daily-budget 30 --quota-probe-extra 1`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next == null || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
}

function splitPath(input) {
  if (!input) return [];
  return String(input)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function fullSourcePath(knowledgeBase, parts) {
  return [knowledgeBase, ...parts].join(' / ');
}

function localPartsFromSource(folderParts, title, opts) {
  const strip = splitPath(opts['strip-source-prefix']);
  let parts = folderParts.slice();

  if (strip.length > 0 && strip.every((part, index) => parts[index] === part)) {
    parts = parts.slice(strip.length);
  }

  const prefix = splitPath(opts['local-prefix']);
  return [...prefix, ...parts, title];
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function writeJsonlAtomic(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.part`;
  fs.writeFileSync(tempPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const records = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${filePath}:${index + 1} is not valid JSONL: ${err.message}`);
    }
  }
  return records;
}

function resolveRootPath(input, defaultPath) {
  const value = input || defaultPath;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function parseEnvValue(value) {
  let parsed = value.trim();
  if (
    (parsed.startsWith('"') && parsed.endsWith('"')) ||
    (parsed.startsWith("'") && parsed.endsWith("'"))
  ) {
    parsed = parsed.slice(1, -1);
  }
  return parsed.replace(/\\n/g, '\n');
}

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) continue;
    process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
  }
}

function parsePositiveInteger(input, name, defaultValue) {
  if (input == null || input === true || input === '') return defaultValue;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(input, name, defaultValue) {
  if (input == null || input === true || input === '') return defaultValue;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseCommaList(input, defaultValue) {
  const source = input == null || input === true || input === '' ? defaultValue : input;
  return String(source)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePriorities(input) {
  const priorities = parseCommaList(input, 'P0,P1').map((priority) => priority.toUpperCase());
  for (const priority of priorities) {
    if (!PRIORITY_ORDER.has(priority)) {
      throw new Error(`Invalid priority: ${priority}`);
    }
  }
  return new Set(priorities);
}

function uniqueByMediaId(records) {
  const seen = new Set();
  const deduped = [];
  for (const record of records) {
    if (!record.media_id || seen.has(record.media_id)) continue;
    seen.add(record.media_id);
    deduped.push(record);
  }
  return deduped;
}

function isQuotaError(err) {
  const message = err && err.message ? err.message : String(err || '');
  return /资料获取次数已达上限|请明天再尝试|请求频控|频控|quota|rate limit/i.test(message);
}

function shanghaiDateKey(input) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(input));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function recordDateKey(record, field) {
  const value = record && record[field];
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return shanghaiDateKey(value);
}

function inferLegacyDailyAttempts(knowledgeBaseName, dateKey) {
  const downloaded = readJsonl(DOWNLOADED_PATH).filter((record) =>
    record.knowledge_base === knowledgeBaseName &&
    record.request_id &&
    recordDateKey(record, 'downloaded_at') === dateKey
  );
  const failed = readJsonl(FAILED_PATH).filter((record) =>
    record.knowledge_base === knowledgeBaseName &&
    recordDateKey(record, 'failed_at') === dateKey
  );
  return {
    downloaded: downloaded.length,
    failed: failed.length,
    total: downloaded.length + failed.length,
  };
}

function loadDailyQuotaState(knowledgeBaseName, now = new Date()) {
  const dateKey = shanghaiDateKey(now);
  let records = readJsonl(DOWNLOAD_ATTEMPTS_PATH).filter((record) =>
    record.date === dateKey && record.knowledge_base === knowledgeBaseName
  );
  let baseline = records.find((record) => record.kind === 'daily_baseline');

  if (!baseline) {
    const inferred = inferLegacyDailyAttempts(knowledgeBaseName, dateKey);
    baseline = {
      kind: 'daily_baseline',
      created_at: new Date(now).toISOString(),
      date: dateKey,
      knowledge_base: knowledgeBaseName,
      attempts: inferred.total,
      inferred_downloaded: inferred.downloaded,
      inferred_failed: inferred.failed,
    };
    appendJsonl(DOWNLOAD_ATTEMPTS_PATH, baseline);
    records = [baseline, ...records];
  }

  const explicitAttempts = records.filter((record) => record.kind === 'download_attempt').length;
  return {
    date: dateKey,
    baseline_attempts: Number(baseline.attempts || 0),
    explicit_attempts: explicitAttempts,
    used: Number(baseline.attempts || 0) + explicitAttempts,
  };
}

function classifyQuotaSlot(used, dailyBudget, quotaProbeExtra) {
  if (used < dailyBudget) return 'budget';
  if (used < dailyBudget + quotaProbeExtra) return 'probe';
  return 'stop';
}

function compareDownloadPriority(a, b) {
  const aPriority = PRIORITY_ORDER.get(String(a.priority || '').toUpperCase()) ?? Infinity;
  const bPriority = PRIORITY_ORDER.get(String(b.priority || '').toUpperCase()) ?? Infinity;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return Number(a.rank || Infinity) - Number(b.rank || Infinity);
}

function isRetriableImaError(message) {
  return /请求频率超限|请求频控|频控|HTTP 429|rate limit/i.test(String(message || ''));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function imaApi(apiPath, body) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = spawnSync(process.execPath, [IMA_API, apiPath, JSON.stringify(body)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.status !== 0) {
      let msg = result.stderr || result.stdout || `ima_api exited with status ${result.status}`;
      try {
        const parsed = JSON.parse(result.stderr || '{}');
        msg = parsed.msg || msg;
      } catch {}
      lastError = new Error(msg.trim());
      if (attempt < 4 && isRetriableImaError(lastError.message)) {
        sleepSync(1500 * attempt);
        continue;
      }
      throw lastError;
    }

    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`ima_api returned invalid JSON: ${err.message}`);
    }

    if (response.code !== 0) {
      lastError = new Error(response.msg || `IMA API business error: ${response.code}`);
      if (attempt < 4 && isRetriableImaError(lastError.message)) {
        sleepSync(1500 * attempt);
        continue;
      }
      throw lastError;
    }

    return response;
  }
  throw lastError;
}

function deepSeekConfig(overrides = {}) {
  loadDotEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required. Put it in .env or export it in the environment.');
  }
  const modelEnv = overrides.modelEnv || 'DEEPSEEK_RANK_MODEL';
  const fallbackModelEnv = overrides.fallbackModelEnv || 'DEEPSEEK_RERANK_MODEL';
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: overrides.model ||
      process.env[modelEnv] ||
      process.env[fallbackModelEnv] ||
      overrides.defaultModel ||
      'deepseek-v4-flash',
    requestTimeoutMs: parsePositiveInteger(
      process.env.DEEPSEEK_REQUEST_TIMEOUT_MS,
      'DEEPSEEK_REQUEST_TIMEOUT_MS',
      120000
    ),
    maxTokens: parsePositiveInteger(process.env.DEEPSEEK_MAX_TOKENS, 'DEEPSEEK_MAX_TOKENS', 12000),
  };
}

function chatCompletionsUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {}

  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {}

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(unfenced.slice(start, end + 1));
  }
  throw new Error('LLM returned invalid JSON');
}

async function callDeepSeekJson(config, messages) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(chatCompletionsUrl(config.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0,
          max_tokens: config.maxTokens,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
        }),
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`DeepSeek API error HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
      }

      const payload = JSON.parse(bodyText);
      const content = payload.choices && payload.choices[0] && payload.choices[0].message
        ? payload.choices[0].message.content
        : '';
      return extractJsonObject(content);
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function rankingSystemPrompt() {
  return `你是严谨的买方科技研究审稿人。请只根据输入中的研报标题、通用摘要、关键结论、内容标签、关键数据、实体和正文证据，对 AI Infrastructure 投资研究价值做正文优先排序，并在同一次输出中完成报告类型分类和一级行业分类。

输出必须是严格 JSON object：
{"results":[{"priority":"P0|P1|P2|P3","score":0-100,"report_type":"company|industry|strategy|macro|commodity|other","report_type_reason":"一句话分类依据","sectors_cn":["..."],"topics":["..."],"reasons":["..."],"evidence":["..."],"false_positive_checks":["..."]}]}

results 必须与输入数组等长、同顺序。不要输出 markdown，不要使用公司常识补充输入中不存在的信息。

## AI Infrastructure 排序

P0（85-100）：正文明确以 AI 数据中心资本开支、AI 服务器/GPU/ASIC/HBM/先进封装、数据中心光互联/网络、电力/冷却或人形机器人核心硬件为主要投资逻辑。
P1（65-84）：正文有明确、可投资的 AI 基建需求、供给、价格、产能或业绩传导证据，但不是全文唯一主线；也包括强相关半导体设备材料、PCB、光纤光缆、工业自动化。
P2（35-64）：正文仅有泛 AI、应用或间接敞口，缺少清晰基建传导。
P3（0-34）：正文没有实质 AI 基建证据，或只是普通宏观、消费、金融、医药、地产、汽车等。

通用摘要、关键结论、关键数据、实体都是尚未经过 PDF 级正式验证的路由候选。evidence 可能为空，为空时以通用摘要和关键结论中的具体事实与数字为准，不得因缺少原文引文而系统性压低评级。
必须在 reasons/evidence 中引用输入给出的具体事实或数字。标题与正文冲突时以正文为准。存在“数据中心”但实际只是地产/租赁/并购时主动检查假阳性。

## 报告类型分类（report_type，六选一）

- company（公司研究）：单一公司、评级、目标价、盈利预测；
- industry（行业研究）：行业、产业链、供需、多公司比较；
- strategy（投资策略）：资产配置、市场风格、仓位、交易策略；
- macro（宏观经济）：经济体、央行、财政货币政策；
- commodity（大宗商品）：实物商品价格、供需、库存；
- other（其他研究）：已理解内容后，确认无法归入以上类型，例如无主导研究对象的多主题合集、研究方法或数据产品说明、会议日程和索引类行政材料。

判定顺序（命中第一条即停，行业数量和 topics 不得反向决定 report_type）：
1. 主要结论锚定单一公司、评级、目标价或盈利预测 → company；
2. 主要对象是实物商品价格、供需、库存或贸易流 → commodity；
3. 主要对象是经济体、央行、通胀、就业或财政货币政策 → macro；
4. 核心交付物是配置、仓位、组合、风格或交易建议 → strategy；
5. 主要对象是行业、产业链、竞争格局或多家公司比较 → industry；
6. 确实无法归入以上类型 → other。

report_type_reason 必须是一句话，引用输入中的具体事实说明依据。无法可靠判断时，report_type 留空字符串或省略该字段，不得猜测填入 other。

## 一级行业分类（sectors_cn，0-3 个，只用中文，主行业排第一）

只允许从以下 11 个中文行业名中选择，不得自造名称：
能源、原材料、工业、可选消费、主要消费、医药卫生、金融、信息技术、通信服务、公用事业、房地产。

宏观或综合策略类报告的 sectors_cn 可以为空数组。`;
}

async function classifyBatchWithDeepSeek(config, batch) {
  const inputs = batch.map((record) => ({
    media_id: record.media_id,
    title: record.title,
    executive_summary: record.executive_summary,
    key_findings: record.key_findings,
    content_tags: record.content_tags,
    data_points: record.data_points,
    entities: record.entities,
    evidence: record.evidence,
  }));
  const messages = [
    { role: 'system', content: rankingSystemPrompt() },
    {
      role: 'user',
      content: `请按正文证据排序以下研报，返回 results 与输入同顺序、同长度：\n${JSON.stringify(inputs, null, 2)}`,
    },
  ];

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parsed = await callDeepSeekJson(config, messages);
      if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error(`Rank LLM returned ${parsed && Array.isArray(parsed.results) ? parsed.results.length : 0} results for ${batch.length} inputs`);
      }
      return parsed.results.map((result, index) => normalizeRanking(result, batch[index]));
    } catch (err) {
      lastError = err;
      if (attempt < 2) continue;
      throw lastError;
    }
  }
  throw lastError;
}

function normalizeStringArray(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
}

function normalizeClassification(result) {
  const warnings = [];
  const rawReportType = typeof result.report_type === 'string' ? result.report_type.trim() : '';
  let reportType = null;
  let reportTypeReason = null;
  if (rawReportType && REPORT_TYPES.has(rawReportType)) {
    const rawReason = typeof result.report_type_reason === 'string' ? result.report_type_reason.trim() : '';
    if (rawReason) {
      reportType = rawReportType;
      reportTypeReason = rawReason;
    } else {
      warnings.push('missing_report_type_reason');
    }
  } else if (rawReportType) {
    warnings.push(`invalid_report_type:${rawReportType}`);
  }

  const rawSectors = Array.isArray(result.sectors_cn) ? result.sectors_cn : [];
  const sectors = [];
  for (const raw of rawSectors) {
    const nameCn = typeof raw === 'string' ? raw.trim() : '';
    if (!nameCn) continue;
    if (!SECTORS_CN_TO_EN.has(nameCn)) {
      warnings.push(`invalid_sector_removed:${nameCn}`);
      continue;
    }
    if (sectors.some((sector) => sector.name_cn === nameCn)) continue;
    sectors.push({ name_cn: nameCn, name_en: SECTORS_CN_TO_EN.get(nameCn) });
  }
  let finalSectors = sectors;
  if (sectors.length > MAX_SECTORS) {
    warnings.push(`sectors_truncated:${sectors.length}->${MAX_SECTORS}`);
    finalSectors = sectors.slice(0, MAX_SECTORS);
  }

  return {
    report_type: reportType,
    report_type_reason: reportTypeReason,
    sectors: finalSectors,
    classification_warnings: warnings,
  };
}

function normalizeRanking(result, record) {
  const priority = String(result.priority || '').toUpperCase();
  if (!PRIORITY_ORDER.has(priority)) {
    throw new Error(`LLM returned invalid priority for ${record.title}: ${result.priority}`);
  }
  const score = Number(result.score);
  if (!Number.isFinite(score)) {
    throw new Error(`LLM returned invalid score for ${record.title}: ${result.score}`);
  }
  const classification = normalizeClassification(result);
  return {
    priority,
    score: Math.max(0, Math.min(100, Math.round(score))),
    report_type: classification.report_type,
    report_type_reason: classification.report_type_reason,
    sectors: classification.sectors,
    classification_source: 'deepseek_rank',
    classification_warnings: classification.classification_warnings,
    topics: normalizeStringArray(result.topics, []),
    reasons: normalizeStringArray(result.reasons || result.reason, []),
    evidence: normalizeStringArray(result.evidence, []),
    false_positive_checks: normalizeStringArray(result.false_positive_checks, []),
  };
}

function shouldLogProgress(opts) {
  return opts.quiet !== true && opts.quiet !== 'true';
}

function findKnowledgeBaseId(name) {
  const response = imaApi('openapi/wiki/v1/search_knowledge_base', {
    query: name,
    cursor: '',
    limit: 20,
  });
  const matches = (response.data.info_list || []).filter((item) => item.kb_name === name || item.name === name);
  if (matches.length === 0) {
    throw new Error(`Knowledge base not found: ${name}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple knowledge bases matched: ${name}`);
  }
  return matches[0].kb_id || matches[0].id;
}

function getKnowledgeListPage(knowledgeBaseId, folderId, cursor) {
  const body = {
    knowledge_base_id: knowledgeBaseId,
    cursor,
    limit: 50,
  };
  if (folderId) body.folder_id = folderId;
  return imaApi('openapi/wiki/v1/get_knowledge_list', body);
}

function listFolderAll(knowledgeBaseId, folderId) {
  const items = [];
  let cursor = '';
  for (;;) {
    const response = getKnowledgeListPage(knowledgeBaseId, folderId, cursor);
    items.push(...(response.data.knowledge_list || []));
    if (response.data.is_end) break;
    cursor = response.data.next_cursor || '';
    if (!cursor) break;
  }
  return items;
}

function resolveFolderPath(knowledgeBaseId, folderParts) {
  let folderId = '';
  const resolved = [];

  for (const part of folderParts) {
    const items = listFolderAll(knowledgeBaseId, folderId);
    const folder = items.find((item) => item.media_type === FOLDER_MEDIA_TYPE && item.title === part);
    if (!folder) {
      throw new Error(`Folder not found: ${fullSourcePath('(knowledge base)', [...resolved, part])}`);
    }
    folderId = folder.media_id;
    resolved.push(part);
  }

  return folderId;
}

function existingIndexKeys() {
  return new Set(readJsonl(INDEX_PATH).map((record) => record.media_id).filter(Boolean));
}

async function collectFolderRecords(knowledgeBaseId, knowledgeBaseName, folderId, folderParts, opts, records) {
  const items = listFolderAll(knowledgeBaseId, folderId);

  for (const item of items) {
    if (item.media_type === FOLDER_MEDIA_TYPE) {
      await collectFolderRecords(
        knowledgeBaseId,
        knowledgeBaseName,
        item.media_id,
        [...folderParts, item.title],
        opts,
        records
      );
      continue;
    }

    const isPdf = item.media_type === PDF_MEDIA_TYPE || /\.pdf$/i.test(item.title || '');
    if (!isPdf) continue;

    const localParts = localPartsFromSource(folderParts, item.title, opts);
    const savedPath = path.join(DOWNLOADS_DIR, ...localParts);
    records.push({
      indexed_at: new Date().toISOString(),
      knowledge_base: knowledgeBaseName,
      source_path: fullSourcePath(knowledgeBaseName, [...folderParts, item.title]),
      title: item.title,
      media_type: item.media_type,
      media_id: item.media_id,
      parent_folder_id: item.parent_folder_id || null,
      local_relative_path: localParts.join('/'),
      saved_path: savedPath,
    });
  }
}

async function runIndex(opts) {
  const knowledgeBaseName = opts.kb;
  if (!knowledgeBaseName) throw new Error('--kb is required');

  fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
  const knowledgeBaseId = findKnowledgeBaseId(knowledgeBaseName);
  const folderParts = splitPath(opts['source-path']);
  const folderId = resolveFolderPath(knowledgeBaseId, folderParts);
  const seen = existingIndexKeys();
  const collected = [];

  await collectFolderRecords(
    knowledgeBaseId,
    knowledgeBaseName,
    folderId,
    folderParts,
    opts,
    collected
  );

  const records = uniqueByMediaId(collected);
  if (records.length === 0) {
    throw new Error(`No PDFs found in source folder: ${opts['source-path'] || '(knowledge base root)'}`);
  }

  const stats = {
    seen: records.length,
    indexed: 0,
    skipped_existing_index: 0,
    snapshot: null,
    snapshot_written: 0,
  };

  for (const record of records) {
    if (seen.has(record.media_id)) {
      stats.skipped_existing_index += 1;
      continue;
    }
    appendJsonl(INDEX_PATH, record);
    seen.add(record.media_id);
    stats.indexed += 1;
  }

  if (opts.snapshot != null) {
    if (opts.snapshot === true || String(opts.snapshot).trim() === '') {
      throw new Error('--snapshot requires a path');
    }
    const snapshotPath = resolveRootPath(opts.snapshot);
    writeJsonlAtomic(snapshotPath, records);
    stats.snapshot = path.relative(ROOT, snapshotPath);
    stats.snapshot_written = records.length;
  }

  return stats;
}

function sourceMatches(record, requestedSourcePath) {
  if (!requestedSourcePath) return true;
  const normalized = requestedSourcePath.includes(' / ')
    ? requestedSourcePath
    : fullSourcePath(record.knowledge_base, splitPath(requestedSourcePath));
  return record.source_path === normalized || record.source_path.startsWith(`${normalized} / `);
}

function loadDownloadState() {
  const downloaded = readJsonl(DOWNLOADED_PATH);
  return {
    mediaIds: new Set(downloaded.map((record) => record.media_id).filter(Boolean)),
    savedPaths: new Set(downloaded.map((record) => record.saved_path).filter(Boolean)),
  };
}

async function downloadOne(record) {
  if (fs.existsSync(record.saved_path)) {
    const buffer = fs.readFileSync(record.saved_path);
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('existing file is not a PDF');
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    appendJsonl(DOWNLOADED_PATH, {
      downloaded_at: new Date().toISOString(),
      knowledge_base: record.knowledge_base,
      source_path: record.source_path,
      title: record.title,
      media_id: record.media_id,
      media_type: record.media_type,
      saved_path: record.saved_path,
      file_size_bytes: buffer.length,
      sha256,
      skipped_existing_file: true,
      request_id: null,
    });

    return { status: 'skipped_file_exists' };
  }

  const info = imaApi('openapi/wiki/v1/get_media_info', { media_id: record.media_id });
  const data = info.data || {};
  const urlInfo = data.url_info || {};
  if (!urlInfo.url) {
    throw new Error('get_media_info did not return url_info.url');
  }

  const response = await fetch(urlInfo.url, { headers: urlInfo.headers || {} });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('downloaded content is not a PDF');
  }

  fs.mkdirSync(path.dirname(record.saved_path), { recursive: true });
  const tempPath = `${record.saved_path}.part`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, record.saved_path);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  appendJsonl(DOWNLOADED_PATH, {
    downloaded_at: new Date().toISOString(),
    knowledge_base: record.knowledge_base,
    source_path: record.source_path,
    title: record.title,
    media_id: record.media_id,
    media_type: data.media_type ?? record.media_type,
    saved_path: record.saved_path,
    file_size_bytes: buffer.length,
    sha256,
    request_id: info.request_id || null,
  });

  return { status: 'downloaded', bytes: buffer.length };
}

async function runDownload(opts) {
  const knowledgeBaseName = opts.kb;
  if (!knowledgeBaseName) throw new Error('--kb is required');

  const state = loadDownloadState();
  const limit = opts.limit ? Number(opts.limit) : Infinity;
  if (!Number.isFinite(limit) && opts.limit) throw new Error('--limit must be a number');

  const records = readJsonl(INDEX_PATH)
    .filter((record) => record.knowledge_base === knowledgeBaseName)
    .filter((record) => sourceMatches(record, opts['source-path']))
    .filter((record) => !state.mediaIds.has(record.media_id))
    .filter((record) => !state.savedPaths.has(record.saved_path));

  const stats = {
    candidates: records.length,
    downloaded: 0,
    failed: 0,
    skipped_file_exists: 0,
    skipped_limit: 0,
  };

  let attempted = 0;
  for (const record of records) {
    if (attempted >= limit) {
      stats.skipped_limit += 1;
      continue;
    }
    attempted += 1;

    try {
      const result = await downloadOne(record);
      if (result.status === 'downloaded') stats.downloaded += 1;
      if (result.status === 'skipped_file_exists') stats.skipped_file_exists += 1;
    } catch (err) {
      stats.failed += 1;
      appendJsonl(FAILED_PATH, {
        failed_at: new Date().toISOString(),
        knowledge_base: record.knowledge_base,
        source_path: record.source_path,
        title: record.title,
        media_id: record.media_id,
        media_type: record.media_type,
        saved_path: record.saved_path,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return stats;
}

async function runRankAi(opts) {
  if (!opts['summary-source']) {
    throw new Error('rank-ai requires --summary-source; title-only ranking has been removed');
  }
  if (!opts.queue) throw new Error('rank-ai requires --queue');
  return runRankAiSummary(opts);
}

async function runRankAiSummary(opts) {
  const summaryPath = resolveRootPath(opts['summary-source']);
  const queuePath = resolveRootPath(opts.queue);
  const batchSize = parsePositiveInteger(opts['batch-size'], '--batch-size', 12);
  const allSummaries = uniqueByMediaId(readJsonl(summaryPath));
  const reviewed = allSummaries.filter((record) =>
    record.status === 'reviewed' &&
    record.summary_role === 'routing_candidate' &&
    record.source_match === true &&
    String(record.executive_summary || '').trim() !== ''
  );
  const unreviewed = allSummaries.filter((record) => !reviewed.includes(record));
  const config = reviewed.length > 0 ? deepSeekConfig({
    modelEnv: 'DEEPSEEK_RANK_MODEL',
    fallbackModelEnv: 'DEEPSEEK_RERANK_MODEL',
    defaultModel: 'deepseek-v4-flash',
  }) : null;

  const rankedAt = new Date().toISOString();
  const queue = [];
  const totalBatches = Math.ceil(reviewed.length / batchSize);
  for (let index = 0; index < reviewed.length; index += batchSize) {
    const batch = reviewed.slice(index, index + batchSize);
    const batchNumber = Math.floor(index / batchSize) + 1;
    if (shouldLogProgress(opts)) {
      process.stderr.write(`[rank-ai] classifying batch ${batchNumber}/${totalBatches} (${batch.length} records)\n`);
    }
    const rankings = await classifyBatchWithDeepSeek(config, batch);
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      queue.push({
        ...batch[batchIndex],
        priority: rankings[batchIndex].priority,
        score: rankings[batchIndex].score,
        report_type: rankings[batchIndex].report_type,
        report_type_reason: rankings[batchIndex].report_type_reason,
        sectors: rankings[batchIndex].sectors,
        classification_source: rankings[batchIndex].classification_source,
        classification_warnings: rankings[batchIndex].classification_warnings,
        topics: rankings[batchIndex].topics,
        reasons: rankings[batchIndex].reasons,
        ranking_evidence: rankings[batchIndex].evidence,
        false_positive_checks: rankings[batchIndex].false_positive_checks,
        ranking_mode: 'single_summary_pass',
        llm_provider: 'deepseek',
        llm_model: config.model,
        ranked_at: rankedAt,
      });
    }
  }
  queue.sort((a, b) => {
    const priorityDelta = PRIORITY_ORDER.get(a.priority) - PRIORITY_ORDER.get(b.priority);
    if (priorityDelta !== 0) return priorityDelta;
    if (b.score !== a.score) return b.score - a.score;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
  });
  queue.forEach((record, index) => { record.rank = index + 1; });
  writeJsonlAtomic(queuePath, queue);

  const byPriority = {};
  for (const record of queue) byPriority[record.priority] = (byPriority[record.priority] || 0) + 1;
  return {
    mode: 'single_summary_pass',
    ranking_passes: 1,
    summary_source: path.relative(ROOT, summaryPath),
    queue: path.relative(ROOT, queuePath),
    reviewed: reviewed.length,
    unreviewed: unreviewed.length,
    written: queue.length,
    by_priority: byPriority,
    llm_provider: config ? 'deepseek' : null,
    llm_model: config ? config.model : null,
  };
}

async function runDownloadQueue(opts) {
  const knowledgeBaseName = opts.kb;
  if (!knowledgeBaseName) throw new Error('--kb is required');
  if (!opts.queue) throw new Error('download-queue requires --queue');

  const queuePath = resolveRootPath(opts.queue);
  const priorities = parsePriorities(opts.priorities);
  const dailyBudget = parseNonNegativeInteger(opts['daily-budget'], '--daily-budget', 30);
  const quotaProbeExtra = parseNonNegativeInteger(
    opts['quota-probe-extra'],
    '--quota-probe-extra',
    0,
  );
  const state = loadDownloadState();
  const quotaState = loadDailyQuotaState(knowledgeBaseName);
  const queue = readJsonl(queuePath)
    .filter((record) => record.knowledge_base === knowledgeBaseName)
    .filter((record) => priorities.has(String(record.priority || '').toUpperCase()))
    .filter((record) => !state.mediaIds.has(record.media_id))
    .filter((record) => !state.savedPaths.has(record.saved_path))
    .sort(compareDownloadPriority);

  const stats = {
    candidates: queue.length,
    attempted: 0,
    budget_used: 0,
    daily_budget: dailyBudget,
    daily_used_at_start: quotaState.used,
    daily_used_at_end: quotaState.used,
    daily_budget_remaining_at_start: Math.max(0, dailyBudget - quotaState.used),
    quota_probe_extra: quotaProbeExtra,
    probe_attempted: 0,
    probe_succeeded: false,
    probe_quota_rejected: false,
    quota_may_have_increased: false,
    downloaded: 0,
    failed: 0,
    skipped_file_exists: 0,
    attempted_by_priority: {},
    downloaded_by_priority: {},
    stopped_budget: false,
    stopped_probe_limit: false,
    stopped_quota: false,
    quota_error: null,
  };
  let dailyUsed = quotaState.used;

  for (const record of queue) {
    const willConsumeBudget = !fs.existsSync(record.saved_path);
    let quotaSlot = null;
    if (willConsumeBudget) {
      quotaSlot = classifyQuotaSlot(dailyUsed, dailyBudget, quotaProbeExtra);
      if (quotaSlot === 'stop') {
        stats.stopped_budget = dailyUsed >= dailyBudget && quotaProbeExtra === 0;
        stats.stopped_probe_limit = dailyUsed >= dailyBudget + quotaProbeExtra && quotaProbeExtra > 0;
        break;
      }

      const attemptId = crypto.randomUUID();
      appendJsonl(DOWNLOAD_ATTEMPTS_PATH, {
        kind: 'download_attempt',
        attempt_id: attemptId,
        attempted_at: new Date().toISOString(),
        date: quotaState.date,
        knowledge_base: knowledgeBaseName,
        media_id: record.media_id,
        title: record.title,
        priority: record.priority,
        quota_slot: quotaSlot,
      });
      dailyUsed += 1;
      stats.daily_used_at_end = dailyUsed;
      if (quotaSlot === 'budget') stats.budget_used += 1;
      if (quotaSlot === 'probe') stats.probe_attempted += 1;
    }

    stats.attempted += 1;
    const priority = String(record.priority || 'UNKNOWN').toUpperCase();
    stats.attempted_by_priority[priority] = (stats.attempted_by_priority[priority] || 0) + 1;
    try {
      const result = await downloadOne(record);
      if (result.status === 'downloaded') {
        stats.downloaded += 1;
        stats.downloaded_by_priority[priority] = (stats.downloaded_by_priority[priority] || 0) + 1;
        if (quotaSlot === 'probe') {
          stats.probe_succeeded = true;
          stats.quota_may_have_increased = true;
        }
      }
      if (result.status === 'skipped_file_exists') stats.skipped_file_exists += 1;
    } catch (err) {
      stats.failed += 1;
      appendJsonl(FAILED_PATH, {
        failed_at: new Date().toISOString(),
        knowledge_base: record.knowledge_base,
        source_path: record.source_path,
        title: record.title,
        media_id: record.media_id,
        media_type: record.media_type,
        saved_path: record.saved_path,
        priority: record.priority,
        rank: record.rank,
        error: err && err.message ? err.message : String(err),
      });

      if (isQuotaError(err)) {
        stats.stopped_quota = true;
        stats.quota_error = err && err.message ? err.message : String(err);
        if (quotaSlot === 'probe') stats.probe_quota_rejected = true;
        break;
      }
    }

    if (quotaSlot === 'probe') {
      stats.stopped_probe_limit = true;
      break;
    }
  }

  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['index', 'download', 'sync', 'rank-ai', 'download-queue'].includes(opts.command)) {
    usage();
    process.exit(opts.command ? 1 : 0);
  }

  if (opts.command === 'index') {
    console.log(JSON.stringify({ command: 'index', ...(await runIndex(opts)) }));
    return;
  }

  if (opts.command === 'download') {
    console.log(JSON.stringify({ command: 'download', ...(await runDownload(opts)) }));
    return;
  }

  if (opts.command === 'rank-ai') {
    console.log(JSON.stringify({ command: 'rank-ai', ...(await runRankAi(opts)) }));
    return;
  }

  if (opts.command === 'download-queue') {
    console.log(JSON.stringify({ command: 'download-queue', ...(await runDownloadQueue(opts)) }));
    return;
  }

  const indexed = await runIndex(opts);
  const downloaded = await runDownload(opts);
  console.log(JSON.stringify({ command: 'sync', indexed, downloaded }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  classifyQuotaSlot,
  compareDownloadPriority,
  loadDailyQuotaState,
  rankingSystemPrompt,
  runRankAi,
  shanghaiDateKey,
  REPORT_TYPES,
  SECTORS_CN_TO_EN,
  MAX_SECTORS,
  normalizeClassification,
  normalizeRanking,
  classifyBatchWithDeepSeek,
};
