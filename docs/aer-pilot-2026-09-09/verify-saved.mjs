// Read-only acceptance for this first five-paper import, relative to its recorded baseline.
// It deliberately fails if a later collection/import changes this specific acceptance state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadJournalConfig } from '../../src/services/journals.js';
import { readJournalLibrary, readLibraryRef, DEFAULT_LIBRARY_ROOT as root } from '../../src/services/journalLibrary.js';
import { importTranslationFile } from '../../src/services/translationWorkflow.js';
import { translationEligibility } from '../../src/services/translationQueue.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const before = await json(path.join(here, 'before-save.json'));
const baseline = await json(path.join(here, 'baseline.json'));
const config = await loadJournalConfig();
const current = await readJournalLibrary({ config });
const oldManifest = await readLibraryRef(root, before.pointer.manifest);
const oldPapers = (await Promise.all(Object.values(oldManifest.papers).map(ref => readLibraryRef(root, ref)))).flat();
const batchId = 'batch-4f39a6be67f8138e1e8e2af7e96674d65327c0c01e3cea132bc89a032107575b';
const responsePath = path.join(root, 'translations', 'batches', batchId, 'response.json');
const response = await json(responsePath);
const selected = new Map(response.items.map(paper => [paper.id, paper]));
const previous = new Map(oldPapers.map(paper => [paper.id, paper]));
const allowed = new Set(['title_zh', 'abstract_zh', 'title_translation_status', 'abstract_translation_status',
  'translation_model', 'translated_at', 'translation_provenance']);
const nonTranslation = paper => Object.fromEntries(Object.entries(paper).filter(([key]) => !allowed.has(key)));
const changed = [];
assert.equal(selected.size, 5);
assert.equal(current.papers.length, before.paper_count);
for (const paper of current.papers) {
  const old = previous.get(paper.id);
  assert.ok(old, `Unexpected new paper: ${paper.id}`);
  if (!selected.has(paper.id)) { assert.deepEqual(paper, old); continue; }
  assert.deepEqual(nonTranslation(paper), nonTranslation(old));
  for (const field of ['title', 'abstract']) {
    assert.equal(paper[`${field}_zh`], selected.get(paper.id)[`${field}_zh`]);
    assert.equal(paper[`${field}_translation_status`], 'done');
    const provenance = paper.translation_provenance[field];
    assert.equal(provenance.model, response.model);
    assert.equal(provenance.translated_at, response.translated_at);
    assert.equal(provenance.batch_id, batchId);
    assert.equal(provenance.source_text_hash, paper.source_text_hash[field]);
  }
  changed.push({ id: paper.id, title_zh: paper.title_zh });
}
assert.equal(changed.length, 5);
assert.equal(current.manifest.operation, 'translation_import');
assert.deepEqual(current.manifest.parent, before.pointer.manifest);
assert.equal(current.runs.length, before.run_count);
assert.deepEqual(current.manifest.runs, oldManifest.runs);
assert.deepEqual(current.manifest.raw, oldManifest.raw);
assert.deepEqual(current.audit, await readLibraryRef(root, oldManifest.audit));
assert.equal(current.imports.length, before.import_count + 1);
assert.equal(current.imports[0].batch_id, batchId);
assert.equal(current.imports[0].status, 'success');
assert.equal(current.queue.field_count, before.queue - 10);
assert.equal(current.queue.paper_count, before.paper_count - 5);
assert.equal(current.queue.tasks.some(task => selected.has(task.paper_id)), false);
let preservedFiles = 0;
for (const [relative, expected] of Object.entries({ ...baseline.files, ...before.work_files })) {
  if (relative === 'current.json') continue; // The only pre-existing file intentionally replaced by publication.
  const actual = createHash('sha256').update(await fs.readFile(path.join(root, relative))).digest('hex');
  assert.equal(actual, expected, `Historical/work file changed: ${relative}`);
  preservedFiles++;
}
assert.equal(await fs.stat(path.join(root, 'writer.lock')).then(() => true, err => {
  if (err.code === 'ENOENT') return false;
  throw err;
}), false);
const repeat = await importTranslationFile(config, { file: responsePath, save: false });
assert.equal(repeat.status, 'no_changes');
assert.equal(repeat.report.stats.unchanged_fields, 10);
assert.equal(repeat.report.stats.changed_papers, 0);
assert.deepEqual((await readJournalLibrary({ config })).pointer, current.pointer);
const eligibility = translationEligibility(current.papers);
console.log(JSON.stringify({
  checked_at: new Date().toISOString(), saved: true, status: 'success',
  run_id: current.manifest.run_id, imported_at: current.imports[0].started_at,
  paper_count: current.papers.length, completed_paper_count: changed.length,
  completed_fields: 10, failed_fields: 0, rejected_fields: 0,
  pending_fields_before: before.queue, pending_fields_after: current.queue.field_count,
  ready_pending_fields: eligibility.ready.field_count, held_pending_fields: eligibility.held.field_count,
  untouched_papers: current.papers.length - changed.length,
  unchanged_nontranslation_fields: true, unchanged_collection_logs: true,
  collection_run_count: current.runs.length, translation_import_count: current.imports.length,
  preserved_historical_and_work_files: preservedFiles, only_replaced_existing_library_file: 'current.json',
  writer_lock_released: true, duplicate_import_preview: repeat.report.stats,
  pointer: current.pointer, previous_pointer: before.pointer, changed_papers: changed,
  scope: 'Local translation import only; no collection, metadata repair, build, push, or deployment.'
}, null, 2));
