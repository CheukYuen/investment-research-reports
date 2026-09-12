# IMA 每日摘要、正文排序与下载候选 Runbook

## 当前入口：定时打印手动提问词（2026-09-12）

每日定时任务改为北京时间 21:30 更新今天和昨天的日期索引，然后完整打印 IMA 短摘要提问词。用户手动在 IMA 提问、复制回答，再交给 Codex 或 Claude Code 处理。无需开发操作页面。此入口优先于下文保留的旧 Browser/App 全自动流程；定时运行到打印 Prompt 为止，不操作 IMA 问答界面，不调用排序、不下载、不提交 Git。

每个日期依次运行：

```bash
node scripts/ima-daily-summary.cjs prepare --date YYYYMMDD
node scripts/ima-manual-prompts.cjs --date YYYYMMDD
```

第二条命令只读取索引和已有摘要进度，不修改旧批次状态，按 `manual_batch_size`（默认30，可用 `--batch-size` 调小）生成全部待补报告的完整 Prompt。已有有效摘要跳过，失败或缺失摘要仍列出；不会因打印过 Prompt 就标记完成。30 是本轮手动操作参数，不代表已验证的 IMA 接口上限。昨天、今天按 Asia/Shanghai 计算，各自分批，不混合文件夹；索引失败如实报告，不用旧索引冒充本次更新结果。

回答采用“文件名 / 核心摘要”分段格式。优先整理该文件已有 AI 摘要，仅信息缺失或不足以说明主题时补读正文；每篇2～3句、约80～150字，最多保留1～2个带单位、期间和属性的重要数字，信息少可更短。摘要首句注明实际来自“该文件已有AI摘要”“该文件正文”或两者；此说明原样保存在 `executive_summary`，不等于本地 PDF 原文核验。列表未显示或文件名日期不同不能作为不在目录的依据；每篇只输出一次，不重启第二版答案。来源信息和正文均无法获取时输出 `NO_CONTENT`，保持待补而不是编造内容。

短摘要沿用 `executive_summary`、`summary_role=routing_candidate` 和现有排序、查询产物，不要求扩写或虚构缺失字段。手动 Prompt 不建立 `planned` 批次，收到用户回答后代理须按日期索引核对文件名，并通过现有 `report-summaries.cjs record` 接口逐篇保存合法结构化记录；不要直接调用依赖旧批次的 `ima-daily-summary.cjs ingest`，不要按顺序猜配标题或自行编造摘要。未匹配项保持待补。排序、下载分别等待用户指令，继续执行既有证据、额度和断点规则。

当前 `auto_download=false`、`auto_git_commit=false`。下文描述的全自动路径仅供用户明确要求恢复时参考；其中旧默认值不能覆盖当前配置。

执行硬约束：整个每日流程不得启动、激活或使用 Sublime Text、TextEdit 或其他文本编辑器，包括查看 Prompt、保存回答、检查临时文件和处理失败。不要用 `open`、`open -a`、`subl`、文件双击或“用默认应用打开”等方式打开文本文件。临时文件只通过程序直接读写，不在 GUI 中打开；复制或写入失败也不解除此限制。

## 1. 定位与边界

本流程每天处理 IMA 知识库「环球研报直通车」中 Asia/Shanghai 当天目录的全部 PDF，并检查前一自然日目录的新增 PDF，一并补齐处理：

```text
当天索引
→ IMA DS 快速模式（DeepSeek-V4-Flash）分批生成通用摘要
→ 逐篇写入可恢复进度
→ 生成权威日期快照
→ 基于摘要做 AI Infrastructure 正文排序
→ 生成当日排序队列并更新当月 P0–P3 HTML 与跨月份汇总导航
→ P0/P1 优先下载，P2 补足普通额度
```

IMA 摘要的角色固定为 `routing_candidate`：它只用于主题路由、PDF 下载筛选和后续原文定位，不是正式 PDF 数据提取结果。不要在 IMA 阶段生成 canonical metric、标准化单位、正式 scope 或数据库记录。

仓库配置位于 `config/ima-daily-summary.json`：

