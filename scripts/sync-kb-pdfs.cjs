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
const DEFAULT_QUEUE_PATH = path.join(MANIFESTS_DIR, 'ai-ranked-queue.jsonl');
const PDF_MEDIA_TYPE = 1;
const FOLDER_MEDIA_TYPE = 99;
const PRIORITY_ORDER = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);

function usage() {
  console.log(`Usage:
  node scripts/sync-kb-pdfs.cjs index --kb <name> [--source-path <path>] [--strip-source-prefix <path>] [--local-prefix <path>] [--snapshot <path>]
  node scripts/sync-kb-pdfs.cjs download --kb <name> [--source-path <path>] [--limit <n>]
  node scripts/sync-kb-pdfs.cjs sync --kb <name> [--source-path <path>] [--strip-source-prefix <path>] [--local-prefix <path>] [--limit <n>]
  node scripts/sync-kb-pdfs.cjs rank-ai [--months <month1,month2>] [--queue <path>] [--batch-size <n>] [--rerank-batch-size <n>]
  node scripts/sync-kb-pdfs.cjs rank-ai --summary-source <summaries.jsonl> --queue <queue.jsonl> [--baseline-queue <queue.jsonl>] [--comparison <comparison.jsonl>]
  node scripts/sync-kb-pdfs.cjs download-queue --kb <name> [--queue <path>] [--priorities <P0,P1>] [--daily-budget <n>]

Examples:
  node scripts/sync-kb-pdfs.cjs sync --kb "环球研报直通车" --source-path "2026年国际顶级投行研报/7月" --strip-source-prefix "2026年国际顶级投行研报" --local-prefix "2026"
  node scripts/sync-kb-pdfs.cjs download --kb "环球研报直通车" --source-path "环球研报直通车 / 2026年国际顶级投行研报 / 7月"
  node scripts/sync-kb-pdfs.cjs rank-ai --months "2026/6月,2026/7月" --queue manifests/ai-ranked-queue.jsonl
  node scripts/sync-kb-pdfs.cjs download-queue --kb "环球研报直通车" --queue manifests/ai-ranked-queue.jsonl --priorities P0,P1 --daily-budget 28`);
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

function parseMonths(input) {
  return parseCommaList(input, '2026/6月,2026/7月');
}

function recordMatchesMonths(record, months) {
  return months.some((month) => (record.local_relative_path || '').startsWith(`${month}/`));
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

function dateRank(record) {
  const match = (record.local_relative_path || '').match(/^(\d{4})\/(\d+)月\/(\d+(?:\.\d+)?)\//);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3].replace('.', ''));
  return year * 10000 + month * 100 + day;
}

function isQuotaError(err) {
  const message = err && err.message ? err.message : String(err || '');
  return /资料获取次数已达上限|请明天再尝试|请求频控|频控|quota|rate limit/i.test(message);
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
  const modelEnv = overrides.modelEnv || 'DEEPSEEK_MODEL';
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: overrides.model || process.env[modelEnv] || overrides.defaultModel || 'deepseek-v4-flash',
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
  return `你是买方科技研究助理，只根据研报 PDF 标题和路径做 AI Infrastructure 主题的第一轮广义召回。

输出必须是严格 JSON object，格式：
{"results":[{"priority":"P0|P1|P2|P3","score":0-100,"topics":["..."],"reasons":["..."]}]}

results 必须与输入数组等长、同顺序。不要输出 markdown，不要解释 JSON 以外内容。

第一轮目标是提高召回率，宁可把可能相关的候选放入 P0/P1，后续会有第二轮严格复核。理由仍必须基于标题或路径中的词语，不要只用公司名、ticker 或行业常识作为决定性证据。

优先级定义：
P0 = 核心 AI Infrastructure：AIDC/AI 数据中心 capex、云或 hyperscaler 数据中心资本开支、AI 服务器、GPU、ASIC、HBM、存储、先进封装、CoWoS、光互联、数据中心网络、电力、冷却、液冷、AI 半导体上游、人形机器人或具身智能核心硬件。明确 AIDC capex / AI 数据中心资本开支必须 P0。
P1 = 强相关上游或投资线索：半导体设备/材料、晶圆厂扩产、ABF、PCB、MLCC、AI PC、明确指向 AI 基建/数据中心/云 capex 的 IT 支出、机器人或 AI 产能相关工业自动化。
P2 = 泛 AI 或间接主题：AI 应用、企业 AI 渗透率、互联网或云应用、AI 生产率、科技硬件但基建指向不强。
P3 = 弱相关或无关：宏观、地产、医疗、消费、银行、普通汽车销量、普通互联网估值等。

score 代表下载优先级，P0 通常 85-100，P1 通常 65-84，P2 通常 35-64，P3 通常 0-34。
topics 使用英文短标签，如 aidc_capex, ai_server, semiconductor_upstream, optical_interconnect, hbm_memory, advanced_packaging, data_center_power, humanoid_robotics, ai_pc, ai_application, unrelated。`;
}

function rerankingSystemPrompt() {
  return `你是严谨的买方科技研究审稿人，负责对第一轮召回出的 AI Infrastructure 候选研报做第二轮严格复核和重排。

你仍然只能使用标题和路径，不读取 PDF 正文。不要针对任何单一公司写特殊规则；请用统一的证据标准判断。

输出必须是严格 JSON object，格式：
{"results":[{"corrected_priority":"P0|P1|P2|P3","final_score":0-100,"topics":["..."],"reasons":["..."],"evidence_keywords":["..."],"evidence_level":"explicit|indirect|weak|none","downgrade_reasons":["..."]}]}

results 必须与输入数组等长、同顺序。不要输出 markdown，不要解释 JSON 以外内容。

复核原则：
1. 证据优先：P0 必须能从标题或路径看到 AI 基建技术支出、算力硬件、半导体上游、光互联、数据中心网络、电力/冷却、AI PC、人形机器人/具身智能核心硬件等明确信号。
2. 区分“基础设施载体”和“技术资本开支”：只说明数据中心、房地产、信托、租赁、收购、评级、目标价、估值、买入卖出等金融或资产观点时，不应给很高分；如果同时出现 AI capex、GPU、服务器、芯片、光模块、液冷、电力容量、hyperscaler 扩建等标题证据，可以保留较高优先级。
3. 避免常识幻觉：不要仅凭公司名、ticker、所属行业、你知道这家公司做什么，就把报告提升到 P0。理由必须指出标题或路径中的证据词；证据弱时要主动降权。
4. 排序校准：P0 通常 85-100；P1 通常 65-84；P2 通常 35-64；P3 通常 0-34。证据强度不足时，即使第一轮是 P0，也可降为 P1/P2/P3。
5. AIDC capex、AI 数据中心资本开支、云/超大规模数据中心 capex、AI 服务器、GPU/ASIC、HBM、先进封装/CoWoS、光互联、数据中心网络、电力/冷却、AI 半导体上游、人形机器人/具身智能核心硬件是高优先级方向；但必须由标题或路径支持。`;
}

function summaryRankingSystemPrompt() {
  return `你是严谨的买方科技研究审稿人。请只根据输入中的研报标题、报告类型、通用摘要、关键结论、内容标签、关键数据、实体和正文证据，对 AI Infrastructure 投资研究价值做正文优先排序。

输出必须是严格 JSON object：
{"results":[{"priority":"P0|P1|P2|P3","score":0-100,"topics":["..."],"reasons":["..."],"evidence":["..."],"false_positive_checks":["..."]}]}

results 必须与输入数组等长、同顺序。不要输出 markdown，不要使用公司常识补充输入中不存在的信息。

P0（85-100）：正文明确以 AI 数据中心资本开支、AI 服务器/GPU/ASIC/HBM/先进封装、数据中心光互联/网络、电力/冷却或人形机器人核心硬件为主要投资逻辑。
P1（65-84）：正文有明确、可投资的 AI 基建需求、供给、价格、产能或业绩传导证据，但不是全文唯一主线；也包括强相关半导体设备材料、PCB、光纤光缆、工业自动化。
P2（35-64）：正文仅有泛 AI、应用或间接敞口，缺少清晰基建传导。
P3（0-34）：正文没有实质 AI 基建证据，或只是普通宏观、消费、金融、医药、地产、汽车等。

通用摘要、关键数据、实体都是尚未经过 PDF 级正式验证的路由候选；排序时优先依赖 evidence 的原文连续摘录，并把候选字段仅用于定位和辅助理解。
必须在 reasons/evidence 中引用输入给出的具体事实或数字。标题与正文冲突时以正文为准。存在“数据中心”但实际只是地产/租赁/并购时主动检查假阳性。`;
}

async function classifyBatchWithDeepSeek(config, batch) {
  const inputs = batch.map((record) => ({
    title: record.title,
    source_path: record.source_path,
    local_relative_path: record.local_relative_path,
  }));

  const parsed = await callDeepSeekJson(config, [
    { role: 'system', content: rankingSystemPrompt() },
    {
      role: 'user',
      content: `请分类以下研报，返回 results 与输入同顺序、同长度：\n${JSON.stringify(inputs, null, 2)}`,
    },
  ]);

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('LLM JSON must contain a results array');
  }
  if (parsed.results.length !== batch.length) {
    throw new Error(`LLM returned ${parsed.results.length} results for ${batch.length} inputs`);
  }

  return parsed.results.map((result, index) => normalizeRanking(result, batch[index]));
}

async function rerankBatchWithDeepSeek(config, batch) {
  const inputs = batch.map((record) => ({
    title: record.title,
    source_path: record.source_path,
    local_relative_path: record.local_relative_path,
    recall_priority: record.priority,
    recall_score: record.score,
    recall_topics: record.topics,
    recall_reasons: record.reasons,
  }));

  const parsed = await callDeepSeekJson(config, [
    { role: 'system', content: rerankingSystemPrompt() },
    {
      role: 'user',
      content: `请严格复核以下第一轮候选，返回 results 与输入同顺序、同长度：\n${JSON.stringify(inputs, null, 2)}`,
    },
  ]);

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('Rerank LLM JSON must contain a results array');
  }
  if (parsed.results.length !== batch.length) {
    throw new Error(`Rerank LLM returned ${parsed.results.length} results for ${batch.length} inputs`);
  }

  return parsed.results.map((result, index) => normalizeReranking(result, batch[index]));
}

async function classifySummaryBatchWithDeepSeek(config, batch) {
  const inputs = batch.map((record) => ({
    media_id: record.media_id,
    title: record.title,
    report_type: record.report_type,
    research_subject: record.research_subject,
    executive_summary: record.executive_summary,
    key_findings: record.key_findings,
    content_tags: record.content_tags,
    data_points: record.data_points,
    entities: record.entities,
    evidence: record.evidence,
  }));
  const parsed = await callDeepSeekJson(config, [
    { role: 'system', content: summaryRankingSystemPrompt() },
    {
      role: 'user',
      content: `请按正文证据排序以下研报，返回 results 与输入同顺序、同长度：\n${JSON.stringify(inputs, null, 2)}`,
    },
  ]);
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
    throw new Error(`Summary rank LLM returned ${parsed && Array.isArray(parsed.results) ? parsed.results.length : 0} results for ${batch.length} inputs`);
  }
  return parsed.results.map((result, index) => ({
    ...normalizeRanking(result, batch[index]),
    evidence: normalizeStringArray(result.evidence, []),
    false_positive_checks: normalizeStringArray(result.false_positive_checks, []),
  }));
}

