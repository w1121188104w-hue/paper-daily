import { readJournalLibrary, readLibraryRef, withLibraryLock, newRunId, writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';
import { assertLibrary, stableJson, validatePapers } from './libraryValidation.js';
import { translationEligibility } from './translationQueue.js';
import { translationQualityError } from './translationImport.js';
import { dateInShanghai } from './paperMerge.js';

// Restore accepted text only from the hash-verified ancestor chain, never from a
// success flag alone. No network, new translation, ledger reset, or source edit.
export async function recoverHistoricalTranslations(config, { root, state, now = () => new Date() }) {
  return withLibraryLock(root, async () => {
    let library = await readJournalLibrary({ root, config });
    const accepted = new Map();
    for (const entry of state.reservations) if (entry.finished_at) for (const item of entry.items) {
      if (!item.usage || !['succeeded', 'partial'].includes(item.status)) continue;
      for (const task of item.tasks) if (item.completed_fields.includes(task.field)) {
        const batches = accepted.get(task.task_id) || new Set();
        batches.add(entry.batch_id); accepted.set(task.task_id, batches);
      }
    }
    const pending = new Map(translationEligibility(library.papers).ready.tasks
      .filter(task => accepted.has(task.task_id)).map(task => [task.task_id, task]));
    if (!pending.size) return { recovered_fields: 0, committed: false };
    const logs = new Map(library.imports.map(log => [log.run_id, log]));
    const current = new Map(library.papers.map(paper => [paper.id, paper]));
    const plans = [], visited = new Set();
    let ref = library.pointer.manifest;
    while (ref && pending.size) {
      assertLibrary(!visited.has(ref.path), '恢复译文的历史版本链存在循环'); visited.add(ref.path);
      const manifest = await readLibraryRef(root, ref);
      assertLibrary(ref.path === `snapshots/${manifest.run_id}/manifest.json`, '恢复译文的版本身份不符');
      const log = logs.get(manifest.run_id);
      const tasks = [...pending.values()].filter(task => accepted.get(task.task_id).has(log?.batch_id));
      if (manifest.operation === 'translation_import' && log && tasks.length) {
        const report = await readLibraryRef(root, log.report);
        assertLibrary(report.batch_id === log.batch_id && stableJson(report.stats) === stableJson(log.stats), '历史译文报告不符');
        const papers = (await Promise.all(Object.values(manifest.papers).map(bucket => readLibraryRef(root, bucket)))).flat();
        validatePapers(papers, config);
        const rows = [];
        for (const task of tasks) {
          const old = papers.find(paper => paper.id === task.paper_id), paper = current.get(task.paper_id), field = task.field;
          const provenance = old?.translation_provenance?.[field];
          if (!old || old.doi !== paper.doi || old.journal_key !== paper.journal_key ||
            old[`${field}_translation_status`] !== 'done' || old[`${field}_original`] !== paper[`${field}_original`] ||
            old.source_text_hash[field] !== task.source_text_hash || provenance?.source_text_hash !== task.source_text_hash ||
            provenance.task_id !== task.task_id || provenance.batch_id !== log.batch_id ||
            provenance.model !== log.model || provenance.translated_at !== log.translated_at ||
            !report.fields.some(row => row.id === paper.id && row.field === field && ['completed', 'unchanged'].includes(row.action)) ||
            translationQualityError(paper[`${field}_original`], old[`${field}_zh`], field)) continue;
          rows.push({ task, value: old[`${field}_zh`], provenance }); pending.delete(task.task_id);
        }
        if (rows.length) plans.push({ log, ref, rows });
      }
      ref = manifest.parent;
    }
    let recovered = 0;
    for (const plan of plans) {
      const at = now(), startedAt = at.toISOString(), runId = newRunId(at);
      const papers = structuredClone(library.papers), byId = new Map(papers.map(paper => [paper.id, paper]));
      for (const { task, value, provenance } of plan.rows) {
        const paper = byId.get(task.paper_id), field = task.field;
        paper[`${field}_zh`] = value; paper[`${field}_translation_status`] = 'done';
        paper.translation_provenance ||= {};
        paper.translation_provenance[field] = { ...provenance, imported_at: startedAt };
      }
      const stats = { completed_fields: plan.rows.length, failed_fields: 0, rejected_fields: 0, rejected_rows: 0,
        unchanged_fields: 0, changed_papers: new Set(plan.rows.map(row => row.task.paper_id)).size };
      const report = { schema_version: 1, batch_id: plan.log.batch_id, status: 'success', stats,
        fields: plan.rows.map(({ task }, index) => ({ index, id: task.paper_id, field: task.field, action: 'completed', code: null, message: null })),
        recovery: { source_manifest: plan.ref, source_report: plan.log.report, paid_requests: 0 } };
      const reportRef = await writeLibraryJson(root, `snapshots/${runId}/translation-report.json`, report);
      const log = { schema_version: 1, run_id: runId, run_date: dateInShanghai(at), started_at: startedAt,
        finished_at: now().toISOString(), batch_id: plan.log.batch_id, model: plan.log.model,
        translated_at: plan.log.translated_at, status: 'success', stats, report: reportRef };
      await publishLibrarySnapshot({ root, config, previous: library, papers, translationImport: log,
        audit: library.audit, raw: library.manifest.raw });
      recovered += plan.rows.length;
      library = await readJournalLibrary({ root, config });
    }
    return { recovered_fields: recovered, committed: recovered > 0 };
  });
}
