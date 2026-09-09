import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_JOURNALS_PATH = path.resolve(__dirname, '../../data/config/journals.json');

const REQUIRED_CATEGORIES = new Set([
  'accounting',
  'economics',
  'finance',
  'management_operations'
]);

export function isValidIssn(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!/^\d{4}-?\d{3}[\dX]$/.test(text)) return false;
  const compact = text.replace('-', '');
  if (!/^\d{7}[\dX]$/.test(compact)) return false;
  const weighted = compact
    .slice(0, 7)
    .split('')
    .reduce((sum, digit, index) => sum + Number(digit) * (8 - index), 0);
  const check = (11 - (weighted % 11)) % 11;
  const expected = check === 10 ? 'X' : String(check);
  return compact[7] === expected;
}

export function validateJournalConfig(config, options = {}) {
  const expectedCount = Number(options.expectedCount ?? 19);
  const errors = [];
  const journals = Array.isArray(config?.journals) ? config.journals : [];

  if (config?.schema_version !== 1) {
    errors.push('schema_version 必须为 1');
  }
  if (journals.length !== expectedCount) {
    errors.push(`期刊数量应为 ${expectedCount}，实际为 ${journals.length}`);
  }

  const seenKeys = new Set();
  const seenOpenAlexIds = new Set();
  const seenIssns = new Set();

  journals.forEach((journal, index) => {
    const label = `journals[${index}]`;
    const key = String(journal?.key || '').trim().toUpperCase();
    const name = String(journal?.name || '').trim();
    const openAlexId = String(journal?.openalex_source_id || '').trim();
    const printIssn = String(journal?.print_issn || '').trim().toUpperCase();
    const electronicIssn = String(journal?.electronic_issn || '').trim().toUpperCase();
    const crossrefIssn = String(journal?.crossref_route_issn || '').trim().toUpperCase();

    // Reject noncanonical config rather than validate a normalized copy then use the original.
    for (const [field, value] of Object.entries({ key, name, openalex_source_id: openAlexId,
      print_issn: printIssn, electronic_issn: electronicIssn, crossref_route_issn: crossrefIssn })) {
      if (journal?.[field] !== value) errors.push(`${label}.${field} 必须使用规范格式，不能带多余空格`);
    }
    if (![printIssn, electronicIssn, crossrefIssn].every((value) => /^\d{4}-\d{3}[\dX]$/.test(value))) {
      errors.push(`${label} 的 ISSN 必须使用 XXXX-XXXX 格式`);
    }

    if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key)) errors.push(`${label}.key 无效`);
    if (seenKeys.has(key)) errors.push(`${label}.key 重复：${key}`);
    seenKeys.add(key);

    if (!name) errors.push(`${label}.name 不能为空`);
    if (!REQUIRED_CATEGORIES.has(journal?.category)) {
      errors.push(`${label}.category 无效：${journal?.category || ''}`);
    }
    if (!isValidIssn(printIssn)) errors.push(`${label}.print_issn 无效：${printIssn}`);
    if (!isValidIssn(electronicIssn)) {
      errors.push(`${label}.electronic_issn 无效：${electronicIssn}`);
    }
    if (printIssn === electronicIssn) errors.push(`${label} 的印刷版和电子版 ISSN 相同`);
    for (const issn of [printIssn, electronicIssn]) {
      if (seenIssns.has(issn)) errors.push(`${label} 的 ISSN 重复：${issn}`);
      seenIssns.add(issn);
    }

    if (!/^S\d+$/.test(openAlexId)) {
      errors.push(`${label}.openalex_source_id 无效：${openAlexId}`);
    }
    if (seenOpenAlexIds.has(openAlexId)) {
      errors.push(`${label}.openalex_source_id 重复：${openAlexId}`);
    }
    seenOpenAlexIds.add(openAlexId);

    if (![printIssn, electronicIssn].includes(crossrefIssn)) {
      errors.push(`${label}.crossref_route_issn 必须等于该刊的 print_issn 或 electronic_issn`);
    }
    if (typeof journal?.enabled !== 'boolean') errors.push(`${label}.enabled 必须是布尔值`);
  });

  if (errors.length) {
    const error = new Error(`期刊配置校验失败：\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_JOURNAL_CONFIG';
    error.details = errors;
    throw error;
  }
  return config;
}

export async function loadJournalConfig(filePath = DEFAULT_JOURNALS_PATH) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const config = JSON.parse(raw);
  return validateJournalConfig(config);
}

export function enabledJournals(config) {
  validateJournalConfig(config);
  return config.journals.filter((journal) => journal.enabled);
}

export function findJournal(config, key) {
  validateJournalConfig(config);
  const normalizedKey = String(key || '').trim().toUpperCase();
  return config.journals.find((journal) => journal.key === normalizedKey) || null;
}
