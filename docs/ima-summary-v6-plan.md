# IMA 摘要 v6 改造方案（交付 Codex 执行）

目标：把 IMA 单篇摘要从「强制 JSON」切换到「固定小标题的自然语言」，并在本地补一个 section 解析器，使
`key_findings` / `data_points` / `entities` / `content_tags` 重新有值，同时堵住「错误文本被当成合法摘要」的漏洞。

改动必须一次性完成。只上 v6 prompt 而不改解析器，会比现状更差：IMA 的小标题会原样落进
`executive_summary`，月度页面上出现一段带「核心摘要 / 关键结论」字样的纯文本。

---

## 1. 现状与问题

数据链路：

```
ima-daily-summary.cjs next   → 渲染 prompt（PROMPT_PATH）
IMA（Hy3 快速模式，当天目录，1 篇/对话，只问一次）
ima-daily-summary.cjs ingest → parseBatchAnswer → validateAndNormalizeSuccess
                             → manifests/report-summaries-YYYYMMDD.jsonl
sync-kb-pdfs.cjs rank-ai     → DeepSeek 正文排序 → ai-ranked-queue-summary-YYYYMMDD.jsonl
render-ai-ranking-html.cjs   → ai-ranking-analysis-YYYYMM.html
```

当前 `scripts/ima-daily-summary.cjs:365` 的 `parseBatchAnswer` 在 JSON 解析失败且只有 1 篇时，
把**整段原文塞进 `executive_summary`**，其余五个数组置空。由此产生四个问题：

| 问题 | 位置 | 后果 |
| --- | --- | --- |
| 结构化字段全空 | `ima-daily-summary.cjs:376-381` | DeepSeek 只拿到一段自然语言；月度页面的关键结论/重要数字/标签/实体四个板块空白 |
| 排序 prompt 与输入不符 | `sync-kb-pdfs.cjs:430` | 写着「优先依赖 evidence 的原文连续摘录」，而 evidence 恒为空 |
| 长度告警必然触发 | `report-summaries.cjs:277` | 窗口 120—200 字，自然语言必然超出 |
| **错误文本被判 reviewed** | `sync-kb-pdfs.cjs:788` | `NO_CONTENT`、「我没有找到该文件」都是非空字符串 → 进入排序输入 |

第四条违反 CLAUDE.md 的「正文排序失败项保持 UNREVIEWED，不得静默兜底」。

---

## 2. 改动清单（5 个文件）

### 2.1 `prompts/ima-download-screen-summary-batch-v6.txt`

文件已存在（未提交）。**保持现有内容不动**，只把首行的硬编码 `1` 换成占位符，便于将来放大批量：

```
读这{{REPORT_COUNT}}篇研报，写一份摘要，用于主题排序和PDF下载筛选：
```

其余部分原样保留。完整定稿内容：

```
读这{{REPORT_COUNT}}篇研报，写一份摘要，用于主题排序和PDF下载筛选：

{{FILE_LIST}}

只用这篇的内容，不引用其他文件或外部信息。按下面5个小标题作答，小标题单独成行、原样保留：

文件名
核心摘要
关键结论
重要数字
关键实体与标签

核心摘要写一段，讲清核心观点、评级或展望、主要变化和驱动、影响路径、催化剂与风险，不要只复述标题。
关键结论用“- ”列2—5条。
重要数字用“- ”列出，保留原文数值、单位和期间，注明是实际、预测、指引还是估值。
关键实体与标签用“- ”列公司、产品、技术、行业、地区，以及适用的主题标签。
读不到这篇正文时，只回答一行：NO_CONTENT
```

设计要点，改 prompt 时不要破坏：

- 无字数下限、无固定条数、不要求原文引文——这三项是历史上导致 IMA「找到 41 篇资料后不生成正文」的主因。
- 不出现 JSON、不出现字段枚举名。
- `NO_CONTENT` 是唯一的失败出口，必须保留在最后一行。
- 小标题必须是这 5 个中文词，解析器按它们切段。

### 2.2 `scripts/report-summaries.cjs`

新增导出 `parseSectionAnswer(rawAnswer, expectedTitle)`，并调整两个常量。

