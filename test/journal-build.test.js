import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary, withLibraryLock, writeLibraryJson, newRunId } from '../src/services/journalLibrary.js';
import { buildJournalSite, validateSiteDirectory, SITE_ASSETS } from '../src/services/journalSiteBuild.js';
import { journalGitFiles, stageJournalFiles } from '../src/services/journalGitFiles.js';
import { runSiteBuildCommand } from '../scripts/build-journal-site.js';
import { runJournalGitCommand } from '../scripts/journal-git-files.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const firstTime = '2026-09-07T01:00:00.000Z', secondTime = '2026-09-08T01:00:00.000Z';
function clients(title = 'Credit markets and investment') {
  return Object.fromEntries(['openalex', 'crossref'].map((source) => [source, async (j, options) => {
    const records = source === 'crossref' ? [normalizeSourceRecord({ source, source_id: '10.1234/one', doi: '10.1234/one',
      title, abstract: '', authors: [{ name: 'Alice Smith', orcid: '' }], journal_key: 'AER', journal_name: journal.name,
      journal_category: journal.category, journal_category_zh: journal.category_zh, print_issn: journal.print_issn,
      electronic_issn: journal.electronic_issn, publication_date: '2026-08-01', last_checked_at: options.checkedAt })] : [];
    return { source, journal_key: j.key, ok: true, complete: true, records, raw_count: records.length,
      raw_pages: [{ fixture: true, private_marker: 'RAW_NOT_FOR_SITE' }], rejected: [], duration_ms: 0, error: null };
  }]));
}
async function fixture(t, initialized = true) {
  const parent = path.resolve(os.tmpdir()), repositoryRoot = await fs.mkdtemp(path.join(parent, 'journal-build-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(repositoryRoot)), parent); assert.ok(path.basename(repositoryRoot).startsWith('journal-build-test-'));
    await fs.rm(repositoryRoot, { recursive: true, force: true });
  });
  const root = path.join(repositoryRoot, 'data/journal-store'), outputRoot = path.join(repositoryRoot, 'data/site-builds');
  if (initialized) await collect(root);
  return { root, outputRoot, repositoryRoot };
}
const collect = (root, time = firstTime, title) => runJournalCollection(config,
  { root, journalKey: 'AER', now: () => new Date(time), clients: clients(title) });
const pointer = (root) => fs.readFile(path.join(root, 'current.json'), 'utf8');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

