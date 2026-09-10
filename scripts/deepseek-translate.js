import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT, libraryPath, readJournalLibrary, writeLibraryJson } from '../src/services/journalLibrary.js';
import { createTranslationBatch, validateTranslationBatch } from '../src/services/translationQueue.js';
import { exportTranslationBatch, readTranslationJson } from '../src/services/translationWorkflow.js';
import { stableJson } from '../src/services/libraryValidation.js';
import { DeepSeekError, requireDeepSeekKey, planDeepSeekBatch, translateDeepSeekBatch } from '../src/services/deepseekTranslation.js';
import { generateReviewKey, reviewPublicKey, sealTranslationReview, openTranslationReview } from '../src/services/translationReviewEnvelope.js';

const HELP = `DeepSeek小批试译：默认不联网、不写库；不自动导入或发布。
  --plan                 只读查看最多10篇的请求规模
  --prepare-review       本机生成草稿解密文件；私钥留在Git忽略的工作目录
  --run                  明确调用API，最多10篇、每篇一次，无重试
                         需环境变量DEEPSEEK_API_KEY、TRANSLATION_REVIEW_PUBLIC_KEY
  --open-review 文件 --key-id 指纹   本机解密已下载的草稿，不改正式库
  --github-output        仅与--run组合，在Actions中输出密文文件目录
禁止把API密钥放命令行、公开仓库、网页或聊天。完成的只是草稿，仍需逐篇审阅。`;

export async function runDeepSeekCommand(args, { root = DEFAULT_LIBRARY_ROOT, env = process.env,
  log = console.log, fetchImpl = fetch, now = () => new Date() } = {}) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, plan: { type: 'boolean' }, 'prepare-review': { type: 'boolean' },
    run: { type: 'boolean' }, 'open-review': { type: 'string' }, 'key-id': { type: 'string' }, 'github-output': { type: 'boolean' }
  } });
  if (!Object.keys(values).length || values.help) { log(HELP); return 0; }
  const modes = ['plan', 'prepare-review', 'run', 'open-review'].filter((key) => values[key]);
  if (modes.length !== 1 || (values['github-output'] && !values.run) || (values['key-id'] && !values['open-review']))
    throw new DeepSeekError('INVALID_ARGUMENTS');
  if (values['prepare-review']) {
    const key = generateReviewKey(), prefix = `translations/review-keys/${key.fingerprint}`;
    const file = await libraryPath(root, `${prefix}/private.pem`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, key.private_key, { flag: 'wx', mode: 0o600 });
    await writeLibraryJson(root, `${prefix}/public.json`, { fingerprint: key.fingerprint, public_key: key.public_key });
    log(JSON.stringify({ key_id: key.fingerprint, public_key: key.public_key, private_key_path: file }, null, 2)); return 0;
  }
  if (values['open-review']) {
    if (!/^[a-f0-9]{64}$/.test(values['key-id'] || '')) throw new DeepSeekError('INVALID_REVIEW_KEY_ID');
    const privateKey = await fs.readFile(await libraryPath(root, `translations/review-keys/${values['key-id']}/private.pem`), 'utf8');
    const payload = openTranslationReview(await readTranslationJson(path.resolve(values['open-review'])), privateKey);
    validateTranslationBatch(payload.request);
    if (payload.result?.batch_id !== payload.request.batch_id || payload.report?.batch_id !== payload.request.batch_id)
      throw new DeepSeekError('INVALID_REVIEW_BUNDLE');
    const prefix = `translations/batches/${payload.request.batch_id}`;
    const requestFile = await libraryPath(root, `${prefix}/request.json`);
    try {
      const existing = await readTranslationJson(requestFile);
      if (stableJson(existing) !== stableJson(payload.request)) throw new DeepSeekError('REVIEW_BATCH_CONFLICT');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeLibraryJson(root, `${prefix}/request.json`, payload.request);
    }
    const outputPrefix = `translations/reviews/${payload.request.batch_id}/${values['key-id']}`;
    await writeLibraryJson(root, `${outputPrefix}/response.json`, payload.result);
    await writeLibraryJson(root, `${outputPrefix}/report.json`, payload.report);
    log(JSON.stringify({ opened: true, formal_data_changed: false, response_path: await libraryPath(root, `${outputPrefix}/response.json`),
      report_path: await libraryPath(root, `${outputPrefix}/report.json`) }, null, 2)); return 0;
  }
  const config = await loadJournalConfig();
  const library = await readJournalLibrary({ root, config });
  const proposed = createTranslationBatch(library.papers, { limit: 10, now: now(), sourceManifest: library.pointer?.manifest || null });
  if (!proposed.items.length) { log('没有待翻译研究论文；未联网或写文件。'); return 0; }
  const plan = planDeepSeekBatch(proposed);
  if (values.plan) { log(JSON.stringify({ ...plan, network_called: false, formal_data_changed: false }, null, 2)); return 0; }
  requireDeepSeekKey(env.DEEPSEEK_API_KEY); reviewPublicKey(env.TRANSLATION_REVIEW_PUBLIC_KEY);
  if (values['github-output'] && (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_OUTPUT)) throw new DeepSeekError('NOT_GITHUB_ACTIONS');
  const exported = await exportTranslationBatch(config, { root, limit: 10, now });
  if (exported.empty) { log('队列已经处理完毕；未联网。'); return 0; }
  planDeepSeekBatch(exported.batch);
  const prefix = `translations/deepseek/${exported.batch.batch_id}`;
  try { await writeLibraryJson(root, `${prefix}/started.json`, { started_at: now().toISOString(), plan }); }
  catch (error) { if (error.code === 'EEXIST') throw new DeepSeekError('BATCH_ALREADY_ATTEMPTED'); throw error; }
  const encryptedPrefix = `${prefix}/encrypted`;
  // Emit only this narrow ciphertext directory. Never upload the parent containing local keys/drafts.
  await fs.mkdir(await libraryPath(root, encryptedPrefix), { recursive: true });
  if (values['github-output']) await fs.appendFile(env.GITHUB_OUTPUT, `directory=${await libraryPath(root, encryptedPrefix)}\n`, 'utf8');
  const output = await translateDeepSeekBatch(exported.batch, { apiKey: env.DEEPSEEK_API_KEY, fetchImpl, now,
    checkpoint: async (bundle) => {
      const index = String(bundle.report.attempted_requests).padStart(2, '0');
      await writeLibraryJson(root, `${encryptedPrefix}/review-${index}.json`, sealTranslationReview(bundle, env.TRANSLATION_REVIEW_PUBLIC_KEY));
    } });
  await writeLibraryJson(root, `${prefix}/completed.json`, { status: output.report.status, attempted_requests: output.report.attempted_requests });
  log(JSON.stringify({ status: output.report.status, attempted_requests: output.report.attempted_requests,
    fields_ready_for_review: output.report.successful_fields, usage: output.report.usage,
    unknown_usage_requests: output.report.unknown_usage_requests, estimated_cny_known_usage: output.report.estimated_cny_known_usage,
    error_code: output.report.rows.find((row) => row.code)?.code || null, formal_data_changed: false }, null, 2));
  return output.report.status === 'ready_for_review' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runDeepSeekCommand(process.argv.slice(2)); }
  catch (error) {
    console.error(`试译未完成（${error instanceof DeepSeekError ? error.code : 'LOCAL_VALIDATION_OR_STORAGE_ERROR'}）；未自动重试、导入或发布。`);
    process.exitCode = 1;
  }
}
