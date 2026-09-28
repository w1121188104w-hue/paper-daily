import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { safeSearchDiagnostic } from '../src/services/searchDiagnostics.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'JFE');
const url = 'https://www.sciencedirect.com/science/article/pii/S0304405X26001236';
const paper = { doi: '10.1016/j.jfineco.2026.104352', title_original: 'Macroprudential regulation and banks’ supply of liquidity services' };
const abstract = 'We study how regulation affects the supply of liquidity services using bank data. Our findings identify the effects of financial constraints on lending and liquidity provision.';
const content = `${paper.title_original}\nDOI: ${paper.doi}\nAbstract\n${abstract}\nKeywords: banking`;

test('阅读诊断只保留本地固定错误码，不输出远端正文、URL或密钥', () => {
  assert.deepEqual(safeSearchDiagnostic({ code: 'INVALID_READER_RESPONSE', message: 'private-key', url }, 'zhipu'),
    { code: 'INVALID_READER_RESPONSE', http_status: null, provider_error_code: null });
});



const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily' };
const targets = [
  { ...paper, journal_key: 'JFE', abstract_original: '' },
  { doi: '10.1111/1911-3846.70065', title_original: 'A synthetic CAR title', journal_key: 'CAR', abstract_original: 'RÉSUMÉ French fixture only.' },
  { doi: '10.1016/j.respol.2026.105508', title_original: 'A synthetic Research Policy title', journal_key: 'RP', abstract_original: abstract }
];
const library = { papers: targets, pointerText: 'original pointer' };