test('静态构建只含八个必要文件，原始页和正式版本目录不会进入网站', async (t) => {
  const options = await fixture(t), before = await pointer(options.root), result = await buildJournalSite(config, options);
  const files = await fs.readdir(result.directory);
  assert.deepEqual(files.sort(), [...SITE_ASSETS, 'data.json', '.nojekyll'].sort());
  const data = await validateSiteDirectory(result.directory, result.hashes);
  assert.equal(data.papers.length, 1); assert.equal(data.delivery_mode, 'static');
  assert.equal(data.papers[0].classification.kind, 'candidate');
  assert.equal(data.classification_summary.version, 2);
  assert.equal(data.translation_eligibility.ready.paper_count, 1);
  assert.ok(!JSON.stringify(data).includes('RAW_NOT_FOR_SITE'));
  assert.equal(await pointer(options.root), before);
  assert.ok(JSON.parse(await pointer(options.outputRoot)).build.endsWith('/build.json'));
});
test('静态两页使用正确展示文案和相对资源，仓库子路径下资源仍可找到', async (t) => {
  const options = await fixture(t), result = await buildJournalSite(config, options);
  for (const page of ['index.html', 'day.html']) {
    const html = await fs.readFile(path.join(result.directory, page), 'utf8');
    assert.ok(html.includes('data-delivery="static"')); assert.ok(!html.includes('本地只读预览'));
    assert.ok(html.includes('重新读取网页数据'));
    for (const [, ref] of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)) {
      const url = new URL(ref, `https://example.test/paper-daily/${page}`);
      assert.ok(url.pathname.startsWith('/paper-daily/'));
      assert.ok((await fs.stat(path.join(result.directory, ref))).isFile());
    }
  }
});
test('默认不构建未初始化空库；显式空库预览不初始化正式数据', async (t) => {
  const options = await fixture(t, false);
  await assert.rejects(buildJournalSite(config, options));
  await assert.rejects(fs.stat(options.outputRoot), { code: 'ENOENT' });
  const result = await buildJournalSite(config, { ...options, allowEmpty: true });
  assert.equal(result.initialized, false); assert.equal(result.paper_count, 0);
  await assert.rejects(fs.stat(options.root), { code: 'ENOENT' });
});
test('损坏正式库即使allowEmpty也不能构建，不覆盖已成功网页入口', async (t) => {
  const options = await fixture(t); await buildJournalSite(config, options);
  const before = await pointer(options.outputRoot), library = await readJournalLibrary({ root: options.root, config });
  const file = path.join(options.root, library.manifest.papers['2026'].path);
  await fs.appendFile(file, ' ');
  await assert.rejects(buildJournalSite(config, { ...options, allowEmpty: true }));
  assert.equal(await pointer(options.outputRoot), before);
});
test('切换前发生中断、内容损坏或出现额外文件，旧网页版本保持可读', async (t) => {
  const options = await fixture(t), first = await buildJournalSite(config, options), before = await pointer(options.outputRoot);
  for (const beforePublish of [async () => { throw new Error('Interrupted'); },
    async ({ directory }) => fs.appendFile(path.join(directory, 'app.js'), '\nBROKEN'),
    async ({ directory }) => fs.writeFile(path.join(directory, 'secret.txt'), 'NOT_PUBLIC')]) {
    await assert.rejects(buildJournalSite(config, { ...options, beforePublish }));
    assert.equal(await pointer(options.outputRoot), before);
    assert.equal((await validateSiteDirectory(first.directory, first.hashes)).papers.length, 1);
  }
});
test('新版本不删除旧网页，失败采集日志仍可随合格历史数据构建', async (t) => {
  const options = await fixture(t), first = await buildJournalSite(config, options);
  const failedClients = Object.fromEntries(['openalex', 'crossref'].map((source) => [source, async () => { throw new Error('offline'); }]));
  await runJournalCollection(config, { root: options.root, journalKey: 'AER', clients: failedClients, now: () => new Date(secondTime) });
  const second = await buildJournalSite(config, options);
  assert.notEqual(second.directory, first.directory);
  assert.equal((await validateSiteDirectory(first.directory, first.hashes)).papers.length, 1);
  const data = await validateSiteDirectory(second.directory, second.hashes);
  assert.equal(data.papers.length, 1); assert.equal(data.runs[0].status, 'full_failure');
});
test('构建锁防止并发，网页输出不能与正式库重叠', async (t) => {
  const options = await fixture(t);
  await withLibraryLock(options.outputRoot, async () => assert.rejects(buildJournalSite(config, options)));
  for (const outputRoot of [options.root, path.dirname(options.root), path.join(options.root, 'website')]) {
    await assert.rejects(buildJournalSite(config, { ...options, outputRoot }));
  }
});
test('Git文件清单包含完整历史，只读列出，不包含草稿、尝试记录或孤立快照', async (t) => {
  const options = await fixture(t); await collect(options.root, secondTime, 'New credit market research');
  const orphan = newRunId(new Date());
  await writeLibraryJson(options.root, `snapshots/${orphan}/raw.json`, { discarded: true });
  await writeLibraryJson(options.root, 'translations/batches/draft/request.json', { private: 'DRAFT' });
  const plan = await journalGitFiles(config, options);
  assert.equal(plan.versions, 2); assert.ok(plan.files.includes('data/journal-store/current.json'));
  assert.equal(plan.files.filter((file) => file.endsWith('/manifest.json')).length, 2);
  assert.ok(!plan.files.some((file) => file.includes(orphan) || file.includes('attempts/') || file.includes('translations/batches/') || file.includes('writer.lock')));
  await assert.rejects(fs.stat(path.join(options.repositoryRoot, '.git')), { code: 'ENOENT' });
});
test('旧历史文件缺失或损坏也会拒绝Git提交，即使当前网页还能读', async (t) => {
  const options = await fixture(t), first = await readJournalLibrary({ root: options.root, config });
  await collect(options.root, secondTime, 'Updated title and evidence');
  const oldFile = path.join(options.root, first.manifest.papers['2026'].path);
  await fs.appendFile(oldFile, ' ');
  assert.equal((await readJournalLibrary({ root: options.root, config })).papers.length, 1);
  await assert.rejects(journalGitFiles(config, options));
});
test('Git清单拒绝把整个data目录或其他文件夹当论文库', async (t) => {
  const options = await fixture(t);
  await assert.rejects(journalGitFiles(config, { ...options, root: path.join(options.repositoryRoot, 'data') }));
  await assert.rejects(journalGitFiles(config, { ...options, repositoryRoot: path.join(options.repositoryRoot, 'nested') }));
});
test('真实临时Git仓库：只暂存正式论文，未提交，旧源码和翻译草稿不混入', async (t) => {
  const options = await fixture(t), cwd = options.repositoryRoot;
  git(cwd, 'init', '-q');
  await fs.writeFile(path.join(cwd, '.gitignore'), 'data/*\n');
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'user work');
  const result = await stageJournalFiles(config, options), staged = git(cwd, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  assert.equal(staged.length, result.staged_count); assert.ok(staged.length > 3);
  assert.ok(staged.every((file) => file.startsWith('data/journal-store/')));
  assert.ok(!staged.some((file) => file.includes('attempts/') || file.includes('writer.lock')));
  assert.throws(() => git(cwd, 'rev-parse', '--verify', 'HEAD'));
  assert.equal(await fs.readFile(path.join(cwd, 'unrelated.txt'), 'utf8'), 'user work');
});
test('已有暂存内容时停止，不把用户文件一起提交也不清空暂存区', async (t) => {
  const options = await fixture(t), cwd = options.repositoryRoot;
  git(cwd, 'init', '-q'); await fs.writeFile(path.join(cwd, 'user.txt'), 'keep'); git(cwd, 'add', '--', 'user.txt');
  await assert.rejects(stageJournalFiles(config, options));
  assert.equal(git(cwd, 'diff', '--cached', '--name-only').trim(), 'user.txt');
});
test('正式历史在Git暂存和不同换行设置下检出均保持原始字节', async (t) => {
  const { repositoryRoot: cwd } = await fixture(t, false);
  git(cwd, 'init', '-q');
  await fs.copyFile(new URL('../.gitattributes', import.meta.url), path.join(cwd, '.gitattributes'));
  const records = [
    ['data/journal-store/current.json', '{\n  "fixture": "LF"\n}\n'],
    ['data/journal-store/snapshots/fixture/raw/source.json', '{\r\n  "fixture": "CRLF"\r\n}\r\n']
  ];
  for (const [file, contents] of records) {
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), contents);
  }
  git(cwd, 'config', 'core.autocrlf', 'true');
  git(cwd, 'add', '--', '.gitattributes', ...records.map(([file]) => file));
  for (const [file, contents] of records) {
    assert.equal(git(cwd, 'show', `:${file}`), contents);
    assert.ok(git(cwd, 'check-attr', 'text', '--', file).trim().endsWith(': text: unset'));
  }
  for (const mode of ['true', 'input', 'false']) {
    const destination = path.join(cwd, `checkout-${mode}`);
    await fs.mkdir(destination);
    git(cwd, '-c', `core.autocrlf=${mode}`, 'checkout-index', '--all', `--prefix=${destination.split(path.sep).join('/')}/`);
    for (const [file, contents] of records) assert.equal(await fs.readFile(path.join(destination, file), 'utf8'), contents);
  }
});
test('CLI没有--stage不暂存，构建GitHub输出参数在本地不能误写文件', async () => {
  let staged = false, built = false;
  await runJournalGitCommand(['--check'], { plan: async () => ({ files: ['one'], versions: 1 }), stage: async () => { staged = true; }, log() {} });
  assert.equal(staged, false);
  await assert.rejects(runSiteBuildCommand(['--github-output'], { env: {}, build: async () => { built = true; }, log() {} }));
  assert.equal(built, false);
});
test('构建命令的GitHub输出只写构建目录，不触发上传', async (t) => {
  const options = await fixture(t, false), output = path.join(options.repositoryRoot, 'actions-output');
  const result = await runSiteBuildCommand(['--allow-empty', '--github-output'], {
    env: { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output }, log() {},
    build: (cfg, opts) => buildJournalSite(cfg, { ...options, ...opts })
  });
  assert.equal(await fs.readFile(output, 'utf8'), `directory=${result.directory}\n`);
});
test('工作流模板是可解析的JSON格式YAML，权限及门控完整', async () => {
  const templates = [];
  for (const name of ['daily-collect', 'deploy-pages']) {
    const file = new URL(`../deploy/github/${name}.yml.example`, import.meta.url);
    const workflow = JSON.parse(await fs.readFile(file, 'utf8')); templates.push(workflow);
    assert.equal(workflow.permissions.contents, 'read'); assert.equal(workflow.concurrency.group, 'journal-production');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.ok(workflow.on.workflow_dispatch); assert.equal(workflow.on.pull_request_target, undefined);
    const deploy = workflow.jobs.deploy; assert.equal(deploy.permissions.pages, 'write'); assert.equal(deploy.permissions['id-token'], 'write');
    assert.equal(deploy.environment.name, 'github-pages'); assert.ok(deploy.if.includes('JOURNAL_PAGES_ENABLED')); assert.ok(deploy.needs);
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
      if (step.run) assert.ok(!/npm (?:start|run (?:refresh|dev))|translations\.js|git add -A|git push --force/.test(step.run));
    }
  }
  assert.deepEqual(templates[0].on.schedule, [{ cron: '7,17,27,37,47,57 * * * *', timezone: 'Asia/Shanghai' }]);
  assert.equal(templates[1].on.schedule, undefined);
  const collect = templates[0].jobs.collect;
  assert.equal(collect.permissions.contents, 'write'); assert.ok(collect.if.includes('JOURNAL_AUTOMATION_ENABLED'));
  assert.ok(collect.if.includes('github.event.repository.default_branch'));
  assert.equal(collect.steps.find((step) => step.id === 'collect')['continue-on-error'], true);
  assert.ok(templates[0].jobs.report_source_failure.if.includes("collection_outcome == 'failure'"));
});
test('工作流先校验再暂存推送，随后构建和发布；不上传整个仓库或论文库', async () => {
  const flow = JSON.parse(await fs.readFile(new URL('../deploy/github/daily-collect.yml.example', import.meta.url), 'utf8'));
  const steps = flow.jobs.collect.steps, stage = steps.findIndex((step) => step.run?.includes('journal-git-files.js --stage'));
  assert.equal(steps[stage - 1].run, 'node scripts/journal-library.js --validate');
  assert.ok(steps[stage + 1].run.includes('git push origin'));
  assert.equal(steps[stage + 2].id, 'translate');
  assert.equal(steps[stage + 3].run, 'node scripts/journal-library.js --validate');
  assert.equal(steps[stage + 4].id, 'build');
  assert.equal(steps.find((step) => step.uses?.includes('upload-pages-artifact')).with.path, '${{ steps.build.outputs.directory }}');
  assert.equal(steps.filter((step) => JSON.stringify(step).includes('secrets.')).length, 2);
  assert.ok(steps.findIndex(step => step.id === 'collect') < steps.findIndex(step => step.id === 'enrich'));
  assert.ok(steps.findIndex(step => step.id === 'enrich') < stage);
  assert.equal(steps[stage + 2].env.DEEPSEEK_API_KEY, '${{ secrets.DEEPSEEK_API_KEY }}');
});

