import { probeDeepseekAbstractSearch } from './deepseek-abstract-search-probe.js';

// Keep the existing, explicitly authorized manual workflow entry point.
// Ten-paper DeepSeek native search test. No formal writes or publication.
try {
  await probeDeepseekAbstractSearch();
} catch (error) {
  console.error('PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'));
  process.exitCode = 1;
}
