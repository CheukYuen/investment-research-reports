# IMA 每日摘要、正文排序与下载候选 Runbook

## 1. 定位与边界

本流程每天处理 IMA 知识库「环球研报直通车」中 Asia/Shanghai 当天目录的全部 PDF：

```text
当天索引
→ IMA DS 快速模式（DeepSeek-V4-Flash）分批生成通用摘要
→ 逐篇写入可恢复进度
→ 生成权威日期快照
→ 基于摘要做 AI Infrastructure 正文排序
→ 生成当日排序队列并更新当月 P0–P3 HTML
→ P0/P1 优先下载，P2 补足普通额度
```

IMA 摘要的角色固定为 `routing_candidate`：它只用于主题路由、PDF 下载筛选和后续原文定位，不是正式 PDF 数据提取结果。不要在 IMA 阶段生成 canonical metric、标准化单位、正式 scope 或数据库记录。

仓库配置位于 `config/ima-daily-summary.json`：

- `max_batch_size`：每次最多 5 篇；
- `browser_url`：IMA Web 的固定目标知识库入口；Browser 必须直接打开该地址，不从公共首页猜测知识库路径；
- `max_attempts`：单篇累计重试上限；
- `interaction_order`：固定为 `browser,app`，Browser 是主路径，App 仅为兜底；
- `browser_model_version` / `app_model_version`：记录摘要实际来自哪个界面；
- `auto_download`：默认 `true`；
- `daily_budget`：普通下载额度为 30，跨同一天续跑累计；
- `download_priorities`：默认 `P0,P1,P2`，按 P0、P1、P2 顺序消费额度；
- `quota_probe_extra`：默认 1，普通额度用满后只探测第 31 篇一次；
- `auto_git_commit`：默认 `false`，结果保存与 Git 提交分离。

## 2. 每日文件

`YYYYMMDD` 由 Asia/Shanghai 当天日期生成，不得写死日期或篇数。

```text
manifests/index-YYYYMMDD.jsonl
manifests/report-summary-browser-progress-YYYYMMDD.jsonl
manifests/report-summary-browser-failures-YYYYMMDD.jsonl
manifests/report-summary-batches-YYYYMMDD.jsonl
manifests/report-summaries-YYYYMMDD.jsonl
manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl
manifests/ai-ranking-analysis-YYYYMM.html
```

`progress` 保存每篇完整 IMA 原始回答和结构化摘要；`failures` 保存失败原因与累计尝试次数；`batches` 保存每次 Prompt、批次文件和批次状态。三者共同构成断点，不依赖 Codex 聊天记录。

## 3. 准备当天任务

在仓库根目录执行：

```bash
node scripts/ima-daily-summary.cjs prepare
```

它会：

1. 按当天目录重新索引并生成日期快照；
2. 初始化当天摘要进度文件；
3. 保留已有摘要进度，续跑时不覆盖成功记录。

历史日期可显式传入：

```bash
node scripts/ima-daily-summary.cjs prepare --date 20260723
```

只验证已有索引、避免再次调用 IMA API：

```bash
node scripts/ima-daily-summary.cjs prepare \
  --date 20260723 \
  --skip-index
```

## 4. Browser 优先、App 兜底的操作状态机

### Browser 登录态判定

登录状态必须以能否访问受保护的目标知识库为准，不能仅凭公共首页首帧出现“登录”文字判断：

1. 优先复用并接管已有的 Codex 内置 Browser 标签；
2. 直接打开目标知识库页，等待会话异步恢复和页面稳定；
3. 出现“搜索知识库”、个人/共享/订阅知识库列表、“环球研报直通车”标题或内容、当天目录/PDF、历史问答中的任一信号，即判定已登录；
4. 只有目标知识库持续被登录墙阻断或重定向，且间隔数秒的两次稳定检查均无任何已登录信号，才判定登录不可用；
5. 加载中、首帧或信号矛盾时记为 `AUTH_UNKNOWN`，继续在 Browser 复核，不得切换 App，也不得记录 `LOGIN_REQUIRED`。

