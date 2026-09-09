---
name: report-search
description: |
  检索本地券商研报库（腾讯 ima 同步的投行研报，约 6200 篇）。
  当用户想找某个行业、公司、概念或主题的研报时使用，例如"光纤研报"、"找找 HBM 的报告"、
  "有没有液冷相关的"、"戴尔最近的研报"、"数据中心 P0 的都有哪些"。
  即使用户没说"研报"二字，只要是在问某个投资主题下有哪些券商/投行报告、
  或者要定位某篇研报的 PDF，也应触发此 skill。
  不要用它做正式的研报数据提取——它只负责定位 PDF。
---

# 研报主题检索

数据在 `/Users/leon/Stock/investment-research-reports`：腾讯 ima 知识库同步的券商研报，
约 6200 篇（截至 2026-09），其中约 4200 篇有 IMA 摘要和 DeepSeek 的优先级、行业、报告类型分类。

## 执行步骤

**1. 直接查。** 用户给的关键词就是查询词，不要自己改写：

```bash
node /Users/leon/Stock/investment-research-reports/scripts/search-reports.cjs query '光纤'
```

**2. 命中为空或明显偏少时，加 `--facets` 再查一次：**

```bash
node /Users/leon/Stock/investment-research-reports/scripts/search-reports.cjs query '光纤' --facets
```

`--facets` 会打印命中集合里 `topics` / `entities` / `sectors` 的词频，例如查"光纤"会带出
`光纤光缆(8) CPO(8) 光通信(6) 光模块(2)`。**用这些词重查，不要凭空猜同义词。**
中文研报里同一个主题写法很多（光纤 / 光通信 / 光模块 / 光缆 / CPO / 800G），
facets 是从数据里长出来的，比猜可靠。

**3. 汇报时每条都要给 PDF 路径**，未下载的明确说明。不要只给标题。

**4. 用户要看具体内容时**，打开 `pdf_path` 指向的 PDF 读，不要拿检索结果里的摘要顶替。

## 常用筛选

```
--priority P0,P1     优先级（P0 核心 AI 基建 → P3 弱相关）
--type company       报告类型：company/industry/strategy/macro/commodity/other
--sector 信息技术    一级行业（中证/GICS 11 类）
--month 202609       只查某月
--date 2026-09-03    只查某天快照
--downloaded         只看本地已有 PDF
--not-downloaded     只看未下载
--limit 30           输出上限，0 表示不限
--any                多关键词由 AND 改为 OR
--json               结构化输出，带 abs_path 和 repo_root
```

## 结果怎么读

每条自带 PDF 路径。从本仓库之外调用时自动给绝对路径，可直接打开；`--json` 另外返回
`abs_path` 和 `repo_root`。

标了 `NOT_DOWNLOADED media_id=...` 的，本地没有 PDF。用户需要的话，回到本仓库按 `media_id`
走 `download-queue`——**不要自己去调 IMA 接口，也不要 curl**。注意每日下载额度有限制，
无关任务不要擅自触发下载。

## 边界（重要）

`query` 返回的摘要是 **IMA 路由摘要**（`summary_role=routing_candidate`），
只用于筛选和定位 PDF，**不是正式的 PDF 数据提取**。

正式的数字、页码和证据必须打开 PDF 核对。不要把检索结果里的 `executive_summary`
或 `data_points` 直接当研报数据回答用户。

## 不要做的事

- 不要遍历 `downloads/`（约 1250 个 PDF、4.9 GB）
- 不要 grep `manifests/ai-ranking-analysis*.html`（单文件 11 MB，是给人看的网页）
- 不要跨日期逐个读 `manifests/report-summaries-*.jsonl` 或 `ai-ranked-queue-summary-*.jsonl`（各 65 个文件）
- 不要自己实现 IMA 知识库接口

## 兜底

脚本跑不起来时，索引本身就是可 grep 的 JSONL，一篇研报一行：

```bash
rg '光纤' /Users/leon/Stock/investment-research-reports/manifests/search-index-*.jsonl
```

`rg` 匹配整行（含 `media_id`、`summary_role` 等非检索字段），召回范围比 `query` 宽，
可能多召，两者不等价。

## 一个已知的坑

行业和报告类型分类**只在** `ai-ranked-queue-summary-*.jsonl` 有值。
`report-summaries-*.jsonl` 的 `report_type` / `sectors` / `topics` 恒为空，这是刻意设计
（DeepSeek 排序阶段是唯一分类权威），不是数据损坏。直接读后者做行业筛选会得到空结果。
检索索引已经处理好这件事，走 `query` 就不会踩到。

## 更详细的字段说明

`/Users/leon/Stock/investment-research-reports/docs/data-catalog.md`
