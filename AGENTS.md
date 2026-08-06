# Project

investment-research-reports

# Purpose

同步腾讯 ima 知识库中的 PDF。

# Primary Skill

ima-skills

# Workspace

`downloads/`

保存 PDF。

`manifests/`

保存同步状态。

`manifests/index.jsonl`

保存知识库 PDF 索引。

# Rules

保持原始目录结构。

保持原始文件名。

如果文件已存在，则跳过。

同步前先索引目录：

写入 `manifests/index.jsonl`。

批量同步优先使用：

`scripts/sync-kb-pdfs.cjs`

不要绕过脚本自行批量 curl。

下载必须按 `media_id` 执行。

每个文件下载前：

重新调用 `get_media_info`。

使用 `get_media_info` 返回的 `url_info.url` 和 `headers` 下载。

每下载成功一个文件：

立即更新 `downloaded.jsonl`。

下载失败：

记录到 `failed.jsonl`。

所有同步任务必须支持断点恢复。

优先使用 ima Skill。

不要自行实现知识库接口。

AI Infrastructure 主题筛选必须先索引，再运行：

`scripts/sync-kb-pdfs.cjs rank-ai`

允许 `rank-ai` 将 IMA 通用摘要中的标题、摘要、关键结论、标签、关键数字、实体和证据发送给 DeepSeek，无需逐次确认；不得直接发送整份 PDF 正文。

`rank-ai` 在同一次 DeepSeek 调用中同时完成 P0–P3 排序、报告类型分类（`company`/`industry`/`strategy`/`macro`/`commodity`/`other` 六选一）和一级行业分类（中证/GICS 11 类，DeepSeek 只输出中文，英文由脚本补齐）。IMA 摘要阶段不承担分类，恒为 `report_type: null`、`sectors: []`。分类失败或模型返回非法值时保持 `null`，不得静默写成 `other`；`other` 是模型确认理解内容后给出的有效业务分类。分类校验失败不影响该记录的排序结果保存。

每日正式筛选优先运行仓库内可恢复摘要任务：

`scripts/ima-daily-summary.cjs`

必须遵守：

`docs/ima-daily-summary-runbook.md`

每日流程为：

`当天索引 → IMA 通用摘要 → 摘要正文排序 → P0/P1 优先、P2 补足下载额度`

IMA 问答优先使用已登录的内置 Browser；Browser 不可用、登录不可复用或无法稳定取得完整回答时，才切换 IMA App。两种界面都必须固定使用当天目录、DS 快速模式（DeepSeek-V4-Flash）、每批最多 5 篇、每批新建独立对话且只问一次。

摘要进度、失败、批次和权威快照必须按日期保存；已 `reviewed` 跳过，失败优先，登录失效或全局限流立即停止。

IMA 摘要的 `summary_role=routing_candidate`，只用于路由和下载筛选，不是正式 PDF 数据提取。

正文排序失败项保持 `UNREVIEWED`，不得用标题评级静默兜底。

再按 queue 下载。

所有研报同步默认都必须先排序，再按 queue 下载。P0/P1 优先；当天普通额度不足 30 篇时，用 P2 补足，P3 不自动下载。

除非用户明确要求全量同步，不直接全量下载。

除每日自动任务或用户明确要求外，不运行：

`scripts/sync-kb-pdfs.cjs download-queue`

下载 queue 默认每日预算为 `--daily-budget 30`。

每日自动任务使用 `--priorities P0,P1,P2` 和 `--quota-probe-extra 1`。跨续跑按上海日期累计已消耗次数；达到 30 次后只允许额外探测 1 篇。第 31 篇成功或失败后都必须停止，不得尝试第 32 篇。

遇到 IMA “资料获取次数已达上限”等上限错误，必须立即停止下载。

`manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl` 是当天唯一筛选结果，必须保留并提交。

`manifests/ai-ranking-analysis-YYYYMM.html` 是当月唯一的 P0–P3 排序页面；每日覆盖更新，必须保留并提交。

DeepSeek 排序只允许读取 `report-summaries-YYYYMMDD.jsonl`，每次调用直接完成正文排序。用户明确要求时，允许对同一日期重新排序并覆盖该日期队列、刷新月度页面；不得运行标题-only 召回、P0/P1 二阶段 rerank 或标题/正文对照流程。

不要提交 `.env`。
