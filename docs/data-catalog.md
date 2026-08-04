# investment-research-reports 数据说明

本文档说明本项目当前沉淀了哪些数据、数据放在哪里、各 JSONL 文件的字段含义，以及其他项目应该如何引用这些数据。

## 数据范围

`investment-research-reports` 用于同步、归档腾讯 ima 知识库中的 PDF 研报。目前主要数据来自知识库：

- `环球研报直通车`

数据类型包括：

- PDF 原文文件：保存在 `downloads/`
- 知识库 PDF 索引：保存在 `manifests/index.jsonl`
- 单日 PDF 快照：保存在 `manifests/index-YYYYMMDD.jsonl`
- 下载成功/失败事件日志：保存在 `manifests/downloaded.jsonl`、`manifests/failed.jsonl`
- 每日额度与上限探测日志：保存在 `manifests/download-attempts.jsonl`
- AI Infrastructure 主题排序队列：保存在 `manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl`
- IMA 通用摘要快照：保存在 `manifests/report-summaries-YYYYMMDD.jsonl`
- DeepSeek 基于摘要正文的一轮排序：保存在 `manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl`
- 月度 P0–P3 排序看板：保存在 `manifests/ai-ranking-analysis-YYYYMM.html`

当前快照（2026-07-06）：

- `manifests/index.jsonl`：2242 条 PDF 索引记录
- 已下载 PDF：62 份，约 268MB
- 旧的标题-only `ai-ranked-queue*.jsonl` 仅为历史产物，不再由每日任务生成
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
  index-YYYYMMDD.jsonl
  downloaded.jsonl
  failed.jsonl
  download-attempts.jsonl
  report-summary-browser-progress-YYYYMMDD.jsonl
  report-summary-browser-failures-YYYYMMDD.jsonl
  report-summary-batches-YYYYMMDD.jsonl
  report-summaries-YYYYMMDD.jsonl
  ai-ranked-queue-summary-YYYYMMDD.jsonl
  ai-ranking-analysis-YYYYMM.html
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

### `manifests/index-YYYYMMDD.jsonl`

指定单日 IMA 文件夹的完整 PDF 快照。它与 append-only 的 `index.jsonl` 不同：即使 `media_id` 已在全局索引中，仍会出现在本日快照。字段与 `index.jsonl` 相同，用于 rank-ai 单日对账和人工金标准复核。

### `manifests/report-summaries-YYYYMMDD.jsonl`

当天通用摘要的权威快照，每个索引 `media_id` 恰好一行。`status=reviewed` 表示 IMA 回答已通过本轮下载筛选所需的宽松校验；`UNREVIEWED` 表示没有可用摘要或已达到重试上限。

主要字段：

| 字段 | 含义 |
| --- | --- |
| `media_id` / `title` / `source_path` / `local_relative_path` | 从当天索引继承的稳定身份与后续下载定位 |
| `status` | `reviewed` 或 `UNREVIEWED` |
| `summary_role` | 固定为 `routing_candidate`，不得当作正式 PDF 提取结果 |
| `report_type` / `research_subject` / `executive_summary` | 报告类型、研究主体和通用摘要 |
| `key_findings` / `content_tags` | 关键结论和内容覆盖标签 |
| `data_points` | 最多 4 条原始口径关键数字；未做单位或指标标准化 |
| `entities` / `evidence` | 路由实体和对应报告的连续原文线索 |
| `source_match` | IMA 返回的 `source_title` 是否精确对应索引文件名 |
| `prompt_version` / `model_version` | Prompt 与 IMA 模型版本 |
| `generated_at` / `elapsed_ms` / `attempts` | 生成时间、批次耗时和累计尝试次数 |
| `raw_answer` | 该批 IMA 的完整原始 JSON 回答 |
| `validation_warnings` / `failure_code` | 宽松校验警告或失败原因 |

其他项目可以按 `media_id` 读取摘要做候选筛选，但必须回到 `downloads/<local_relative_path>` 的 PDF 执行正式数字、页码和证据验证。

增量执行状态分别位于：

- `report-summary-browser-progress-YYYYMMDD.jsonl`：成功记录，完成一篇立即原子写入；
- `report-summary-browser-failures-YYYYMMDD.jsonl`：失败类型与尝试次数；
- `report-summary-batches-YYYYMMDD.jsonl`：每批 Prompt、文件清单、状态、耗时和回答哈希。

### `manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl`

读取标题、通用摘要、关键结论、内容标签、原始关键数字、实体和证据后生成的 AI Infrastructure 正文排序。只接收 `reviewed + source_match + executive_summary` 记录；失败项不会由标题评级静默补齐。

