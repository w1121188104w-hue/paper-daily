import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { makePipelineRuntime } from './journal-pipeline.js';
import { repairPaperMetadata } from '../src/services/searchMetadata.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { originalAbstractSection } from '../src/services/searchExtraction.js';

try {
  assertLibrary(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    process.env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily', '仅允许受控隔离检验');
  const config = await loadJournalConfig(), policy = await loadSearchPolicy();
  const baseline = await readJournalLibrary({ config, root: path.resolve('production-baseline/data/journal-store') });
  const runtime = await makePipelineRuntime({ env: process.env, policy });
  const targets = ['JFE', 'RP', 'QJE'].map(key => baseline.papers.find(p => p.journal_key === key && !p.abstract_original && p.doi)).filter(Boolean);
  const records = [];
  let calls = 0;
  const search = async request => {
    if (++calls > 12) return { called: false, reason: 'probe_limit' };
    const response = await runtime.search(request);
    const leads = response.result?.leads || [];
    console.log('SEARCH_CHECK ' + JSON.stringify({ provider: request.provider, called: response.called,
      leads: leads.length, content_lengths: leads.slice(0, 5).map(row => row.content?.length || 0),
      labelled_abstracts: leads.filter(row => /\babstract\b/i.test(row.content || '')).length,
      bounded_abstracts: leads.filter(row => originalAbstractSection(row.content)).length,
      diagnostics: response.diagnostic || null }));
    return response;
  };
  for (const paper of targets) {
    const result = await repairPaperMetadata(paper, findJournal(config, paper.journal_key), {
      sources: runtime.sources, search, fields: ['abstract'] });
    records.push({ doi: paper.doi, journal: paper.journal_key, status: result.status,
      abstract_length: result.paper.abstract_original.length, changed_fields: result.changed_fields, attempts: result.attempts });
  }
  // Exercise the extraction API separately with explicitly synthetic evidence;
  // this never enters a paper or the formal library.
  const fixture = await runtime.sources.searchExtract({ paper: { title: 'Synthetic API connectivity test', doi: '10.0000/fixture', journal: 'Synthetic fixture' },
    evidence: [{ title: 'Synthetic API connectivity test', url: 'https://example.com/fixture',
      content: 'Synthetic API connectivity test DOI: 10.0000/fixture Abstract This is synthetic test evidence for an API connectivity check. It is not a real research paper and will never enter the database. Keywords: test' }] });
  console.log('ABSTRACT_EXTRACTION_PROBE ' + JSON.stringify({ records, extraction_api_responded: Boolean(fixture && Object.hasOwn(fixture, 'record')),
    ...runtime.summary(), production_writes: 0, translation_calls: 0 }));
  assertLibrary(fixture && Object.hasOwn(fixture, 'record'), '智谱提取接口未通过真实验证');
} catch (error) {
  console.error('PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'));
  process.exitCode = 1;
}