每个批次都必须完整执行以下状态机，不得在旧对话中追问：

1. 优先连接已登录的 Codex 内置 Browser，直接打开配置中的 `browser_url`，并进入 `YYYY年国际顶级投行研报 / M月 / M.D` 当天目录。
2. 确认问答范围是当前文件夹。
3. 选择内置模型 `DS`，思考模式为 `快速`，确认底层模型为 `DeepSeek-V4-Flash`，关闭联网搜索。
4. 在当天目录中点击右上角“新建对话”。
5. 确认新对话没有历史问答。
6. 在终端执行 Browser 批次命令，取得本批 Prompt：

   ```bash
   node scripts/ima-daily-summary.cjs next --surface browser --compact
   ```

   完整 Prompt 与报告清单保存在 `batches` 文件对应的最新 `planned` 批次中。Browser 控制端直接读取该行，不把完整 Prompt 和记录再次打印到工具输出。

7. 将该批次的 `prompt` 完整粘贴到 IMA，只发送一次。
8. 等待回答停止生成，并确认“生成脑图”或回答底部操作图标已经出现；不要用固定睡眠代替完成检测。正常轮询只检查目标完成信号，不重复输出完整 DOM。
9. 在本次新增回答右下角点击 `…` → “复制”，从 Browser 剪贴板读取全文并写入仓库外的临时 UTF-8 文件。不要误用相邻“分享”菜单中的“复制链接”；`…` 可能是无文字图标，DOM 中没有“复制”文字不代表功能缺失。以剪贴板文本包含本批标题或摘要结构作为复制成功依据；不得读取旧回答或只取可视区域。只有无法定位控件或页面结构变化时，才读取一次 DOM 快照或截图。
10. 立即从临时文件写入仓库进度，并显式记录 Browser：

    ```bash
    node scripts/ima-daily-summary.cjs ingest \
      --surface browser \
      --input-file /tmp/ima-answer.txt
    ```

    `ingest` 会先排除既没有本批标题、也没有任何摘要结构的明显错误剪贴板文本。若返回 `INPUT_NOT_COPIED`，说明复制或传输错误；当前批次保持打开、失败次数不增加，应在同一回答重新执行 `…` → “复制”后再次 ingest，不得向 IMA 重复提问。只要文本呈现 IMA 回答结构，就继续由正式解析器判断来源错配、缺篇或内容失败。

11. 再次执行 `next`。若 `done=false`，回到第 4 步另开新对话；若 `done=true`，进入最终对账。

仅在以下任一条件成立时，才允许切换 IMA App：

- 无法连接或控制内置 Browser；
- IMA Web 登录不可用，但 IMA App 已登录；
- 页面结构变化导致无法定位输入框、新对话按钮、新增回答或 `…` → “复制”；缺少“复制”文字或误入分享面板不能单独作为切换理由；
- 已回到新增回答底部操作区重试 `…` → “复制”，并在一次全新对话重试后仍无法从 Browser 剪贴板取得完整回答文本。

切换时保留同一个待处理批次，不增加单篇失败次数：

```bash
node scripts/ima-daily-summary.cjs next --surface app
```

然后在 IMA App 的当天目录另开新对话，只提交一次同一 Prompt。回答完整后点击 `…` → “复制”，再执行：

```bash
pbpaste | node scripts/ima-daily-summary.cjs ingest --surface app
```

`pbpaste` 仅用于 IMA App 兜底；Browser 主路径必须使用 Browser 剪贴板和 `--input-file`，避免两个剪贴板不同步。

来源不符、回答内容质量差、IMA 全局限流或资料额度耗尽，不属于 Browser 故障，不得靠切换 App 绕过。

关键不变量：

- 每个新对话只有一次用户提问；
- 每批最多 5 篇，尾批按实际剩余数量生成；
- 用 `source_title` 精确映射 `media_id`，不依赖数组顺序；
- 同批某篇缺失或格式异常只失败该篇，其余有效记录立即保存；
- 已 `reviewed` 的记录不会再次进入待处理清单；
- 失败记录优先于未处理记录，达到上限后保留 `UNREVIEWED`。

