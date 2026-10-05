import copy
import unittest
from verification import resolve_verification, finish_verification, navigate, page_summary

URL = 'https://academic.oup.com/qje/issue/141/3'
GATE = {'url': 'https://academic.oup.com/crawlprevention/governor?token=private', 'challenge': True}
CONTENT = {'url': URL, 'challenge': False, 'items': [{'title': 'Paper'}]}


class Clock:
    def __init__(self):
        self.at = 0

    def now(self):
        return self.at

    def sleep(self, seconds):
        self.at += seconds


class Browser:
    def __init__(self, answers=(), info=None):
        self.page = copy.deepcopy(GATE)
        self.answers = list(answers)
        self.calls = 0
        self.reloads = []
        self.info = info or {'provider': 'unknown', 'kind': 'unknown'}

    def execute_script(self, script, **kwargs):
        return copy.deepcopy(self.page)

    def inspect_verification(self, **kwargs):
        return self.info if self.page.get('challenge') else {}

    def click_checkbox_once(self, **kwargs):
        self.calls += 1
        answer = self.answers.pop(0) if self.answers else False
        if answer == 'cleared':
            self.page = CONTENT
        if answer == 'cleared_then_error':
            self.page = CONTENT
            raise TimeoutError('private data must not appear')
        return answer if isinstance(answer, bool) else None

    def get(self, url, **kwargs):
        self.reloads.append(url)


class VerificationTests(unittest.TestCase):
    def resolve(self, driver, **options):
        clock = Clock()
        return resolve_verification(driver, 'extract', copy.deepcopy(GATE),
                                    clock=clock.now, sleep=clock.sleep, target_url=URL, **options)

    def test_second_interaction_succeeds_and_stops_without_five_clicks(self):
        driver = Browser([False, 'cleared'])
        page, trace = self.resolve(driver)
        self.assertEqual(driver.calls, 2)
        self.assertEqual(trace['outcome'], 'challenge_cleared')
        self.assertEqual(finish_verification(trace, 'catalog_candidates')['outcome'], 'passed')
        self.assertEqual(page['items'], CONTENT['items'])

    def test_persistent_gate_gets_five_attempts_and_two_target_reloads(self):
        driver = Browser()
        _, trace = self.resolve(driver)
        self.assertEqual(driver.calls, 5)
        self.assertEqual(driver.reloads, [URL, URL])
        self.assertEqual(trace['outcome'], 'attempt_limit')
        self.assertTrue(all(a['helper_result'] is False for a in trace['attempts']))
        self.assertNotIn('private', str(trace))

    def test_exception_still_reads_new_page_and_does_not_expose_exception_text(self):
        _, trace = self.resolve(Browser(['cleared_then_error']))
        self.assertEqual(trace['outcome'], 'challenge_cleared')
        self.assertEqual(trace['attempts'][0]['error_type'], 'TimeoutError')
        self.assertNotIn('private', str(trace))

    def test_successful_helper_return_is_not_proof_of_pass(self):
        _, trace = self.resolve(Browser([True] * 5))
        self.assertEqual(finish_verification(trace, 'needs_user_verification')['outcome'], 'attempt_limit')

    def test_image_slider_text_do_not_repeat_checkbox_actions(self):
        for kind in ('image', 'slider', 'text'):
            driver = Browser(info={'provider': 'recaptcha', 'kind': kind, 'component': True})
            _, trace = self.resolve(driver)
            self.assertEqual(driver.calls, 0)
            self.assertEqual(trace['outcome'], 'unsupported_' + kind)

    def test_automatic_check_can_complete_without_interaction(self):
        driver = Browser(info={'provider': 'cloudflare', 'kind': 'automatic', 'component': True})
        def loaded(*args, **kwargs):
            driver.page = CONTENT
            return copy.deepcopy(CONTENT)
        driver.execute_script = loaded
        _, trace = self.resolve(driver)
        self.assertEqual(driver.calls, 0)
        self.assertEqual(trace['outcome'], 'challenge_cleared')

    def test_rate_limit_is_not_a_captcha_retry(self):
        driver = Browser(info={'access': 'rate_limited'})
        _, trace = self.resolve(driver)
        self.assertEqual(driver.calls, 0)
        self.assertEqual(trace['outcome'], 'rate_limited')

    def test_pause_persists_attempt_and_does_not_continue(self):
        driver = Browser()
        snapshots = []
        _, trace = self.resolve(driver, paused=lambda: driver.calls > 0,
                                save=lambda t: snapshots.append(copy.deepcopy(t)))
        self.assertEqual(driver.calls, 1)
        self.assertEqual(trace['outcome'], 'paused')
        self.assertEqual(snapshots[-1]['outcome'], 'paused')

    def test_time_budget_prevents_five_attempts(self):
        _, trace = self.resolve(Browser(), total_seconds=5)
        self.assertEqual(trace['outcome'], 'time_limit')
        self.assertLess(len(trace['attempts']), 5)

    def test_cleared_blank_page_is_not_passed(self):
        driver = Browser(['cleared'])
        driver.execute_script = lambda *a, **kw: {'url': URL, 'challenge': False}
        _, trace = self.resolve(driver)
        self.assertEqual(finish_verification(trace, 'no_entries_found')['outcome'], 'cleared_but_content_unconfirmed')

    def test_timeout_recovery_rejects_previous_page_and_query(self):
        for stale in ('https://academic.oup.com/qje/article/old', URL + '?page=2', 'https://evil.test/crawlprevention/governor'):
            driver = Browser()
            driver.get = lambda *a, **kw: (_ for _ in ()).throw(TimeoutError())
            driver.page = {'url': stale, 'items': [{'title': 'old'}]}
            with self.assertRaises(TimeoutError) as error:
                navigate(driver, URL, 'extract', sleep=lambda _: None)
            self.assertEqual(len(error.exception.navigation_attempts), 3)

    def test_timeout_can_recover_same_host_verification_redirect(self):
        driver = Browser()
        driver.get = lambda *a, **kw: (_ for _ in ()).throw(TimeoutError())
        page, attempts = navigate(driver, URL, 'extract')
        self.assertTrue(page['challenge'])
        self.assertEqual(attempts[0]['state'], 'recovered_after_error')

    def test_diagnostics_strip_credentials_query_and_fragment(self):
        self.assertEqual(page_summary({'url': 'https://user:pass@host.test/a?token=secret#private'})['url'], 'https://host.test/a')


if __name__ == '__main__':
    unittest.main()
