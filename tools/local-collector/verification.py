"""Bounded retries with private diagnostics; a helper return is not a pass."""
from datetime import datetime, timezone
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

MAX_ATTEMPTS = 5
MAX_TOTAL_ATTEMPTS = MAX_ATTEMPTS * 4
TOTAL_SECONDS = 150
POLL_SECONDS = 3


def is_challenge(capture):
    try:
        redirect = urlsplit(capture.get('url', '')).path.startswith('/crawlprevention/')
    except ValueError:
        redirect = False
    state = capture.get('verification_state') or {}
    detected = state.get('component') or state.get('kind') in ('automatic', 'image', 'slider', 'text')
    return bool(capture.get('challenge') or redirect or detected and not state.get('solved'))


def content_visible(capture):
    if 'items' in capture:
        return bool(capture.get('items') or capture.get('empty_message') or capture.get('issue_links'))
    return bool(capture.get('candidates') or capture.get('noAbstract') or
                capture.get('dois') and capture.get('titles'))


def page_summary(capture):
    try:
        u = urlsplit(capture.get('url', ''))
        url = urlunsplit((u.scheme, u.hostname or '', u.path, '', ''))
    except ValueError:
        url = ''
    return {'url': url, 'challenge': is_challenge(capture),
            'page_title': str(capture.get('page_title', ''))[:300],
            'items': len(capture.get('items', [])),
            'abstract_candidates': len(capture.get('candidates', [])),
            'verification': capture.get('verification_state', {})}


def resolve_verification(driver, script, capture, *, paused=lambda: False,
                         save=lambda trace: None, clock=time.monotonic,
                         sleep=time.sleep, total_seconds=TOTAL_SECONDS, target_url=None):
    started = clock()
    deadline = started + total_seconds
    trace = {'version': 3, 'started_at': datetime.now(timezone.utc).isoformat(),
             'max_attempts': MAX_TOTAL_ATTEMPTS, 'max_stage_attempts': MAX_ATTEMPTS,
             'timeout_seconds': total_seconds,
             'initial': page_summary(capture), 'attempts': [], 'settling': [],
             'navigations': [], 'outcome': 'not_detected'}

    def persist(outcome=None):
        if outcome:
            trace['outcome'] = outcome
        trace['elapsed_seconds'] = round(clock() - started, 3)
        save(trace)

    def wait(seconds):
        until = min(clock() + seconds, deadline)
        while clock() < until and not paused():
            sleep(min(0.2, until - clock()))
        return not paused() and clock() < deadline

    def inspect(page):
        if callable(getattr(driver, 'inspect_verification', None)) and clock() < deadline:
            try:
                info = driver.inspect_verification(timeout=min(5, deadline - clock()))
                info = info if isinstance(info, dict) else {}
                page['verification_state'] = info
                if info.get('solved') and content_visible(page) and not info.get('continue_required'):
                    page['challenge'] = False
            except Exception as error:
                page['verification_state'] = {'probe_error': type(error).__name__}
        page['challenge'] = is_challenge(page)
        return page

    def read_page():
        page = driver.execute_script(script, timeout=min(10, max(0.01, deadline - clock())))
        return inspect(page)

    capture = inspect(capture)
    trace['initial'] = page_summary(capture)

    # The document can arrive before its cards/abstract, or before its challenge.
    # Give either a chance to appear instead of recording an empty directory.
    for _ in range(3):
        if is_challenge(capture) or content_visible(capture):
            break
        if not wait(POLL_SECONDS):
            break
        try:
            capture = read_page()
            trace['settling'].append({'page': page_summary(capture)})
        except Exception as error:
            trace['settling'].append({'error_type': type(error).__name__})
        persist()
    if paused():
        persist('paused')
        return capture, trace
    if (capture.get('verification_state') or {}).get('access'):
        persist(capture['verification_state']['access'])
        return capture, trace
    capture['challenge'] = is_challenge(capture)
    if not capture['challenge']:
        persist()
        return capture, trace
    persist('pending')
    stage_counts = {}
    while len(trace['attempts']) < MAX_TOTAL_ATTEMPTS:
        if paused() or clock() >= deadline:
            break
        state = capture.get('verification_state') or {}
        stage_key = (state.get('provider'), state.get('kind'), bool(state.get('continue_required')))
        number = stage_counts.get(stage_key, 0) + 1
        if number > MAX_ATTEMPTS:
            break
        stage_counts[stage_key] = number
        # A checkbox that escalates to an image puzzle gets its own bounded
        # attempts. Waiting through the first gate cannot consume every action.
        action = ('publisher_continue' if state.get('continue_required') else
                  'local_' + state['kind'] + '_solver' if state.get('kind') in ('image', 'slider', 'text') else
                  'wait_for_component' if state.get('load_failed') else
                  'wait_for_automatic_check' if state.get('kind') == 'automatic' and (number == 1 or state.get('provider') == 'unknown') else
                  'checkbox_helper')
        attempt = {'number': len(trace['attempts']) + 1, 'stage_attempt': number, 'before': page_summary(capture), 'action': action,
                   'helper_state': 'not_called', 'observations': []}
        trace['attempts'].append(attempt)
        persist()  # Preserve the attempt even if the process is interrupted.
        if action == 'checkbox_helper':
            if not callable(getattr(driver, 'click_checkbox_once', None)):
                attempt['helper_state'] = 'unavailable'
            else:
                attempt['helper_state'] = 'started'
                persist()
                try:
                    result = driver.click_checkbox_once(timeout=min(20, max(0.01, deadline - clock())))
                    attempt['helper_state'] = 'returned'
                    # None/False are not proof that a checkbox was clicked.
                    attempt['helper_result'] = result if isinstance(result, bool) else None
                except Exception as error:
                    attempt['helper_state'] = 'error'
                    attempt['error_type'] = type(error).__name__
                    attempt['error_frames'] = [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name} for f in traceback.extract_tb(error.__traceback__)[-4:]]
        elif action == 'publisher_continue' or action.startswith('local_'):
            method = getattr(driver, 'continue_after_verification' if action == 'publisher_continue' else 'solve_challenge_once', None)
            if not callable(method):
                attempt['helper_state'] = 'unavailable'
            else:
                attempt['helper_state'] = 'started'
                persist()
                try:
                    budget = min(25, max(0.1, deadline - clock()))
                    result = method(timeout=budget) if action == 'publisher_continue' else method(state['kind'], timeout=budget)
                    attempt['helper_state'] = 'returned'
                    if isinstance(result, dict):
                        attempt['handler_result'] = {key: result[key] for key in
                            ('state', 'engine', 'selected', 'label', 'refreshed', 'error_type') if key in result}
                    else:
                        attempt['helper_result'] = result if isinstance(result, bool) else None
                except Exception as error:
                    attempt['helper_state'] = 'error'
                    attempt['error_type'] = type(error).__name__
                    attempt['error_frames'] = [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name} for f in traceback.extract_tb(error.__traceback__)[-4:]]
        persist()
        # Re-read even after a helper exception. Its action may have succeeded
        # before timing out; never classify the stale pre-click page as final.
        for _ in range(3):
            if not wait(POLL_SECONDS):
                break
            try:
                capture = read_page()
                attempt['observations'].append({'after_seconds': round(clock() - started, 3),
                                                'page': page_summary(capture)})
            except Exception as error:
                attempt['observations'].append({'error_type': type(error).__name__})
                persist()
                continue
            persist()
            if (capture.get('verification_state') or {}).get('access'):
                persist(capture['verification_state']['access'])
                return capture, trace
            if not is_challenge(capture):
                # A cleared gate can still be a loading page. Wait for content
                # and detect a gate that reappears before declaring it cleared.
                for _ in range(3):
                    if content_visible(capture) or not wait(POLL_SECONDS):
                        break
                    try:
                        capture = read_page()
                        attempt['observations'].append({'page': page_summary(capture)})
                    except Exception as error:
                        attempt['observations'].append({'error_type': type(error).__name__})
                    persist()
                    if is_challenge(capture):
                        break
                if paused():
                    break
                if is_challenge(capture):
                    continue
                persist('challenge_cleared')
                return capture, trace
            current_state = capture.get('verification_state') or {}
            if (current_state.get('provider'), current_state.get('kind'), bool(current_state.get('continue_required'))) != stage_key:
                break
        # Refresh the original publisher URL after two unsuccessful cycles.
        # This can use a newly accepted browser session after a gate redirect.
        # It does not change identities, proxies, or saved cookies.
        current_state = capture.get('verification_state') or {}
        same_stage = (current_state.get('provider'), current_state.get('kind'), bool(current_state.get('continue_required'))) == stage_key
        if number in (2, 4) and same_stage and not action.startswith('local_') and action != 'publisher_continue' and target_url and not paused() and clock() < deadline:
            navigation = {'after_attempt': number, 'url': page_summary({'url': target_url})['url'],
                          'state': 'started'}
            trace['navigations'].append(navigation)
            persist()
            try:
                driver.get(target_url, timeout=min(30, deadline - clock()))
                navigation['state'] = 'returned'
            except Exception as error:
                navigation.update(state='error', error_type=type(error).__name__)
            if wait(POLL_SECONDS):
                try:
                    capture = read_page()
                    navigation['page'] = page_summary(capture)
                    if not is_challenge(capture):
                        persist('challenge_cleared')
                        return capture, trace
                except Exception as error:
                    navigation['read_error'] = type(error).__name__
            persist()
    kind = (capture.get('verification_state') or {}).get('kind')
    persist('paused' if paused() else 'time_limit' if clock() >= deadline else
            ('unsupported_' + kind if not callable(getattr(driver, 'solve_challenge_once', None)) else kind + '_attempt_limit')
            if kind in ('image', 'slider', 'text') else 'attempt_limit')
    return capture, trace