function normalizeStringArray(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
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
  return {
    priority,
    score: Math.max(0, Math.min(100, Math.round(score))),
    topics: normalizeStringArray(result.topics, []),
    reasons: normalizeStringArray(result.reasons || result.reason, []),
  };
}

function normalizeReranking(result, record) {
  const priority = String(result.corrected_priority || result.priority || '').toUpperCase();
  if (!PRIORITY_ORDER.has(priority)) {
    throw new Error(`Rerank LLM returned invalid priority for ${record.title}: ${result.corrected_priority || result.priority}`);
  }
  const score = Number(result.final_score ?? result.score);
  if (!Number.isFinite(score)) {
    throw new Error(`Rerank LLM returned invalid score for ${record.title}: ${result.final_score ?? result.score}`);
  }
  const evidenceLevel = String(result.evidence_level || '').toLowerCase();
  return {
    priority,
    score: Math.max(0, Math.min(100, Math.round(score))),
    topics: normalizeStringArray(result.topics, record.topics || []),
    reasons: normalizeStringArray(result.reasons || result.reason, record.reasons || []),
    evidence_keywords: normalizeStringArray(result.evidence_keywords || result.evidence, []),
    evidence_level: ['explicit', 'indirect', 'weak', 'none'].includes(evidenceLevel) ? evidenceLevel : '',
    downgrade_reasons: normalizeStringArray(result.downgrade_reasons || result.penalty_applied, []),
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
  if (opts['summary-source']) return runRankAiSummary(opts);
  const months = parseMonths(opts.months);
  const queuePath = resolveRootPath(opts.queue, DEFAULT_QUEUE_PATH);
  const batchSize = parsePositiveInteger(opts['batch-size'], '--batch-size', 40);
  const rerankBatchSize = parsePositiveInteger(opts['rerank-batch-size'], '--rerank-batch-size', batchSize);
  const config = deepSeekConfig({ defaultModel: 'deepseek-v4-flash' });
  const rerankConfig = deepSeekConfig({
    modelEnv: 'DEEPSEEK_RERANK_MODEL',
    defaultModel: 'deepseek-v4-pro',
  });

  const records = uniqueByMediaId(
    readJsonl(INDEX_PATH)
      .filter((record) => sourceMatches(record, opts['source-path']))
      .filter((record) => recordMatchesMonths(record, months))
  );

  if (records.length === 0) {
    throw new Error(`No indexed PDFs matched months: ${months.join(', ')}`);
  }

  const rankedAt = new Date().toISOString();
  const recallQueue = [];
  const totalBatches = Math.ceil(records.length / batchSize);
  const logProgress = shouldLogProgress(opts);
  for (let index = 0; index < records.length; index += batchSize) {
    const batch = records.slice(index, index + batchSize);
    const batchNumber = Math.floor(index / batchSize) + 1;
    if (logProgress) {
      process.stderr.write(`[rank-ai] classifying batch ${batchNumber}/${totalBatches} (${batch.length} records)\n`);
    }
    const rankings = await classifyBatchWithDeepSeek(config, batch);
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      recallQueue.push({
        ...batch[batchIndex],
        priority: rankings[batchIndex].priority,
        rank: 0,
        score: rankings[batchIndex].score,
        topics: rankings[batchIndex].topics,
        reasons: rankings[batchIndex].reasons,
        llm_provider: 'deepseek',
        llm_model: config.model,
        ranked_at: rankedAt,
        recall_priority: rankings[batchIndex].priority,
        recall_score: rankings[batchIndex].score,
        recall_topics: rankings[batchIndex].topics,
        recall_reasons: rankings[batchIndex].reasons,
        recall_llm_model: config.model,
      });
    }
    if (logProgress) {
      process.stderr.write(`[rank-ai] completed batch ${batchNumber}/${totalBatches}\n`);
    }
  }

  const rerankCandidates = recallQueue.filter((record) => record.priority === 'P0' || record.priority === 'P1');
  const totalRerankBatches = Math.ceil(rerankCandidates.length / rerankBatchSize);
  for (let index = 0; index < rerankCandidates.length; index += rerankBatchSize) {
    const batch = rerankCandidates.slice(index, index + rerankBatchSize);
    const batchNumber = Math.floor(index / rerankBatchSize) + 1;
    if (logProgress) {
      process.stderr.write(`[rank-ai] reranking batch ${batchNumber}/${totalRerankBatches} (${batch.length} records)\n`);
    }
    const rerankings = await rerankBatchWithDeepSeek(rerankConfig, batch);
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const record = batch[batchIndex];
      const reranking = rerankings[batchIndex];
      record.priority = reranking.priority;
      record.score = reranking.score;
      record.topics = reranking.topics;
      record.reasons = reranking.reasons;
      record.evidence_keywords = reranking.evidence_keywords;
      record.evidence_level = reranking.evidence_level;
      record.downgrade_reasons = reranking.downgrade_reasons;
      record.rerank_changed = record.priority !== record.recall_priority || record.score !== record.recall_score;
      record.rerank_llm_model = rerankConfig.model;
      record.llm_model = `${config.model}+${rerankConfig.model}`;
    }
    if (logProgress) {
      process.stderr.write(`[rank-ai] completed rerank batch ${batchNumber}/${totalRerankBatches}\n`);
    }
  }

  const queue = recallQueue;
  queue.sort((a, b) => {
    const priorityDelta = PRIORITY_ORDER.get(a.priority) - PRIORITY_ORDER.get(b.priority);
    if (priorityDelta !== 0) return priorityDelta;
    if (b.score !== a.score) return b.score - a.score;
    const dateDelta = dateRank(b) - dateRank(a);
    if (dateDelta !== 0) return dateDelta;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
  });
  queue.forEach((record, index) => {
    record.rank = index + 1;
  });

  writeJsonlAtomic(queuePath, queue);

  const byPriority = {};
  for (const record of queue) {
    byPriority[record.priority] = (byPriority[record.priority] || 0) + 1;
  }

  return {
    months,
    queue: path.relative(ROOT, queuePath),
    candidates: records.length,
    written: queue.length,
    by_priority: byPriority,
    llm_provider: 'deepseek',
    llm_model: `${config.model}+${rerankConfig.model}`,
    recall_llm_model: config.model,
    rerank_llm_model: rerankConfig.model,
    rerank_candidates: rerankCandidates.length,
  };
}

