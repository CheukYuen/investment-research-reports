# sync-month

同步整个月目录中的 PDF 研报。

示例目录：

`2026/7月`

目标：

- 使用 `ima-skill` 访问指定月份目录。
- 遍历该月份下的日期目录。
- 保持原始目录结构和文件名。
- 将 PDF 保存到 `downloads/`。
- 已存在文件跳过。
- 成功项记录到 `manifests/downloaded.jsonl`。
- 失败项记录到 `manifests/failed.jsonl`。
- 支持断点恢复。