**(a) 放宽长度告警**（第 277 行附近）：

```js
if (executiveSummary && (executiveSummary.length < 80 || executiveSummary.length > 600)) {
  warnings.push(`executive_summary_length:${executiveSummary.length}`);
}
```

**(b) 默认 prompt_version** 两处（第 330、363 行附近）从 `ima-download-screen-summary-batch-v5`
改为 `ima-download-screen-summary-batch-v6`。

**(c) 新增 section 解析器**。参考实现（可优化，但字段语义和失败码必须一致）：

```js
const SECTION_ALIASES = new Map([
  ['文件名', 'source_title'],
  ['报告文件名', 'source_title'],
  ['核心摘要', 'executive_summary'],
  ['摘要', 'executive_summary'],
  ['关键结论', 'key_findings'],
  ['主要结论', 'key_findings'],
  ['重要数字', 'data_points'],
  ['关键数字', 'data_points'],
  ['重要数据', 'data_points'],
  ['关键实体与标签', 'entities'],
  ['关键实体和标签', 'entities'],
  ['关键实体/标签', 'entities'],
  ['关键实体、标签', 'entities'],
  ['关键实体', 'entities'],
  ['实体与标签', 'entities'],
]);

const TAG_KEYWORDS = new Map([
  ['financials', ['财务', '业绩', '营收', '收入', '利润', '毛利', '现金流']],
  ['guidance', ['指引', '展望', 'guidance', '预期区间']],
  ['rating_valuation', ['评级', '目标价', '估值', 'valuation', '买入', '增持', '中性']],
  ['segment_product', ['分部', '业务线', '产品线', '产品结构']],
  ['supply_demand', ['供需', '需求', '供给', '产能', '库存', '订单', '价格']],
  ['consensus_comparison', ['一致预期', '市场预期', 'consensus', '超预期', '低于预期']],
  ['catalysts_risks', ['催化', '风险', '不确定性', '下行', '上行风险']],
  ['macro_policy', ['宏观', '政策', '关税', '利率', '汇率', '财政', '监管']],
  ['industry_structure', ['竞争格局', '份额', '行业结构', '集中度', '壁垒']],
]);

const BASIS_KEYWORDS = new Map([
  ['actual', ['实际', '实绩', '已实现', '同比', '环比', '报告期']],
  ['forecast', ['预测', '预计', '我们预期', '模型', 'E)', '26E', '27E']],
  ['guidance', ['指引', '公司预计', '管理层预期']],
  ['valuation', ['估值', '目标价', 'PE', 'PB', 'EV/EBITDA', 'DCF']],
]);

function normalizeHeadingLine(line) {
  return String(line || '')
    .replace(/^\s*[#>*\-•·]+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*\d+[.、)]\s*/, '')
    .replace(/[：:]\s*$/, '')
    .trim();
}

function stripBullet(line) {
  return String(line || '')
    .replace(/^\s*[-*•·–—]\s*/, '')
    .replace(/^\s*\d+[.、)]\s*/, '')
    .replace(/\*\*/g, '')
    .trim();
}

function normalizeTitleForCompare(value) {
  return String(value || '')
    .replace(/[《》"'"'\s]/g, '')
    .replace(/\.pdf$/i, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[，,]/g, ',')
    .toLowerCase();
}

function splitSections(rawAnswer) {
  const text = stripCitationArtifacts(rawAnswer);
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const heading = SECTION_ALIASES.get(normalizeHeadingLine(line));
    if (heading) {
      current = heading;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current && line.trim()) sections.get(current).push(line.trim());
  }
  return sections;
}

function classifyEntityLine(item, entities, contentTags) {
  const lowered = item.toLowerCase();
  let matched = false;
  for (const [tag, keywords] of TAG_KEYWORDS) {
    if (keywords.some((keyword) => lowered.includes(keyword.toLowerCase()))) {
      if (!contentTags.includes(tag)) contentTags.push(tag);
      matched = true;
    }
  }
  if (!matched && item.length <= 40) entities.push(item);
}

function parseDataPointLine(line) {
  const context = stripBullet(line);
  if (!context) return null;
  let basis = '';
  for (const [key, keywords] of BASIS_KEYWORDS) {
    if (keywords.some((keyword) => context.includes(keyword))) { basis = key; break; }
  }
  const separator = context.search(/[：:]/);
  const metric = separator > 0 ? context.slice(0, separator).trim() : '';
  const remainder = separator > 0 ? context.slice(separator + 1).trim() : context;
  const valueMatch = remainder.match(/[-+]?\d[\d,.]*\s*(?:%|亿|万亿|万|美元|元|日元|欧元|港元|倍|个百分点|bps|pp)?/);
  const periodMatch = context.match(/(20\d{2}\s*[-—/]?\s*(?:年)?(?:[1-4]?Q|[一二三四]季度|H[12]|上半年|下半年)?E?|[1-4]Q\s*?20\d{2}|FY\s*?20\d{2}|20\d{2}E)/);
  return {
    metric: metric || context.slice(0, 24),
    value_text: valueMatch ? valueMatch[0].trim() : '',
    period: periodMatch ? periodMatch[0].trim() : '',
    basis,
    context,
  };
}

// 返回值与 mapBatchReports 的单元素结果同构：
//   { title, report, warnings } 或 { title, failure_code, error }
function parseSectionAnswer(rawAnswer, expectedTitle) {
  const text = stripCitationArtifacts(rawAnswer);
  if (/^\s*NO_CONTENT\s*$/m.test(text) && text.replace(/\s/g, '').length <= 40) {
    return { title: expectedTitle, failure_code: 'CONTENT_UNREADABLE', error: 'answer is NO_CONTENT' };
  }
  const sections = splitSections(text);
  const warnings = ['section_answer_parsed'];

  const summary = (sections.get('executive_summary') || []).map(stripBullet).filter(Boolean).join('');
  if (!summary) {
    return { title: expectedTitle, failure_code: 'MISSING_SUMMARY_SECTION', error: 'no 核心摘要 section' };
  }

  const answerTitleRaw = (sections.get('source_title') || []).map(stripBullet).filter(Boolean).join(' ');
  let sourceTitle = expectedTitle;
  if (!answerTitleRaw) {
    warnings.push('source_title_section_missing');
  } else if (normalizeTitleForCompare(answerTitleRaw) !== normalizeTitleForCompare(expectedTitle)) {
    return { title: expectedTitle, failure_code: 'SOURCE_TITLE_MISMATCH', error: `answer title: ${answerTitleRaw}` };
  } else if (answerTitleRaw.replace(/[《》]/g, '') !== expectedTitle) {
    warnings.push('source_title_normalized');
  }

  const keyFindings = (sections.get('key_findings') || []).map(stripBullet).filter(Boolean);
  if (!keyFindings.length) warnings.push('empty_key_findings_section');

  const dataPoints = (sections.get('data_points') || []).map(parseDataPointLine).filter(Boolean);
  if (!dataPoints.length) warnings.push('empty_data_points_section');

  const entities = [];
  const contentTags = [];
  for (const line of sections.get('entities') || []) {
    for (const item of stripBullet(line).split(/[、,，/｜|]/).map((part) => part.trim()).filter(Boolean)) {
      classifyEntityLine(item, entities, contentTags);
    }
  }
  if (!entities.length) warnings.push('empty_entities_section');
  if (!sections.has('entities')) warnings.push('answer_possibly_truncated');

  return {
    title: expectedTitle,
    report: {
      source_title: sourceTitle,
      report_type: 'other',
      research_subject: '',
      executive_summary: summary,
      key_findings: keyFindings,
      content_tags: contentTags,
      data_points: dataPoints,
      entities,
      evidence: [],
    },
    warnings,
  };
}
```

