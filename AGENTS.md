# Project

inv-research-hub

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