- `max_batch_size`：每次最多 10 篇；
- `browser_url`：IMA Web 的固定目标知识库入口；Browser 必须直接打开该地址，不从公共首页猜测知识库路径；
- `max_attempts`：单篇累计重试上限；
- `interaction_order`：固定为 `browser,app`，Browser 是主路径，App 仅为兜底；
- `browser_model_version` / `app_model_version`：记录摘要实际来自哪个界面；
- `auto_download`：当前 `false`，下载由用户单独发起；
- `daily_budget`：普通下载额度为 30，跨同一天续跑累计；
- `download_priorities`：默认 `P0,P1,P2`，按 P0、P1、P2 顺序消费额度；
- `quota_probe_extra`：默认 1，普通额度用满后只探测第 31 篇一次；
- `auto_git_commit`：是否由每日自动任务窄提交本次产物；当前仓库配置为 `false`。

## 2. 每日文件

`YYYYMMDD` 为研报所属目录日期，不得写死日期或篇数。当日与昨日各自保存日期产物，不混写。下载额度仍按实际执行时的上海日期累计。

```text
manifests/index-YYYYMMDD.jsonl
manifests/report-summary-browser-progress-YYYYMMDD.jsonl
manifests/report-summary-browser-failures-YYYYMMDD.jsonl
manifests/report-summary-batches-YYYYMMDD.jsonl
manifests/report-summaries-YYYYMMDD.jsonl
manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl
manifests/ai-ranking-analysis.html
manifests/ai-ranking-analysis-YYYYMM.html
manifests/search-index-YYYYMM.jsonl
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

### 3.1 定时任务：处理昨天和今天

运行开始时按 Asia/Shanghai 固定今天和前一自然日（包括跨月、跨年）。所有摘要命令显式传入目标日期 `--date YYYYMMDD`。

1. **重新索引两天目录**：分别执行 `prepare --date YYYYMMDD`，不使用 `--skip-index`。
2. **按已有进度补齐**：每个日期独立执行摘要循环，已 `reviewed` 跳过，失败优先，新增和中断记录自然进入待处理范围。UI 固定目标日期目录，每批最多 10 篇、新对话、只问一次；下文“当天目录”在补录昨日时指昨日目录。有摘要更新或排序未完成时执行该日期 `finalize`，允许补录昨日后更新其正文排序；已完整且没有变化则跳过。结果仍保存在各自日期文件中，失败保持 `UNREVIEWED`。
3. **统一优先级下载**：使用两天各自的队列，按第 7 节先 P0、再 P1、最后 P2，共用实际执行日的 30+1 次额度。跨月时刷新受影响月份的页面、检索索引和导航。

直接复用现有索引、摘要进度和排序队列，不另外保存旧索引基线或新增检查记录。目录缺失或索引失败如实报告，普通单日目录问题不阻断另一日；登录失效或全局限流立即整体停止。

### 3.2 常规 UI 操作自动授权

启动每日自动任务，即表示已授权代理在配置指定的 IMA 知识库中完成本 Runbook 定义的常规 UI 操作，包括进入日期目录、新建对话、选择既定模型和模式、粘贴仓库生成的批次 Prompt、点击发送、等待回答、复制回答并执行 `ingest`。这些动作是既定数据处理流程，不是需要用户逐批决策的对外沟通；不得在每批发送前要求人工确认，也不得仅因“即将向 IMA 发送 Prompt”而暂停。

该自动授权只覆盖本 Runbook 已限定的 IMA 摘要任务，不扩大数据范围或停止条件。发送前仍须确认当前目录、批次文件、模型、快速模式和联网关闭状态正确；只有登录失效、全局限流、IMA 资料额度拒绝、第 31 次下载硬停、目录缺失、连续系统性故障或确实需要用户选择时才暂停并报告。

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

7. 将该批次的 `prompt` 完整粘贴到 IMA，只发送一次。发送属于第 3.2 节已授权的常规自动步骤，无须另行询问用户；但必须在发送前核对当前目录与最新 `planned` 批次一致，防止把旧批次或其他日期的 Prompt 发出。
8. 等待回答停止生成，并确认“生成脑图”或回答底部操作图标已经出现；不要用固定睡眠代替完成检测。正常轮询只检查目标完成信号，不重复输出完整 DOM。
9. 在本次新增回答右下角直接点击复制图标（两个重叠方块）。由 Browser 控制端直接读取 Browser 剪贴板，再通过当前工具支持的文件写入能力，将全文直接覆盖写入仓库外的 UTF-8 临时文件 `/tmp/ima-answer.txt`。固定传输路径为：`Browser 复制 → Browser 剪贴板 → 程序写文件 → ingest`。“写入文件”不表示打开编辑器粘贴；写完也不打开文件预览。不得在 Browser 主路径使用 `pbpaste`。不要误用相邻“分享”中的“复制链接”。复制图标可能没有可见文字，DOM 中没有“复制”二字不代表功能缺失。以剪贴板文本包含本批标题或摘要结构作为复制成功依据；不得读取旧回答或只取可视区域。只有无法定位控件或页面结构变化时，才读取一次 DOM 快照或截图。
   - 先确认当前 Browser 工具文档支持的剪贴板读取和文件传输能力，不猜测 API。验证文本、编码和写入结果均使用程序，不启动 GUI 编辑器。
   - 若工具缺少直接读取剪贴板或写入文件的能力，将其视为 Browser 完整提取能力不可用，按下文保留同批次并切换 IMA App；App 也不可用时保留进度并报告。不得用编辑器中转解决能力缺失。
10. 立即从临时文件写入仓库进度，并显式记录 Browser：

    ```bash
    node scripts/ima-daily-summary.cjs ingest \
      --surface browser \
      --input-file /tmp/ima-answer.txt
    ```

    `ingest` 会先排除既没有本批标题、也没有任何摘要结构的明显错误剪贴板文本。若返回 `INPUT_NOT_COPIED`，说明复制或传输错误；当前批次保持打开、失败次数不增加，应在同一回答重新直接点击复制图标后再次 ingest，不得向 IMA 重复提问。只要文本呈现 IMA 回答结构，就继续由正式解析器判断来源错配、缺篇或内容失败。

11. 再次执行 `next`。若 `done=false`，回到第 4 步另开新对话；若 `done=true`，进入最终对账。

仅在以下任一条件成立时，才允许切换 IMA App：

- 无法连接或控制内置 Browser；
- 当前 Browser 工具缺少直接读取剪贴板或将回答文本写入临时文件的能力；
- IMA Web 登录不可用，但 IMA App 已登录；
- 页面结构变化导致无法定位输入框、新对话按钮、新增回答或复制图标；缺少“复制”文字或误入分享面板不能单独作为切换理由；
- 已回到新增回答底部操作区重试直接点击复制图标，并在一次全新对话重试后仍无法从 Browser 剪贴板取得完整回答文本。

切换时保留同一个待处理批次，不增加单篇失败次数：

```bash
node scripts/ima-daily-summary.cjs next --surface app
```

然后在 IMA App 的当天目录另开新对话，只提交一次同一 Prompt。回答完整后直接点击复制图标，再执行：

```bash
pbpaste | node scripts/ima-daily-summary.cjs ingest --surface app
```

`pbpaste` 仅用于 IMA App 兜底；Browser 主路径必须使用 Browser 剪贴板和 `--input-file`，避免两个剪贴板不同步。

来源不符、回答内容质量差、IMA 全局限流或资料额度耗尽，不属于 Browser 故障，不得靠切换 App 绕过。

关键不变量：

- 每个新对话只有一次用户提问；
- 每批最多 10 篇，尾批按实际剩余数量生成；
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

除本节和第 3.2 节列出的暂停条件外，普通的“新建对话、粘贴 Prompt、点击发送、复制回答、写入进度”不得设置人工确认点。

## 6. 最终快照、正文排序与检查

批次全部处理或本次运行需要安全收尾时执行：

```bash
node scripts/ima-daily-summary.cjs finalize
node scripts/ima-daily-summary.cjs status
```

`finalize` 总是先写入一行对应一个 `media_id` 的权威摘要快照，再调用 DeepSeek 直接基于正文摘要排序，生成日期化摘要队列，汇总当月所有日期化摘要队列覆盖更新月度 P0–P3 HTML，最后重建主题检索索引 `manifests/search-index-YYYYMM.jsonl`。用户明确要求时，允许对同一日期重新排序；新结果原子覆盖该日期队列并刷新月度页面。不得生成标题排序基线、标题/正文对照，或把一次排序拆成标题召回与 P0/P1 二阶段 rerank。进入正文排序的最低条件是：

- `status=reviewed`；
- `summary_role=routing_candidate`；
- `source_match=true`；
- `executive_summary` 非空。

证据、标签或其他字段不足记录为警告，不因本轮模糊筛选而轻易拒绝；无法解析、文件名缺失/重复或摘要为空的记录保持 `UNREVIEWED`。不得用标题评级静默填补摘要失败项。

报告类型（`report_type`）与一级行业（`sectors`）由 DeepSeek 排序阶段在同一次调用中产出，摘要阶段（IMA 通用摘要）不承担分类，恒为 `null` / `[]`。分类失败或模型返回非法值时保持 `report_type: null`，不得静默写成 `other`；`other` 是模型确认理解内容后给出的有效业务分类，与 `null`（技术性缺失）严格区分。分类校验失败不影响该记录的 P0–P3 排序结果保存。

结束时简洁报告：今天处理多少、昨天补处理多少、下载多少及当天额度用量、还有哪些未完成及原因。发生登录、限流或第 31 次停止时说明；有 Git 提交时附 commit hash。详细批次和排序结果保留在日期产物中，不逐项展开汇报。

## 7. 自动下载与 Git

默认在摘要排序完成后自动下载：P0/P1 优先，若当天普通额度仍有空余则用 P2 补足。P3 不进入自动下载。

定时任务涉及两天时保留两份日期化权威队列，不合并覆盖它们。先对昨日、当天队列分别执行 `--priorities P0`，再分别执行 `--priorities P1`，最后分别执行 `--priorities P2`（同级昨日优先）。每次均带 `--daily-budget 30 --quota-probe-extra 1`，共用同一下载尝试账本，不能给每个日期或优先级重置预算。昨日完整且无新增时也可消费其已有队列中的未下载候选，不必重复摘要或排序。任一调用到达第 31 次、额度拒绝、登录失效或全局限流，立即停止所有后续下载调用。不要让某一天的 P2 抢占另一日 P0/P1 的额度。

```bash
node scripts/sync-kb-pdfs.cjs download-queue \
  --kb "环球研报直通车" \
  --queue manifests/ai-ranked-queue-summary-YYYYMMDD.jsonl \
  --priorities P0,P1,P2 \
  --daily-budget 30 \
  --quota-probe-extra 1
