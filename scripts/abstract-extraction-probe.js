import { publisherReaderProbe } from './publisher-reader-probe.js';

// Keep the existing, explicitly authorized manual workflow entry point.
// This reviewed revision tests only three original-page reads: no broad search,
// synthetic model call, translation, formal data mutation or publication.
try {
  await publisherReaderProbe();
} catch (error) {
  console.error('PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'));
  process.exitCode = 1;
}
