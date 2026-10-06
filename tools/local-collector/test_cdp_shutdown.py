import subprocess
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cdp_driver import CDPDriver


class ShutdownTests(unittest.TestCase):
    def adapter(self, quit_method):
        driver = CDPDriver.__new__(CDPDriver)
        driver.client = SimpleNamespace(driver=object(), quit=quit_method)
        driver.process = Mock()
        driver.process.poll.return_value = None
        return driver

    def test_disconnected_browser_cannot_hold_worker_or_atexit(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()

        def stuck():
            entered.set()
            release.wait(3)
            finished.set()

        driver = self.adapter(stuck)
        other_browser = object()
        registered = {driver.client.driver, other_browser}
        try:
            with patch('cdp_driver.get_registered_instances', return_value=registered):
                started = time.monotonic()
                driver.quit(timeout=0.05)
                self.assertLess(time.monotonic() - started, 1)
                self.assertTrue(entered.is_set())
                self.assertFalse(finished.is_set())
                self.assertEqual(registered, {other_browser})
                driver.process.terminate.assert_called_once()
                driver.process.wait.assert_called_once_with(timeout=5)
                driver.quit(timeout=0.05)
                driver.process.terminate.assert_called_once()
        finally:
            release.set()
            self.assertTrue(finished.wait(1))

    def test_graceful_or_failed_client_cleanup_still_reaps_only_owned_process(self):
        for error in (None, RuntimeError('disconnected')):
            close = Mock(side_effect=error)
            driver = self.adapter(close)
            driver.process.wait.side_effect = [subprocess.TimeoutExpired('owned-browser', 5), None]
            with patch('cdp_driver.get_registered_instances', return_value={driver.client.driver}):
                driver.quit(timeout=0.05)
            close.assert_called_once()
            driver.process.terminate.assert_called_once()
            driver.process.kill.assert_called_once()
            self.assertEqual(driver.process.wait.call_count, 2)

    def test_already_exited_browser_needs_no_termination(self):
        driver = self.adapter(Mock())
        driver.process.poll.return_value = 0
        with patch('cdp_driver.get_registered_instances', return_value={driver.client.driver}):
            driver.quit(timeout=0.05)
        driver.process.terminate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