导出：在 `module.exports` 加上 `parseSectionAnswer`（以及测试需要的 `splitSections` 可选）。

关键约定，不要改：

- **`source_title` 只在归一化后完全相等时才回填 expected 值**。归一化只去掉书名号、空白、`.pdf` 后缀和全半角括号/逗号差异。
  完全对不上就判 `SOURCE_TITLE_MISMATCH` 失败，不许模糊匹配后静默通过——`rank-ai` 用
  `source_match === true` 过滤，静默兜底等于把错篇送进排序。
- `evidence` 恒为空数组。v6 不要求原文引文，`validateAndNormalizeSuccess` 只会加一条 `no_evidence` 警告，不影响 reviewed。
- `report_type` 固定 `other`，`research_subject` 留空，各产生一条既有警告。不要为了消警告去猜。

### 2.3 `scripts/ima-daily-summary.cjs`

**(a) 常量**（第 23-24 行）：

```js
const PROMPT_PATH = path.join(ROOT, 'prompts', 'ima-download-screen-summary-batch-v6.txt');
const PROMPT_VERSION = 'ima-download-screen-summary-batch-v6';
```

**(b) 替换 `parseBatchAnswer`（第 365-385 行整段）**，删除现有的「整段原文塞进 executive_summary」兜底：

```js
function parseBatchAnswer(rawAnswer, titles) {
  try {
    return mapBatchReports(parseStrictJson(rawAnswer), titles);
  } catch (error) {
    if (titles.length !== 1) throw error;
    return [parseSectionAnswer(rawAnswer, titles[0])];
  }
}
```

