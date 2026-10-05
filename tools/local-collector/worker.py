"""Resumable local browser worker. Raw captures only; Node owns review/import."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time
from types import SimpleNamespace
from urllib.parse import urlsplit
from verification import resolve_verification, finish_verification, navigate

HERE = Path(__file__).resolve().parent


def write_json(file, data):
    tmp = file.with_suffix(file.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    tmp.replace(file)


def key(task):
    identity = (task.get('doi') or task['url']) if task['kind'] == 'article' else task['url']
    return hashlib.sha256((task['kind'] + '|' + task['journal'] + '|' + identity).encode()).hexdigest()


def safe_url(url, hosts):
    try:
        u = urlsplit(url)
        return u.scheme == 'https' and u.hostname in hosts and not u.username and not u.password and not u.port
    except ValueError:
        return False


def enqueue(state, tasks, plan):
    known = {key(t) for t in state['queue']}
    completed = {p['doi'] for p in plan.get('known_papers', []) if p.get('complete') and p.get('doi')}
    for task in tasks:
        if not safe_url(task['url'], plan['allowed_hosts']):
            continue
        if task['kind'] == 'article' and task.get('doi') in completed:
            continue
        if task['kind'] == 'article' and plan.get('allowed_article_dois') is not None and task.get('doi') not in plan['allowed_article_dois']:
            continue
        if task['kind'] == 'catalog' and task.get('depth', 0) >= plan.get('max_catalog_pages', 50):
            state['remaining'].append({**task, 'reason': 'catalog_page_limit'})
            continue
        identity = key(task)
        if identity not in known:
            state['queue'].append(task)
            known.add(identity)


def run(plan_file, state_file, control_file, node, profile, driver_factory=None):
    plan = json.loads(plan_file.read_text(encoding='utf-8'))
    if plan.get('version') != 1 or plan.get('interval_seconds', 0) < 3:
        raise ValueError('INVALID_LOCAL_PLAN')
    if state_file.exists():
        state = json.loads(state_file.read_text(encoding='utf-8'))
        if state['run_id'] != plan['run_id']:
            raise ValueError('PLAN_ID_CHANGED')
    else:
        state = {'version': 1, 'run_id': plan['run_id'], 'phase': 'running', 'cursor': 0,
                 'queue': [], 'items': [], 'remaining': [], 'current': None}
        enqueue(state, plan['jobs'], plan)
    root = state_file.parent
    captures = root / 'captures'
    captures.mkdir(exist_ok=True)
    verification_dir = root / 'verification'
    verification_dir.mkdir(exist_ok=True)
    state['phase'] = 'running'
    state.setdefault('domain_health', {})

    def save():
        state['updated_at'] = datetime.now(timezone.utc).isoformat()
        write_json(state_file, state)

    def paused():
        try:
            return json.loads(control_file.read_text(encoding='utf-8')).get('pause', False)
        except FileNotFoundError:
            return False

    driver = None
    last_end = time.monotonic()
    try:
        while state['cursor'] < len(state['queue']):
            if paused():
                state['phase'] = 'paused'
                break
            # Consecutive failures cool down that publisher while other hosts
            # continue. The task stays pending; a cooldown is never a result.
            pending = range(state['cursor'], len(state['queue']))
            eligible = next((i for i in pending if state['domain_health'].get(
                urlsplit(state['queue'][i]['url']).hostname, {}).get('retry_at', 0) <= time.time()), None)
            if eligible is None:
                time.sleep(0.2)
                continue
            if eligible != state['cursor']:
                state['queue'].insert(state['cursor'], state['queue'].pop(eligible))
            task = state['queue'][state['cursor']]
            identity = key(task)
            state['current'] = {'journal': task['journal'], 'kind': task['kind'], 'title': task.get('title'), 'url': task['url']}
            save()
            output = captures / (identity + '.json')
            # A crash between capture persistence and queue persistence reuses
            # the immutable saved result, without reopening the website.
            if output.exists():
                captured = json.loads(output.read_text(encoding='utf-8'))
            else:
                while time.monotonic() - last_end < plan['interval_seconds'] and not paused():
                    time.sleep(0.2)
                if paused():
                    state['phase'] = 'paused'
                    break
                stage = 'browser_start'
                verification = None
                navigation_attempts = []
                try:
                    if driver is None:
                        if driver_factory is None:
                            from cdp_driver import CDPDriver
                            driver_factory = CDPDriver
                        driver = driver_factory(SimpleNamespace(binary=None, browser='edge', headless=False, profile=str(profile), timeout=30))
                    stage = 'navigation'
                    capture, navigation_attempts = navigate(driver, task['url'], plan['scripts'][task['kind']], paused=paused)
                    if paused():
                        state['phase'] = 'paused'
                        break
                    time.sleep(plan.get('settle_seconds', 3))
                    stage = 'extraction'
                    capture = capture or driver.execute_script(plan['scripts'][task['kind']])
                    stage = 'verification'
                    audit_file = verification_dir / (identity + '.json')
                    audit = json.loads(audit_file.read_text(encoding='utf-8')) if audit_file.exists() else {'sessions': []}
                    audit['sessions'].append({})
                    def save_verification(trace):
                        audit['sessions'][-1] = trace
                        write_json(audit_file, audit)
                    capture, verification = resolve_verification(driver, plan['scripts'][task['kind']], capture,
                                                                 paused=paused, save=save_verification, target_url=task['url'])
                    if verification['outcome'] == 'paused':
                        state['phase'] = 'paused'
                        break  # Keep the queue item pending; the attempt log is already durable.
                    stage = 'assessment'
                    capture['captured_at'] = datetime.now(timezone.utc).isoformat()
                    request_file = root / 'current-capture.json'
                    response_file = root / 'current-assessment.json'
                    write_json(request_file, {'task': task, 'capture': capture})
                    result = subprocess.run([node, str(HERE / 'bridge.mjs'), str(request_file), str(response_file)],
                                            capture_output=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    if result.returncode:
                        raise RuntimeError('CAPTURE_ASSESSMENT_FAILED')
                    assessed = json.loads(response_file.read_text(encoding='utf-8'))
                    if verification['outcome'] in ('rate_limited', 'access_denied', 'login_required'):
                        assessed = {'result': {'status': verification['outcome']}, 'next': []}
                    finish_verification(verification, assessed['result'].get('status'))
                    save_verification(verification)
                    captured = {'task': task, 'capture': capture, 'verification': verification,
                                'navigation_attempts': navigation_attempts, **assessed}
                except Exception as error:
                    # Store the bounded error class/stage, never browser output,
                    # cookies or arbitrary exception text in published status.
                    captured = {'task': task, 'result': {'status': 'capture_failed',
                                'error_stage': stage, 'error_type': type(error).__name__}, 'next': []}
                    if verification is not None:
                        captured['verification'] = verification
                    if stage == 'navigation' or navigation_attempts:
                        captured['navigation_attempts'] = getattr(error, 'navigation_attempts', navigation_attempts)
                    # The next task gets a fresh browser after a broken session.
                    if driver:
                        try:
                            driver.quit()
                        except Exception:
                            pass
                    driver = None
                write_json(output, captured)
                last_end = time.monotonic()
            result = captured['result']
            status = result.get('status', 'capture_failed')
            host = urlsplit(task['url']).hostname
            health = state['domain_health'].setdefault(host, {'failures': 0, 'retry_at': 0})
            if status in ('needs_user_verification', 'rate_limited', 'access_denied', 'capture_failed'):
                health['failures'] += 1
                if health['failures'] >= 2:
                    health['retry_at'] = time.time() + min(300, 60 * (health['failures'] - 1))
            else:
                health.update(failures=0, retry_at=0)
            if not any(i['key'] == identity for i in state['items']):
                state['items'].append({'key': identity, 'kind': task['kind'], 'journal': task['journal'],
                                       'doi': task.get('doi'), 'file': 'captures/' + identity + '.json', 'status': status})
            if (captured.get('capture') or {}).get('content_loading_timeout'):
                state['remaining'].append({**task, 'reason': 'content_loading_timeout'})
            elif status not in ('candidate_extracted', 'catalog_candidates', 'catalog_empty', 'catalog_landing', 'no_abstract_stated'):
                state['remaining'].append({**task, 'reason': status})
            enqueue(state, captured.get('next', []), plan)
            state['cursor'] += 1
            save()
        else:
            state['phase'] = 'captured'
        state['current'] = None
        save()
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
    return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('plan', 'state', 'control', 'profile'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    try:
        run(args.plan, args.state, args.control, args.node, args.profile)
    except Exception:
        print('LOCAL_CAPTURE_STOPPED: saved captures are retained', flush=True)
        raise SystemExit(1)
