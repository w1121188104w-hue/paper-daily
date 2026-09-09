import { beijingDay } from '../../public/journals/viewModel.js';

// Synthetic, in-memory UI fixtures only. Never pass these to the formal collection/storage workflow.
export function journalUiFixture(config, now = new Date()) {
  const today = beijingDay(now), yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const previousDay = yesterday.toISOString().slice(0, 10);
  const journals = config.journals.map(({ key, name, category, category_zh }) => ({ key, name, category, category_zh }));
  const keys = [...journals.map((journal) => journal.key), 'AER', 'JAR', 'JAE', 'CAR', 'AER', 'JAR'];
  const papers = keys.map((key, index) => {
    const journal = journals.find((item) => item.key === key), number = index + 1;
    const status = ['done', 'pending', 'failed', 'outdated', 'no_abstract'][index % 5];
    const titleStatus = status === 'no_abstract' ? 'pending' : status;
    const title = `[UI TEST] ${key}: Credit supply and firm investment (${number})`;
    return {
      id: `ui-test:${String(number).padStart(3, '0')}`, doi: `10.9999/ui-test-${String(number).padStart(3, '0')}`,
      journal_key: key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
      first_seen_date: index % 5 === 0 ? previousDay : today,
      title_original: index === 24 ? '[UI TEST] <img src=x onerror=alert(1)> JAR security display test' :
        index === 23 ? `${title} ${'LongUnbrokenIdentifier'.repeat(8)}` : title,
      title_zh: ['done', 'failed', 'outdated'].includes(titleStatus) ? `【验收测试】${key}：信贷供给与企业投资（${number}）` : '',
      title_translation_status: titleStatus,
      classification: { version: 2, kind: 'candidate', excluded: false, rule: 'retain_by_default' },
      abstract_original: status === 'no_abstract' ? '' : '[UI TEST: fictional research, not a real paper.] We examine credit supply and firm investment using a synthetic sample from 2001 to 2020. The simulated effect is 2.5 percent.\n\nThis paragraph checks preserved line breaks and the English abstract switch. No finding here should be cited as research evidence.',
      abstract_zh: ['done', 'failed', 'outdated'].includes(status) ? '【验收测试：虚构材料，不是真实论文】我们使用2001至2020年的模拟样本，测试信贷供给与企业投资的展示。模拟影响为2.5%。\n\n本段用于检查换行、中文摘要切换和窄屏阅读。请勿将这里的内容用作学术证据。' : '',
      abstract_translation_status: status,
      sources: index % 3 === 0 ? ['openalex', 'crossref'] : [index % 2 ? 'openalex' : 'crossref'],
      authors: Array.from({ length: index === 6 || index === 0 ? 9 : 2 }, (_, author) => ({
        name: ['Test Alice Smith', 'Test Bob Chen', 'Test Carol Wang', 'Test David Li', 'Test Emma Jones',
          'Test Frank Zhang', 'Test Grace Brown', 'Test Henry Wu', 'Test Iris Liu'][author], orcid: '' })),
      published_online_date: '2026-07-15', published_print_date: index % 2 ? '' : '2026-08',
      publication_date: '2026-07-15', volume: '100', issue: '3', pages: '1–25'
    };
  });
  return { schema_version: 1, initialized: true, snapshot_at: now.toISOString(), journals, papers,
    pending: { paper_count: papers.filter((paper) => paper.title_translation_status !== 'done').length,
      field_count: papers.reduce((sum, paper) => sum + Number(paper.title_translation_status !== 'done') + Number(!['done', 'no_abstract'].includes(paper.abstract_translation_status)), 0) },
    attempt_warning: null,
    runs: [{ run_date: today, started_at: now.toISOString(), finished_at: now.toISOString(), from_date: '2026-07-15', to_date: today,
      journal_keys: keys.slice(0, 19), status: 'partial_failure', stats: { added: 20, updated: 0, new_pending_fields: 0 },
      sources: journals.flatMap((journal) => ['openalex', 'crossref'].map((source) => ({ source, journal_key: journal.key,
        ok: !(journal.key === 'AER' && source === 'crossref'), complete: !(journal.key === 'AER' && source === 'crossref') }))) }]
  };
}
