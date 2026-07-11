# inv-research-hub

从腾讯 ima 知识库同步并归档 PDF 研报。默认不做全量下载：先按 **AI Infrastructure** 主题筛出 P0/P1，再按每日预算限量下载。

这是一个 AI Workspace（上游数据源），不是传统应用程序。知识库访问与 PDF 下载通过 `ima-skill` + `scripts/sync-kb-pdfs.cjs` 完成，并保持 ima 中的原始目录结构和文件名。

## 给其他项目 / LLM：30 秒速览

| 问题 | 答案 |
| --- | --- |
| 这是什么？ | PDF 原文 + JSONL manifest 的上游归档仓 |
| 不是什么？ | 不做全文抽取、embedding、财务结构化，也不自行实现 IMA SDK |
| 默认下载谁？ | 仅 AI Infrastructure **P0 + P1**，每日预算约 28 份 |
| 其他项目怎么读？ | 读 `manifests/` + `downloads/<local_relative_path>` |
| 字段与接入示例？ | 见 [docs/data-catalog.md](docs/data-catalog.md) |
| Agent 硬规则？ | 见 [AGENTS.md](AGENTS.md) |

## 核心产物

| 路径 | 用途 |
| --- | --- |
| `downloads/` | PDF 原文，保持原始目录与文件名 |
| `manifests/index.jsonl` | 知识库 PDF 全量索引（发现入口） |
| `manifests/ai-ranked-queue.jsonl` | 最新 / 滚动排序队列（可被后续同步覆盖） |
| `manifests/ai-ranked-queue-YYYYMMDD.jsonl` | 当天筛选快照（须保留并提交） |
| `manifests/downloaded.jsonl` | 下载成功日志 |
| `manifests/failed.jsonl` | 下载失败日志 |
| `manifests/ai-p0p1-analysis.html` | 最新 P0/P1 人工查看页（可覆盖） |
| `manifests/ai-p0p1-analysis-YYYYMMDD.html` | 当天 P0/P1 分析页（须保留并提交） |

HTML 仅供人工复核，不是机器读取的主数据源。跨机器引用 PDF 时用 `local_relative_path`，不要依赖 `saved_path`。

## 排序与过滤规则

主路径只服务 **AI Infrastructure** 主题。`rank-ai` 只看标题和路径，不读 PDF 正文，不调用 IMA，不消耗资料获取额度。

```mermaid
flowchart LR
  indexJsonl[index.jsonl] --> recall[Round1_recall_flash]
  recall --> rerank[Round2_rerank_P0P1_only_pro]
  rerank --> queue[ai-ranked-queue]
  queue --> download[download-queue_P0P1_budget28]
```

### 两轮流程

1. **第一轮召回（recall）**  
   模型：`deepseek-v4-flash`（可用 `DEEPSEEK_MODEL` 覆盖）。  
   对索引中的候选全量打 `P0`–`P3`，目标是高召回：宁可多放进 P0/P1，留给第二轮收紧。

2. **第二轮复核（rerank）**  
   模型：`deepseek-v4-pro`（可用 `DEEPSEEK_RERANK_MODEL` 覆盖）。  
   **只复核第一轮的 P0/P1**。要求标题或路径中有证据词；禁止仅凭公司名、ticker 或行业常识抬到 P0。证据不足时可降为 P1/P2/P3。

3. **最终排序**  
   `priority`（P0→P3）→ `score` 降序 → 日期新优先 → 标题。写入 queue 后赋 `rank`（从 1 开始）。

### 优先级定义

| 级别 | 含义 | 典型主题 |
| --- | --- | --- |
| **P0** | 核心 AI Infrastructure | AIDC / hyperscaler 数据中心 capex、AI 服务器、GPU/ASIC、HBM/存储、先进封装/CoWoS、光互联、数据中心网络、电力/冷却/液冷、AI 半导体上游、人形机器人/具身智能核心硬件。明确 AIDC / AI 数据中心资本开支必须 P0 |
| **P1** | 强相关上游或投资线索 | 半导体设备/材料、晶圆厂扩产、ABF、PCB、MLCC、AI PC、明确指向 AI 基建/数据中心/云 capex 的 IT 支出、机器人或 AI 产能相关工业自动化 |
| **P2** | 泛 AI 或间接 | AI 应用、企业 AI 渗透率、互联网/云应用、生产率、科技硬件但基建指向不强 |
| **P3** | 弱相关或无关 | 宏观、地产、医疗、消费、银行、普通汽车销量、普通互联网估值等 |