def navigate(driver, url, script, *, paused=lambda: False, sleep=time.sleep):
    """Recover a navigation timeout without accepting the previous tab's page."""
    attempts = []
    for number in range(1, 4):
        if paused():
            return None, attempts
        row = {'number': number}
        attempts.append(row)
        try:
            driver.get(url)
            row['state'] = 'loaded'
            return None, attempts
        except Exception as error:
            row.update(state='error', error_type=type(error).__name__)
            try:
                capture = driver.execute_script(script)
                requested, actual = urlsplit(url), urlsplit(capture.get('url', ''))
                # A partially loaded target or same-host gate is recoverable;
                # a previous article/current-issue page is not.
                same_host = actual.scheme == 'https' and actual.hostname == requested.hostname and not actual.username and not actual.password and not actual.port
                if same_host and ((actual.path, actual.query) == (requested.path, requested.query) or is_challenge(capture)):
                    row['state'] = 'recovered_after_error'
                    row['page'] = page_summary(capture)
                    return capture, attempts
            except Exception as read_error:
                row['read_error'] = type(read_error).__name__
            if number == 3:
                error.navigation_attempts = attempts
                raise
            for _ in range(15):
                if paused():
                    return None, attempts
                sleep(0.2)
    return None, attempts


def finish_verification(trace, status):
    trace['assessment_status'] = status
    if trace['outcome'] == 'challenge_cleared':
        trace['outcome'] = ('passed' if status in ('candidate_extracted', 'no_abstract_stated',
                            'catalog_candidates', 'catalog_empty', 'catalog_landing')
                            else 'cleared_but_content_unconfirmed')
    return trace
