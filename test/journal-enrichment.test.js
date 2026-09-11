import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { validatePapers } from '../src/services/libraryValidation.js';
import { makeEvidenceHttp, EvidenceError, evidenceHash, robotsAllows, checkedEvidenceUrl } from '../src/services/evidenceHttp.js';
import { parsePublisherFeed, parsePublisherArticle, publicationDate, windowMembership, publisherRecord } from '../src/services/publisherParsers.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { discoverOfficialPapers } from '../src/services/publisherDiscovery.js';
import { matchOfficialPaper, fillMissingAbstract, enrichAbstract, reconcileJournal, runJournalEnrichment, abstractIsDue } from '../src/services/journalEnrichment.js';
import { emptyEnrichmentState, validateEnrichmentOnlyChange } from '../src/services/enrichmentValidation.js';
import { readJournalLibrary, readLibraryRef, publishLibrarySnapshot } from '../src/services/journalLibrary.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';
import { enrichmentCommand } from '../scripts/enrich-library.js';

const config = await loadJournalConfig(), journal = findJournal(config,'AER');
const at = '2026-09-11T01:00:00.000Z', now = () => new Date(at), window = { fromDate: '2026-07-14',toDate: '2026-09-11' };
const abstract = 'We examine the effects of credit markets on firm investment using administrative records and an empirical research design.';
const response = (body,url = 'https://www.aeaweb.org/articles?id=10.1234/one') => ({ body,url,fetched_at: at,sha256: evidenceHash(body) });
const evidence = { url: 'https://www.aeaweb.org/issues/859',scope_url: 'https://www.aeaweb.org/issues/859',fetched_at: at,body_sha256: 'a'.repeat(64),method: 'publisher_rss' };
function record(overrides = {}) { return normalizeSourceRecord({ source: 'crossref',source_id: '10.1234/one',doi: '10.1234/one',
  title: 'Credit markets and firm investment',abstract: '',authors: ['Alice Smith'],journal_key: 'AER',journal_name: journal.name,
  journal_category: journal.category,journal_category_zh: journal.category_zh,print_issn: journal.print_issn,electronic_issn: journal.electronic_issn,
  publication_date: '2026-08-01',last_checked_at: at,type: 'journal-article',...overrides }); }
const paper = overrides => mergePapers([record(overrides)],{ firstSeenDate: '2026-09-08',checkedAt: at }).papers[0];
const lead = overrides => ({ title: 'Credit markets and firm investment',doi: '10.1234/one',date: '2026-08-01',authors: [{ name: 'Alice Smith',orcid: '' }],
  url: 'https://www.aeaweb.org/articles?id=10.1234/one',type: 'journal-article',abstract: '',evidence,...overrides });
