# resume

根据 manifest 继续同步。

目标：

- 读取 `manifests/downloaded.jsonl` 识别已成功下载的文件。
- 读取 `manifests/failed.jsonl` 识别失败项。
- 已成功下载或本地已存在的文件跳过。
- 对未完成项继续同步。
- 对失败项按任务需要重试或记录新的失败状态。
- 继续使用 `ima-skill` 访问知识库。
- 保持原始目录结构和文件名。