JSON 优先、section 兜底的顺序要保留：这样 v2/v5 时期留下的 JSON 答案仍可复现，回滚也不需要动解析器。

从 `./report-summaries.cjs` 的 require 列表里加入 `parseSectionAnswer`。

**(c) 失败码**：`CONTENT_UNREADABLE`、`MISSING_SUMMARY_SECTION`、`SOURCE_TITLE_MISMATCH` 都是**单篇内容失败**，
必须计入 attempts，**不要**加进 `GLOBAL_STOP_CODES`（那是登录失效、限流这类全局停止用的）。
`commandIngest` 现有的失败分支（第 470 行起）已经能直接消费 `item.failure_code`，无需改动。

### 2.4 `scripts/sync-kb-pdfs.cjs`

第 430 行那句与实际输入矛盾，改为：

```
通用摘要、关键结论、关键数据、实体都是尚未经过 PDF 级正式验证的路由候选。evidence 可能为空，为空时以通用摘要和关键结论中的具体事实与数字为准，不得因缺少原文引文而系统性压低评级。
```

其余排序规则（P0—P3 定义、假阳性检查、results 等长同序）一律不动。

### 2.5 `config/ima-daily-summary.json`

保持 `"max_batch_size": 1`。v6 与 section 解析器目前只支持单篇；`titles.length > 1` 时会走 JSON 分支并以
`INVALID_JSON` 失败，这是预期行为。

---

## 3. 测试（`tests/ima-daily-summary.test.cjs`）

现有第 67-96 行两个用例会失败，需要改写：

- `dynamic prompt keeps core content requirements...`：断言改为匹配 v6 文案
  （`/读这2篇研报/`、`/核心摘要/`、`/关键结论/`、`/重要数字/`、`/关键实体与标签/`、`/NO_CONTENT/`，
  并保留 `assert.doesNotMatch(prompt, /\{\{REPORT_COUNT\}\}|\{\{FILE_LIST\}\}/)`）。
- `ingest wraps a single natural-language IMA answer as a reviewed summary`：删除，由下面的新用例取代。

新增用例：

1. **标准小标题答案** → `reviewed`，且 `key_findings.length >= 2`、`data_points.length >= 1`、
   `entities.length >= 1`、`executive_summary` 不含「核心摘要」四个字。
2. **markdown 变体**（`## 核心摘要`、`**关键结论**`、`1. ` 编号列表、`•` 项目符号）→ 与用例 1 等价结果。
3. **`NO_CONTENT`** → `failed = 1`，failures 里 `failure_code === 'CONTENT_UNREADABLE'`，progress 不新增记录。
4. **文件名段落写错**（换成另一个文件名）→ `SOURCE_TITLE_MISMATCH`，progress 不新增记录。
5. **文件名带书名号、缺 `.pdf` 后缀** → `reviewed`，warnings 含 `source_title_normalized`。
6. **缺「核心摘要」段的闲聊答案**（例如「我没有找到该文件」）→ `MISSING_SUMMARY_SECTION`，**不得**进 progress。

