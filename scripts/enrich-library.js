import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT, readJournalLibrary } from '../src/services/journalLibrary.js';
import { runJournalEnrichment } from '../src/services/journalEnrichment.js';
import { makeEvidenceHttp } from '../src/services/evidenceHttp.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';

export async function enrichmentCommand(args, { root = DEFAULT_LIBRARY_ROOT, env = process.env, log = console.log, execute = runJournalEnrichment } = {}) {
  const { values } = parseArgs({ args,strict: true,allowPositionals: false,options: {
    help: { type: 'boolean' },status: { type: 'boolean' },run: { type: 'boolean' },save: { type: 'boolean' },
    official: { type: 'boolean' },abstracts: { type: 'boolean' },all: { type: 'boolean' },journal: { type: 'string' },
    'lookback-days': { type: 'string' },'max-abstracts': { type: 'string' },'only-if-needed': { type: 'boolean' },'github-output': { type: 'boolean' }
  } });
  if (!Object.keys(values).length || values.help) {
    log('只读：node scripts/enrich-library.js --status\n执行并保存：--run --save --all --official --abstracts --lookback-days 60 --max-abstracts 100 --only-if-needed\n可用 --journal AER 小范围核对。官网仅报告实际可核实范围；摘要只保存真实来源，不调用 AI。'); return 0;
  }
  const config = await loadJournalConfig();
  if (values.status && Object.keys(values).length === 1) {
    const library = await readJournalLibrary({ root,config });
    log(JSON.stringify({ total: library.papers.length,missing_abstracts: library.papers.filter(p => !p.abstract_original).length,
      last_official_check: library.enrichmentState.official_last_run_date || null,
      latest_enrichment: [...library.enrichments].sort((a,b) => b.started_at.localeCompare(a.started_at))[0] || null },null,2)); return 0;
  }
  if (values.status || !values.run || !values.save || (!values.official && !values.abstracts) ||
    Boolean(values.all) === Boolean(values.journal)) throw new Error('必须明确执行、保存、范围和补全类型');
  const lookbackDays = Number(values['lookback-days'] || 60), maxAbstracts = Number(values['max-abstracts'] || 100);
  if (lookbackDays !== 60) throw new Error('当前授权范围固定为最近60天');
  const http = makeEvidenceHttp();
  const result = await execute(config,{ root,journalKey: values.journal,official: Boolean(values.official),abstracts: Boolean(values.abstracts),
    lookbackDays,maxAbstracts,onlyIfNeeded: Boolean(values['only-if-needed']),http,
    sources: makeEnrichmentSources(http,{ semanticScholarKey: env.SEMANTIC_SCHOLAR_API_KEY || '' }),onProgress: progress => log(JSON.stringify(progress)) });
  log(JSON.stringify({ status: result.status,committed: result.committed,run_id: result.run_id,stats: result.stats,requests: http.count() },null,2));
  if (values['github-output']) {
    if (env.GITHUB_ACTIONS !== 'true' || !path.isAbsolute(env.GITHUB_OUTPUT || '')) throw new Error('缺少GitHub输出路径');
    await fs.appendFile(env.GITHUB_OUTPUT,`status=${result.status}\n`, 'utf8');
    if (path.isAbsolute(env.GITHUB_STEP_SUMMARY || '')) {
      const stats = result.stats || { added: 0,abstracts_filled: 0,abstracts_checked: 0 };
      const rows = (result.report?.journals || []).map(j => `| ${j.journal_key} | ${j.coverage === 'restricted' ? '访问受限/未核实' : '部分核对'} | ${j.official_observed_count ?? '未知'} | ${j.official_in_window_count} | ${j.existing_total_count} | ${j.missing_count} | ${j.added_count} | ${j.pending_count} |`).join('\n');
      await fs.appendFile(env.GITHUB_STEP_SUMMARY,`## 官网核对与真实摘要补全\n\n最近60天；订阅清单不代表完整出版目录。新增论文 ${stats.added} 篇；补得真实摘要 ${stats.abstracts_filled} / 检查 ${stats.abstracts_checked} 篇。\n\n| 期刊 | 核对范围 | 官网清单观察数（不限日期） | 60天内确认数 | 原库总数 | 确认漏收 | 补入 | 待核实 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\n完整明细保存在正式历史的 enrichment-report.json；没有摘要时不生成中文摘要。\n`,'utf8');
    }
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await enrichmentCommand(process.argv.slice(2)); }
  catch (error) { console.error(`补全未提交或执行未完成：${/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'ENRICHMENT_ERROR'}。旧版本保留；未输出密钥或远程错误正文。`); process.exitCode = 1; }
}
