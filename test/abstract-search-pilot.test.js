import test from 'node:test';
import assert from 'node:assert/strict';
import { abstractSearchPilot, TARGET_IDS } from '../scripts/abstract-search-pilot.js';
import { pilotSearch } from '../scripts/search-pilot.js';
test('摘要试跑不在本机读取密钥或启动，限定三篇已知论文', async () => {
  await assert.rejects(abstractSearchPilot({ env: {} }));
  assert.equal(TARGET_IDS.length, 3); assert.ok(Object.isFrozen(TARGET_IDS));
});
test('三篇完整搜索兜底最多六次免费请求，不放大月额度', async () => {
  let requests = 0;
  const search = pilotSearch({ maxSerpapi: 6, policy: { zhipu_monthly_limit: 2000 },
    sources: { account: async () => ({}) }, budget: { run: async args => { assert.equal(args.zhipuMonthlyLimit, 2000); requests++; return { called: true }; } } });
  for (let i = 0; i < 7; i++) await search.run({ provider: 'serpapi_google' });
  assert.equal(requests, 6); assert.equal(search.blocked().pilot_request_limit, 1);
  assert.throws(() => pilotSearch({ maxSerpapi: 7 }));
});
