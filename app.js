import { RUN_LABELS, TRANSLATION_LABELS, DOCUMENT_LABELS, CLASSIFICATION_REASONS, documentKind, normalizeDocumentFilter, isMissingAbstract,
  beijingDay, validDay, validMonth, shiftMonth, monthCells,
  filterPapers, countsByDay, selectedJournalKeys, collectionStatusForDay, latestCollectionActivity, paperTitle, doiHref, pageHref,
  sourceLabel, publicationDateText, publicationMonthText, ABSTRACT_LABELS, abstractSourceHref, workflowAuditChecks } from './viewModel.js';
import {loadWebsiteData} from './dataSource.js';

const $ = (id) => document.getElementById(id);
const node = (tag, text = '', className = '') => {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
};
const button = (label, action, className = 'secondary') => {
  const element = node('button', label, className); element.type = 'button';
  element.addEventListener('click', action); return element;
};
const params = new URLSearchParams(location.search), isDayPage = document.body.dataset.page === 'day';
const isCatalogPage = document.body.dataset.page === 'catalog';
const isStaticPage = document.body.dataset.delivery === 'static';
const isPublishedPage = document.body.dataset.source === 'journals';
let today = beijingDay();
const selectedDate = isDayPage ? params.get('date') : '';
const state = { data: null, page: 1, month: validMonth(params.get('month')) ? params.get('month') : today.slice(0, 7),
  filters: { journal: params.get('journal') || '', category: params.get('category') || '',
    kind: normalizeDocumentFilter(params.get('kind')), q: (params.get('q') || '').slice(0, 500) },
  catalog: { collection: ['issue','online','other','failed','all'].includes(params.get('collection')) ? params.get('collection') : 'issue',
    year: params.get('year') || '', volume: params.get('volume') || '', catalog: params.get('catalog') || '',
    failureStatus:['open','resolved','all'].includes(params.get('failureStatus'))?params.get('failureStatus'):'open',failureStage:params.get('failureStage')||'' } };
if(isCatalogPage) {
  if(isPublishedPage&&state.catalog.collection==='failed')state.catalog.collection='issue';
  state.filters.category='';
  if(state.catalog.collection==='other'&&!params.has('kind')) state.filters.kind='all';
  if(['online','other','failed'].includes(state.catalog.collection)) {state.catalog.year='';state.catalog.volume='';}
}
const timeText = (value) => value ? `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
  dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(value))}（北京时间）` : '暂无';

const journalLabel=key=>state.data?.journals.find(j=>j.key===key)?.display_name||key;
function syncUrl() {
  const extra = isCatalogPage ? state.catalog : isDayPage ? { date: selectedDate || '' } : { month: state.month };
  history.replaceState(null, '', pageHref(isCatalogPage ? 'catalog.html' : isDayPage ? 'day.html' : 'index.html', state.filters, extra));
  if($('catalogViewLink')) $('catalogViewLink').href=pageHref('catalog.html',{journal:state.filters.journal,kind:'candidate'});
  if($('calendarViewLink')) $('calendarViewLink').href=pageHref('index.html',state.filters);
  if (isDayPage) $('backToCalendar').href = pageHref('index.html', state.filters,
    { month: validDay(selectedDate) ? selectedDate.slice(0, 7) : today.slice(0, 7) });
}


function renderOverviewStats(data) {
  const grid=node('dl','','overview-stats');
  for(const [label,value] of [['文献记录',data.papers.length],['期刊目录',data.local_rss.catalogs.length],
    ['待翻译',data.pending.paper_count],['待补摘要',data.enrichment.missing_abstracts]]) {
    const item=node('div','','overview-stat');item.append(node('dt',label),node('dd',Number(value).toLocaleString('zh-CN')));grid.append(item);
  }
  $('libraryMeta').replaceChildren(grid);
}
function renderLocalStatus(data) {
  const rss=data.local_rss,job=rss.job,latest=data.runs[0];
  const running=job?.status==='running';
  $('statusBadge').textContent=running?'本地处理中':job?.status==='complete'?'RSS 处理完成':job?'部分步骤待处理':'尚未请求 RSS';
  $('statusBadge').className='status-badge '+(running?'':job?.status==='complete'?'ready':'partial');
  $('statusText').textContent=(job?.stage||'从插件点击“请求 RSS”开始。')+
    (latest?' 最近完成：'+timeText(latest.finished_at)+'；新增 '+latest.stats.added+' 条，更新 '+latest.stats.updated+' 条。':'');
  renderOverviewStats(data);
  $('libraryMeta').append(node('p','待翻译共 '+data.pending.field_count+' 个字段；当前请求范围 '+rss.active_journals.length+' 刊。','meta'));
  const failures=(rss.failures||[]).filter(f=>f.status==='open');
  $('attemptWarning').hidden=!(job?.errors?.length||failures.length);
  if(job?.errors?.length||failures.length) {
    $('attemptWarning').replaceChildren(node('span','部分步骤未完成，已保存内容保留。当前程序失败 '+failures.length+' 项。 '));
    const link=node('a','查看程序失败目录');link.href='catalog.html?collection=failed&kind=all';$('attemptWarning').append(link);
  }
  if($('enrichmentStatus')) $('enrichmentStatus').textContent='待补摘要 '+data.enrichment.missing_abstracts+' 条；其他及已确认无摘要的记录不计入。';
  renderLocalCatalogs(data);
}
function renderLocalCatalogs(data) {
  const target=$('workflowStatus');if(!target)return;
  const expanded=new Set([...target.querySelectorAll('details[data-journal][open]')].map(e=>e.dataset.journal));
  const scroller=target.closest('.popover-body'),scrollTop=scroller?.scrollTop||0;
  target.replaceChildren();
  const catalogs=data.local_rss.catalogs||[];
  target.append(node('p','按期刊展开查看卷期、收录数量和状态。','meta catalog-status-intro'));
  const list=node('div','','journal-status-list');target.append(list);
  const collectionOrder={issue:0,online:1,other:2};
  for(const key of data.local_rss.active_journals) {
    const rows=catalogs.filter(c=>c.journal_key===key).sort((a,b)=>
      (collectionOrder[a.collection]??3)-(collectionOrder[b.collection]??3)||
      numberOrder.compare(b.year||'',a.year||'')||numberOrder.compare(b.volume||'',a.volume||'')||
      numberOrder.compare(b.issue||'',a.issue||''));
    const group=node('details','','journal-status');group.dataset.journal=key;group.open=expanded.has(key);
    const summary=node('summary'),name=node('span','','journal-status-name');
    name.append(node('strong',journalLabel(key)),node('span',rows.length+' 个目录','meta'));
    summary.append(name,node('span',rows.reduce((total,c)=>total+c.paper_count,0).toLocaleString('zh-CN')+' 条','journal-status-count'));
    const content=node('div','','journal-status-content');group.append(summary,content);
    if(!rows.length) content.append(node('p','尚未建立目录','meta'));
    for(const catalog of rows) {
      const row=node('div','','catalog-status-row'),heading=node('div','','catalog-status-heading');
      heading.append(node('span',catalog.label,'catalog-status-label'),node('strong',catalog.paper_count+' 条','catalog-status-count'));row.append(heading);
      if(catalog.collection==='issue') {
        const meta=node('div','','catalog-status-meta');
        meta.append(node('span',catalog.status==='complete'?'已完成':'持续收录','catalog-state '+(catalog.status==='complete'?'complete':'collecting')));
        if(catalog.baseline)meta.append(node('span','起始卷期','catalog-baseline'));
        row.append(meta);
      }
      content.append(row);
    }
    list.append(group);
  }
  target.append(node('p','卷期沿用出版社编号；起始卷期不补历史缺项，确认下一正式期后将上一期标为已完成。','meta catalog-status-note'));
  if(scroller)scroller.scrollTop=scrollTop;
}