该队列保留索引身份和下载字段，可直接作为 `download-queue` 的输入。每次排序调用都直接按正文摘要分类，`ranking_mode=single_summary_pass` 描述的是单次调用内没有标题召回或二阶段 rerank，并不限制同一日期以后重新排序。用户明确要求重新排序时，覆盖该日期队列并刷新月度页面。

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

### `manifests/download-attempts.jsonl`

下载额度审计日志，按 Asia/Shanghai 日期累计，避免同一天续跑时重新获得一份本地预算。

- `daily_baseline`：当天首次运行时，从已有成功和失败日志推断此前真实调用数；
- `download_attempt`：每次调用 `get_media_info` 前立即写入，包含 `media_id`、优先级和 `budget|probe` 槽位；
- 同一天 `daily_baseline.attempts + download_attempt 条数` 即本地认定的累计调用次数。

第 31 篇是一次性上限探测。其结果仍分别落入 `downloaded.jsonl` 或 `failed.jsonl`；无论成功还是失败，当天都不再尝试第 32 篇。

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

### 一轮正文排序字段

`manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl` 在摘要字段基础上增加：

| 字段 | 含义 |
| --- | --- |
| `priority` | `P0`、`P1`、`P2`、`P3`；P0 最高 |
| `rank` | 全队列排序，从 1 开始 |
| `score` | 0-100 下载优先分 |
| `topics` | 英文主题标签数组 |
| `reasons` | 排序理由数组 |
| `llm_provider` | LLM 提供方，目前为 `deepseek` |
| `ranking_evidence` | 排序直接引用的摘要原文证据 |
| `false_positive_checks` | 数据中心地产、租赁、并购等假阳性检查 |
| `ranking_mode` | 固定为 `single_summary_pass`，表示本次调用为正文摘要直排；不表示该日期禁止重新排序 |
| `llm_model` | 实际使用的单一 DeepSeek 模型 |
| `ranked_at` | 排序生成时间 |

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

旧的 `ai-ranked-queue.jsonl`、`ai-ranked-queue-YYYYMMDD.jsonl`、`ai-ranking-comparison-YYYYMMDD.jsonl` 和非 summary HTML 仅保留作历史审计，不再更新，也不得作为新流程输入。

月度 P0–P3 排序看板固定为 `manifests/ai-ranking-analysis-YYYYMM.html`。日期化 JSONL 保留审计轨迹，HTML 每月仅维护一份并由每日任务覆盖更新。

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

const repoRoot = '/Users/leon/Stock/investment-research-reports';
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
const queue = readJsonl(path.join(repoRoot, 'manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl'));

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
  --summary-source manifests/report-summaries-YYYYMMDD.jsonl \
  --queue manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl
```

更新当月 P0–P3 看板：

```bash
node scripts/render-ai-ranking-html.cjs \
  --month YYYYMM \
  --out manifests/ai-ranking-analysis-YYYYMM.html
```

按 queue 下载 PDF：

```bash
node scripts/sync-kb-pdfs.cjs download-queue \
  --kb "环球研报直通车" \
  --queue manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl \
  --priorities P0,P1,P2 \
  --daily-budget 30 \
  --quota-probe-extra 1
```

注意：`download-queue` 会调用 IMA `get_media_info` 并消耗资料获取额度。每日自动任务按 P0/P1/P2 顺序运行，P2 只用于补足 30 篇普通额度；达到 30 次后只额外探测 1 篇。其他场景未经明确要求，不应自动运行该命令。

`manifests/download-attempts.jsonl` 是追加式额度审计日志。每天第一条 `daily_baseline` 从既有成功和失败清单推断当日已消耗次数，后续每次真实下载调用在调用前写入 `download_attempt`，用于跨中断和跨续跑限制第 30/31 次。

## 使用约束

- 不直接批量 curl IMA 资源；下载必须通过 `scripts/sync-kb-pdfs.cjs` 和 `media_id` 执行
- 每个文件下载前必须重新调用 `get_media_info`，使用返回的 `url_info.url` 和 `headers`
- 文件已存在则跳过，不覆盖
- 下载成功立即追加 `downloaded.jsonl`
- 下载失败立即追加 `failed.jsonl`
- 所有同步任务支持断点恢复
- AI Infrastructure 研报同步默认先排序，P0/P1 优先、P2 补足，P3 不自动下载
- 默认下载预算为 `--daily-budget 30`
- 普通额度用满后默认只额外探测 1 篇
- 不提交 `.env`

## 这个项目不提供的数据

- 不保存 IMA 临时下载 URL 或 headers
- 不保存 PDF 正文抽取文本
- 不保存 embedding 或向量索引
- 不保存研报结构化财务数据
- 不保证 `saved_path` 在其他机器可用

如果其他项目需要全文检索、RAG 或结构化抽取，建议把本项目作为 PDF 和 manifest 的上游数据源，在下游项目中另建文本抽取、chunk、embedding 和索引层。