跑：

```bash
node --test tests/*.test.cjs
```

---

## 4. IMA 闭环验证（Codex 执行）

素材用 7.24：`manifests/report-summary-browser-failures-20260724.jsonl` 有 38 条 `ANSWER_TIMEOUT`，
正好是 v2 强约束下卡住的样本，是最严格的回归集。

必须遵守 `docs/ima-daily-summary-runbook.md` 和 CLAUDE.md：当天目录、Hy3 快速模式、关闭联网搜索、
**每篇新建独立对话且只问一次**，不在原对话追问。

```bash
node scripts/ima-daily-summary.cjs next --date 20260724 --batch-size 1 --surface browser
```

把返回的 `prompt` 原样发给 IMA，取回完整答案后：

```bash
pbpaste | node scripts/ima-daily-summary.cjs ingest --date 20260724 --surface browser
```

逐篇检查 `manifests/report-summaries-20260724.jsonl` 里新写入的记录。

**验收标准（连续 5 篇）：**

- ≥4 篇 `status === "reviewed"`；
- 这些 reviewed 记录里，`key_findings.length >= 2` 且 `data_points.length >= 1` 且 `entities.length >= 1` 的占比 ≥80%；
- `executive_summary` 不含小标题残留（「核心摘要」「关键结论」「重要数字」「关键实体」）；
- `validation_warnings` 里不出现 `natural_language_answer_wrapped`（该分支已删除，出现即代表改动没生效）；
- 单篇 IMA 端到端耗时明显低于 v2 时期的超时阈值，不再出现「找到 N 篇资料后不生成正文」。

未达标时先看是 prompt 还是解析器的问题：把 `raw_answer` 打出来，若 IMA 输出正常但字段空 → 解析器；
若 IMA 又卡在检索阶段 → 继续删 prompt 约束，优先删「重要数字」那条对口径的要求，再删「关键实体与标签」。

失败/中断处理照旧：

```bash
node scripts/ima-daily-summary.cjs fail-batch --date 20260724 --code <CODE> --surface browser
node scripts/ima-daily-summary.cjs status --date 20260724
```

遇到登录失效或全局限流立即停止当天循环。

验证通过后再跑排序与页面：

```bash
node scripts/ima-daily-summary.cjs finalize --date 20260724
```

检查 `manifests/ai-ranked-queue-summary-20260724.jsonl` 与 `manifests/ai-ranking-analysis-202607.html`：
页面卡片上「关键结论」「重要数字」「标签」「实体」四个板块必须有内容。

**排序质量抽查**：从 v2 时期已 reviewed 的日子（7.20 或 7.26，两天都是 0 条空摘要）挑 10 篇 P0/P1，
确认 v6 改造后同类研报的优先级没有系统性下滑。若 P0 数量骤降，先怀疑 2.4 的排序 prompt 那句没改到位。

---

## 5. 提交与回滚

提交内容（CLAUDE.md 要求当天筛选结果和月度页面必须保留并提交）：

- `prompts/ima-download-screen-summary-batch-v6.txt`（新增）
- `prompts/ima-download-screen-summary-batch-v5.txt`（当前未跟踪；一并提交，作为 v6 未达标时的回滚目标）
- `prompts/ima-download-screen-summary-batch-v2.txt`（已删除，一并提交删除）
- `scripts/report-summaries.cjs`、`scripts/ima-daily-summary.cjs`、`scripts/sync-kb-pdfs.cjs`
- `tests/ima-daily-summary.test.cjs`
- `config/ima-daily-summary.json`
- 当天的 `manifests/report-summar*`、`ai-ranked-queue-summary-*.jsonl`、`ai-ranking-analysis-202607.html`
- 本文件 `docs/ima-summary-v6-plan.md`

不要提交 `.env`。

**回滚**：把 `PROMPT_PATH` / `PROMPT_VERSION` 改回 v5 即可，section 解析器保留无害（JSON 分支优先）。
真正不可回滚的只有已写入 manifests 的记录——所以验证阶段每次只跑 1 篇，确认字段正确再继续。