function renderStatus() {
  if(state.data.publication) {
    const data=state.data;
    $('statusBadge').textContent='已发布';$('statusBadge').className='status-badge ready';
    $('statusText').textContent='各期刊已收录的文献与目录概览。';
    renderOverviewStats(data);
    $('attemptWarning').hidden=true;
    if($('enrichmentStatus'))$('enrichmentStatus').textContent='待补摘要不含出版社已确认未提供摘要的记录。';
    renderLocalCatalogs(data);return;
  }
  if(state.data.local_rss) {renderLocalStatus(state.data);return;}
  const data = state.data, latest = data.runs[0];
  $('statusBadge').textContent = latest ? RUN_LABELS[latest.status] : '尚未采集';
  $('statusBadge').className = `status-badge ${latest?.status === 'full_failure' ? 'failed' :
    latest?.status === 'partial_failure' ? 'partial' : latest ? 'ready' : ''}`;
  $('statusText').textContent = latest ? `最近已保存的采集：${timeText(latest.finished_at)}。范围：${latest.journal_keys.join('、')}（${latest.journal_keys.length}/${data.journals.length}刊）；回查发表日期 ${latest.from_date} 至 ${latest.to_date}。本轮新增 ${latest.stats.added} 条、更新 ${latest.stats.updated} 条文献记录。` :
    '尚未建立真实采集记录。页面中的空白不代表这些期刊没有论文；浏览页面不会启动采集。';
  const activity=latestCollectionActivity(data);
  if(activity&&(!latest||Date.parse(activity.at)>=Date.parse(latest.finished_at))){
    const coverage=collectionStatusForDay(data,activity.date,data.journals.map(j=>j.key));
    $('statusBadge').textContent=coverage.label;
    $('statusBadge').className=`status-badge ${coverage.failed?'partial':'ready'}`;
    $('statusText').textContent=`最近已保存的采集或来源检查：${timeText(activity.at)}。当日 ${coverage.captured}/${coverage.total} 刊有官网采集证据；Crossref/OpenAlex ${coverage.complete}/${coverage.total} 刊双源检查完成，${coverage.failed} 刊来源失败或不完整。目录是否完整以目录核对结果为准。`;
  }
  const counts = data.papers.reduce((all, paper) => { const kind = documentKind(paper); all[kind] = (all[kind] || 0) + 1; return all; }, {});
  const kinds = Object.entries(DOCUMENT_LABELS).filter(([key]) => key !== 'all' && counts[key])
    .map(([key, label]) => `${label} ${counts[key]} 条`).join('；');
  const eligibility = data.translation_eligibility;
  $('libraryMeta').textContent = `库中共 ${data.papers.length} 条文献记录${kinds ? `：${kinds}` : ''}。历史待翻译总计 ${data.pending.paper_count} 条、${data.pending.field_count} 个字段。${eligibility ? `默认可导出研究论文 ${eligibility.ready.paper_count} 条、${eligibility.ready.field_count} 个字段；其他 ${eligibility.held.paper_count} 条暂缓。` : ''}${data.snapshot_at ? ` 数据版本保存于 ${timeText(data.snapshot_at)}，翻译保存时间不等于采集时间。` : ''}`;
  if (data.quarantined?.length) {
    const details = node('details');
    details.append(node('summary', `另有 ${data.quarantined.length} 条已确认错刊记录被隔离，不计入正常列表；原始记录仍保留。`));
    for (const row of data.quarantined) details.append(node('p',
      `${row.doi}：${row.title_original}。原归入 ${row.journal_key}，实际为 ${row.actual_journal}（ISSN ${row.actual_issn}）；目标 ISSN ${row.expected_issns.join(' / ')}。`, 'meta'));
    $('libraryMeta').append(details);
  }
  const warning = data.attempt_warning;
  $('attemptWarning').hidden = !warning;
  if (warning) {
    $('attemptWarning').textContent = ({
      uncommitted_failure: '注意：另有一次较新的采集未能保存，上面的状态仅属于较早的已保存记录。请先检查本地运行情况。',
      unconfirmed: '注意：另有一次采集尚无已保存的结果，可能仍在运行或曾经中断；不能将上面的记录视为最新采集成功。',
      unavailable: '注意：暂时无法核实是否有未保存的采集尝试，上方仅显示已通过校验的历史记录。'
    })[warning.status];
    $('statusBadge').textContent = '最新尝试需核查'; $('statusBadge').className = 'status-badge partial';
  }
  const enrichment = data.enrichment;
  if ($('enrichmentStatus')) {
    $('enrichmentStatus').textContent = enrichment?.latest ? `最近补全：${timeText(enrichment.latest.finished_at)}；本轮补入 ${enrichment.latest.stats.added} 篇，找到真实摘要 ${enrichment.latest.stats.abstracts_filled} 篇。库中仍有 ${enrichment.missing_abstracts} 条缺摘要；不会因打开网页而启动搜索。` : '官网核对与摘要补全尚未运行。';
  }
  renderWorkflow(data.collection_workflow);
}

