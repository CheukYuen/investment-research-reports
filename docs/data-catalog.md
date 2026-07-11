# investment-research-archive 数据说明

本文档说明本项目当前沉淀了哪些数据、数据放在哪里、各 JSONL 文件的字段含义，以及其他项目应该如何引用这些数据。

## 数据范围

`investment-research-archive` 用于同步、归档腾讯 ima 知识库中的 PDF 研报。目前主要数据来自知识库：

- `环球研报直通车`

数据类型包括：

- PDF 原文文件：保存在 `downloads/`
- 知识库 PDF 索引：保存在 `manifests/index.jsonl`
- 下载成功/失败事件日志：保存在 `manifests/downloaded.jsonl`、`manifests/failed.jsonl`
- AI Infrastructure 主题排序队列：保存在 `manifests/ai-ranked-queue*.jsonl`
- P0/P1 人工查看页面：保存在 `manifests/ai-p0p1-analysis*.html`

当前快照（2026-07-06）：

- `manifests/index.jsonl`：2242 条 PDF 索引记录
- 已下载 PDF：62 份，约 268MB
- `manifests/ai-ranked-queue.jsonl`：42 条 AI Infrastructure 排序记录，其中 P0 5 条、P1 5 条、P2 6 条、P3 26 条
- 当前索引月份：`2026/6月`、`2026/7月`

## 目录结构

```text
downloads/
  2026/
    6月/
    7月/
      7.6/
        <原始研报文件名>.pdf

manifests/
  index.jsonl
  downloaded.jsonl
  failed.jsonl
  ai-ranked-queue.jsonl
  ai-ranked-queue-YYYYMMDD.jsonl
  ai-p0p1-analysis.html
  ai-p0p1-analysis-YYYYMMDD.html
```

项目约定保留 ima 知识库中的原始目录结构和原始文件名。其他项目引用 PDF 时，推荐使用：

```text
<repo-root>/downloads/<local_relative_path>
```

不要把 `saved_path` 当作跨机器稳定路径；它是当前机器上的绝对路径。跨项目、跨机器、CI 或容器环境中，应优先读取 `local_relative_path`，再按自己的 repo 根目录拼出实际文件路径。

## 核心数据集

### `downloads/`

PDF 原文文件目录。文件名保持知识库原始文件名，目录结构来自知识库路径。

适合用途：

- PDF 原文阅读
- 文本抽取、OCR、embedding、RAG 入库
- 与 `downloaded.jsonl` 中的 `sha256` 做完整性校验

引用方式：

```js
const pdfPath = path.join(repoRoot, 'downloads', record.local_relative_path);
```

### `manifests/index.jsonl`

知识库 PDF 索引，是其他项目发现“知识库里有哪些 PDF”的主要入口。每行是一条 JSON 记录。

字段：

| 字段 | 含义 |
| --- | --- |
| `indexed_at` | 索引写入时间，ISO 8601 |
| `knowledge_base` | 知识库名称 |
| `source_path` | ima 知识库中的完整原始路径 |
| `title` | PDF 原始文件名 |
| `media_type` | ima 媒体类型；PDF 通常为 `1` |
| `media_id` | ima 媒体 ID，下载时的稳定主键 |
| `parent_folder_id` | ima 父目录 ID |
| `local_relative_path` | 相对 `downloads/` 的本地路径，推荐跨项目引用 |
| `saved_path` | 当前机器上的 PDF 绝对保存路径 |

主键建议：

- 首选 `media_id`
- 文件系统引用首选 `local_relative_path`

注意：`index.jsonl` 是索引结果文件，不代表 PDF 都已下载。判断本地是否已有 PDF，应结合 `downloads/` 或 `downloaded.jsonl`。

### `manifests/downloaded.jsonl`

下载成功事件日志。每成功处理一个文件，脚本会立即追加一行。

字段：

