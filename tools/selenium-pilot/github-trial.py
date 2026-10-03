"""Fixed, read-only cloud comparison against the locally observed same pages."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace

from collect import collect_one, create_driver, HERE


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def summarize(state):
    articles = [r for r in state['records'] if r['kind'] == 'article']
    catalogs = [r for r in state['records'] if r['kind'] == 'catalog']
    groups = {}
    for r in catalogs:
        groups.setdefault(r['catalog_id'], []).append(r)
    acceptable = {'catalog_candidates', 'catalog_empty'}
    return {'planned_pages': state['planned_pages'], 'visited_pages': len(state['records']),
        'articles_tested': len(articles), 'abstract_candidates': sum(r.get('workflow_status') == 'candidate_extracted' for r in articles),
        'catalog_entrypoints_tested': len(groups),
        'catalog_entrypoints_read': sum(any(r.get('workflow_status') in acceptable for r in rr) for rr in groups.values()),
        'workflow_statuses': dict(Counter(r.get('workflow_status') for r in state['records'])),
        'initial_challenges': sum(bool(r.get('initial_challenge_provider')) for r in state['records']),
        'helper_calls': sum(r.get('captcha_attempt') == 'checkbox_helper_called_once' for r in state['records']),
        'remaining_verification': sum(r.get('workflow_status') == 'needs_user_verification' for r in state['records']),
        'complete': len(state['records']) == state['planned_pages'], 'production_imported': False, 'paid_requests': 0}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--binary')
    p.add_argument('--browser', choices=['edge','chrome'], default='edge')
    p.add_argument('--profile', type=Path, required=True)
    p.add_argument('--interval', type=float, default=3)
    p.add_argument('--limit', type=int)
    opts = p.parse_args()
    if opts.interval < 3:
        p.error('Minimum page interval is 3 seconds')
    plan = json.loads(opts.plan.read_text(encoding='utf-8'))
    for kind, script in plan['scripts'].items():
        if hashlib.sha256(script.encode()).hexdigest() != plan['extractor_hashes'][kind]:
            raise ValueError('EXTRACTOR_HASH_MISMATCH')
    node = shutil.which('node')
    subprocess.run([node,str(HERE/'github-trial-bridge.mjs'),'verify',str(opts.plan)], check=True)
    tasks = plan['tasks'][:opts.limit] if opts.limit else plan['tasks']
    opts.output.mkdir(parents=True, exist_ok=False)
    state = {'schema_version': 1, 'experiment': 'github-hosted-fixed-sample',
        'started_at': datetime.now(timezone.utc).isoformat(), 'planned_pages': len(tasks),
        'plan_sha256': hashlib.sha256(opts.plan.read_bytes()).hexdigest(),
        'interval_seconds': opts.interval, 'settle_seconds': 8, 'manual_intervention': False,
        'extractor_hashes': plan['extractor_hashes'], 'journal_order': plan['journal_order'],
        'platform': platform.platform(), 'python_version': platform.python_version(),
        'github_run_id': os.environ.get('GITHUB_RUN_ID'), 'github_run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'commit': os.environ.get('GITHUB_SHA'), 'browser': opts.browser,
        'records': [], 'production_imported': False, 'paid_requests': 0}
    def checkpoint():
        state['updated_at'] = datetime.now(timezone.utc).isoformat()
        write_json(opts.output/'results.json', state)
        write_json(opts.output/'summary.json', summarize(state))
    args = SimpleNamespace(engine='cdp',browser=opts.browser,binary=opts.binary,headless=False,
        profile=str(opts.profile),timeout=30,settle=8,interval=opts.interval,manual_wait=0,click_checkbox=True)
    driver = None
    checkpoint()
    try:
        driver = create_driver(args)
        write_json(opts.output/'browser.json',driver.capabilities)
        for n, task in enumerate(tasks,1):
            time.sleep(opts.interval)
            folder = opts.output/f'{n:03d}-{task["journal"]}-{task["kind"]}'
            folder.mkdir()
            print(f'[{n}/{len(tasks)}] {task["journal"]} {task["kind"]} {task["test_id"]}',flush=True)
            record = collect_one(driver,task,args,folder)
            record.update(test_id=task['test_id'],task=task,collection=task.get('collection'),
                catalog_id=task.get('catalog_id'),selection_source=task.get('selection_source'),
                baseline_status=task.get('baseline_status'))
            try:
                capture = driver.execute_script(plan['scripts'][task['kind']])
                capture['captured_at'] = datetime.now(timezone.utc).isoformat()
                request, response = folder/'workflow-capture.json',folder/'workflow-assessed.json'
                write_json(request,{'task':task,'capture':capture})
                subprocess.run([node,str(HERE/'github-trial-bridge.mjs'),'assess',str(request),str(response)],
                    capture_output=True,check=True,timeout=30)
                checked = json.loads(response.read_text(encoding='utf-8'))
                record['workflow_status'] = checked['status']
                record['workflow_catalog' if task['kind']=='catalog' else 'workflow_article'] = checked
            except Exception as exc:
                record.update(workflow_status='capture_error',workflow_error_type=type(exc).__name__)
            state['records'].append(record)
            checkpoint()
            print(f'  {record["status"]} / workflow={record["workflow_status"]}',flush=True)
        state['finished_at'] = datetime.now(timezone.utc).isoformat()
    finally:
        checkpoint()
        if driver:
            driver.quit()
        summary = summarize(state)
        print(json.dumps(summary,ensure_ascii=False),flush=True)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as out:
                out.write('## Fixed journal-browser trial\n\n```json\n'+json.dumps(summary,indent=2)+'\n```\n')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    main()