function renderWorkflow(flow){
  if(state.data?.local_rss) {renderLocalCatalogs(state.data);return;}
  const target=$('workflowStatus');if(!target)return;const expanded=!!target.querySelector('details')?.open;target.replaceChildren();
  if(!flow){target.append(node('p','本网站尚无正式任务清单。没有提醒不能当作没有更新。'));return;}
  const stale=!flow.monitors.length||flow.monitors.some(m=>Date.now()-Date.parse(m.checked_at)>48*3600000);
  if(stale)target.append(node('p','发现监测尚未运行或超过 48 小时未更新。当前不能依赖“没有提醒”判断；可手动全刊巡检。','notice'));
  const failed=flow.monitors.filter(m=>['failed','partial','quota_exhausted'].includes(m.status));
  if(failed.length)target.append(node('p',`有 ${failed.length} 项来源检查失败、不完整或额度不足，不代表没有新论文。`,'notice'));
  target.append(node('h3','发现更新'));
  target.append(node('p','三源发现＋官网目录直读 → 插件补全剩余内容并核对 → 自动上传 → GitHub 统一翻译发布。外部付费搜索已停用；每周或半月手动全刊巡检兜底。','meta'));
  target.append(node('p',flow.tasks.length?`有 ${flow.tasks.length} 个目录待处理。打开浏览器扩展 → 开始增量采集，已由官网完整读取的目录不重复打开。`:'目前没有未处理的新目录提醒；这不保证期刊没有更新。'));
  const official=flow.monitors.filter(m=>m.source==='official'&&m.catalog_id);
  if(official.length)target.append(node('p',`官网直读：完整读取 ${official.filter(m=>m.status==='ok').length} / ${official.length} 个目录；受限或不完整的仍需浏览器处理，不当作空目录。`,'meta'));
  const feeds=flow.monitors.filter(m=>m.source==='official'&&!m.catalog_id);
  if(feeds.length)target.append(node('p',`公开 RSS：${feeds.filter(m=>m.status==='partial').length} 本期刊取得部分清单；用于发现和补原文，不代表目录完整。`,'meta'));
  for(const task of flow.tasks){const p=node('p',`${task.journal} · ${task.collection==='issue'?'卷期目录':'在线发表'} · ${task.confidence==='paper_detected'?'发现新论文线索':'疑似目录更新'} · `),a=node('a','查看官网目录');
    try{const u=new URL(task.url);if(u.protocol==='https:'){a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';p.append(a);}}catch{}target.append(p);}
  const checks=workflowAuditChecks(flow),due=checks.filter(c=>c.status!=='recently_checked');
  target.append(node('h3','到期巡检'));
  target.append(node('p',due.length?`${due.length} 个目录尚无核对基线或已到巡检时间（间隔 ${flow.audit_interval_days||14} 天）。这是巡检提醒，不代表发现了新论文；请在扩展中手动选择“全刊巡检”。`:
    checks.length?'目录均在巡检周期内；这不保证期间没有更新。':'尚无逐目录基线，不能确认巡检是否到期。'));
  const details=node('details');details.open=expanded;details.append(node('summary','查看各目录核对时间与已采卷期'));
  for(const c of checks)details.append(node('p',`${c.journal} · ${c.collection==='issue'?'最新一期':'在线发表'} · ${c.rank?`卷 ${c.rank[0]}${c.rank[1]?` 期 ${c.rank[1]}`:''} · `:''}${c.checked_at?`${c.paper_count} 篇目录记录`:'目录数量未确认'} · 上次核对 ${timeText(c.checked_at)} · ${c.status==='baseline_missing'?'待建立基线':c.status==='audit_due'?'已到期':`下次巡检 ${timeText(c.next_audit_at)}`}`,'meta'));
  target.append(details);
  target.append(node('p',`待补论文 ${flow.pending_papers?.length||0} 篇；上次完成全刊目录巡检：${timeText(flow.full_audit_last_at)}。日常增量不会自动扩成全刊巡检；已完成详情不重复采集。`,'meta'));
  const latest=flow.receipts.at(-1);if(latest)target.append(node('p',`最近已上线批次：${timeText(latest.at)}；完成目录 ${latest.completed_catalogs} 个，未完成目录 ${latest.pending_catalogs} 个。${latest.translation_status==='pending'?' GitHub 翻译正在排队。':latest.translation_status==='attention'?' 部分翻译暂缓，已完成内容保留。':latest.translation_status==='translated'?' 本批次翻译已处理。':''}`,'meta'));
}

const workflowTimer=setInterval(()=>{if(state.data)renderWorkflow(state.data.collection_workflow);},60000);
workflowTimer.unref?.(); // DOM unit tests must not be kept alive by the browser clock.

function renderFilters({ syncQuery = true } = {}) {
  if(isCatalogPage) {renderCatalogFilters({syncQuery});return;}
  const journals = state.data.journals, categories = [...new Map(journals.map((item) => [item.category, item.category_zh]))];
  if (!categories.some(([key]) => key === state.filters.category)) state.filters.category = '';
  if (!journals.some((item) => item.key === state.filters.journal && (!state.filters.category || item.category === state.filters.category))) state.filters.journal = '';
  const option = (value, label) => { const element = node('option', label); element.value = value; return element; };
  $('category').replaceChildren(option('', '全部分类'), ...categories.map(([key, label]) => option(key, label)));
  $('journal').replaceChildren(option('', state.filters.category ? '本分类全部期刊' : `全部${journals.length}刊`),
    ...journals.filter((item) => !state.filters.category || item.category === state.filters.category).map((item) => option(item.key, `${item.display_name||item.key} · ${item.name}`)));
  $('category').value = state.filters.category; $('journal').value = state.filters.journal;
  state.filters.kind = normalizeDocumentFilter(state.filters.kind);
  $('kind').replaceChildren(...Object.entries(DOCUMENT_LABELS).map(([key, label]) => option(key, label)));
  $('kind').value = state.filters.kind;
  if (syncQuery) $('query').value = state.filters.q;
  $('quickFilters').replaceChildren(...['', 'AER', 'JAR', 'JAE', 'CAR'].map((key) => {
    const item = button(key || `全部${journals.length}刊`, () => {
      clearTimeout(searchTimer); state.filters.q = $('query').value.trim();
      state.filters.journal = key; state.filters.category = ''; state.page = 1; renderFilters(); render();
    });
    item.setAttribute('aria-pressed', String(state.filters.journal === key && (!state.filters.category || Boolean(key))));
    return item;
  }));
}

const catalogTypeLabels={issue:'正式发表',online:'在线发表',other:'其他目录',failed:'程序失败',all:'全部文献目录'};
const numberOrder=new Intl.Collator('en',{numeric:true});
function catalogFormalMonthText(catalog) {
  const months=[...new Set(state.data.papers.filter(p=>p.catalog_id===catalog.id)
    .map(p=>(p.published_print_month||p.published_print_date||'').slice(0,7)).filter(validMonth))].sort();
  return '正式发表月份：'+(months.length?months.map(month=>month.slice(0,4)+' 年 '+Number(month.slice(5))+' 月').join('、'):'未提供');
}
function catalogChoices({ignoreId=false,ignoreYear=false,ignoreVolume=false}={}) {
  const f=state.catalog;
  return (state.data?.local_rss?.catalogs||[]).filter(c=>
    (!state.filters.journal||c.journal_key===state.filters.journal)&&
    (f.collection==='all'||c.collection===f.collection)&&
    (ignoreYear||!f.year||c.year===f.year)&&
    (ignoreVolume||!f.volume||c.volume===f.volume)&&
    (ignoreId||!f.catalog||c.id===f.catalog))
    .sort((a,b)=>a.journal_key.localeCompare(b.journal_key)||
      numberOrder.compare(b.year,a.year)||numberOrder.compare(b.volume,a.volume)||numberOrder.compare(b.issue,a.issue));
}
function catalogSelect(id,items,emptyLabel,selected) {
  const option=(value,label)=>{const o=node('option',label);o.value=value;return o;};
  const options=[option('',emptyLabel),...items.map(([value,label])=>option(value,label))];
  // An unknown bookmarked directory must show no results, not silently broaden to all papers.
  if(selected&&!items.some(([value])=>value===selected)) options.push(option(selected,'当前目录中不存在：'+selected));
  $(id).replaceChildren(...options);$(id).value=selected;
}
function clearCatalogLocation() {state.catalog.year='';state.catalog.volume='';state.catalog.catalog='';}
function renderCatalogFilters({syncQuery=true}={}) {
  const keys=[...new Set([...(state.data.local_rss?.active_journals||[]),...(state.data.local_rss?.catalogs||[]).map(c=>c.journal_key)])];
  const journals=keys.map(key=>state.data.journals.find(j=>j.key===key)||{key,name:key});
  catalogSelect('journal',journals.map(j=>[j.key,(j.display_name||j.key)+' · '+j.name]),'全部已建目录期刊',state.filters.journal);
  $('collection').value=state.catalog.collection;
  const failed=state.catalog.collection==='failed';
  $('issueFilters').hidden=['online','other','failed'].includes(state.catalog.collection);
  $('failureFilters').hidden=!failed;$('kindFilter').hidden=failed;
  $('failureStatus').value=state.catalog.failureStatus;$('failureStage').value=state.catalog.failureStage;
  $('catalogHint').textContent=failed?'这里记录流程卡住的文献或整批任务，用于排查 bug；与存放非研究文献和归属待定记录的“其他目录”分开。成功恢复后移入历史，不删除原文和原目录关系。':state.catalog.collection==='other'?'其他目录收录讨论评论、更正、撤稿、编辑资料等非研究文献，以及归属待定记录。':'默认展示研究论文；可切换文献类型查看全部记录。目录条数不随搜索或文献类型筛选改变。';
  $('collectionTabs').replaceChildren(...Object.entries(catalogTypeLabels).filter(([key])=>key!=='all'&&(!isPublishedPage||key!=='failed')).map(([key,label])=>{
    const open=(state.data.local_rss?.failures||[]).filter(f=>f.status==='open'&&(!state.filters.journal||f.journal_key===state.filters.journal)).length;
    const item=button(label+(key==='failed'?' · '+open:''),()=>{state.catalog.collection=key;if(key==='other')state.filters.kind='all';clearCatalogLocation();state.page=1;renderFilters();render();});
    item.setAttribute('aria-pressed',String(state.catalog.collection===key));return item;
  }));
  const base=catalogChoices({ignoreId:true,ignoreYear:true,ignoreVolume:true});
  const years=[...new Set(base.filter(c=>c.collection==='issue').map(c=>c.year))].sort((a,b)=>numberOrder.compare(b,a));
  catalogSelect('year',years.map(v=>[v,v+' 年']),'全部年份',state.catalog.year);
  const volumes=[...new Set(base.filter(c=>c.collection==='issue'&&(!state.catalog.year||c.year===state.catalog.year)).map(c=>c.volume))].sort((a,b)=>numberOrder.compare(b,a));
  catalogSelect('volume',volumes.map(v=>[v,'第 '+v+' 卷']),'全部卷号',state.catalog.volume);
  const choices=catalogChoices({ignoreId:true});
  catalogSelect('catalog',choices.map(c=>[c.id,journalLabel(c.journal_key)+' · '+c.label]),'全部匹配目录',state.catalog.catalog);
  catalogSelect('kind',Object.entries(DOCUMENT_LABELS).filter(([key])=>key!=='all'),'全部文献记录',state.filters.kind==='all'?'':state.filters.kind);
  // Keep the shared document-filter value, including all, for ordinary form changes.
  $('kind').options[0].value='all';$('kind').value=state.filters.kind;
  if(syncQuery) $('query').value=state.filters.q;
  $('quickFilters').replaceChildren(...['',...keys].map(key=>{
    const item=button(journalLabel(key)||'全部期刊',()=>{
      clearTimeout(searchTimer);state.filters.q=$('query').value.trim();state.filters.journal=key;state.page=1;
      clearCatalogLocation();renderFilters();render();
    });item.setAttribute('aria-pressed',String(state.filters.journal===key));return item;
  }));
  const chosen=catalogChoices(),total=chosen.reduce((n,c)=>n+c.paper_count,0);
  $('catalogScope').textContent=chosen.length?'当前选择 '+chosen.length+' 个目录，共 '+total+' 条已保存记录。':'当前选择尚无本地目录。';
  $('catalogGrid').replaceChildren(...choices.map(c=>{
    const item=button('',()=>{state.catalog.catalog=state.catalog.catalog===c.id?'':c.id;state.page=1;renderFilters();render();},'catalog-card');
    item.dataset.catalogId=c.id;item.setAttribute('aria-pressed',String(state.catalog.catalog===c.id));
    item.append(node('strong',journalLabel(c.journal_key)+' · '+c.label),node('span',c.paper_count+' 条记录','catalog-count'));
    if(c.collection==='issue') item.append(node('span',catalogFormalMonthText(c),'meta catalog-formal-month'));
    item.append(node('span',c.collection==='issue'?(c.status==='complete'?'已完成':'持续收录'):c.collection==='online'?'尚未归入正式卷期':'非研究文献及归属待定记录','meta'));
    if(c.collection==='online'&&c.completeness_basis==='rss_returned_list') item.append(node('span','按 RSS 认定齐全 · 持续更新','meta'));
    if(c.baseline) item.append(node('span','起始卷期，不补历史缺项','meta'));
    return item;
  }));
  if(!choices.length) $('catalogGrid').append(node('p','尚无匹配目录。可调整期刊或卷期筛选。','empty-state'));
  $('catalogGrid').hidden=failed||!state.filters.journal;
  if(failed) $('catalogScope').textContent='故障不改变已确认的卷期归属；下方按处理环节记录当前失败和恢复历史。';
}
function renderFailures() {
  const all=(state.data.local_rss?.failures||[]).filter(f=>!state.filters.journal||f.journal_key===state.filters.journal);
  const query=state.filters.q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows=all.filter(f=>(state.catalog.failureStatus==='all'||f.status===state.catalog.failureStatus)&&
    (!state.catalog.failureStage||f.stage===state.catalog.failureStage)&&query.every(token=>
      [f.title_original,f.doi,f.journal_key,journalLabel(f.journal_key),f.error_code,f.explanation,f.stage_label].join(' ').toLocaleLowerCase().includes(token)));
  $('listTitle').textContent=(state.filters.journal?state.filters.journal+' · ':'')+'程序失败目录';
  const open=all.filter(f=>f.status==='open');
  $('catalogSummary').replaceChildren(node('p','当前失败 '+open.length+' 项，其中 '+open.filter(f=>f.scope==='article').length+' 项涉及文献、'+open.filter(f=>f.scope==='feed').length+' 项尚未识别到具体文献；已恢复 '+all.filter(f=>f.status==='resolved').length+' 项。'));
  const pageSize=20,pages=Math.max(1,Math.ceil(rows.length/pageSize));state.page=Math.min(state.page,pages);
  $('listMeta').textContent='匹配 '+rows.length+' 项故障记录'+(rows.length?'；第 '+state.page+'/'+pages+' 页':'')+'。同一文献可能有不同环节的故障记录。';
  $('paperList').replaceChildren(...rows.slice((state.page-1)*pageSize,state.page*pageSize).map(f=>{
    const card=node('article','','paper-card failure-card');
    card.append(node('span',f.status==='open'?'当前失败':'已恢复','status-badge '+(f.status==='open'?'failed':'ready')),
      node('h3',(f.journal_key?journalLabel(f.journal_key)+' · ':'')+(f.title_original||'整批任务（尚未识别具体文献）')),
      node('p','卡住的环节：'+f.stage_label),node('p',f.explanation,'notice'),node('p','错误代码：'+f.error_code,'meta'),
      node('p','首次失败：'+timeText(f.first_failed_at)+'；最近失败：'+timeText(f.last_failed_at)+'；失败记录 '+f.occurrences+' 次。','meta'));
    if(f.doi)card.append(node('p','DOI：'+f.doi,'meta'));
    if(f.status==='resolved')card.append(node('p','恢复时间：'+timeText(f.resolved_at),'meta'));
    card.append(node('p','排查文件：data/程序失败目录/'+f.id+'.json','meta'));
    const evidence=node('details');evidence.append(node('summary','原始证据位置'),node('p',f.evidence.join('\n')||'见故障记录文件','meta evidence-paths'));card.append(evidence);
    const actions=node('div','','paper-actions'),paper=state.data.papers.find(p=>p.id===f.paper_id&&p.journal_key===f.journal_key);
    if(paper) {const a=node('a','查看已保存文献','ghost-link');a.href=pageHref('catalog.html',{journal:paper.journal_key,kind:'all',q:paper.doi},{collection:paper.collection,catalog:paper.catalog_id});actions.append(a);}
    const href=doiHref(f.doi)||abstractSourceHref(f.source_url);
    if(href){const a=node('a','查看来源','ghost-link');a.href=href;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}
    card.append(actions);return card;
  }));
  if(!rows.length) $('paperList').append(node('p',open.length===0&&state.catalog.failureStatus==='open'?'当前没有未完成的程序故障。已恢复的记录可切换“已恢复历史”查看。':'当前筛选条件下没有故障记录。','empty-state'));
  $('pagination').replaceChildren();
  if(pages>1) {const prev=button('上一页',()=>{state.page--;renderFailures();}),next=button('下一页',()=>{state.page++;renderFailures();});prev.disabled=state.page===1;next.disabled=state.page===pages;$('pagination').append(prev,node('span',state.page+' / '+pages),next);}
}
function renderCatalogSummary(papers) {
  const catalogs=catalogChoices(),ids=new Set(catalogs.map(c=>c.id));
  const stored=state.data.papers.filter(p=>ids.has(p.catalog_id));
  const title=catalogs.length===1?journalLabel(catalogs[0].journal_key)+' · '+catalogs[0].label:
    (state.filters.journal||'全部期刊')+' · '+catalogTypeLabels[state.catalog.collection];
  $('listTitle').textContent=title;
  const target=$('catalogSummary');target.replaceChildren();
  target.append(node('p','目录已保存 '+stored.length+' 条；当前筛选显示 '+papers.length+' 条；待补摘要 '+stored.filter(isMissingAbstract).length+' 条；无需摘要 '+stored.filter(p=>!p.abstract_original&&!isMissingAbstract(p)).length+' 条。'));
  if(catalogs.some(c=>c.collection==='issue')) target.append(node('p','条数表示本地已收录内容。起始卷期不追补历史缺项；下一正式期出现后，上一期标记完成。','meta'));
  if(catalogs.length&&stored.length===0) target.append(node('p','该目录目前没有记录。','meta'));
  return ids;
}

function renderCalendar(papers) {
  const counts = countsByDay(papers);
  $('monthTitle').textContent = `${state.month.slice(0, 4)}年 ${Number(state.month.slice(5))}月`;
  $('calendarMeta').textContent = `今天 ${today}（北京）；${DOCUMENT_LABELS[state.filters.kind]}，本月匹配 ${papers.filter((paper) => paper.first_seen_date.startsWith(state.month)).length} 条。点击日期查看。`;
  const cells = ['一', '二', '三', '四', '五', '六', '日'].map((label) => node('div', label, 'weekday'));
  for (const date of monthCells(state.month)) {
    if (!date) { const blank = node('div', '', 'day-cell empty'); blank.setAttribute('aria-hidden', 'true'); cells.push(blank); continue; }
    const count = counts[date] || 0;
    const link = node('a', '', `day-cell ${count ? 'has-recommendations' : ''} ${date === today ? 'today' : ''} ${date > today ? 'future' : ''}`);
    link.href = pageHref('day.html', state.filters, { date });
    link.setAttribute('aria-label', `${date}，${count}条匹配记录`);
    if (date === today) link.setAttribute('aria-current', 'date');
    link.append(node('span', String(Number(date.slice(8))), 'day-number'),
      node('span', `${count}条`, 'day-note day-count'));
    cells.push(link);
  }
  $('calendarGrid').replaceChildren(...cells);
}

function oldTranslation(field, paper) {
  if (!paper[`${field}_zh`] || paper[`${field}_translation_status`] === 'done') return null;
  const details = node('details'); details.append(node('summary', `查看旧中文${field === 'title' ? '标题' : '摘要'}（不作为当前译文）`),
    node('p', paper[`${field}_zh`], 'summary')); return details;
}
function renderPaper(paper) {
  const card = node('article', '', 'paper-card');
  const tags = node('div', '', 'paper-tags');
  const kind = documentKind(paper);
  tags.append(node('span', `${journalLabel(paper.journal_key)} · ${paper.journal_category_zh}`, 'status-badge'),
    node('span', DOCUMENT_LABELS[kind], `status-badge document-kind ${kind}`),
    ...paper.sources.map((source) => node('span', sourceLabel(source), 'status-badge')));
  card.append(tags, node('h3', paperTitle(paper)));
  const classification = node('details', '', 'classification-detail');
  classification.append(node('summary', '为什么这样分类？'), node('p',
    paper.classification?.reason || CLASSIFICATION_REASONS[paper.classification?.rule] || '缺少可核实的分类依据，需人工核查。', 'meta'));
  card.append(classification);
  if (kind === 'possible_retraction' || kind === 'possible_correction') card.append(node('p',
    '这条记录是疑似通知，不是普通研究论文。请核对通知正文及它所指的原论文；系统不会自动删除或合并原论文。', 'notice'));
  if (paper.title_translation_status === 'done') {
    const english = node('p', paper.title_original, 'english-title'); english.lang = 'en'; card.append(english);
  }
  card.append(node('p', `标题：${TRANSLATION_LABELS[paper.title_translation_status]} · 摘要：${TRANSLATION_LABELS[paper.abstract_translation_status]}`, 'meta'));
  const oldTitle = oldTranslation('title', paper); if (oldTitle) card.append(oldTitle);
  const names = paper.authors.map((author) => author.name);
  if (names.length > 4) {
    const details = node('details', '', 'paper-authors');
    details.append(node('summary', `作者：${names.slice(0, 4).join('；')} 等${names.length}位（展开全部）`), node('p', names.join('；'))); card.append(details);
  } else card.append(node('p', `作者：${names.join('；') || '来源未提供作者'}`, 'paper-authors'));
  if(paper.affiliations?.length){const details=node('details','','paper-affiliations');details.append(node('summary','作者机构（展开查看）'));
    for(const a of paper.affiliations)details.append(node('p',`${a.author||'作者对应关系未明确'}：${a.affiliation}`));card.append(details);}
  if (paper.author_variants?.length > 1) {
    const details = node('details', '', 'author-variants');
    details.append(node('summary', '来源作者写法不同（展开对照）'),
      node('p', '以下保留各来源的署名及顺序。差异可能只是拼写，也可能需要核对；不据此自动合并作者。', 'meta'));
    for (const variant of paper.author_variants) details.append(node('p',
      `${variant.sources.map(sourceLabel).join(' / ')}：${variant.names.join('；')}`, 'meta'));
    card.append(details);
  }
  card.append(node('p', paper.journal_name, 'meta'));
  if(paper.collection) card.append(node('p','目录：'+(state.data.local_rss?.catalogs?.find(c=>c.id===paper.catalog_id)?.label||paper.collection),'meta'));
  if(paper.publisher_directory) card.append(node('p','出版社原始归属：'+paper.publisher_directory.label,'meta'));
  if(paper.directory_routing) card.append(node('p',paper.directory_routing.reason,'meta'));
  const abstractState = node('p', `原始摘要：${!paper.abstract_original&&!isMissingAbstract(paper)?'无摘要，无需补采':ABSTRACT_LABELS[paper.abstract_status] || (paper.abstract_original ? '已有摘要' : '待补全')}${paper.abstract_next_retry_at ? `；下次尝试不早于 ${timeText(paper.abstract_next_retry_at)}` : ''}`, 'meta');
  const sourceUrl = abstractSourceHref(paper.abstract_source_url);
  if (sourceUrl && paper.abstract_original) {
    const link = node('a', ` · 查看 ${sourceLabel(paper.abstract_source)} 来源`, 'ghost-link'); link.href = sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; abstractState.append(link);
  }
  card.append(abstractState);
  if (paper.abstract_original) {
    const originalLanguage = paper.abstract_status === 'english_missing' ? 'fr' : 'en';
    const translated = paper.abstract_translation_status === 'done' && Boolean(paper.abstract_zh);
    const abstract = node('p', translated ? paper.abstract_zh : paper.abstract_original, 'summary');
    abstract.lang = translated ? 'zh-CN' : originalLanguage;
    if (translated) {
      const controls = node('div', '', 'abstract-switch'); controls.setAttribute('aria-label', '摘要语言');
      const setLanguage = (zh) => {
        abstract.textContent = zh ? paper.abstract_zh : paper.abstract_original; abstract.lang = zh ? 'zh-CN' : originalLanguage;
        chinese.setAttribute('aria-pressed', String(zh)); english.setAttribute('aria-pressed', String(!zh));
      };
      const chinese = button('中文摘要', () => setLanguage(true));
      const english = button(originalLanguage === 'fr' ? '法文原文（英文待补）' : 'English abstract', () => setLanguage(false));
      controls.append(chinese, english); setLanguage(true); card.append(controls);
    } else card.append(node('p', originalLanguage === 'fr' ? '法文原文（英文待补）' : '英文摘要', 'meta'));
    card.append(abstract);
  } else card.append(node('p', '来源未提供摘要。暂不补写或推测论文内容。', 'empty-state'));
  const oldAbstract = oldTranslation('abstract', paper); if (oldAbstract) card.append(oldAbstract);
  const date = (field) => paper.date_conflicts?.includes(field) ? '来源月份有冲突，待自动核实' : publicationDateText(paper[field], paper.date_sources?.[field]);
  const formal=Object.hasOwn(paper,'published_print_month')?`正式发表月份：${date('published_print_month')}`:`正式发表：${date('published_print_date')}`;
  card.append(node('p', `首次发现：${paper.first_seen_date}（北京） · 在线发表：${date('published_online_date')} · ${formal}`, 'meta'));
  if (Object.hasOwn(paper, 'publication_month')) card.append(node('p', `发表月份：${publicationMonthText(paper)}`, 'meta'));
  else if (paper.publication_date) card.append(node('p', `来源通用发表月份：${date('publication_date')}（不等同于在线发表时间）`, 'meta'));
  const bibliographic = [paper.volume ? `卷 ${paper.volume}` : '', paper.issue ? `期 ${paper.issue}` : '', paper.pages ? `页 ${paper.pages}` : ''].filter(Boolean);
  if (bibliographic.length) card.append(node('p', bibliographic.join(' · '), 'meta'));
  const actions = node('div', '', 'paper-actions'), href = doiHref(paper.doi);
  if (href) {
    const link = node('a', `DOI：${paper.doi}`, 'ghost-link'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
  } else actions.append(node('span', '来源未提供可用 DOI', 'meta'));
  if (!isDayPage) {
    const link = node('a', '查看发现当日', 'ghost-link'); link.href = pageHref('day.html', state.filters, { date: paper.first_seen_date }); actions.append(link);
  }
  if(!isCatalogPage&&paper.catalog_id) {
    const link=node('a','查看所属目录','ghost-link');
    link.href=pageHref('catalog.html',{journal:paper.journal_key,kind:state.filters.kind},
      {collection:paper.collection,year:paper.issue_year,volume:paper.volume,catalog:paper.catalog_id});actions.append(link);
  }
  card.append(actions); return card;
}

function renderList(papers) {
  const pageSize = 20, pageCount = Math.max(1, Math.ceil(papers.length / pageSize));
  state.page = Math.min(state.page, pageCount);
  $('listMeta').textContent = `找到 ${papers.length} 条${isCatalogPage?'当前目录内的':isDayPage ? '本日' : '全部日期的'}匹配记录（${DOCUMENT_LABELS[state.filters.kind]}）${papers.length ? `；第 ${state.page}/${pageCount} 页，每页最多 ${pageSize} 条` : ''}。`;
  $('paperList').replaceChildren(...papers.slice((state.page - 1) * pageSize, state.page * pageSize).map(renderPaper));
  if (!papers.length) $('paperList').append(node('p', isCatalogPage?'当前目录及筛选条件下没有记录。可清空搜索、选择全部文献，或切换目录。':!state.data.initialized ? (isStaticPage ? '尚无已发布的论文，请等待维护者完成首次采集。' : '尚未建立真实论文库。完成一次手动采集并保存后，在这里重新读取即可。') :
    '当前条件下没有记录。可切换文献类型、重置筛选或查看其他日期；没有匹配结果不表示当天已成功采集。', 'empty-state'));
  $('pagination').replaceChildren();
  if (pageCount > 1) {
    const move = (delta) => {
      state.page += delta; renderList(papers);
      const title = $('listTitle'); title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true }); title.scrollIntoView({ block: 'start' });
    };
    const previous = button('上一页', () => move(-1)), next = button('下一页', () => move(1));
    previous.disabled = state.page === 1; next.disabled = state.page === pageCount;
    $('pagination').append(previous, node('span', `${state.page} / ${pageCount}`), next);
  }
}

function render() {
  if (!state.data) return;
  today = beijingDay();
  syncUrl();
  if (isDayPage && !validDay(selectedDate)) {
    $('dayTitle').textContent = '日期无效'; $('dayCoverage').textContent = '请从日历点击有效日期进入。';
    $('paperList').replaceChildren(); $('listMeta').textContent = '没有展示其他日期的论文。'; return;
  }
  let papers = filterPapers(state.data.papers, { ...state.filters, date: isDayPage ? selectedDate : '' });
  if(isCatalogPage) {
    if(state.catalog.collection==='failed') {renderFailures();return;}
    const ids=new Set(catalogChoices().map(c=>c.id));papers=papers.filter(p=>ids.has(p.catalog_id));
    renderCatalogSummary(papers);renderList(papers);return;
  }
  if (isDayPage) {
    $('dayTitle').textContent = `${selectedDate} 论文详情`;
    const coverage = collectionStatusForDay(state.data, selectedDate, selectedJournalKeys(state.data.journals, state.filters));
    $('dayCoverage').textContent = `已保存记录显示：${selectedDate > today ? '未来日期' : coverage.label}；所选期刊 ${coverage.captured}/${coverage.total} 刊有官网采集证据，${coverage.complete}/${coverage.total} 刊 Crossref/OpenAlex 双源检查完成，${coverage.failed} 刊来源失败或不完整。采集状态不受搜索关键词或文献类型影响；论文条数按首次入库日期统计，零条不代表没有采集，目录完整性见核对结果。`;
    if(state.data.publication) $('dayCoverage').textContent='已发布论文按首次发现日期归档；日期为空不代表出版社当天没有论文。';
    else if(state.data.local_rss) $('dayCoverage').textContent='本地 RSS：'+coverage.label+'；本轮已接入的所选期刊 '+coverage.rss_checked+'/'+coverage.rss_total+' 刊完成请求。论文按首次发现日期归档。';
    document.title = `${selectedDate} 论文详情 · 经管顶刊`;
  } else renderCalendar(papers);
  renderList(papers);
}

async function load() {
  $('reload').disabled = true;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), isPublishedPage?60000:15000);
  try {
    const data = await loadWebsiteData({split:isPublishedPage,signal:controller.signal});
    if (data.schema_version !== 1 || !Array.isArray(data.papers) || !Array.isArray(data.journals) || !Array.isArray(data.runs)) throw new Error('Invalid data');
    state.data = data;
    state.page = 1;
    for (const control of $('filters').elements) control.disabled = false;
    renderStatus(); renderFilters(); render();
  } catch {
    $('statusBadge').textContent = '读取失败'; $('statusBadge').className = 'status-badge failed';
    $('statusText').textContent = state.data ? '新数据读取失败；下方保留本页上次成功读取的内容，不是最新结果。请检查论文库或稍后重试。' :
      (isStaticPage ? '网页数据暂时无法读取，请稍后重试或联系维护者；这不代表没有论文。' : '论文数据暂时无法读取或未通过校验。请通过本地只读预览打开页面，或检查论文库；这不代表没有论文。');
  } finally { clearTimeout(timer); $('reload').disabled = false; }
}

