import { probeElsevier } from './elsevier-api-probe.js';

// Keep the existing, explicitly authorized manual workflow entry point.
// Bounded Elsevier-only check. No search, translation, formal writes or publication.
try {
  await probeElsevier();
} catch (error) {
  console.error('PROBE_FAILED ' + (/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'));
  process.exitCode = 1;
}
