# inv-research-hub

用于同步、归档腾讯 ima 知识库中的 PDF 研报。

这是一个 AI Workspace，不是传统应用程序。所有知识库访问与 PDF 下载都应通过 `ima-skill` 完成，并保持 ima 知识库中的原始目录结构和文件名。

## 目录

`AGENTS.md`

整个仓库唯一的 Agent 配置文件。

`CLAUDE.md`

指向 `AGENTS.md` 的 symlink。

`ima-skill/`

本 Workspace 使用的 ima Skill。

`.claude/skills/ima-skill`

指向 `ima-skill/` 的 symlink。

`downloads/`

保存下载后的 PDF，按原始目录结构归档。

`manifests/downloaded.jsonl`

记录已成功下载的文件。

`manifests/failed.jsonl`

记录下载失败的文件。

## 更新 ima-skill

将新版 ima Skill 放入 `ima-skill/`，保持目录名不变。

更新后确认 `.claude/skills/ima-skill` 仍指向 `../../ima-skill`。

不要修改 `downloads/` 或 `manifests/` 中的同步状态文件。

## 同步

使用 `ima-skill` 访问知识库，将 PDF 保存到 `downloads/`，并即时更新 `manifests/`。

根据 `manifests/downloaded.jsonl` 跳过已完成文件，根据 `manifests/failed.jsonl` 识别需要重试或确认的失败项。

### 批量索引和下载

`scripts/sync-kb-pdfs.cjs` 用于先索引目录，再按 `media_id` 下载 PDF。

索引结果写入：

`manifests/index.jsonl`

下载成功立即写入：

`manifests/downloaded.jsonl`

下载失败立即写入：

`manifests/failed.jsonl`

下载时会对每个文件重新调用 `get_media_info`，使用返回的 `url_info.url` 和 `headers` 获取 PDF，因此临时 URL 过期后可以直接重跑。

示例：同步「环球研报直通车」中 2026 年 7 月目录，保存到 `downloads/2026/7月/...`：

```bash
node scripts/sync-kb-pdfs.cjs sync \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/7月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"
```

只索引不下载：

```bash
node scripts/sync-kb-pdfs.cjs index \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/7月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"
```

只下载已索引但未完成的文件：

```bash
node scripts/sync-kb-pdfs.cjs download \
  --kb "环球研报直通车" \
  --source-path "环球研报直通车 / 2026年国际顶级投行研报 / 7月"
```

测试少量下载时可以加 `--limit`：

```bash
node scripts/sync-kb-pdfs.cjs download \
  --kb "环球研报直通车" \
  --source-path "环球研报直通车 / 2026年国际顶级投行研报 / 7月" \
  --limit 3
```