for (const control of $('filters').elements) control.disabled = true;
let searchTimer, composingQuery = false;
const applyFilters = ({ preserveQuery = false } = {}) => {
  if (!state.data) return;
  if(isCatalogPage&&state.filters.journal!==$('journal').value) clearCatalogLocation();
  clearTimeout(searchTimer); state.filters.q = $('query').value.trim(); state.filters.journal = $('journal').value;
  state.filters.category = $('category')?.value||''; state.page = 1;
  state.filters.kind = normalizeDocumentFilter($('kind').value);
  renderFilters({ syncQuery: !preserveQuery }); render();
};
$('filters').addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); });
const scheduleSearch = () => {
  clearTimeout(searchTimer);
  if (!composingQuery) searchTimer = setTimeout(() => applyFilters({ preserveQuery: true }), 180);
};
// Do not overwrite an in-progress query: this preserves spaces, caret and IME composition.
$('query').addEventListener('compositionstart', () => { composingQuery = true; clearTimeout(searchTimer); });
$('query').addEventListener('compositionend', () => { composingQuery = false; scheduleSearch(); });
$('query').addEventListener('input', scheduleSearch);
for (const id of ['journal', 'category', 'kind']) $(id)?.addEventListener('change', applyFilters);
$('reset').addEventListener('click', () => { clearTimeout(searchTimer); state.filters = { journal: '', category: '', kind: 'candidate', q: '' }; state.page = 1;
  if(isCatalogPage) {state.catalog.collection='issue';state.catalog.failureStatus='open';state.catalog.failureStage='';clearCatalogLocation();}renderFilters(); render(); });
