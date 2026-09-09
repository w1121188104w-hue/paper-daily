// Read-only pilot verification: no network, save, publication, or file writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadJournalConfig } from '../../src/services/journals.js';
import { readJournalLibrary, DEFAULT_LIBRARY_ROOT } from '../../src/services/journalLibrary.js';
import { importTranslationFile } from '../../src/services/translationWorkflow.js';
import { translationEligibility } from '../../src/services/translationQueue.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(await fs.readFile(path.join(here, 'baseline.json'), 'utf8'));
const batchId = 'batch-4f39a6be67f8138e1e8e2af7e96674d65327c0c01e3cea132bc89a032107575b';
const responsePath = path.join(DEFAULT_LIBRARY_ROOT, 'translations', 'batches', batchId, 'response.json');
const config = await loadJournalConfig();
const before = await readJournalLibrary({ config });
const preview = await importTranslationFile(config, { file: responsePath, save: false });
assert.equal(preview.dry_run, true);
assert.equal(preview.committed, false);
assert.equal(preview.report.stats.completed_fields, 10);
assert.equal(preview.report.stats.changed_papers, 5);
assert.equal(preview.report.stats.failed_fields, 0);
assert.equal(preview.report.stats.rejected_fields, 0);
assert.equal(preview.report.stats.rejected_rows, 0);
const changedOriginalFiles = [];
for (const [relative, expected] of Object.entries(baseline.files)) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(DEFAULT_LIBRARY_ROOT, relative))).digest('hex');
  if (actual !== expected) changedOriginalFiles.push(relative);
}
assert.deepEqual(changedOriginalFiles, []);
const after = await readJournalLibrary({ config });
assert.deepEqual(after.pointer, before.pointer);
assert.deepEqual(after.papers, before.papers);
assert.deepEqual(after.queue, before.queue);
const eligibility = translationEligibility(after.papers);
console.log(JSON.stringify({
  checked_at: new Date().toISOString(),
  dry_run: true,
  committed: false,
  status: preview.status,
  report: preview.report,
  formal_library: {
    paper_count: after.papers.length,
    pending_field_count: after.queue.field_count,
    ready_field_count: eligibility.ready.field_count,
    held_field_count: eligibility.held.field_count,
    original_file_count: Object.keys(baseline.files).length,
    changed_original_files: changedOriginalFiles,
    pointer: after.pointer,
    preview_did_not_mutate_papers_or_queue: true
  },
  limitation: 'Mechanical checks plus original-file hashes; semantic translation review is separate. No formal import was performed.'
}, null, 2));