```

下载仍必须按 `media_id` 重新调用 `get_media_info`，保持原目录和文件名，成功/失败立即写入既有下载清单。`manifests/download-attempts.jsonl` 按上海日期记录普通额度基线和后续每次真实尝试，使中断续跑不会重新获得 30 次本地预算。

`download-queue` 结束后会根据日期化 queue 自动重新生成对应月份的 `ai-ranking-analysis-YYYYMM.html`，覆盖更新跨月份主入口 `ai-ranking-analysis.html`，并重建主题检索索引 `manifests/search-index-YYYYMM.jsonl`，以最新文件和 `downloaded.jsonl` 状态刷新“本地已有”标记。过期的检索索引比没有索引更糟，因此这一步与 HTML 刷新绑定执行。即使本次没有新的候选或因额度停止，也会执行刷新，避免页面停留在下载前快照。

普通额度累计达到 30 次后，只允许第 31 篇作为上限探测：

- 第 31 篇成功：记录 `quota_may_have_increased=true`，但仍立即停止，不尝试第 32 篇；
- 第 31 篇返回 IMA 获取上限：记录拒绝并立即停止；
- 第 31 篇发生其他失败：同样停止，不用另一篇替代探测。

只有用户在当前任务中明确要求解除 30+1 停止条件并继续下载时，才允许人工追加 `--allow-over-quota`。该参数不得写入每日自动任务配置，也不得由自动任务自行推断。启用后，超额真实尝试必须以 `quota_slot=override` 逐篇写入 `download-attempts.jsonl`；仍须按 queue 顺序下载，并在 IMA 获取上限、登录失效或全局限流时立即停止。

Git 自动提交由 `auto_git_commit` 决定。为 `true` 时，自动任务只可暂存本次处理的当天及昨日日期产物、受影响的月度页面/检索索引、导航和本次新增下载，运行 `git diff --cached --check` 后创建窄提交。不得提交 `.env`、其他旧日期未跟踪文件或运行前已有的无关改动。