test('按用户授权允许公开仓库，仍要求明确启用开关且不读取或上传个人配置', async () => {
  for (const [name, jobKey] of [['daily-collect', 'collect'], ['deploy-pages', 'build']]) {
    const workflow = JSON.parse(await fs.readFile(new URL(`../deploy/github/${name}.yml.example`, import.meta.url), 'utf8'));
    const job = workflow.jobs[jobKey], serialized = JSON.stringify(workflow);
    assert.ok(job.steps[0].uses.startsWith('actions/checkout@'));
    assert.ok(!serialized.includes('JOURNAL_HISTORY_PRIVATE'));
    assert.ok(!serialized.includes('repository.private'));
    assert.ok(job.if.includes("== 'true'"));
    assert.ok(job.if.includes('github.event.repository.default_branch'));
    assert.ok(!/llm-settings\.json|git add -A|path.*data\/journal-store/.test(serialized));
    const secretSteps = job.steps.filter((step) => JSON.stringify(step).includes('secrets.'));
    assert.equal(secretSteps.length, name === 'daily-collect' ? 2 : 0);
    for (const step of secretSteps) assert.equal(step.if, step.id === 'enrich' ? "vars.JOURNAL_ENRICHMENT_ENABLED == 'true'" : "vars.JOURNAL_TRANSLATION_ENABLED == 'true'");
  }
});

