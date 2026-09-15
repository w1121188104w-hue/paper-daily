import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { savePipelineCheckpoint, restorePipelineCheckpoint, checkpointOutput } from '../scripts/pipeline-checkpoint.js';
import { loadJournalConfig } from '../src/services/journals.js';
import { runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { verifyPilotReuse } from '../src/services/pilotReuseCheck.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), workspace = await fs.mkdtemp(path.join(parent, 'pipeline-archive-test-'));
  t.after(async () => { assert.equal(path.dirname(workspace), parent); assert.ok(path.basename(workspace).startsWith('pipeline-archive-test-')); await fs.rm(workspace, { recursive: true, force: true }); });
  const repo = path.join(workspace, 'source'), root = path.join(repo, 'data', 'journal-store');
  const config = await loadJournalConfig(), at = new Date('2026-09-15T01:00:00.000Z');
  const url = 'https://www.aeaweb.org/articles?id=10.1257/archive.test';
  await runCatalogDiscovery(config, { root, journalKey: 'AER', now: () => at,
    http: { request: () => assert.fail('Offline fixture') }, discover: async () => ({ leads: [{
      title: 'Investment and financial constraints', doi: '10.1257/archive.test', authors: ['Alice Smith'], date: '2026-09-10',
      abstract: 'We investigate investment responses to financial constraints using a quantitative model and a detailed panel of firms across several markets.',
      url, journal_confirmed: true, evidence: { url, scope_url: 'https://www.aeaweb.org/issues/123',
        fetched_at: at.toISOString(), method: 'citation_meta_abstract', body_sha256: 'a'.repeat(64) }
    }], attempts: [] }),
    search: async () => ({ called: false, reason: 'quota_exhausted' }) });
  return { workspace, root, config, at };
}

test('存档保留已验证历史和重试状态；不复制旁置密钥，续跑不重查未到期清单', async t => {
  const { workspace, root, config, at } = await fixture(t);
  await fs.writeFile(path.join(root, 'ignored-secret.txt'), 'not for export');
  const original = await readJournalLibrary({ root, config });
  const saved = await savePipelineCheckpoint(config, { root, tempParent: workspace });
  await assert.rejects(fs.readFile(path.join(saved.directory, 'data/journal-store/ignored-secret.txt')), { code: 'ENOENT' });
  const restored = await restorePipelineCheckpoint(config, { directory: saved.directory, tempParent: workspace });
  assert.notEqual(restored.directory, saved.directory);
  const library = await readJournalLibrary({ root: restored.root, config });
  assert.equal(library.papers.length, 1);
  assert.deepEqual(library.papers, original.papers);
  assert.ok(library.papers[0].abstract_original);
  assert.equal(library.papers[0].abstract_zh, '');
  assert.deepEqual(library.queue, original.queue);
  assert.deepEqual(library.enrichmentState, original.enrichmentState);
  assert.deepEqual(library.repairState, original.repairState);
  assert.equal(library.pointerText, original.pointerText);
  assert.equal(await restored.verifyOriginal(), true);
  const reuse = await verifyPilotReuse(config, { root: restored.root, journalKey: 'AER', now: () => at });
  assert.equal(reuse.network_calls, 0); assert.equal(reuse.status, 'verified_no_repeat_requests');
  const output = path.join(workspace, 'output');
  await checkpointOutput(output, saved);
  assert.equal(await fs.readFile(output, 'utf8'), `checkpoint_path=${saved.directory}\n`);
  await assert.rejects(checkpointOutput(output, { directory: 'bad\nextra=path' }));
});

test('篡改指针、伪造文件路径或更换期刊配置均不能恢复', async t => {
  const { workspace, root, config } = await fixture(t);
  const saved = await savePipelineCheckpoint(config, { root, tempParent: workspace });
  const marker = path.join(saved.directory, 'pipeline-checkpoint.json'), text = await fs.readFile(marker, 'utf8');
  await assert.rejects(restorePipelineCheckpoint({ ...config, altered: true }, { directory: saved.directory, tempParent: workspace }));
  const forged = JSON.parse(text); forged.files[0].path = '../../private';
  await fs.writeFile(marker, JSON.stringify(forged));
  await assert.rejects(restorePipelineCheckpoint(config, { directory: saved.directory, tempParent: workspace }));
  await fs.writeFile(marker, text);
  await fs.appendFile(path.join(saved.directory, 'data/journal-store/current.json'), '\n');
  await assert.rejects(restorePipelineCheckpoint(config, { directory: saved.directory, tempParent: workspace }));
});

test('正式历史若出现当前凭据字节，拒绝生成可上传清单', async t => {
  const { workspace, root, config } = await fixture(t);
  await assert.rejects(savePipelineCheckpoint(config, { root, tempParent: workspace, secrets: ['schema_version'] }), /禁止导出/);
  // The deliberately matching sentinel is only a test, not a real API key.
});
