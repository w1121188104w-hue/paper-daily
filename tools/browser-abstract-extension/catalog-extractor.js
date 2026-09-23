// Serialized into the owned publisher tab. No network, cookie access, AI or page clicks.
export function readCatalogDocument() {
  const text = el => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el && !el.closest('[hidden],[aria-hidden="true"]') && el.getBoundingClientRect().height > 0;
  const safeLink = el => { try { const u = new URL(el.getAttribute('href'), location.href); const id=u.hostname==='www.aeaweb.org'&&u.pathname==='/articles'?u.searchParams.get('id'):null; u.search = ''; u.hash = ''; if(id&&/^10\.1257\/aer\.[^\s?#]+$/i.test(id))u.searchParams.set('id',id); return u.href; } catch { return ''; } };
  const body = text(document.body), page_title = document.title;
  const gate = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],#challenge-running,#challenge-stage,.g-recaptcha')].some(visible);
  const challenge = gate || /just a moment|access denied|robot check|are you (?:a )?robot\s*\?|verify (?:you are|that you)|checking your browser|security verification|unusual traffic|请稍候|验证您是否|人机验证/i.test(page_title + ' ' + body.slice(0, 1800));
  const page_not_found = /^(?:404\b|not found\b|page not found\b)/i.test(page_title.trim()) ||
    [...document.querySelectorAll('h1')].some(h => /^(?:404(?:\s*[-:–]\s*)?)?(?:page )?not found$/i.test(text(h)));
  const headings = [page_title, ...[...document.querySelectorAll('h1,meta[name="citation_journal_title"],meta[property="og:title"],.journal-title,.journal-name,.journal-header')].map(x => x.content || text(x))];
  // OUP/AAA sometimes put the journal name only in the linked masthead logo.
  // Only the current journal's home/issue links count, not partner/footer logos.
  const journalCode = location.pathname.split('/')[1];
  if (['academic.oup.com', 'publications.aaahq.org'].includes(location.hostname)) {
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.href);
        if (u.origin === location.origin && [ `/${journalCode}`, `/${journalCode}/`, `/${journalCode}/issue` ].includes(u.pathname)) {
          for (const img of a.querySelectorAll('img[alt]')) headings.push(img.alt);
          const label = a.getAttribute('aria-label') || a.getAttribute('title'); if (label) headings.push(label);
        }
      } catch { /* Not a journal identity link. */ }
    }
  }
  const issns = [...document.querySelectorAll('meta[name="citation_issn"],meta[name="prism.issn"],meta[property="prism.issn"]')]
    .flatMap(x => (x.content || '').match(/\d{4}-[\dXx]{4}/g) || []);
  // AAA Early Access can identify the journal through footer ISSNs instead of
  // metadata. Only explicitly labelled ISSNs count, never arbitrary numbers.
  if(location.hostname==='publications.aaahq.org') {
    const footer=document.querySelector('footer,[role="contentinfo"],.site-footer,.footer');
    for(const m of text(footer).matchAll(/\b(?:(?:Print|Online|Electronic)\s+)?(?:E?ISSN)\s*:?\s*(\d{4}-[\dXx]{4})\b/gi)) issns.push(m[1]);
  }
  const exclude = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (/^(?:NAV|FOOTER|ASIDE)$/.test(n.tagName) || /recommend|most[-_ ]?(?:read|cited)|related[-_ ]?(?:article|content)|citation[-_ ]?list/i.test(n.className + ' ' + n.id)) return true;
    }
    return false;
  };
  const articlePath = href => /\/science\/article\/(?:abs\/)?pii\/[A-Za-z0-9]+|\/doi\/(?:abs\/|full\/|pdf\/|epdf\/|pdfplus\/|abstract\/)?10\.|https:\/\/doi\.org\/10\.|\/article\/10\.|\/(?:qje|restud|rfs|accounting-review)\/(?:article|advance-article)\/|aeaweb\.org\/articles\?id=10\./i.test(href);
  const cardSelector = '.js-article-list-item,.article-list-item,.issue-item,.toc-item,.toc__item,.table-of-content__item,.al-article-item,.al-article-items,.al-article-list-item,.c-listing__item,.c-card,.journal-article';
  const cards = [...document.querySelectorAll(cardSelector)]
    .filter(x => !exclude(x));
  const roots = cards.filter(x => !cards.some(y => y !== x && x.contains(y)));
  const items = [], used = new Set();
  const titleLinks = card => [...card.querySelectorAll('h2 a[href],h3 a[href],h4 a[href],h5 a[href],.al-title a[href],a.al-title[href],.article-content-title[href],.issue-item__title a[href],.hlFld-Title a[href]')]
    .filter(a => articlePath(a.href) && !exclude(a));
  const articleCount = card => new Set(titleLinks(card).map(safeLink)).size;
  const collect = (card, selector, forcedAnchor) => {
    // Some themes use the plural class for the entire list. Never send several
    // papers as one article's evidence; fallback headings will split the list.
    if (articleCount(card) > 1) {
      if (!forcedAnchor) return;
      let scoped = forcedAnchor.closest('h2,h3,h4,h5,.al-title,.article-content-title,.issue-item__title,.hlFld-Title') || forcedAnchor;
      while (scoped.parentElement && scoped.parentElement !== card && articleCount(scoped.parentElement) <= 1) scoped = scoped.parentElement;
      card = scoped;
    }
    const links = [...card.querySelectorAll('a[href]')];
    const a = forcedAnchor || links.find(x => articlePath(x.href) &&
      (x.matches('.article-content-title,.issue-item__title,.publication_title,.hlFld-Title,.al-title') || x.closest('h2,h3,h4,h5,.issue-item__title,.publication_title,.hlFld-Title,.al-title')) &&
      !/^(?:abstract|full text|pdf|epub|first page|download|references)$/i.test(text(x))) ||
      links.find(x => articlePath(x.href) && text(x).length > 20 && !/^(?:https?:|10\.|full text|download)/i.test(text(x)));
    if (!a || used.has(a) || exclude(a)) return;
    // Access badges are not part of a title (e.g. "FREE" in AAA listings).
    const titleNode=a.cloneNode(true);
    titleNode.querySelectorAll('.free,.free-access,.open-access,.access-label,.access-icon,.badge,sup').forEach(n=>{
      if(/^(?:free|open access|free access)$/i.test(text(n)))n.remove();
    });
    const title = text(titleNode); if (!title) return; used.add(a);
    let doi = card.getAttribute('data-doi') || card.querySelector('[data-doi]')?.getAttribute('data-doi') || null;
    for (const link of [a, ...links]) {
      if (doi) break;
      try {
        const u = new URL(link.href), p = decodeURIComponent(u.pathname);
        doi = u.hostname === 'doi.org' ? p.slice(1) : u.hostname==='www.aeaweb.org' ? u.searchParams.get('id') :
          p.match(/^\/article\/(10\.\d{4,9}\/[^/]+)\/?$/i)?.[1] ||
          p.match(/\/(?:advance-article|article)\/doi\/(10\.\d{4,9}\/[^/]+(?:\/[^/]+)?)(?=\/\d+\/|\/\d+$)/i)?.[1] ||
          p.match(/^\/doi\/(?:abs\/|full\/|pdf\/|epdf\/|pdfplus\/|abstract\/)?(10\.\d{4,9}\/.+)/i)?.[1];
      } catch { /* Keep the title/link even without DOI. */ }
    }
    const authorNodes = [...card.querySelectorAll('.authors,.author,.author-group,.authors-list,.author-list,.issue-item__authors,.hlFld-ContribAuthor,.loa,.al-authors-list,.c-author-list,[class*="author-name"]')];
    const authors = authorNodes.filter(x => !authorNodes.some(y => y !== x && y.contains(x))).map(text).filter(Boolean);
    const dateNodes = [...card.querySelectorAll('time,.article-date,.cover-date,.epub-date,.item__date,.publication-date,[class*="date"]')];
    items.push({ title, doi: doi || null, url: safeLink(a), selector, authors_raw: [...new Set(authors)].join('; ').slice(0, 1500) || null,
      date_raw: [...new Set(dateNodes.map(text).filter(Boolean))].join('; ').slice(0, 500) || null,
      section: text(card.querySelector('.article-type,.issue-item__type,.subType,.articleType,.content-type')).slice(0, 200) || null,
      evidence_text: (() => { const copy = card.cloneNode(true); copy.querySelectorAll('script,style,form,input,textarea,select,nav,aside').forEach(n => n.remove()); return text(copy); })(),
      evidence_version: 2 });
  };
  roots.slice(0, 500).forEach(x => collect(x, 'publisher_article_card'));
  // Conservative diagnostic fallback: only article title headings, not every DOI on the page.
  for (const a of document.querySelectorAll('h2 a[href],h3 a[href],h4 a[href],h5 a[href],.al-title a[href],a.al-title[href],.article-content-title[href],.issue-item__title a[href],.hlFld-Title a[href]')) {
    if (articlePath(a.href)) collect(a.closest(cardSelector + ',article,li,.article-item') || a.parentElement, 'heading_fallback_unverified', a);
  }
  const next_links = [], more_controls = [], navigation_links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const label = (a.getAttribute('aria-label') || text(a)).trim();
    if (/^(?:previous issue|next issue|all issues|view all issues)$/i.test(label)) navigation_links.push(a.href);
    if (!visible(a) || a.getAttribute('aria-disabled') === 'true' || a.classList.contains('disabled')) continue;
    if (a.rel === 'next' || /^(?:next(?: page)?|next \d+|下一页|›|»|→)$/i.test(label)) {
      // Never treat next issue / next article as next page.
      if (!/issue|article/i.test(label)) next_links.push(a.href);
    }
    // Wiley sometimes offers only numbered pagination. Follow a later numeric
    // page within the same pathname, never "next issue" or arbitrary links.
    if (/^\d+$/.test(label) && a.closest('[class*="pagination"],[aria-label*="Pagination"],[aria-label*="pagination"]')) {
      try {
        const here = new URL(location.href), next = new URL(a.href);
        const container = a.closest('[class*="pagination"],[aria-label*="Pagination"],[aria-label*="pagination"]');
        const selected = Number(text(container.querySelector('[aria-current="page"],.active,.current')));
        const current = selected || (here.searchParams.has('startPage') ? Number(here.searchParams.get('startPage')) + 1 : Number(here.searchParams.get('page') || here.searchParams.get('pageNumber') || 1));
        const wileyAlias = here.hostname === 'onlinelibrary.wiley.com' && (() => {
          const p = here.pathname.match(/^\/toc\/([^/]+)\/(current|\d{4}\/\d+\/\d+)\/?$/i), q = next.pathname.match(/^\/toc\/([^/]+)\/(current|\d{4}\/\d+\/\d+)\/?$/i);
          return p && q && p[1] === q[1] && (p[2] === 'current' || q[2] === 'current');
        })();
        if (next.origin === here.origin && (next.pathname === here.pathname || wileyAlias) && Number(label) > current &&
          ['startPage','page','pageNumber','offset'].some(k => next.searchParams.has(k))) next_links.push(next.href);
      } catch { /* Not a supported pagination URL. */ }
    }
  }
  for (const b of document.querySelectorAll('button,[role="button"],a[href]')) {
    const label = (b.getAttribute('aria-label') || text(b)).trim();
    if (visible(b) && !b.disabled && /^(?:load more|show more|view more|show all|view all)(?: articles| results)?$/i.test(label)) more_controls.push(label);
  }
  const navigationText = [...document.querySelectorAll('[class*="pagination"],[aria-label*="Pagination"],[aria-label*="pagination"]')].map(text).join(' ').slice(0, 600);
  const paginationNumbers = (navigationText.match(/\b\d+\b/g) || []).map(Number);
  const here = new URL(location.href);
  const pagination_current = Number(text(document.querySelector('[class*="pagination"] [aria-current="page"],[class*="pagination"] .active,[class*="pagination"] .current'))) ||
    (here.searchParams.has('startPage') ? Number(here.searchParams.get('startPage')) + 1 : Number(here.searchParams.get('page') || here.searchParams.get('pageNumber') || 1));
  const pagination_unresolved = !next_links.length && paginationNumbers.some(n => n > pagination_current);
  const issue_heading = [...document.querySelectorAll('h1,h2,.volume-issue,.issue-header,.publication-volume,.issue-info')].map(text).filter(s => /volume|issue|ahead of print|early view|just accepted|articles in press/i.test(s)).join(' | ').slice(0, 1500);
  const issue_links = [...document.querySelectorAll('a[href]')].filter(a => /^current issue$/i.test(text(a)) || /\/volumes-and-issues\/\d+-[\d-]+$/.test(a.pathname)).map(a=>({url:a.href,label:text(a)}));
  const observed_article_links = [...new Set([...document.querySelectorAll('a[href]')].filter(a=>!exclude(a)&&articlePath(a.href)&&text(a).length>20&&!/^(?:https?:|10\.|full text|download|view|add to|open the)/i.test(text(a))).map(safeLink))];
  const unmatched_article_links = observed_article_links.filter(url=>!items.some(i=>i.url===url));
  return { url: location.href, page_title, headings, issns, challenge, page_not_found, items, raw_card_count: roots.length,
    adapter: roots.length ? 'publisher_cards' : 'heading_fallback', issue_heading,
    next_links: [...new Set(next_links)], pagination_current, pagination_unresolved, more_controls, navigation_links, issue_links, observed_article_links, unmatched_article_links,
    empty_message: body.match(/(?:this journal currently does not have articles in press|no articles (?:are )?(?:currently )?available|there are currently no articles|no results found)/i)?.[0] || null,
    warnings: [ ...(unmatched_article_links.length ? ['unmatched_article_links:' + unmatched_article_links.length] : []), ...(roots.length > 500 ? ['card_limit_500'] : []), ...(navigationText ? ['pagination_present:' + navigationText] : []),
      ...(!roots.length ? ['publisher_card_selector_not_matched'] : []) ] };
}
