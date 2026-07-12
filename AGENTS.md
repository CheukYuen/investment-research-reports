# Project

investment-research-reports

# Purpose

同步腾讯 ima 知识库中的 PDF。

# Primary Skill

ima-skill

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

再按 queue 下载。

所有研报同步默认都必须先筛选 P0/P1，再按 queue 下载。

除非用户明确要求全量同步，不直接全量下载。

未经用户明确要求，不运行：

`scripts/sync-kb-pdfs.cjs download-queue`

下载 queue 默认每日预算为 `--daily-budget 28`。

遇到 IMA “资料获取次数已达上限”等上限错误，必须立即停止下载。

`manifests/ai-ranked-queue-YYYYMMDD.jsonl` 是当天筛选结果，必须保留并提交。

`manifests/ai-p0p1-analysis-YYYYMMDD.html` 是当天 P0/P1 分析页面，必须保留并提交。

`manifests/ai-ranked-queue.jsonl` 是最新/滚动 queue，可被后续同步覆盖。

`manifests/ai-p0p1-analysis.html` 是最新/滚动 P0/P1 总览，可被后续同步覆盖。

不要提交 `.env`。
