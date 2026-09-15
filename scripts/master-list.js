import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { readJournalLibrary, DEFAULT_LIBRARY_ROOT } from '../src/services/journalLibrary.js';
import { repairSummary } from '../src/services/repairState.js';
import { safeSearchLink } from '../src/services/searchSources.js';
import { isIsoTime } from '../src/services/libraryValidation.js';

const HELP = `论文总名册（只读，不联网、不读密钥、不修改正式数据）
  node scripts/master-list.js --status
  node scripts/master-list.js --list
  node scripts/master-list.js --unresolved
  node scripts/master-list.js --unresolved --due
可选：--journal AER；--root 指向离线测试库。
待办分页：--limit 1000 --offset 0；返回总数与has_more，不会把一页误称全部。
多页到期清单使用相同--as-of（首份输出的query_at），并核对snapshot_sha256一致。输出JSON，可供以后Codex集中读取。`;

export function parseMasterArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, status: { type: 'boolean' }, list: { type: 'boolean' }, unresolved: { type: 'boolean' },
    due: { type: 'boolean' }, journal: { type: 'string' }, root: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, 'as-of': { type: 'string' }
  } });
  if (values.help || !Object.keys(values).length) return { mode: 'help' };
  if (['status', 'list', 'unresolved'].filter(key => values[key]).length !== 1 || (values.due && !values.unresolved)) throw new Error('请选择一种只读模式，--due只能用于待办清单');
  if ((values.limit !== undefined || values.offset !== undefined || values['as-of'] !== undefined) && !values.unresolved) throw new Error('分页仅用于待办清单');
  if (values['as-of'] !== undefined && (!isIsoTime(values['as-of']) || !/Z$/.test(values['as-of']))) throw new Error('查询时刻必须是带Z的UTC时间');
  const limit = Number(values.limit ?? 1000), offset = Number(values.offset ?? 0);
  if (!/^\d+$/.test(values.limit ?? '1000') || !/^\d+$/.test(values.offset ?? '0') ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('分页参数无效');
  return { ...values, limit, offset, mode: values.list ? 'list' : values.unresolved ? 'unresolved' : 'status' };
}

const select = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
function repairContexts(library) {
  const contexts = new Map((library.masterList?.entries || []).map(row => [row.id,
    select(row, ['title', 'doi', 'authors', 'journal_name', 'publication_year', 'publication_month', 'discovery_sources', 'missing_fields', 'conflicts'])]));
  const logs = new Map((library.enrichments || []).map(log => [log.run_id, log]));
  for (const paper of library.papers || []) {
    const context = contexts.get(paper.id); if (!context) continue;
    context.evidence_sources = paper.source_records.flatMap(record => {
      const url = safeSearchLink(record.source_evidence?.url || record.url);
      return url ? [{ source: record.source, source_id: record.source_id, url,
        ...select(record.source_evidence, ['method', 'fetched_at', 'body_sha256']) }] : [];
    });
  }
  for (const report of [...(library.enrichmentReports || [])].sort((a, b) => a.run_id.localeCompare(b.run_id))) {
    for (const repair of report.repairs || []) {
      const context = contexts.get(repair.paper_id); if (!context) continue;
      context.last_repair = { run_id: report.run_id, checked_at: logs.get(report.run_id)?.finished_at || null,
        ...select(repair, ['status', 'changed_fields', 'missing_fields', 'requested_fields']),
        attempts: (repair.attempts || []).map(attempt => select(attempt,
          ['source', 'status', 'stage', 'called', 'leads_returned', 'leads_checked', 'lead_statuses'])) };
    }
  }
  return contexts;
}

export async function runMasterCommand(args, { log = console.log, read = readJournalLibrary, now = () => new Date() } = {}) {
  const options = parseMasterArgs(args);
  if (options.mode === 'help') { log(HELP); return 0; }
  const config = await loadJournalConfig();
  const journal = options.journal?.toUpperCase();
  if (journal && !config.journals.some(row => row.key === journal)) throw new Error('期刊缩写无效');
  const library = await read({ root: options.root || DEFAULT_LIBRARY_ROOT, config });
  const match = row => !journal || (row.journal || row.journal_key) === journal;
  if (options.mode === 'list') log(JSON.stringify({ ...library.masterList, entries: (library.masterList?.entries || []).filter(match) }, null, 2));
  else if (options.mode === 'unresolved') {
    const exportedAt = now(), checkedAt = options['as-of'] ? new Date(options['as-of']) : exportedAt;
    if (!(exportedAt instanceof Date) || !Number.isFinite(exportedAt.getTime())) throw new Error('待办查询时间无效');
    const issues = Object.values(library.repairState.issues).filter(issue => issue.status !== 'resolved' && match(issue) &&
      (!options.due || !issue.next_retry_at || Date.parse(issue.next_retry_at) <= checkedAt.getTime())).sort((a, b) => a.id.localeCompare(b.id));
    const papers = repairContexts(library), page = issues.slice(options.offset, options.offset + options.limit);
    const catalogTasks = Object.values(library.enrichmentState?.catalog_search || {}).filter(row => match(row) &&
      row.status !== 'catalog_checked_partial' && (!options.due || Date.parse(row.next_retry_at) <= checkedAt.getTime()));
    const latestCatalogs = new Map();
    for (const report of [...(library.enrichmentReports || [])].sort((a, b) => a.run_id.localeCompare(b.run_id))) {
      for (const row of report.journals || []) if (match(row)) latestCatalogs.set(row.journal_key, row);
    }
    const pendingDiscoveries = [...latestCatalogs.values()].filter(row => {
      const checks = Object.values(library.enrichmentState?.catalog_search || {}).filter(check => check.journal_key === row.journal_key);
      return !options.due || !checks.length || checks.some(check => Date.parse(check.next_retry_at) <= checkedAt.getTime());
    }).flatMap(row => row.entries.filter(entry => entry.status === 'pending')
      .map(entry => ({ journal_key: row.journal_key, ...entry })));
    log(JSON.stringify({ schema_version: 2, automatic_queue: true, manual_review_required: false,
      exported_at: exportedAt.toISOString(), query_at: checkedAt.toISOString(), snapshot_sha256: library.pointer?.manifest?.sha256 || null,
      issue_count: issues.length, paper_count: new Set(issues.map(issue => issue.paper_id)).size,
      returned_issue_count: page.length, offset: options.offset, limit: options.limit,
      has_more: options.offset + page.length < issues.length, catalog_pagination: 'not_paginated',
      catalog_tasks: catalogTasks, pending_discoveries: pendingDiscoveries,
      issues: page.map(issue => ({ ...issue, ...papers.get(issue.paper_id) })) }, null, 2));
  } else log(JSON.stringify({ initialized: Boolean(library.pointer), persisted: Boolean(library.manifest?.master_list),
    generated_at: library.masterList?.generated_at || null, coverage: library.masterList?.coverage || 'not_proven_complete',
    statistics: journal ? library.masterList?.journals.find(row => row.journal === journal) || null : library.masterList?.statistics || null,
    unresolved: repairSummary({ schema_version: 1, issues: Object.fromEntries(Object.entries(library.repairState.issues).filter(([, row]) => match(row))) }) }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runMasterCommand(process.argv.slice(2)); }
  catch { console.error('总名册读取失败：请检查参数、期刊缩写或正式库完整性；未输出原始错误正文。'); process.exitCode = 1; }
}