## 5. 失败与停止

普通超时、复制失败、JSON 不完整或页面结构变化：

```bash
node scripts/ima-daily-summary.cjs fail-batch \
  --code ANSWER_TIMEOUT \
  --message "简短说明" \
  --surface browser
```

如果属于 Browser 控制或完整提取故障，先按上一节切换 App，不要先把整批记为内容失败。若 App 也失败，再运行 `fail-batch --surface app`。普通内容失败必须在当天目录另开新对话重试，不得在原对话追问。连续 3 批出现同类页面或来源系统性错误时停止当天 UI 循环并保留进度。

登录失效：

```bash
node scripts/ima-daily-summary.cjs fail-batch --code LOGIN_REQUIRED
```

资料次数上限、请求过于频繁或全局限流：

```bash
node scripts/ima-daily-summary.cjs fail-batch --code GLOBAL_LIMIT
```

`LOGIN_REQUIRED` 和 `GLOBAL_LIMIT` 不增加单篇重试次数，记录后必须立即停止，不得继续提问或下载。下次执行会从同一日期的进度继续。

## 6. 最终快照、正文排序与检查

批次全部处理或本次运行需要安全收尾时执行：

```bash
node scripts/ima-daily-summary.cjs finalize
node scripts/ima-daily-summary.cjs status
```

`finalize` 总是先写入一行对应一个 `media_id` 的权威摘要快照，再调用 DeepSeek 做唯一一次正文排序，生成日期化摘要队列，并汇总当月所有日期化摘要队列覆盖更新月度 P0–P3 HTML。不再生成标题排序基线、第二轮 rerank 或标题/正文对照。进入正文排序的最低条件是：

- `status=reviewed`；
- `summary_role=routing_candidate`；
- `source_match=true`；
- `executive_summary` 非空。

证据、标签或其他字段不足记录为警告，不因本轮模糊筛选而轻易拒绝；无法解析、文件名缺失/重复或摘要为空的记录保持 `UNREVIEWED`。不得用标题评级静默填补摘要失败项。

当天汇总至少报告：

- 日期和当天文件夹；
- 实际使用 Browser / App 的批次数及切换原因；
- 索引总数、`reviewed` / `UNREVIEWED`；
- 可重试失败 / 终止失败；
- 单轮正文排序模型及 P0/P1/P2/P3 数量；
- 当月 HTML 路径；
- 当日下载额度开始 / 结束用量；
- 各优先级下载成功数；
- 第 31 篇是否尝试，以及成功或额度拒绝结果；
- 是否因登录或限流停止；
- 是否提交及 commit hash；
- 需要用户处理的事项。

## 7. 自动下载与 Git

默认在摘要排序完成后自动下载：P0/P1 优先，若当天普通额度仍有空余则用 P2 补足。P3 不进入自动下载。

```bash
node scripts/sync-kb-pdfs.cjs download-queue \
  --kb "环球研报直通车" \
  --queue manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl \
  --priorities P0,P1,P2 \
  --daily-budget 30 \
  --quota-probe-extra 1
```

下载仍必须按 `media_id` 重新调用 `get_media_info`，保持原目录和文件名，成功/失败立即写入既有下载清单。`manifests/download-attempts.jsonl` 按上海日期记录普通额度基线和后续每次真实尝试，使中断续跑不会重新获得 30 次本地预算。

普通额度累计达到 30 次后，只允许第 31 篇作为上限探测：

- 第 31 篇成功：记录 `quota_may_have_increased=true`，但仍立即停止，不尝试第 32 篇；
- 第 31 篇返回 IMA 获取上限：记录拒绝并立即停止；
- 第 31 篇发生其他失败：同样停止，不用另一篇替代探测。

默认不自动提交 Git。只有 `auto_git_commit=true` 时，自动任务才可只暂存当天日期产物和本次新增下载，运行 `git diff --cached --check` 后创建窄提交。不得提交 `.env`、旧日期未跟踪文件或运行前已有的无关改动。