$('reload').addEventListener('click', load);
if(isCatalogPage) for(const id of ['collection','year','volume','catalog','failureStatus','failureStage']) $(id).addEventListener('change',()=>{
  state.catalog[id]=$(id).value;
  if(id==='collection') {clearCatalogLocation();if(state.catalog.collection==='other')state.filters.kind='all';}
  if(id==='year') {state.catalog.volume='';state.catalog.catalog='';}
  if(id==='volume') state.catalog.catalog='';
  state.page=1;clearTimeout(searchTimer);state.filters.q=$('query').value.trim();renderFilters();render();
});
if (!isDayPage&&!isCatalogPage) {
  for (const [id, delta] of [['prevMonth', -1], ['nextMonth', 1]]) $(id).addEventListener('click', () => { state.month = shiftMonth(state.month, delta); render(); });
  $('thisMonth').addEventListener('click', () => { state.month = beijingDay().slice(0, 7); render(); });
}
// Navigation must remain usable even while the first read is pending or fails.
syncUrl();
load();

// Refresh local results automatically without triggering collection or translation.
if(!isPublishedPage&&(location.hostname==='127.0.0.1'||location.hostname==='localhost')) setInterval(async()=>{
  if(document.hidden||composingQuery||document.activeElement===$('query'))return;
  try{
    const response=await fetch('./data.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    const next=await response.json();
    if(next.schema_version===1&&next.snapshot_at!==state.data?.snapshot_at){
      state.data=next;renderStatus();renderFilters();render();
    }
  }catch{}
},5000);

// Publication status is separate from the unchanged local data.json contract.
if(!isPublishedPage) setInterval(async()=>{
  if(document.hidden)return;
  try{
    const response=await fetch('./_local/publication/status',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(!response.ok)return;const publication=await response.json();
    let target=$('publicationStatus');
    if(!target){target=node('p','','meta');target.id='publicationStatus';$('statusText').after(target);}
    target.textContent=publication.message||'';
  }catch{}
},5000);
