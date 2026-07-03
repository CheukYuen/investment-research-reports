#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IMA_API = path.join(ROOT, 'ima-skill', 'ima_api.cjs');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const INDEX_PATH = path.join(MANIFESTS_DIR, 'index.jsonl');
const DOWNLOADED_PATH = path.join(MANIFESTS_DIR, 'downloaded.jsonl');
const FAILED_PATH = path.join(MANIFESTS_DIR, 'failed.jsonl');
const PDF_MEDIA_TYPE = 1;
const FOLDER_MEDIA_TYPE = 99;

function usage() {
  console.log(`Usage:
  node scripts/sync-kb-pdfs.cjs index --kb <name> [--source-path <path>] [--strip-source-prefix <path>] [--local-prefix <path>]
  node scripts/sync-kb-pdfs.cjs download --kb <name> [--source-path <path>] [--limit <n>]
  node scripts/sync-kb-pdfs.cjs sync --kb <name> [--source-path <path>] [--strip-source-prefix <path>] [--local-prefix <path>] [--limit <n>]

Examples:
  node scripts/sync-kb-pdfs.cjs sync --kb "环球研报直通车" --source-path "2026年国际顶级投行研报/7月" --strip-source-prefix "2026年国际顶级投行研报" --local-prefix "2026"
  node scripts/sync-kb-pdfs.cjs download --kb "环球研报直通车" --source-path "环球研报直通车 / 2026年国际顶级投行研报 / 7月"`);
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

function imaApi(apiPath, body) {
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
    throw new Error(msg.trim());
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`ima_api returned invalid JSON: ${err.message}`);
  }

  if (response.code !== 0) {
    throw new Error(response.msg || `IMA API business error: ${response.code}`);
  }

  return response;
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

async function indexFolder(knowledgeBaseId, knowledgeBaseName, folderId, folderParts, opts, seen, stats) {
  const items = listFolderAll(knowledgeBaseId, folderId);

  for (const item of items) {
    if (item.media_type === FOLDER_MEDIA_TYPE) {
      await indexFolder(knowledgeBaseId, knowledgeBaseName, item.media_id, [...folderParts, item.title], opts, seen, stats);
      continue;
    }

    const isPdf = item.media_type === PDF_MEDIA_TYPE || /\.pdf$/i.test(item.title || '');
    if (!isPdf) continue;

    const localParts = localPartsFromSource(folderParts, item.title, opts);
    const savedPath = path.join(DOWNLOADS_DIR, ...localParts);
    const record = {
      indexed_at: new Date().toISOString(),
      knowledge_base: knowledgeBaseName,
      source_path: fullSourcePath(knowledgeBaseName, [...folderParts, item.title]),
      title: item.title,
      media_type: item.media_type,
      media_id: item.media_id,
      parent_folder_id: item.parent_folder_id || null,
      local_relative_path: localParts.join('/'),
      saved_path: savedPath,
    };

    stats.seen += 1;
    if (seen.has(item.media_id)) {
      stats.skipped_existing_index += 1;
      continue;
    }

    appendJsonl(INDEX_PATH, record);
    seen.add(item.media_id);
    stats.indexed += 1;
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
  const stats = { seen: 0, indexed: 0, skipped_existing_index: 0 };

  await indexFolder(knowledgeBaseId, knowledgeBaseName, folderId, folderParts, opts, seen, stats);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['index', 'download', 'sync'].includes(opts.command)) {
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

  const indexed = await runIndex(opts);
  const downloaded = await runDownload(opts);
  console.log(JSON.stringify({ command: 'sync', indexed, downloaded }));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
