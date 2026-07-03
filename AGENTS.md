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

# Rules

保持原始目录结构。

保持原始文件名。

如果文件已存在，则跳过。

每下载成功一个文件：

立即更新 `downloaded.jsonl`。

下载失败：

记录到 `failed.jsonl`。

所有同步任务必须支持断点恢复。

优先使用 ima Skill。

不要自行实现知识库接口。
