import { publisherReaderComparison } from './publisher-reader-comparison.js';

// Keep the existing, explicitly authorized manual workflow entry point.
// Publisher-grouped comparison: bounded reads and searches, no model generation,
// translation, formal data mutation or publication. Same reviewed manual workflow.
try {
  await publisherReaderComparison();
} catch (error) {
  console.error('PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'));
  process.exitCode = 1;
}