test('更新的官方上传组件只打包已校验目录，保留.nojekyll，不扩大上传范围', async () => {
  for (const name of ['daily-collect', 'deploy-pages']) {
    const workflow = JSON.parse(await fs.readFile(new URL(`../deploy/github/${name}.yml.example`, import.meta.url), 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-pages-artifact@'));
    assert.equal(upload.uses, 'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9');
    assert.deepEqual(upload.with, { path: '${{ steps.build.outputs.directory }}', 'include-hidden-files': true });
  }
});

test('已授权的采集日程每天北京时间08:17和13:17运行，独立发布仍只接受手动入口', async () => {
  for (const name of ['daily-collect', 'deploy-pages']) {
    const template = JSON.parse(await fs.readFile(new URL(`../deploy/github/${name}.yml.example`, import.meta.url), 'utf8'));
    const prepared = JSON.parse(await fs.readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    template.name = template.name.replace(' (INACTIVE TEMPLATE)', '');
    assert.deepEqual(prepared, template);
    if (name === 'daily-collect') {
      assert.deepEqual(prepared.on.schedule, [{ cron: '7,17,27,37,47,57 * * * *', timezone: 'Asia/Shanghai' }]);
      assert.equal(prepared.on.workflow_dispatch.inputs.respect_schedule.default,false);
      assert.deepEqual(Object.keys(prepared.on),['workflow_dispatch','schedule']);
    } else assert.deepEqual(prepared.on,{ workflow_dispatch: {} });
    assert.equal(prepared.jobs.deploy.if, "vars.JOURNAL_PAGES_ENABLED == 'true'");
    if (name === 'daily-collect') {
      assert.equal(prepared.jobs.collect.steps.find((step) => step.id === 'collect').run,
        'node scripts/journal-library.js --collect --save --all --lookback-days 60 --only-if-needed');
    }
  }
});
