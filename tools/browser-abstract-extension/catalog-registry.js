// Target identities mirror data/config/journals.json. Existing pilot IDs stay stable.
const rows = [
  ['TAR','The Accounting Review','0001-4826','1558-7967','silverchair','accounting-review'],
  ['AOS','Accounting, Organizations and Society','0361-3682','1873-6289','elsevier','accounting-organizations-and-society'],
  ['JAE','Journal of Accounting and Economics','0165-4101','1879-1980','elsevier','journal-of-accounting-and-economics'],
  ['CAR','Contemporary Accounting Research','0823-9150','1911-3846','wiley','19113846'],
  ['RAS','Review of Accounting Studies','1380-6653','1573-7136','springer','11142'],
  ['AER','American Economic Review','0002-8282','1944-7981','aea','aer'],
  ['QJE','The Quarterly Journal of Economics','0033-5533','1531-4650','oup','qje'],
  ['RES','The Review of Economic Studies','0034-6527','1467-937X','oup','restud'],
  ['JF','The Journal of Finance','0022-1082','1540-6261','wiley','15406261'],
  ['JFE','Journal of Financial Economics','0304-405X','1879-2774','elsevier','journal-of-financial-economics'],
  ['RFS','The Review of Financial Studies','0893-9454','1465-7368','oup','rfs'],
  ['JCF','Journal of Corporate Finance','0929-1199','1872-6313','elsevier','journal-of-corporate-finance'],
  ['JIBS','Journal of International Business Studies','0047-2506','1478-6990','springer','41267'],
  ['MS','Management Science','0025-1909','1526-5501','atypon','mnsc'],
  ['JM','Journal of Management','0149-2063','1557-1211','atypon','joma'],
  ['JOM','Journal of Operations Management','0272-6963','1873-1317','wiley','18731317']
];
export const EXTRA_CATALOG_TASKS = rows.flatMap(([journal,name,print,online,family,code]) => {
  let host, prefix, tails, labels, extra = {};
  if (family === 'elsevier') { host='www.sciencedirect.com'; prefix=`/journal/${code}/`; tails=['latest','articles-in-press']; labels=['最新卷期','Articles in Press']; }
  if (family === 'wiley') { host='onlinelibrary.wiley.com'; prefix=`/toc/${code}/`; tails=['current','0/0']; labels=['最新卷期','Early View']; }
  if (family === 'atypon') { host=journal==='MS'?'pubsonline.informs.org':'journals.sagepub.com'; prefix=`/toc/${code}/`; tails=['current',journal==='MS'?'0/':'0/0']; labels=['最新卷期',journal==='MS'?'Articles in Advance':'OnlineFirst']; }
  if (family === 'oup' || family === 'silverchair') {
    host=family==='oup'?'academic.oup.com':'publications.aaahq.org'; prefix=`/${code}/`;
    tails=['issue',family==='oup'?'advance-articles':'publish-ahead-of-print']; labels=['最新卷期',family==='oup'?'Advance Articles':'Early Access'];
    extra={catalog_pattern:`^/${code}/(?:issue(?:/.*)?|advance-articles${family==='silverchair'?'|publish-ahead-of-print':''})/?$`,article_pattern:`^/${code}/(?:article|advance-article)/`};
  }
  if (family === 'springer') {
    host='link.springer.com';prefix=`/journal/${code}/`;tails=['volumes-and-issues','online-first']; labels=['最新卷期','Online First'];
    extra={hosts:['link.springer.com','link.springernature.com'],catalog_pattern:`^/journal/${code}/(?:volumes-and-issues(?:/[\\d-]+)?|online-first)/?$`,article_pattern:'^/article/10\\.'};
  }
  if (family === 'aea') {
    host='www.aeaweb.org';prefix='/journals/aer'; tails=['','/forthcoming'];labels=['最新卷期','Forthcoming Articles'];
    extra={catalog_pattern:'^(?:/journals/aer(?:/forthcoming)?/?|/issues/\\d+)$'};
  }
  return tails.map((tail,i) => ({journal,name,issns:[print,online],family,host,prefix,...extra,
    id:`catalog-${journal.toLowerCase()}-${i?'online':'issue'}`,label:labels[i],collection:i?'online':'issue',
    landing:!i&&['aea','springer'].includes(family),url:`https://${host}${prefix}${tail}`,
    ...(family==='silverchair'&&i?{legacy_urls:[`https://${host}${prefix}issue/advance-article`]}:{})}));
});
