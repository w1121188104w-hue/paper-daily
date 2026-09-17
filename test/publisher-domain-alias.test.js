import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { publisherFor } from '../src/services/publisherCatalog.js';
import { extractionEvidence, verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { checkedEvidenceUrl } from '../src/services/evidenceHttp.js';
import { abstractSearchQueries } from '../src/services/searchSources.js';

const config = await loadJournalConfig();

test('Springer 检索覆盖新旧公开主机，不定向 API 或登录服务，查询不超长', () => {
  for (const key of ['JIBS', 'RAS']) {
    const journal = findJournal(config, key);
    for (const item of [
      { title_original: 'Synthetic international firms', doi: '10.1057/s41267-026-09999-9' },
      { title_original: '😀研究'.repeat(50), doi: '10.1234/' + 'x'.repeat(70) },
      { title_original: 'Synthetic paper without a DOI' }
    ]) {
      const before = structuredClone(item), queries = abstractSearchQueries(item, journal);
      for (const host of ['link.springernature.com', 'link.springer.com'])
        assert.ok(queries.some(q => q.endsWith(` site:${host}`)));
      assert.ok(queries.every(q => [...q].length <= 70));
      assert.ok(queries.every(q => !/api\.springernature|idp\.springer/.test(q)));
      assert.ok(queries.some(q => !q.includes('site:')));
      assert.equal(queries.length, new Set(queries).size);
      assert.deepEqual(item, before);
      if (item.doi?.length > 70)
        assert.ok(!queries.filter(q => /site:link\.springer/.test(q)).some(q => q.startsWith('10.1234/')));
    }
  }
});
const paper = { title_original: 'Synthetic study of international firms', doi: '10.1057/s41267-026-09999-9' };
const body = `${paper.title_original}\nDOI: ${paper.doi}\nAbstract\nThis synthetic test studies international firms and their response to policy changes. We compare firms across regions using original administrative records. The findings show that institutional differences matter for measured outcomes.\nKeywords: firms`;

test('Springer官方新旧域名都可作为原文证据，不扩大到登录站、镜像或其他期刊', () => {
  const journal = findJournal(config, 'JIBS'), hosts = publisherFor(journal).hosts;
  for (const host of ['link.springer.com', 'link.springernature.com']) {
    const url = `https://${host}/article/${paper.doi}`;
    assert.equal(checkedEvidenceUrl(url, hosts).hostname, host);
    const record = verifiedSearchRecord([{ title: paper.title_original, url, content: body }], paper, journal, '2026-09-17T19:05:00.000Z');
    assert.ok(record?.abstract);
    assert.equal(record.source_evidence.url, url);
    assert.equal(record.source_evidence.method, 'zhipu_search_verbatim_abstract');
    assert.deepEqual(extractionEvidence([{ title: paper.title_original, url, content: body }], paper, findJournal(config, 'JFE')), []);
  }
  for (const host of ['idp.springer.com', 'link.springernature.com.example.org', 'mirror.example.org'])
    assert.throws(() => checkedEvidenceUrl(`https://${host}/article/${paper.doi}`, hosts), { code: 'UNSAFE_URL' });
  assert.ok(publisherFor(findJournal(config, 'RAS')).hosts.includes('link.springernature.com'));
});

test('认可新域名不放宽 DOI 与完整摘要规则，其他论文或摘要片段仍不能补入', () => {
  const journal = findJournal(config, 'JIBS'), url = `https://link.springernature.com/article/${paper.doi}`;
  assert.deepEqual(extractionEvidence([{ title: paper.title_original, url, content: body }], { ...paper, doi: '10.1057/s41267-026-08888-8' }, journal), []);
  assert.equal(verifiedSearchRecord([{ title: paper.title_original, url, content: body.replace('Keywords: firms', '') }], paper, journal, '2026-09-17T19:05:00.000Z'), null);
});
