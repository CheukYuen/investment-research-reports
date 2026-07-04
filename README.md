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

## AI Infrastructure 每日队列

AI Infrastructure 主题不需要下载全量 PDF。每日流程是先补索引，再用 DeepSeek 对标题和路径排序，最后只按 queue 下载高优先级文件。

DeepSeek 配置从 `.env` 读取：

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_RERANK_MODEL=deepseek-v4-pro
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

`.env` 不提交。

### 每日流程

先索引目标月份目录，例如 2026 年 6 月和 7 月：

```bash
node scripts/sync-kb-pdfs.cjs index \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/6月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"

node scripts/sync-kb-pdfs.cjs index \
  --kb "环球研报直通车" \
  --source-path "2026年国际顶级投行研报/7月" \
  --strip-source-prefix "2026年国际顶级投行研报" \
  --local-prefix "2026"
```

生成 AI queue：

```bash
node scripts/sync-kb-pdfs.cjs rank-ai \
  --months "2026/6月,2026/7月" \
  --queue manifests/ai-ranked-queue.jsonl
```

`rank-ai` 只调用 DeepSeek，不调用 IMA，不下载 PDF，不消耗 IMA 资料获取额度。

生成 P0/P1 查看页：

```bash
node scripts/render-ai-p0p1-html.cjs \
  --queue manifests/ai-ranked-queue.jsonl \
  --out manifests/ai-p0p1-analysis.html
```

HTML 只做可视化，不调用 DeepSeek，不调用 IMA。

按 queue 下载 PDF：

```bash
node scripts/sync-kb-pdfs.cjs download-queue \
  --kb "环球研报直通车" \
  --queue manifests/ai-ranked-queue.jsonl \
  --priorities P0,P1 \
  --daily-budget 28
```

`download-queue` 会对每个文件重新调用 `get_media_info` 并下载 PDF，会消耗 IMA 资料获取额度。遇到“资料获取次数已达上限”等上限错误会立即停止，不继续刷失败记录。

未经用户明确要求，不要运行 `download-queue`。

### 每日检查

关注这些输出和文件：

`manifests/ai-ranked-queue.jsonl`

DeepSeek 排序后的最终下载队列。

`manifests/ai-p0p1-analysis.html`

人工查看 P0/P1 的 HTML 页面。

`manifests/downloaded.jsonl`

成功下载记录。

`manifests/failed.jsonl`

下载失败记录。

命令输出中的 `by_priority`、`downloaded`、`budget_used`、`stopped_quota` 也需要检查。

### 备份和提交

重新生成 queue 前可以备份旧文件：

```bash
cp manifests/ai-ranked-queue.jsonl manifests/ai-ranked-queue.jsonl.bak-$(date +%Y%m%d-%H%M%S)
```

`manifests/*.bak-*` 备份文件不提交。

如果当天 queue 和 HTML 是正式结果，可以提交 `manifests/ai-ranked-queue.jsonl` 和 `manifests/ai-p0p1-analysis.html`。

PDF 是否提交需要单独确认，避免无意提交大量文件。
