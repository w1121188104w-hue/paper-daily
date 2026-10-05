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

    def test_doi_less_alias_with_completed_abstract_is_not_queued(self):
        task = {**self.task, 'doi': None}
        plan = {**self.plan, 'known_papers': [{**self.task, 'url': 'https://doi.org/' + self.task['doi'],
                    'identity_urls': [self.task['url']], 'complete': True}]}
        state = {'queue': [], 'remaining': []}
        worker.enqueue(state, [task], plan)
        self.assertEqual(state['queue'], [])
        worker.enqueue(state, [task, self.task], self.plan)
        self.assertEqual(len(state['queue']), 1)

    def test_different_dois_or_journals_are_not_deduplicated(self):
        state = {'queue': [], 'remaining': []}
        worker.enqueue(state, [self.task, {**self.task, 'doi': '10.1016/different'},
                               {**self.task, 'journal': 'JFE'}], self.plan)
        self.assertEqual(len(state['queue']), 3)

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

    def test_loading_timeout_preserves_result_but_retains_task(self):
        (self.root / 'captures').mkdir()
        self.save('captures/' + worker.key(self.task) + '.json',
                  {'task': self.task, 'capture': {'content_loading_timeout': True},
                   'result': {'status': 'candidate_extracted', 'abstract': 'Previously captured content'}, 'next': []})
        state = self.run_worker(lambda _: self.fail('saved content must be reused'))
        self.assertEqual(state['items'][0]['status'], 'candidate_extracted')
        self.assertEqual(state['remaining'][0]['reason'], 'content_loading_timeout')
        saved = json.loads((self.root / state['items'][0]['file']).read_text(encoding='utf8'))
        self.assertEqual(saved['result']['abstract'], 'Previously captured content')

    def test_unsafe_url_and_short_interval_rejected(self):
        self.assertFalse(worker.safe_url('https://www.sciencedirect.com.evil.test/a', self.plan['allowed_hosts']))
        self.plan['interval_seconds'] = 1
        self.save('plan.json', self.plan)
        with self.assertRaisesRegex(ValueError, 'INVALID_LOCAL_PLAN'):
            self.run_worker(None)


if __name__ == '__main__':
    unittest.main()
