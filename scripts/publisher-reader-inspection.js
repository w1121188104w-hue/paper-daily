import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { makePipelineRuntime } from './journal-pipeline.js';
import { originalAbstractSection } from '../src/services/searchExtraction.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';

// Follow-up to the publisher matrix: four exact original URLs, Reader only.
// No searches, generated content, formal writes, translations or deployments.
export async function inspectPublisherReader({ env = process.env, log = console.log } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily', '仅允许隔离检验');
  const config = await loadJournalConfig(), policy = await loadSearchPolicy(), root = path.resolve('production-baseline/data/journal-store');
  const before = await readJournalLibrary({ root, config }), runtime = await makePipelineRuntime({ env, policy, enableReaderProbe: true });
  const targets = [
    ['10.1007/s11142-026-09985-w', 'https://link.springer.com/article/10.1007/s11142-026-09985-w'],
    ['10.1177/01492063261480612', 'https://journals.sagepub.com/doi/abs/10.1177/01492063261480612'],
    ['10.1057/s41267-026-00896-1', 'https://link.springer.com/article/10.1057/s41267-026-00896-1'],
    ['10.1257/aer.20230768', 'https://www.aeaweb.org/articles?id=10.1257/aer.20230768']
  ];
  const records = [];
  for (const [doi, url] of targets) {
    const paper = before.papers.find(p => p.doi === doi); assertLibrary(paper, '缺少固定目标');
    const answer = await runtime.sources.readerArticle(paper, findJournal(config, paper.journal_key), url);
    const row = { doi, url, called: answer.called, reason: answer.reason || null, diagnostic: answer.diagnostic || null,
      pages: (answer.result?.leads || []).map(lead => {
        const content = lead.content, markers = [...content.matchAll(/\b(?:Abstract|Access this article|Introduction|Keywords|References|Data Availability)\b/gi)].slice(0, 12);
        return { title: lead.title, content_length: content.length, content_sha256: evidenceHash(content),
          head: content.slice(0, 1200), current_extraction_length: originalAbstractSection(content).length,
          sections: markers.map(m => ({ marker: m[0], offset: m.index, excerpt: content.slice(Math.max(0, m.index - 100), m.index + 1900) })),
          matches_saved_abstract: Boolean(paper.abstract_original && content.includes(paper.abstract_original)) };
      }) };
    records.push(row); log('PUBLISHER_INSPECTION_ROW ' + JSON.stringify(row));
    if (answer.diagnostic?.provider_error_code === '1113' || answer.reason === 'provider_payment_required') break;
  }
  assertLibrary(before.pointerText === (await readJournalLibrary({ root, config })).pointerText, '不得改动正式库');
  log('PUBLISHER_INSPECTION_RESULT ' + JSON.stringify({ records, ...runtime.summary(), production_writes: 0 }));
}
