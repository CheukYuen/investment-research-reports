#!/usr/bin/env node
const fs = require('node:fs');
const { pathsForDate, loadConfig } = require('./ima-daily-summary.cjs');
const { readJsonl } = require('./report-summaries.cjs');

function buildPrompts(index, progress, summaries, batchSize, folder) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 30) {
    throw new Error('batch-size must be an integer between 1 and 30');
  }
  const latest = new Map([...summaries, ...progress].map(r => [r.media_id, r]));
  const unique = new Map();
  for (const record of index) {
    if (!record.media_id || !record.title) throw new Error('Index record lacks media_id or title');
    if (unique.has(record.media_id)) throw new Error(`Duplicate media_id: ${record.media_id}`);
    unique.set(record.media_id, record);
  }
  const pending = [...unique.values()].filter(r => {
    const prior = latest.get(r.media_id);
    return !(prior?.status === 'reviewed' && prior.source_match === true && prior.executive_summary?.trim());
  });
  const prompts = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    const records = pending.slice(i, i + batchSize);
    prompts.push(`请在当前已选文件夹“${folder}”中，返回以下 ${records.length} 篇研报的简短摘要，用于主题检索和下载初筛。

${records.map(r => r.title).join('\n')}

资料使用：
- 优先使用每份文件已有的AI摘要，信息足够就直接整理，无需逐篇重读全文。已有摘要缺失或不足以说明主题时，才补读该文件正文；两者均无法获得时输出 NO_CONTENT。不得根据标题或常识补写。
- 文件夹路径用于限定范围，不要反复检查目录层级。列表只返回部分文件，不代表其余文件不存在；文件名中的报告日期也不必等于文件夹日期。未显示的文件仅在当前文件夹内定向查找，不扩展到其他文件夹。
- 不联网，不引用其他报告或历史对话。预算不足时保留已获取结果，无法获取的文件输出 NO_CONTENT，不反复搜索或重启整份回答。

摘要要求：
- 每篇2～3句，约80～150字；原有信息较少可更短，不凑字数。先写研究对象与核心观点，再写主要变化、驱动及影响，保留具体公司、产品和技术名称，便于检索。
- 最多保留1～2个最重要的数字，连同单位、期间及实际/预测/指引属性；原有信息没提供就省略，不自行推算、换算或补充评级。
- 首句用“据该文件已有AI摘要，”“据该文件正文，”或“据该文件已有AI摘要及正文，”标明实际来源，不能把已有摘要说成已核对全文。

严格按清单顺序输出，每份文件恰好一次。只输出下面的重复文本块，不要表格、编号、内部pdf编号、检索过程、目录分析、开场白、结束语、省略号或第二版答案。输出前核对条目数与清单一致，缺失项保留文件名和 NO_CONTENT，不要省略。

文件名
<原样复制清单中的完整文件名，包含.pdf，不缩写、不改标点>
核心摘要
<带来源说明的简短摘要；无法获取内容时只写 NO_CONTENT>`);
  }
  return { indexed: index.length, pending: pending.length, prompts };
}

function main(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') {
      console.log('Usage: node scripts/ima-manual-prompts.cjs [--date YYYYMMDD] [--batch-size 30]\nReads dated index and summary progress; prints all pending short-summary prompts without changing batch state. Run ima-daily-summary.cjs prepare --date YYYYMMDD first to refresh the index.');
      return;
    }
    if (!['--date', '--batch-size'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[++i];
  }
  const paths = pathsForDate(opts.date);
  if (!fs.existsSync(paths.index)) throw new Error('Missing dated index. Run prepare --date YYYYMMDD first.');
  const result = buildPrompts(readJsonl(paths.index), readJsonl(paths.progress), readJsonl(paths.summaries), Number(opts['batch-size'] ?? loadConfig().manual_batch_size ?? 30), paths.date.sourcePath);
  console.log(`${paths.date.iso}：索引 ${result.indexed} 篇，待摘要 ${result.pending} 篇，共 ${result.prompts.length} 批。`);
  if (!result.pending) console.log(result.indexed ? '已有有效摘要，无需提问。' : '索引为空，请确认目录与索引状态。');
  result.prompts.forEach((prompt, i) => console.log(`\n### ${paths.date.iso} 第 ${i + 1}/${result.prompts.length} 批\n\n\`\`\`text\n${prompt}\n\`\`\``));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildPrompts, main };
