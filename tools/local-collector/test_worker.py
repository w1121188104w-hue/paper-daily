import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import worker


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.task = {'kind': 'article', 'journal': 'RP', 'doi': '10.1016/j.respol.2026.105633',
                     'url': 'https://www.sciencedirect.com/science/article/pii/S0048733326002246'}
        self.plan = {'version': 1, 'run_id': 'one', 'interval_seconds': 3,
                     'allowed_hosts': ['www.sciencedirect.com'], 'jobs': [self.task]}
        self.save('plan.json', self.plan)

    def save(self, name, data):
        worker.write_json(self.root / name, data)

    def run_worker(self, factory):
        return worker.run(self.root / 'plan.json', self.root / 'state.json',
                          self.root / 'control.json', 'node', self.root / 'profile', factory)

    def test_pause_before_browser_keeps_pending_work(self):
        self.save('control.json', {'pause': True})
        result = self.run_worker(lambda _: self.fail('browser must stay closed'))
        self.assertEqual((result['phase'], result['cursor']), ('paused', 0))

    def test_saved_capture_replays_after_crash_without_reopening_browser(self):
        (self.root / 'captures').mkdir()
        self.save('captures/' + worker.key(self.task) + '.json',
                  {'task': self.task, 'result': {'status': 'candidate_extracted'}, 'next': []})
        for _ in range(2):
            result = self.run_worker(lambda _: self.fail('immutable result must be reused'))
            self.assertEqual((result['phase'], result['cursor'], len(result['items'])), ('captured', 1, 1))

    def test_start_failure_is_saved_with_stage_and_no_exception_text(self):
        def failing(_):
            raise RuntimeError('private arbitrary exception text')
        with patch('worker.time.monotonic', side_effect=range(0, 100, 4)):
            result = self.run_worker(failing)
        capture = json.loads((self.root / result['items'][0]['file']).read_text(encoding='utf-8'))
        self.assertEqual(capture['result'], {'status': 'capture_failed', 'error_stage': 'browser_start', 'error_type': 'RuntimeError'})
        self.assertNotIn('private', json.dumps(capture))

    def test_unsafe_url_and_short_interval_rejected(self):
        self.assertFalse(worker.safe_url('https://www.sciencedirect.com.evil.test/a', self.plan['allowed_hosts']))
        self.plan['interval_seconds'] = 1
        self.save('plan.json', self.plan)
        with self.assertRaisesRegex(ValueError, 'INVALID_LOCAL_PLAN'):
            self.run_worker(None)


if __name__ == '__main__':
    unittest.main()
