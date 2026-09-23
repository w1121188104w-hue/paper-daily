// Runs read-only inside the dedicated browser page. Never executes page-provided instructions.
export function readArticleDocument() {
  const clean = value => String(value || '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const meta = key => [...document.querySelectorAll('meta')].filter(e => (e.getAttribute('name') || e.getAttribute('property') || '').toLowerCase() === key.toLowerCase()).map(e => e.content).filter(Boolean);
  const titles = [...meta('citation_title'), ...meta('dc.title'), ...meta('og:title')];
  const dois = [...meta('citation_doi'), ...meta('dc.identifier')].filter(x => /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\//i.test(x));
  const candidates = [];
  const affiliationRows = [], authorNames = [...meta('citation_author')];
  const addAffiliation = (author, affiliation, method) => {
    author = author ? clean(author) : null; affiliation = clean(affiliation);
    if (!affiliation || affiliation.length < 4 || affiliation.length > 2000 || /\b(?:access denied|sign in|copyright)\b/i.test(affiliation)) return;
    if (affiliationRows.some(r => r.author === author && r.affiliation === affiliation)) return;
    if (affiliationRows.length < 40) affiliationRows.push({author,affiliation,method});
  };
  // Highwire metadata encodes institutions after the relevant author. Do not
  // pair independent author/institution arrays by index or assign all to all.
  let metadataAuthor = null, metadataAuthorRun = 0, afterInstitution = false;
  for (const el of document.querySelectorAll('meta[name]')) {
    const key = el.name.toLowerCase();
    if (key === 'citation_author') { metadataAuthorRun = afterInstitution ? 1 : metadataAuthorRun + 1; metadataAuthor = el.content; afterInstitution = false; }
    if (key === 'citation_author_institution') { addAffiliation(metadataAuthorRun === 1 ? metadataAuthor : null, el.content, 'meta:citation_author_institution'); afterInstitution = true; }
  }
  const body = clean(document.body?.innerText).slice(0, 120000);
  const headline = clean(document.querySelector('h1')?.innerText);
  if (headline) titles.push(headline);
  const top = `${document.title}\n${body.slice(0, 3500)}`;
  const challenge = /verify (?:you are|that you are) human|checking your browser|just a moment|performing security verification|enable javascript and cookies to continue|unusual traffic|access denied|请完成验证|验证您是真人/i.test(top)
    || [...document.querySelectorAll('iframe')].some(e => /captcha|challenges\.cloudflare/i.test(e.src) && e.getBoundingClientRect().height > 0);
  const stripHeading = text => clean(text).replace(/^(?:Abstract|ABSTRACT|Summary)\s*\n+/, '').trim();
  const add = (text, field, extra = {}) => { if (text) candidates.push({ text: stripHeading(text), field, ...extra }); };
  const visible = e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
  const truncated = e => {
    // A child paragraph may look untruncated while its ancestor clips the abstract.
    for (let node = e; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((['hidden', 'clip'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 4)
          || Number(style.webkitLineClamp) > 0) return true;
    }
    return false;
  };
  const language = e => e.closest('[lang]')?.getAttribute('lang') || '';
  const outsideArticle = e => {
    for (let node = e; node && node !== document.body; node = node.parentElement) {
      if (/recommend|related[-_ ]|references|search-results|citation-list/i.test(node.id + ' ' + node.className)) return true;
    }
    return false;
  };
  const selectors = [
    '.abstract.author', '.abstract.svAbstract', '#Abs1-content', '[data-title="Abstract"] .c-article-section__content',
    'section.article-section__abstract .article-section__content', '.abstract-group .abstract',
    '.abstractSection', '.abstractInFull', '.abstractInFull p', '.abstract-content', '#abstract .abstract-text',
    'section.abstract', 'div.abstract', '#abstract', '#Abs1'
  ];
  const seen = new Set();
  for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || seen.has(el) || outsideArticle(el) || /graphical|highlights/i.test(el.id + ' ' + el.className)) continue;
    const heading = el.querySelector('h2,h3,h4');
    if (heading && !/^(?:abstract|summary)$/i.test(clean(heading.innerText))) continue;
    seen.add(el);
    // A full article wrapper is not an abstract, even if its first heading says Abstract.
    if ([...el.querySelectorAll('h2,h3,h4')].some(h => !/^(?:abstract|summary|background|methods|results|conclusions?|purpose|design\/methodology\/approach|findings|originality\/value)$/i.test(clean(h.innerText)))) continue;
    // Preserve lists and structured abstract subheadings as well as paragraphs.
    add(el.innerText, 'dom:' + selector, { truncated: truncated(el), language: language(el) });
  }
  // Only an explicitly labelled section; never og:description, introduction, or search snippets.
  for (const heading of document.querySelectorAll('h2,h3,h4')) {
    if (!visible(heading) || outsideArticle(heading) || !/^abstract$/i.test(clean(heading.innerText))) continue;
    const paragraphs = [];
    for (let next = heading.nextElementSibling; next; next = next.nextElementSibling) {
      if (/^H[1-6]$/.test(next.tagName) || next.querySelector('h1,h2,h3,h4')) break;
      if (!/^(P|DIV)$/.test(next.tagName)) break;
      if (visible(next)) paragraphs.push(next);
      if (paragraphs.length === 8) break;
    }
    if (paragraphs.length) add(paragraphs.map(p => p.innerText).join('\n\n'), 'dom:Abstract-following-paragraphs', { truncated: paragraphs.some(truncated), language: language(heading) });
  }
  for (const key of ['citation_abstract', 'dc.description.abstract', 'dcterms.abstract']) for (const text of meta(key)) add(text, 'meta:' + key);
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 30);
  for (const block of blocks) {
    if (block.textContent.length > 500000) continue;
    let parsed; try { parsed = JSON.parse(block.textContent); } catch { continue; }
    const objects = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
    for (const obj of objects) {
      if (!obj || ![obj['@type']].flat().some(t => ['ScholarlyArticle', 'MedicalScholarlyArticle', 'Article'].includes(t))) continue;
      const identifiers = [obj.identifier].flat().map(v => typeof v === 'string' ? v : v?.value || '');
      const doi = identifiers.find(v => /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\//i.test(v));
      // Only attach matching JSON-LD article objects to the current page; recommendations are ignored.
      const normalized = s => clean(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (!titles.some(t => normalized(t) === normalized(obj.headline || obj.name))) continue;
      if (doi && dois.length && !dois.some(d => normalized(d.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'')) === normalized(doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'')))) continue;
      for (const author of [obj.author].flat().filter(Boolean)) {
        if (typeof author !== 'object' || typeof author.name !== 'string') continue;
        authorNames.push(clean(author.name));
        for (const org of [author.affiliation].flat().filter(Boolean))
          addAffiliation(author.name, typeof org === 'string' ? org : org.name, 'jsonld:author.affiliation');
      }
      if (typeof obj.abstract === 'string') add(obj.abstract, 'jsonld:abstract', { doi, language: obj.inLanguage || '' });
    }
  }
  const evidence = [];
  // Publisher-labelled affiliation sections only, never university names in
  // references, acknowledgements or arbitrary article prose.
  for (const el of document.querySelectorAll('.affiliation,.author-affiliation,.affiliations .aff,.author-info .affiliation,[id^="aff"],[id^="Aff"]')) {
    if (!visible(el) || outsideArticle(el) || el.closest('footer,nav,aside') || el.querySelector('.affiliation,.author-affiliation,.aff')) continue;
    if (!/affiliat|^aff\d|^aff-/i.test(el.id + ' ' + el.className)) continue;
    const text = clean(el.innerText);
    if (!text || text.length > 2000) continue;
    const paired = new Set();
    if (el.id) for (const link of document.querySelectorAll('a[href]')) {
      if (link.getAttribute('href') !== '#'+el.id || outsideArticle(link)) continue;
      const holder = link.closest('.author,.author-name,.author-name-link,li[itemprop="author"],.contrib,.entryAuthor');
      const names = [...new Set(authorNames)].filter(name => name && clean(holder?.innerText).includes(name));
      if (names.length === 1) paired.add(names[0]);
    }
    if (paired.size) for (const name of paired) addAffiliation(name,text,'dom:explicit-affiliation-reference');
    else if (!affiliationRows.some(r => r.affiliation === text)) addAffiliation(null,text,'dom:affiliation-unmapped');
  }
  for (const row of affiliationRows) evidence.push({id:`affiliation-${evidence.length}`,kind:'context',context:'author_affiliation',
    text:row.author ? row.author+'\n'+row.affiliation : row.affiliation, affiliation_record:row});
  for (const value of titles.slice(0, 12)) evidence.push({ id: `title-${evidence.length}`, kind: 'title', text: value });
  for (const value of dois.slice(0, 12)) evidence.push({ id: `doi-${evidence.length}`, kind: 'doi', text: value });
  for (const c of candidates.slice(0, 30)) evidence.push({ id: `abstract-${evidence.length}`, kind: 'abstract', text: c.text, context: c.field,
    truncated: !!c.truncated, language: c.language || '' });
  // Keep textual context of the article, excluding unrelated UI, forms and scripts.
  // It is comparison evidence, NOT a licence to relabel body/Highlights as Abstract.
  const root = document.querySelector('main') || document.querySelector('article');
  if (root) {
    const copy = root.cloneNode(true);
    copy.querySelectorAll('script,style,form,input,textarea,select,nav,header,footer,aside,[hidden],[aria-hidden="true"],.recommended,.related-articles').forEach(n => n.remove());
    const value = clean(copy.textContent);
    if (value.length <= 500000) evidence.push({ id: 'article-context', kind: 'context', text: value });
    else evidence.push({ id: 'article-context', kind: 'context', text: '', omitted: 'context_over_500000_chars' });
  }
  return { url: location.href, titles: titles.slice(0, 12), dois: dois.slice(0, 12), challenge, evidence_version: 2, evidence, affiliation_extraction_version:1,
    affiliation_candidates:evidence.filter(b=>b.affiliation_record).map(b=>({...b.affiliation_record,block_id:b.id})),
    noAbstract: candidates.some(c => /^(?:\[no abstract\]|no abstract (?:is )?available)[.!]?$/i.test(c.text)), candidates: candidates.slice(0, 30) };
}