**score 参考带**：P0 通常 85–100，P1 通常 65–84，P2 通常 35–64，P3 通常 0–34。

### 证据原则

- 区分「数据中心 / 地产 / 信托 / 估值 / 买卖评级」叙事与「技术资本开支」信号。
- 仅有前者、标题无 AI 基建技术证据 → 降权；同时出现 GPU、服务器、光模块、液冷、hyperscaler 扩建等证据 → 可保留较高优先级。

### 默认下载过滤

| 规则 | 默认值 |
| --- | --- |
| 下载优先级 | `--priorities P0,P1`（P2/P3 不进默认下载） |
| 每日预算 | `--daily-budget 28` |
| 全量下载 | 仅当用户明确要求时才做 |
| `download-queue` | 未经用户明确要求，不要运行 |
| IMA 额度触顶 | 「资料获取次数已达上限」等错误必须立即停止 |

## 其他项目怎么读

1. **发现有哪些 PDF** → 读 `manifests/index.jsonl`
2. **只要 AI Infra 高优** → 读 `manifests/ai-ranked-queue.jsonl`（或当日 `*-YYYYMMDD.jsonl`），过滤 `priority === 'P0' || priority === 'P1'`，按 `rank` 排序
3. **读本地 PDF** → `path.join(repoRoot, 'downloads', record.local_relative_path)`

字段含义、完整示例与约束见 [docs/data-catalog.md](docs/data-catalog.md)。

## 每日流程

DeepSeek 配置从 `.env` 读取（不提交）：

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_RERANK_MODEL=deepseek-v4-pro
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

### 1. 索引目标月份

```bash
node scripts/sync-kb-pdfs.cjs index \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/7月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"
```

可按需对多个月份各跑一次。索引写入 `manifests/index.jsonl`。

### 2. 生成 AI queue（不耗 IMA 额度）

```bash
node scripts/sync-kb-pdfs.cjs rank-ai \
  --months "2026/6月,2026/7月" \
  --queue manifests/ai-ranked-queue.jsonl
```

正式结果应同时保留日期快照，例如：

```bash
cp manifests/ai-ranked-queue.jsonl manifests/ai-ranked-queue-$(date +%Y%m%d).jsonl
```

### 3. 生成 P0/P1 查看页（不调 DeepSeek / IMA）

```bash
node scripts/render-ai-p0p1-html.cjs \
  --queue manifests/ai-ranked-queue.jsonl \
  --out manifests/ai-p0p1-analysis.html
```

日期快照同理保留 `ai-p0p1-analysis-YYYYMMDD.html`。

### 4. 按 queue 下载（耗 IMA 额度）

```bash
node scripts/sync-kb-pdfs.cjs download-queue \
  --kb "环球研报直通车" \
  --queue manifests/ai-ranked-queue.jsonl \
  --priorities P0,P1 \
  --daily-budget 28
```

每个文件下载前会重新调用 `get_media_info`，用返回的临时 URL 与 headers 拉取 PDF。成功立即写 `downloaded.jsonl`，失败写 `failed.jsonl`。已存在的文件跳过。

关注输出中的 `by_priority`、`downloaded`、`budget_used`、`stopped_quota`。

### 备份与提交

```bash
cp manifests/ai-ranked-queue.jsonl manifests/ai-ranked-queue.jsonl.bak-$(date +%Y%m%d-%H%M%S)
```

- 当天正式结果：提交 `ai-ranked-queue-YYYYMMDD.jsonl` 与 `ai-p0p1-analysis-YYYYMMDD.html`
- 滚动文件可覆盖；`*.bak-*` 不提交
- PDF 是否提交需单独确认，避免无意提交大量文件

## 仅明确要求全量时

```bash
node scripts/sync-kb-pdfs.cjs sync \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/7月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"
```

默认路径不要用全量 `sync` / `download`。

## 仓库入口

| 路径 | 说明 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Agent 唯一配置与硬规则 |
| `CLAUDE.md` | 指向 `AGENTS.md` 的 symlink |
| `ima-skill/` | ima OpenAPI Skill；`.claude/skills/ima-skill` 为其 symlink |
| `scripts/sync-kb-pdfs.cjs` | 索引、排序、按 queue 下载 |
| `scripts/render-ai-p0p1-html.cjs` | P0/P1 HTML 可视化 |
| [docs/data-catalog.md](docs/data-catalog.md) | 字段、路径约定、跨项目引用 |

同步与下载的完整约束（断点恢复、`media_id`、`get_media_info`、禁止自行批量 curl 等）见 [AGENTS.md](AGENTS.md)。
