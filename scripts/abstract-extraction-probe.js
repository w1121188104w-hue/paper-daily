import { inspectPublisherReader } from './publisher-reader-inspection.js';

// Keep the existing, explicitly authorized manual workflow entry point.
// Four-page follow-up to the completed publisher matrix. Reader only, no search,
// translation, formal data mutation or publication. Same reviewed manual workflow.
try {
  await inspectPublisherReader();
} catch (error) {
  console.error('PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'));
  process.exitCode = 1;
}
