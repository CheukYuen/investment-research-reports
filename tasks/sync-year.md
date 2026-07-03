# sync-year

同步整个年份目录中的 PDF 研报。

示例目录：

`2026`

目标：

- 使用 `ima-skill` 访问指定年份目录。
- 遍历该年份下的月份和日期目录。
- 保持原始目录结构和文件名。
- 将 PDF 保存到 `downloads/`。
- 已存在文件跳过。
- 成功项记录到 `manifests/downloaded.jsonl`。
- 失败项记录到 `manifests/failed.jsonl`。
- 支持断点恢复。