async function runRankAiSummary(opts) {
  const summaryPath = resolveRootPath(opts['summary-source']);
  const queuePath = resolveRootPath(opts.queue);
  const comparisonPath = opts.comparison ? resolveRootPath(opts.comparison) : null;
  const baselinePath = opts['baseline-queue'] ? resolveRootPath(opts['baseline-queue']) : null;
  const batchSize = parsePositiveInteger(opts['batch-size'], '--batch-size', 12);
  const allSummaries = uniqueByMediaId(readJsonl(summaryPath));
  const reviewed = allSummaries.filter((record) =>
    record.status === 'reviewed' &&
    record.summary_role === 'routing_candidate' &&
    Array.isArray(record.evidence) &&
    record.evidence.length > 0
  );
  const unreviewed = allSummaries.filter((record) => !reviewed.includes(record));
  const config = reviewed.length > 0 ? deepSeekConfig({
    modelEnv: 'DEEPSEEK_RERANK_MODEL',
    defaultModel: 'deepseek-v4-pro',
  }) : null;

  const rankedAt = new Date().toISOString();
  const queue = [];
  const totalBatches = Math.ceil(reviewed.length / batchSize);
  for (let index = 0; index < reviewed.length; index += batchSize) {
    const batch = reviewed.slice(index, index + batchSize);
    const batchNumber = Math.floor(index / batchSize) + 1;
    if (shouldLogProgress(opts)) {
      process.stderr.write(`[rank-ai-summary] classifying batch ${batchNumber}/${totalBatches} (${batch.length} records)\n`);
    }
    const rankings = await classifySummaryBatchWithDeepSeek(config, batch);
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      queue.push({
        ...batch[batchIndex],
        priority: rankings[batchIndex].priority,
        score: rankings[batchIndex].score,
        topics: rankings[batchIndex].topics,
        reasons: rankings[batchIndex].reasons,
        ranking_evidence: rankings[batchIndex].evidence,
        false_positive_checks: rankings[batchIndex].false_positive_checks,
        ranking_mode: 'summary',
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

  if (comparisonPath) {
    const baseline = new Map((baselinePath ? readJsonl(baselinePath) : []).map((record) => [record.media_id, record]));
    const content = new Map(queue.map((record) => [record.media_id, record]));
    const comparison = allSummaries.map((summary) => {
      const oldRecord = baseline.get(summary.media_id);
      const newRecord = content.get(summary.media_id);
      return {
        media_id: summary.media_id,
        title: summary.title,
        status: newRecord ? 'reviewed' : 'UNREVIEWED',
        old_priority: oldRecord ? oldRecord.priority : null,
        old_score: oldRecord ? oldRecord.score : null,
        old_reasons: oldRecord ? oldRecord.reasons : [],
        new_priority: newRecord ? newRecord.priority : 'UNREVIEWED',
        new_score: newRecord ? newRecord.score : null,
        new_reasons: newRecord ? newRecord.reasons : [],
        summary_evidence: newRecord ? newRecord.ranking_evidence : [],
        priority_delta: oldRecord && newRecord
          ? PRIORITY_ORDER.get(oldRecord.priority) - PRIORITY_ORDER.get(newRecord.priority)
          : null,
      };
    });
    writeJsonlAtomic(comparisonPath, comparison);
  }

  const byPriority = {};
  for (const record of queue) byPriority[record.priority] = (byPriority[record.priority] || 0) + 1;
  return {
    mode: 'summary',
    summary_source: path.relative(ROOT, summaryPath),
    queue: path.relative(ROOT, queuePath),
    comparison: comparisonPath ? path.relative(ROOT, comparisonPath) : null,
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

  const queuePath = resolveRootPath(opts.queue, DEFAULT_QUEUE_PATH);
  const priorities = parsePriorities(opts.priorities);
  const dailyBudget = parseNonNegativeInteger(opts['daily-budget'], '--daily-budget', 28);
  const state = loadDownloadState();
  const queue = readJsonl(queuePath)
    .filter((record) => record.knowledge_base === knowledgeBaseName)
    .filter((record) => priorities.has(String(record.priority || '').toUpperCase()))
    .filter((record) => !state.mediaIds.has(record.media_id))
    .filter((record) => !state.savedPaths.has(record.saved_path))
    .sort((a, b) => Number(a.rank || Infinity) - Number(b.rank || Infinity));

  const stats = {
    candidates: queue.length,
    attempted: 0,
    budget_used: 0,
    downloaded: 0,
    failed: 0,
    skipped_file_exists: 0,
    stopped_budget: false,
    stopped_quota: false,
    quota_error: null,
  };

  for (const record of queue) {
    const willConsumeBudget = !fs.existsSync(record.saved_path);
    if (willConsumeBudget && stats.budget_used >= dailyBudget) {
      stats.stopped_budget = true;
      break;
    }

    stats.attempted += 1;
    try {
      const result = await downloadOne(record);
      if (willConsumeBudget) stats.budget_used += 1;
      if (result.status === 'downloaded') stats.downloaded += 1;
      if (result.status === 'skipped_file_exists') stats.skipped_file_exists += 1;
    } catch (err) {
      if (willConsumeBudget) stats.budget_used += 1;
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
        break;
      }
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

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
