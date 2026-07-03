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

`tasks/`

同步任务说明。

## 更新 ima-skill

将新版 ima Skill 放入 `ima-skill/`，保持目录名不变。

更新后确认 `.claude/skills/ima-skill` 仍指向 `../../ima-skill`。

不要修改 `downloads/` 或 `manifests/` 中的同步状态文件。

## 执行任务

根据需要打开 `tasks/` 下的任务文件：

- `tasks/sync-day.md`
- `tasks/sync-month.md`
- `tasks/sync-year.md`
- `tasks/resume.md`

执行同步时使用 `ima-skill` 访问知识库，将 PDF 保存到 `downloads/`，并即时更新 `manifests/`。

## 恢复同步

使用 `tasks/resume.md`。

恢复时根据 `manifests/downloaded.jsonl` 跳过已完成文件，根据 `manifests/failed.jsonl` 识别需要重试或确认的失败项。