| 字段 | 含义 |
| --- | --- |
| `downloaded_at` | 成功处理时间，ISO 8601 |
| `knowledge_base` | 知识库名称 |
| `source_path` | ima 知识库中的完整原始路径 |
| `title` | PDF 原始文件名 |
| `media_id` | ima 媒体 ID |
| `media_type` | ima 媒体类型 |
| `saved_path` | 当前机器上的 PDF 绝对保存路径 |
| `file_size_bytes` | PDF 文件大小 |
| `sha256` | PDF 内容 SHA-256 |
| `request_id` | ima API 请求 ID；跳过已有文件时可能为 `null` |
| `skipped_existing_file` | 可选；文件已存在且校验为 PDF 时为 `true` |

这是 append-only 事件日志。消费方需要得到“当前已下载集合”时，应按 `media_id` 或 `saved_path` 去重。

### `manifests/failed.jsonl`

下载失败事件日志。失败会立即追加一行。

字段：

| 字段 | 含义 |
| --- | --- |
| `failed_at` | 失败时间，ISO 8601 |
| `knowledge_base` | 知识库名称 |
| `source_path` | ima 知识库中的完整原始路径 |
| `title` | PDF 原始文件名 |
| `media_id` | ima 媒体 ID |
| `media_type` | ima 媒体类型 |
| `saved_path` | 目标保存路径 |
| `priority` | 可选；来自 AI queue 的优先级 |
| `rank` | 可选；来自 AI queue 的排序 |
| `error` | 失败原因 |

常见失败包括 ima 资料获取额度上限。遇到 `资料获取次数已达上限` 这类错误时，同步脚本会停止继续下载。

### `manifests/ai-ranked-queue.jsonl`

AI Infrastructure 主题的滚动下载队列。它由 `index.jsonl` 生成，只基于标题和路径进行 DeepSeek 排序，不读取 PDF 正文，不调用 IMA 下载接口。

该文件在索引字段基础上增加：

| 字段 | 含义 |
| --- | --- |
| `priority` | `P0`、`P1`、`P2`、`P3`；P0 最高 |
| `rank` | 全队列排序，从 1 开始 |
| `score` | 0-100 下载优先分 |
| `topics` | 英文主题标签数组 |
| `reasons` | 排序理由数组 |
| `llm_provider` | LLM 提供方，目前为 `deepseek` |
| `llm_model` | 实际使用的模型组合 |
| `ranked_at` | 排序生成时间 |
| `recall_priority` | 第一轮召回优先级 |
| `recall_score` | 第一轮召回分数 |
| `recall_topics` | 第一轮主题标签 |
| `recall_reasons` | 第一轮理由 |
| `recall_llm_model` | 第一轮模型 |
| `evidence_keywords` | 第二轮复核使用的标题/路径证据词 |
| `evidence_level` | `explicit`、`indirect`、`weak`、`none` |
| `downgrade_reasons` | 第二轮降级理由 |
| `rerank_changed` | 第二轮是否改变优先级或分数 |
| `rerank_llm_model` | 第二轮模型 |

优先级解释：

- `P0`：核心 AI Infrastructure，例如 AI 数据中心 capex、AI 服务器、GPU/ASIC、HBM、先进封装、光互联、数据中心网络、电力、冷却、液冷、AI 半导体上游、人形机器人/具身智能核心硬件
- `P1`：强相关上游或投资线索，例如半导体设备/材料、ABF、PCB、MLCC、AI PC、AI 基建相关 IT 支出、机器人或 AI 产能相关工业自动化
- `P2`：泛 AI 或间接主题，例如 AI 应用、企业 AI 渗透率、互联网/云应用、生产率、科技硬件但基建指向不强
- `P3`：弱相关或无关

常见 `topics`：

- `aidc_capex`
- `ai_server`
- `semiconductor_upstream`
- `optical_interconnect`
- `hbm_memory`
- `advanced_packaging`
- `data_center_power`
- `data_center_cooling`
- `liquid_cooling`
- `humanoid_robotics`
- `ai_pc`
- `ai_application`
- `unrelated`

### `manifests/ai-ranked-queue-YYYYMMDD.jsonl`

某一天生成的 AI Infrastructure 队列快照。与滚动文件字段相同。

引用建议：

- 需要“最新队列”时读 `manifests/ai-ranked-queue.jsonl`
- 需要复现某天筛选结果时读 `manifests/ai-ranked-queue-YYYYMMDD.jsonl`

项目约定当天快照必须保留。

