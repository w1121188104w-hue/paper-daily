import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { originalAbstractSection, verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { makePipelineRuntime } from './journal-pipeline.js';

export async function publisherReaderProbe({ env = process.env, log = console.log,
  configLoader = loadJournalConfig, policyLoader = loadSearchPolicy, readLibrary = readJournalLibrary,
  runtimeFactory = makePipelineRuntime } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily', '仅允许受控隔离检验');
  const config = await configLoader(), policy = await policyLoader();
  const root = path.resolve('production-baseline/data/journal-store');
  const before = await readLibrary({ root, config });
  const targets = [
    ['10.1016/j.jfineco.2026.104352', 'https://www.sciencedirect.com/science/article/pii/S0304405X26001236'],
    ['10.1111/1911-3846.70065', 'https://onlinelibrary.wiley.com/doi/full/10.1111/1911-3846.70065'],
    ['10.1016/j.respol.2026.105508', 'https://www.sciencedirect.com/science/article/pii/S0048733326000995']
  ].map(([doi, url]) => ({ paper: before.papers.find(p => p.doi === doi), url }));
  assertLibrary(targets.every(target => target.paper), '阅读验证目标必须存在于已校验库');
  const runtime = await runtimeFactory({ env, policy, enableReaderProbe: true }), records = [];
  for (const { paper, url } of targets) {
    const row = { doi: paper.doi, journal: paper.journal_key, requested_url: url };
    try {
      const result = await runtime.sources.readerArticle(paper, findJournal(config, paper.journal_key), url);
      const leads = result.result?.leads || [];
      const record = verifiedSearchRecord(leads, paper, findJournal(config, paper.journal_key), new Date().toISOString());
      Object.assign(row, { called: result.called, reason: result.reason || null, diagnostic: result.diagnostic || null,
        content_lengths: leads.map(lead => lead.content.length), bounded_abstracts: leads.filter(lead => originalAbstractSection(lead.content)).length,
        verified: Boolean(record), abstract_length: record?.abstract.length || 0,
        matches_existing_original: record && paper.abstract_original ? record.abstract === paper.abstract_original : null });
    } catch (error) {
      if (['SEARCH_LEDGER_CHECKPOINT_FAILED', 'EVIDENCE_STORAGE_ERROR'].includes(error.code)) throw error;
      row.status = /^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED';
    }
    records.push(row); log('PUBLISHER_READER_CHECK ' + JSON.stringify(row));
  }
  const after = await readLibrary({ root, config });
  assertLibrary(before.pointerText === after.pointerText, '阅读验证不能改变正式数据指针');
  const result = { records, ...runtime.summary(), production_writes: 0, translation_calls: 0 };
  log('PUBLISHER_READER_PROBE ' + JSON.stringify(result)); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await publisherReaderProbe(); }
  catch (error) { console.error('READER_PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED')); process.exitCode = 1; }
}
