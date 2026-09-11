// Publisher-owned public surfaces, not search-engine result pages or unofficial mirrors.
// Feeds are discovery evidence, NOT a guarantee that all articles in a 60-day window appear.
const catalog = {
  TAR: { family: 'silverchair', home: 'https://publications.aaahq.org/accounting-review', hosts: ['publications.aaahq.org'] },
  AOS: { family: 'elsevier', slug: 'accounting-organizations-and-society' },
  JAE: { family: 'elsevier', slug: 'journal-of-accounting-and-economics' },
  JFE: { family: 'elsevier', slug: 'journal-of-financial-economics' },
  JCF: { family: 'elsevier', slug: 'journal-of-corporate-finance' },
  RP: { family: 'elsevier', slug: 'research-policy' },
  JAR: { family: 'wiley' }, CAR: { family: 'wiley' }, JF: { family: 'wiley' }, JOM: { family: 'wiley' },
  RAS: { family: 'springer', journal_id: '11142' }, JIBS: { family: 'springer', journal_id: '41267' },
  AER: { family: 'aea', home: 'https://www.aeaweb.org/journals/aer/issues', hosts: ['www.aeaweb.org', 'pubs.aeaweb.org'] },
  JPE: { family: 'atypon', home: 'https://www.journals.uchicago.edu/toc/jpe/current', hosts: ['www.journals.uchicago.edu'], code: 'jpe' },
  QJE: { family: 'oup', code: 'qje', feeds: ['https://academic.oup.com/rss/site_5504/advanceAccess_3365.xml', 'https://academic.oup.com/rss/site_5504/3365.xml'] },
  RES: { family: 'oup', code: 'restud', feeds: ['https://academic.oup.com/rss/site_5508/advanceAccess_3369.xml', 'https://academic.oup.com/rss/site_5508/3369.xml'] },
  RFS: { family: 'oup', code: 'rfs', feeds: ['https://academic.oup.com/rss/site_5511/advanceAccess_3372.xml', 'https://academic.oup.com/rss/site_5511/3372.xml'] },
  MS: { family: 'atypon', home: 'https://pubsonline.informs.org/toc/mnsc/0/', hosts: ['pubsonline.informs.org'], code: 'mnsc' },
  JM: { family: 'atypon', home: 'https://journals.sagepub.com/toc/joma/0/0', hosts: ['journals.sagepub.com'], code: 'joma' }
};

export function publisherFor(journal) {
  const entry = catalog[journal.key];
  if (!entry) throw new Error('Missing verified journal publisher mapping');
  const p = structuredClone(entry), issn = journal.electronic_issn.replace('-', '');
  if (p.family === 'elsevier') Object.assign(p, {
    home: `https://www.sciencedirect.com/journal/${p.slug}/articles-in-press`,
    hosts: ['www.sciencedirect.com', 'rss.sciencedirect.com', 'api.elsevier.com'],
    feeds: [`https://rss.sciencedirect.com/publication/science/${journal.print_issn.replace('-', '')}`]
  });
  if (p.family === 'wiley') Object.assign(p, { home: `https://onlinelibrary.wiley.com/toc/${issn}/0/0`,
    hosts: ['onlinelibrary.wiley.com'], feeds: [`https://onlinelibrary.wiley.com/feed/${issn}/most-recent`] });
  if (p.family === 'springer') Object.assign(p, { home: `https://link.springer.com/journal/${p.journal_id}/articles`,
    hosts: ['link.springer.com', 'api.springernature.com'], feeds: [] });
  if (p.family === 'oup') Object.assign(p, { home: `https://academic.oup.com/${p.code}/advance-articles`, hosts: ['academic.oup.com'] });
  if (p.family === 'atypon') p.feeds = [`${new URL(p.home).origin}/action/showFeed?type=etoc&feed=rss&jc=${p.code}`];
  return { ...p, feeds: p.feeds || [], journal_key: journal.key };
}

export function canonicalPublisherUrl(value, base) {
  const url = new URL(value, base);
  for (const key of ['rss', 'af', 'dgcid', 'utm_source', 'utm_medium', 'utm_campaign']) url.searchParams.delete(key);
  url.hash = '';
  return url.href;
}