const discovery = leads => ({ leads,coverage: 'partial',coverage_reason: 'feed is partial',official_observed_count: leads.length,attempts: [] });
const notFound = async () => { throw new EvidenceError('NOT_FOUND'); };
const sources = overrides => ({ crossref: notFound,openalex: notFound,semanticscholar: notFound,publisher: notFound,...overrides });
async function temp(t) {
  const parent = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(parent,'journal-enrichment-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)),parent); assert.ok(path.basename(root).startsWith('journal-enrichment-test-')); await fs.rm(root,{ recursive: true,force: true }); });
  return { repositoryRoot: root,root: path.join(root,'data','journal-store') };
}
const opts = { sources: sources(),runDate: '2026-09-11',checkedAt: at };

test('日期保留月/年精度，不能将窗口边界的半个月或未来日期算已核实', () => {
  assert.equal(publicationDate('Fri, 07 Aug 2026 00:00:00 GMT'),'2026-08-07');
  assert.equal(publicationDate('August 7, 2026'),'2026-08-07');
  assert.equal(publicationDate('2026/09'),'2026-09');
  assert.equal(publicationDate('2026-02-30'),'');
  assert.equal(windowMembership('2026-07',window.fromDate,window.toDate),'boundary_date_uncertain');
  assert.equal(windowMembership('2026-08',window.fromDate,window.toDate),'inside');
  assert.equal(windowMembership('2026-12',window.fromDate,window.toDate),'outside');
});
test('官方订阅验证期刊和DOI，目录描述不是摘要，清单永不假装完整', () => {
  const j = findJournal(config,'JAR');
  const body = `<rss><channel><title>Wiley: Journal of Accounting Research: Table of Contents</title><item><title>Research title</title><link>https://onlinelibrary.wiley.com/doi/10.1111/test</link><pubDate>Fri, 07 Aug 2026 00:00:00 GMT</pubDate><description>Journal of Accounting Research, EarlyView. This is a long label, not a real abstract.</description><dc:creator>Alice Smith, Bob Jones</dc:creator></item></channel></rss>`;
  const parsed = parsePublisherFeed(response(body,'https://onlinelibrary.wiley.com/feed/1475679x/most-recent'),j);
  assert.equal(parsed.complete,false); assert.equal(parsed.rows[0].abstract,''); assert.equal(parsed.rows[0].authors.length,2);
  assert.equal(parsed.rows[0].doi,'10.1111/test');
  assert.throws(() => parsePublisherFeed(response(body),journal),/JOURNAL_MISMATCH/);
  assert.throws(() => parsePublisherFeed(response('<!DOCTYPE x>'+body),j),/UNSAFE_XML/);
});
test('官方RSS只采用明确Abstract字段，排除其他期刊链接和冲突DOI', () => {
  const body = `<rss><channel><title>American Economic Review</title><item><title>Credit markets</title><link>https://www.aeaweb.org/articles?id=10.1234/one</link><dc:description>ABSTRACT ${abstract}</dc:description></item><item><title>Other</title><link>https://evil.invalid/article</link></item><item><title>Conflict</title><link>https://www.aeaweb.org/articles?id=10.1234/one</link><prism:doi>10.1234/two</prism:doi></item></channel></rss>`;
  const parsed = parsePublisherFeed(response(body),journal);
  assert.equal(parsed.rows.length,1); assert.equal(parsed.rows[0].abstract,abstract); assert.equal(parsed.rejected.length,2);
});
const html = overrides => `<meta name="citation_title" content="Credit markets and firm investment"><meta name="citation_doi" content="${overrides?.doi || '10.1234/one'}"><meta name="citation_journal_title" content="${overrides?.journal || journal.name}"><meta name="citation_author" content="Alice Smith"><meta name="citation_publication_date" content="2026/08/01"><section class="article-information abstract"><h2>Abstract</h2>${abstract}</section>`;
test('官网页面核对DOI/标题/期刊后提取Abstract，不把description概括当摘要', () => {
  const parsed = parsePublisherArticle(response(html()),journal,lead());
  assert.equal(parsed.abstract,abstract); assert.equal(parsed.date,'2026-08-01');
  validatePapers(mergePapers([publisherRecord(parsed,journal)],{ firstSeenDate: '2026-09-11',checkedAt: at }).papers,config);
  assert.throws(() => parsePublisherArticle(response(html({ doi: '10.1234/two' })),journal,lead()),/DOI_CONFLICT/);
  assert.throws(() => parsePublisherArticle(response(html({ journal: 'Nature' })),journal,lead()),/JOURNAL_MISMATCH/);
  assert.throws(() => parsePublisherArticle(response(html()),journal,lead({ title: 'Other study' })),/TITLE_MISMATCH/);
  assert.equal(parsePublisherArticle(response(html().replace(`<section class="article-information abstract"><h2>Abstract</h2>${abstract}</section>`,`<meta name="description" content="${abstract}">`)),journal,lead()).abstract,'');
});
test('JSON-LD仅接受已核对的文章abstract而非相关论文或description', () => {
  const ld = { '@type': 'ScholarlyArticle',identifier: 'https://doi.org/10.1234/one',headline: lead().title,abstract,isPartOf: { name: journal.name },datePublished: '2026-08-01' };
  assert.equal(parsePublisherArticle(response(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`),journal,lead()).abstract,abstract);
});
test('DOI优先，标题大小写/标点/连字符不制造重复；作者日期不足时暂缓', () => {
  const p = paper({ title: 'Non-compete: Agreements',doi: '',source_id: 'one' });
  const l = lead({ title: 'NONCOMPETE agreements',doi: '' });
  assert.equal(matchOfficialPaper(l,[p],'AER').status,'matched');
  assert.equal(matchOfficialPaper({ ...l,authors: [] },[p],'AER').status,'conflict');
  assert.equal(matchOfficialPaper(lead({ title: 'changed title' }),[paper()],'AER').status,'matched');
  assert.equal(matchOfficialPaper(lead({ doi: '10.1234/two' }),[paper()],'AER').status,'conflict');
  assert.equal(matchOfficialPaper(lead(),[{ ...paper(),journal_key: 'JAR' }],'AER').status,'conflict');
});
test('漏收补入幂等；已收录记录原封不动；行政资料和更正单列不冒充研究', async () => {
  const d = discovery([lead(),lead({ title: 'Front Matter',doi: '10.1234/front' }),lead({ title: 'Correction: Credit',doi: '10.1234/correction' })]);
  const result = await reconcileJournal(d,journal,[],window,opts);
  assert.equal(result.report.added_count,1); validatePapers(result.papers,config);
  const repeated = await reconcileJournal(d,journal,result.papers,window,opts);
  assert.equal(repeated.report.added_count,0); assert.deepEqual(repeated.papers,result.papers);
});
test('缺DOI依靠标题作者日期；不确定日期与同DOI异标题留待核实', async () => {
  const d = discovery([lead({ doi: '',date: '',url: 'https://www.aeaweb.org/article/unknown' }),lead({ doi: '10.1234/two',date: '2026-07' })]);
  const result = await reconcileJournal(d,journal,[],window,opts);
  assert.equal(result.report.added_count,0); assert.equal(result.report.pending_count,2);
  const conflict = await reconcileJournal(discovery([lead(),lead({ title: 'Entirely different' })]),journal,[],window,opts);
  assert.equal(conflict.report.added_count,0); assert.equal(conflict.report.pending_count,2);
});
test('Elsevier封面日期不能充当在线发表日期；有可核实元数据才能补入', async () => {
  const l = lead({ date: '2026-12',date_role: 'issue_cover_date' });
  const no = await reconcileJournal(discovery([l]),journal,[],window,opts); assert.equal(no.report.added_count,0);
  const yes = await reconcileJournal(discovery([l]),journal,[],window,{ ...opts,sources: sources({ crossref: async () => record() }) });
  assert.equal(yes.report.added_count,1); assert.equal(yes.papers[0].publication_date,'2026-08-01'); validatePapers(yes.papers,config);
});
test('真实回归：Wiley七月更新清单的论文实际一月已上线，不在60天漏收数内', async () => {
  const l = lead({ date: '2026-07-23',date_role: 'feed_update_date' });
  const result = await reconcileJournal(discovery([l]),journal,[],window,{ ...opts,sources: sources({ crossref: async () => record({ published_online_date: '2026-01-09' }) }) });
  assert.equal(result.report.added_count,0); assert.equal(result.report.missing_count,0);
  assert.equal(result.report.entries[0].status,'outside_window'); assert.equal(result.report.entries[0].verified_publication_date,'2026-01-09');
  const unresolved = await reconcileJournal(discovery([l]),journal,[],window,opts);
  assert.equal(unresolved.report.added_count,0); assert.equal(unresolved.report.pending_count,1);
});
test('摘要补全只填空，不改标题作者日期和中文；新增英文自动进翻译队列', () => {
  const p = paper(), r = record({ source: 'publisher',source_id: evidence.url,abstract,source_evidence: evidence });
  const n = fillMissingAbstract(p,r); validatePapers([n],config); validateEnrichmentOnlyChange([p],[n]);
  assert.equal(p.abstract_original,''); assert.equal(n.abstract_original,abstract); assert.equal(n.abstract_zh,''); assert.equal(n.abstract_translation_status,'pending');
  assert.equal(fillMissingAbstract(n,record({ abstract: abstract+' Another source.' })),n);
  assert.throws(() => fillMissingAbstract(p,record({ doi: '10.1234/wrong',abstract })),/UNVERIFIED_IDENTITY/);
  assert.throws(() => validateEnrichmentOnlyChange([p],[{ ...n,title_original: 'changed' }]),/不能改动/);
});
test('订阅日期在补摘要来源和后续合并中仍仅是线索，不变成发表日期', () => {
  for (const date_role of ['feed_update_date','issue_cover_date','publisher_feed_date']) {
    const source = publisherRecord(lead({ abstract,date_role }),journal);
    assert.equal(source.publication_date,'');
    assert.equal(source.raw_dates.publisher_date,'2026-08-01');
    const original = record({ publication_date: '' });
    const enriched = fillMissingAbstract(paper({ publication_date: '' }),source);
    assert.equal(enriched.abstract_original,abstract);
    assert.equal(enriched.publication_date,'');
    const merged = mergePapers([original,source],{ firstSeenDate: '2026-09-08',checkedAt: at }).papers[0];
    assert.equal(merged.publication_date,'');
  }
});
test('摘要查询严格按Crossref、OpenAlex、Semantic Scholar、官网顺序；找到立即停止', async () => {
  const calls = [], s = Object.fromEntries(['crossref','openalex','semanticscholar','publisher'].map(source => [source,async () => {
    calls.push(source); return record({ source,source_id: source,abstract: source === 'openalex' ? abstract : '' });
  }]));
  const result = await enrichAbstract(paper(),journal,{ sources: s,state: emptyEnrichmentState(),now: now() });
  assert.deepEqual(calls,['crossref','openalex']); assert.equal(result.report.status,'found');
});
test('无法获得真摘要则中英文保持空，受限和暂缺有间隔重试，身份变更可重新查询', async () => {
  const state = emptyEnrichmentState(), p = paper();
  const result = await enrichAbstract(p,journal,{ sources: sources({ publisher: async () => { throw new EvidenceError('ACCESS_RESTRICTED'); } }),state,now: now() });
  assert.equal(result.report.status,'access_restricted'); assert.deepEqual(result.paper,p);
  assert.equal(abstractIsDue(p,state,now()),false); assert.equal(abstractIsDue(p,state,new Date('2026-09-12T02:00:00Z')),true);
  assert.equal(abstractIsDue({ ...p,title_original: 'Changed title' },state,now()),true);
});
test('robots规则、允许例外和特定UA正确，URL不允许文件/认证/任意跳转', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /rss\nAllow: /rss/public','/rss/public/feed'),true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /rss','/rss/x'),false);
  assert.equal(robotsAllows('User-agent: GPTBot\nDisallow: /','/articles'),true);
  for (const url of ['http://a.test/a','https://user:pass@a.test/a','https://evil.test/a','file:///a']) assert.throws(() => checkedEvidenceUrl(url,['a.test']));
});
test('请求尊重robots；429当轮停止同站请求；敏感头不跟随重定向', async () => {
  let calls = 0;
  const h = makeEvidenceHttp({ intervalMs: 0,fetchImpl: async url => { calls++; return new Response(url.endsWith('robots.txt') ? 'User-agent: *\nDisallow: /blocked' : 'ok'); } });
  await assert.rejects(h.request('https://a.test/blocked',['a.test']),/ROBOTS_DISALLOWED/); assert.equal(calls,1);
  calls = 0;
  const rate = makeEvidenceHttp({ respectRobots: false,intervalMs: 0,fetchImpl: async () => { calls++; return new Response('secret',{ status: 429,headers: { 'retry-after': '600' } }); } });
  await assert.rejects(rate.request('https://a.test/a',['a.test']),/RATE_LIMITED/);
  await assert.rejects(rate.request('https://a.test/b',['a.test']),/RATE_LIMITED/); assert.equal(calls,1);
  const redirect = makeEvidenceHttp({ respectRobots: false,fetchImpl: async () => new Response(null,{ status: 302,headers: { location: 'https://a.test/new' } }) });
  await assert.rejects(redirect.request('https://a.test/a',['a.test'],{ headers: { 'x-api-key': 'never-forward' } }),/REDIRECT_RESTRICTED/);
});
test('HTML验证页、巨大正文、无效robots和站外重定向失败时不会被当作零篇成功', async () => {
  const h = body => makeEvidenceHttp({ respectRobots: false,intervalMs: 0,maxBytes: 150,fetchImpl: async () => new Response(body) });
  await assert.rejects(h('<title>Just a moment</title>').request('https://a.test/',['a.test']),/ACCESS_RESTRICTED/);
  await assert.rejects(h('a'.repeat(151)).request('https://a.test/',['a.test']),/RESPONSE_TOO_LARGE/);
  const d = await discoverOfficialPapers(journal,window,{ http: { request: async () => { throw new EvidenceError('ACCESS_RESTRICTED'); } } });
  assert.equal(d.official_observed_count,null); assert.equal(d.coverage,'restricted');
});
test('Crossref返回相似标题但错误DOI/期刊不采用；S2绝不使用tldr摘要', async () => {
  const cr = { DOI: '10.1234/wrong',title: [lead().title],ISSN: [journal.print_issn],abstract };
  const s = makeEnrichmentSources({ request: async url => ({ ...response(JSON.stringify({ message: cr }),url),body: JSON.stringify({ message: cr }) }) });
  await assert.rejects(s.crossref(paper(),journal),/UNVERIFIED_IDENTITY/);
  const data = { paperId: '123abc',title: lead().title,externalIds: { DOI: '10.1234/one' },abstract: null,tldr: { text: abstract },authors: [{ name: 'Alice Smith' }] };
  const ss = makeEnrichmentSources({ request: async url => response(JSON.stringify(data),url) });
  assert.equal((await ss.semanticscholar(paper(),journal)).abstract,'');
});
test('正式快照新增独立补全日志和重试状态，历史白名单可追溯，重复执行不重复入库', async t => {
  const f = await temp(t), discover = async () => discovery([lead({ abstract })]);
  const first = await runJournalEnrichment(config,{ root: f.root,now,journalKey: 'AER',discover,sources: sources() });
  assert.equal(first.stats.added,1); const library = await readJournalLibrary({ root: f.root,config });
  assert.equal(library.runs.length,0); assert.equal(library.enrichments.length,1); assert.equal(library.papers[0].abstract_original,abstract);
  const plan = await journalGitFiles(config,f); assert.ok(plan.files.some(s => s.endsWith('enrichment-report.json'))); assert.ok(plan.files.some(s => s.endsWith('enrichment-state.json')));
  const repeated = await runJournalEnrichment(config,{ root: f.root,now,journalKey: 'AER',discover,sources: sources() }); assert.equal(repeated.stats.added,0);
});
test('原库补摘要后再普通采集不会丢失补全状态，旧原文和译文仍保留', async t => {
  const f = await temp(t), discover = async () => discovery([lead()]);
  await runJournalEnrichment(config,{ root: f.root,now,journalKey: 'AER',discover,sources: sources(),abstracts: false });
  const before = await readJournalLibrary({ root: f.root,config });
  const result = await runJournalEnrichment(config,{ root: f.root,now,journalKey: 'AER',official: false,sources: sources({ crossref: async () => record({ abstract }) }) });
  assert.equal(result.stats.abstracts_filled,1);
  const after = await readJournalLibrary({ root: f.root,config }); validateEnrichmentOnlyChange(before.papers,after.papers);
  const clients = Object.fromEntries(['crossref','openalex'].map(source => [source,async () => ({ source,journal_key: 'AER',ok: true,complete: true,records: [],raw_pages: [],rejected: [],raw_count: 0,duration_ms: 0,error: null })]));
  await runJournalCollection(config,{ root: f.root,now,journalKey: 'AER',clients });
  const collected = await readJournalLibrary({ root: f.root,config }); assert.deepEqual(collected.enrichmentState,after.enrichmentState); assert.equal(collected.enrichments.length,2);
});
test('切换前模拟中断保留旧指针，正式报告校验值篡改会阻止读取', async t => {
  const f = await temp(t), discover = async () => discovery([lead()]);
  await runJournalEnrichment(config,{ root: f.root,now,journalKey: 'AER',discover,sources: sources(),abstracts: false });
  const before = await fs.readFile(path.join(f.root,'current.json'),'utf8');
  await assert.rejects(runJournalEnrichment(config,{ root: f.root,now,journalKey: 'AER',discover,sources: sources(),abstracts: false,beforePublish: async () => { throw new Error('interrupted'); } }));
  assert.equal(await fs.readFile(path.join(f.root,'current.json'),'utf8'),before);
  const library = await readJournalLibrary({ root: f.root,config });
  await fs.appendFile(path.join(f.root,library.enrichments[0].report.path),' ');
  await assert.rejects(readJournalLibrary({ root: f.root,config }),/校验/);
});
test('命令默认只读；缺明确save/类型/范围不能联网，不允许扩大60天范围', async () => {
  let calls = 0; const execute = async () => { calls++; return { status: 'skipped' }; }, log = () => {};
  await enrichmentCommand([],{ execute,log }); assert.equal(calls,0);
  await assert.rejects(enrichmentCommand(['--run','--all','--official'],{ execute,log }));
  await assert.rejects(enrichmentCommand(['--run','--save','--all','--official','--lookback-days','365'],{ execute,log }));
  await assert.rejects(enrichmentCommand(['--run','--save','--all','--official','--github-output'],{ execute,log,env: {} }),/GitHub输出路径/);
  assert.equal(calls,0);
});

test('每日流水线先双源、官网、补摘要再翻译，新手动流程使用同一生产锁且密钥不交叉', async () => {
  const daily = JSON.parse(await fs.readFile(new URL('../.github/workflows/daily-collect.yml',import.meta.url),'utf8'));
  const steps = daily.jobs.collect.steps;
  assert.ok(steps.findIndex(s => s.id === 'collect') < steps.findIndex(s => s.id === 'enrich'));
  assert.ok(steps.findIndex(s => s.id === 'enrich') < steps.findIndex(s => s.id === 'translate'));
  assert.equal(steps.find(s => s.id === 'enrich').env.DEEPSEEK_API_KEY,undefined);
  const manual = JSON.parse(await fs.readFile(new URL('../.github/workflows/enrich-library.yml',import.meta.url),'utf8'));
  assert.deepEqual(manual.on,{ workflow_dispatch: {} }); assert.deepEqual(manual.concurrency,daily.concurrency);
  assert.ok(manual.jobs.enrich.if.includes('default_branch'));
  for (const s of manual.jobs.enrich.steps.filter(s => s.uses)) assert.match(s.uses,/@[a-f0-9]{40}$/);
  assert.equal(manual.jobs.enrich.steps.find(s => s.id === 'enrich').env.DEEPSEEK_API_KEY,undefined);
  assert.equal(manual.jobs.enrich.steps.find(s => s.id === 'translate').env.SEMANTIC_SCHOLAR_API_KEY,undefined);
});

test('OpenAlex断裂/重叠的摘要位置拒绝采用，不拼成疑似完整原文', async () => {
  for (const index of [{ We: [0],study: [2] },{ We: [0],study: [0] }]) {
    const s = makeEnrichmentSources({ request: async url => response(JSON.stringify({ abstract_inverted_index: index }),url) });
    await assert.rejects(s.openalex(paper(),journal),/INVALID_ABSTRACT_INDEX/);
  }
});