### `manifests/ai-p0p1-analysis.html`

P0/P1 研报的人工查看页面，由 `manifests/ai-ranked-queue.jsonl` 渲染而来。它用于人工快速浏览、筛选和复核，不是机器读取的主数据源。

日期快照：

- `manifests/ai-p0p1-analysis-YYYYMMDD.html`

滚动最新版：

- `manifests/ai-p0p1-analysis.html`

## 推荐接入方式

### 发现全部可用研报

读取 `manifests/index.jsonl`：

```js
import fs from 'node:fs';
import path from 'node:path';

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const repoRoot = '/Users/leon/Stock/investment-research-archive';
const index = readJsonl(path.join(repoRoot, 'manifests/index.jsonl'));

const records = index.map((record) => ({
  mediaId: record.media_id,
  title: record.title,
  sourcePath: record.source_path,
  pdfPath: path.join(repoRoot, 'downloads', record.local_relative_path),
}));
```

### 只读取已下载 PDF

用 `downloaded.jsonl` 构建已下载集合，再回到 `index.jsonl` 取便携路径：

```js
const downloaded = readJsonl(path.join(repoRoot, 'manifests/downloaded.jsonl'));
const downloadedMediaIds = new Set(downloaded.map((record) => record.media_id));

const localPdfs = index
  .filter((record) => downloadedMediaIds.has(record.media_id))
  .map((record) => ({
    ...record,
    pdfPath: path.join(repoRoot, 'downloads', record.local_relative_path),
  }));
```

### 只读取 AI Infrastructure P0/P1

读取 queue，并过滤 `priority`：

```js
const queue = readJsonl(path.join(repoRoot, 'manifests/ai-ranked-queue.jsonl'));

const highPriority = queue
  .filter((record) => record.priority === 'P0' || record.priority === 'P1')
  .sort((a, b) => Number(a.rank) - Number(b.rank));
```

### 校验 PDF 完整性

`downloaded.jsonl` 中有 `sha256` 和 `file_size_bytes`。消费方可以按 `media_id` 找到下载事件，再对本地文件重新计算 hash。

## 数据生成流程

索引目录：

```bash
node scripts/sync-kb-pdfs.cjs index \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/7月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"
```

生成 AI Infrastructure 队列：

```bash
node scripts/sync-kb-pdfs.cjs rank-ai \
  --months "2026/6月,2026/7月" \
  --queue manifests/ai-ranked-queue.jsonl
```

生成 P0/P1 查看页：

```bash
node scripts/render-ai-p0p1-html.cjs \
  --queue manifests/ai-ranked-queue.jsonl \
  --out manifests/ai-p0p1-analysis.html
```

按 queue 下载 PDF：

```bash
node scripts/sync-kb-pdfs.cjs download-queue \
  --kb "环球研报直通车" \
  --queue manifests/ai-ranked-queue.jsonl \
  --priorities P0,P1 \
  --daily-budget 28
```

注意：`download-queue` 会调用 IMA `get_media_info` 并消耗资料获取额度。未经明确要求，不应自动运行该命令。

## 使用约束

- 不直接批量 curl IMA 资源；下载必须通过 `scripts/sync-kb-pdfs.cjs` 和 `media_id` 执行
- 每个文件下载前必须重新调用 `get_media_info`，使用返回的 `url_info.url` 和 `headers`
- 文件已存在则跳过，不覆盖
- 下载成功立即追加 `downloaded.jsonl`
- 下载失败立即追加 `failed.jsonl`
- 所有同步任务支持断点恢复
- AI Infrastructure 研报同步默认先筛选 P0/P1，再按 queue 下载
- 默认下载预算为 `--daily-budget 28`
- 不提交 `.env`

## 这个项目不提供的数据

- 不保存 IMA 临时下载 URL 或 headers
- 不保存 PDF 正文抽取文本
- 不保存 embedding 或向量索引
- 不保存研报结构化财务数据
- 不保证 `saved_path` 在其他机器可用

如果其他项目需要全文检索、RAG 或结构化抽取，建议把本项目作为 PDF 和 manifest 的上游数据源，在下游项目中另建文本抽取、chunk、embedding 和索引层。
