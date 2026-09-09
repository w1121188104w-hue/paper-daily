import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { collectJournals } from '../src/services/collectJournals.js';
import { validateWindow } from '../src/services/sourceClient.js';

const HELP = `经管期刊第二阶段检查（不保存论文、不调用 AI、不读取密钥）

离线检查19刊配置：
  node scripts/journals.js

联网试抓单刊，两源都会查询：
  node scripts/journals.js --collect --journal AER --from 2026-08-01 --to 2026-08-31

可选：--max-pages 10（每源页数上限，默认10）；--all（明确选择19刊）
日期按出版日期筛选。达到页数上限视为不完整，不会当作“没有新增”。
所有结果仅在内存中合并并打印概况，结束后不保留；不会启动旧 arXiv 服务。`;

export function parseJournalArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, collect: { type: 'boolean' }, all: { type: 'boolean' },
    journal: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    'max-pages': { type: 'string' }
  } });
  if (values.help) return { help: true };
  if (!values.collect) {
    if (Object.keys(values).length) throw new Error('联网试抓需明确加 --collect；不加参数只检查配置');
    return { collect: false };
  }
  if (Boolean(values.all) === Boolean(values.journal?.trim())) {
    throw new Error('请用 --journal 指定一本期刊，或用 --all 明确选择全部19刊，二者不能同时使用');
  }
  validateWindow({ fromDate: values.from, toDate: values.to });
  const maxPages = Number(values['max-pages'] ?? 10);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('--max-pages 应为1–1000的整数');
  return { collect: true, journalKey: values.journal, fromDate: values.from, toDate: values.to, maxPages };
}

export async function runJournalCommand(args, { log = console.log, collect = collectJournals } = {}) {
  const options = parseJournalArgs(args);
  if (options.help) { log(HELP); return 0; }
  const config = await loadJournalConfig();
  if (!options.collect) {
    log(`配置检查通过：${config.journals.length} 本期刊；${config.journals.filter((j) => j.enabled).length} 本启用。`);
    log(config.journals.map((j) => `${j.key}｜${j.name}｜${j.print_issn} / ${j.electronic_issn}｜${j.openalex_source_id}`).join('\n'));
    log('此检查仅验证本地配置格式和唯一性；未联网，未改动数据。');
    return 0;
  }
  const { collect: _collect, ...requestOptions } = options;
  log('开始联网试抓。仅使用公开接口；每本期刊分别查询 OpenAlex 和 Crossref。');
  const result = await collect(config, requestOptions);
  log(JSON.stringify({ mode: 'dry_run', status: result.status,
    from_date: result.from_date, to_date: result.to_date, checked_at: result.checked_at,
    stats: result.stats, paper_count: result.papers.length, audit_count: result.audit.length,
    sources: result.source_results.map(({ source, journal_key, ok, complete, raw_count, records, raw_pages, rejected, error }) =>
      ({ source, journal_key, ok, complete, raw_count, accepted_count: records.length,
        pages: raw_pages.length, rejected_count: rejected.length, error })),
    sample: result.papers.slice(0, 2).map(({ doi, title_original, sources, title_translation_status, abstract_translation_status }) =>
      ({ doi, title_original, sources, title_translation_status, abstract_translation_status }))
  }, null, 2));
  log('试抓结束：没有写入正式论文库；没有生成翻译或部署网站。每次试抓都从空的内存集合开始，统计不能当作每日新增数。');
  return ['success', 'no_updates'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runJournalCommand(process.argv.slice(2)); }
  catch (error) { console.error(`检查未完成：${error.message}`); process.exitCode = 1; }
}
