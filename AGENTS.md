# Project

investment-research-reports

# Purpose

同步腾讯 IMA 知识库中的 PDF 研报。

# Primary Skill

ima-skill

# Source of Truth

- 每日摘要、排序、下载和 Git 流程：`docs/ima-daily-summary-runbook.md`
- 当前运行参数：`config/ima-daily-summary.json`
- IMA OpenAPI 操作：`.agents/skills/@tencent-adm/ima-skills/SKILL.md`
- 本地研报检索：`.agents/skills/report-search/SKILL.md`

执行每日任务时必须完整读取 Runbook 和配置，不在本文件重复其 Browser/App 状态机、批次、额度、finalize 或提交细节。

# Workspace

- `downloads/`：PDF，保持 IMA 原始目录结构和文件名。
- `manifests/`：索引、日期进度、排序队列、下载和失败审计。
- `manifests/index.jsonl`：知识库 PDF 索引。

# Sync Invariants

- 同步前先索引；批量操作使用 `scripts/sync-kb-pdfs.cjs`，不自行实现 IMA 接口或批量 `curl`。
- 如文件已存在则跳过。下载必须按 `media_id`，每个文件下载前重新调用 `get_media_info`，并使用返回的 `url_info.url` 和 `headers`。
- 每个成功或失败结果立即写入对应 manifest；所有同步任务必须支持断点恢复。
- 除每日自动任务或用户明确要求外，不运行 `download-queue`；除非明确要求全量同步，不直接全量下载。
- 登录失效、全局限流、IMA 资料获取上限和 `30+1` 停止条件严格按 Runbook 执行，不自行放宽。

# Ranking and Evidence

- AI Infrastructure 正式筛选路径是：索引 → IMA 通用摘要 → `rank-ai` 正文摘要排序 → 按 queue 下载。
- 允许 `rank-ai` 将 IMA 通用摘要中的标题、摘要、关键结论、标签、关键数字、实体和证据发送给 DeepSeek，无需逐次确认；不得发送整份 PDF 正文。
- IMA 摘要的 `summary_role=routing_candidate`，只用于路由和下载筛选；正式数字、页码和证据必须回到 `downloads/<local_relative_path>` 的 PDF 核对。
- 正文排序失败项保持 `UNREVIEWED`，不用标题评级兜底。分类失败时 `report_type` 保持 `null`，不得静默写成 `other`。
- `manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl`、`manifests/ai-ranking-analysis-YYYYMM.html`、`manifests/ai-ranking-analysis.html` 和 `manifests/search-index-YYYYMM.jsonl` 是必须保留的权威产物。

# Report Search

- 主题检索先运行 `node scripts/search-reports.cjs query '<关键词>'`；命中偏少时加 `--facets` 查看实际词汇后重查。
- 不要 grep `manifests/ai-ranking-analysis*.html`，不要遍历 `downloads/`，不要跨日期逐个读取摘要或队列 JSONL。
- 兜底可用 `rg '<关键词>' manifests/search-index-*.jsonl`，但其整行匹配召回范围更宽，不等价于 `query`。

# Skill Layout

- 项目 skill 唯一实体目录是 `.agents/skills/`；`.claude/skills/`、`skills/` 和 `SEARCH.md` 只能作为软链入口。
- SkillHub 安装或覆盖更新 IMA skill 后，立即运行 `node scripts/normalize-ima-skill.cjs`。来源、版本和当前上游包的兼容限制见 README 的「Skill 管理」。

# Git

- 不要提交 `.env`。
- 只有用户明确要求或 Runbook 与当前配置授权时才提交；保持范围窄，排除运行前已有的无关改动。
