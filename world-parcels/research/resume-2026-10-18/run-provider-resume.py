#!/usr/bin/env python3
# Resume the frozen provider queue after its qualification pilot, retaining each stage's checkpoints.
import collections, datetime, hashlib, json, os, pathlib, signal, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[2]
work = pathlib.Path(__file__).resolve().parent
state_path = work / 'pipeline-state.json'
queue = work / 'provider-queue.json'
source = pathlib.Path(sys.argv[1]).resolve()
queue_hash = hashlib.sha256(queue.read_bytes()).hexdigest()
state = json.loads(state_path.read_text()) if state_path.exists() else {'schemaVersion': 1, 'completedSteps': []}
assert state.get('queueSha256', queue_hash) == queue_hash, 'Frozen provider queue changed'
state.update(queueSha256=queue_hash, pid=os.getpid(), status='running', sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest())
child = None

def save():
    state['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pending = state_path.with_suffix('.new')
    pending.write_text(json.dumps(state, indent=2) + '\n')
    os.replace(pending, state_path)

def stop(signum, frame):
    state['status'] = 'stopped-checkpointed'
    save()
    if child is not None and child.poll() is None:
        child.terminate()
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def step(name, argv):
    global child
    if name in state['completedSteps']:
        return
    state.update(phase=name, status='running')
    save()
    print(state['updatedAt'], name, 'started', flush=True)
    with (work / (name + '.log')).open('a') as log:
        child = subprocess.Popen(argv, cwd=root, stdout=log, stderr=subprocess.STDOUT)
        state['childPid'] = child.pid
        save()
        code = child.wait()
    child = None
    state.pop('childPid', None)
    state['lastExitCode'] = code
    expected_holds = False
    if code == 2 and '--state-dir' in argv:
        qualification_state = pathlib.Path(argv[argv.index('--state-dir') + 1]) / 'state.json'
        if qualification_state.exists():
            result = json.loads(qualification_state.read_text())
            expected_holds = result.get('status') == 'complete-with-holds' and all(row.get('status') in ('technical-qualified', 'held', 'excluded') for row in result.get('cities', {}).values())
            if expected_holds:
                state.setdefault('stageResults', {})[name] = 'complete-with-holds'
    if code and not expected_holds:
        state['status'] = 'stage-failed'
        save()
        raise SystemExit(code)
    state['completedSteps'].append(name)
    save()
    print(state['updatedAt'], name, 'finished', flush=True)

qualification = ['python3', 'scripts/run-parcel-qualification.py', '--run', '--repo-root', str(root), '--source-root', str(root), '--workers', '1', '--llm-workers', '1']
step('india-pilot-qualification', qualification + ['--queue', str(work / 'india-qualification-queue.json'), '--state-dir', str(work / 'india-pilot-qualification')])
step('provider-discovery', ['python3', 'scripts/run-parcel-provider-expansion.py', '--run', '--queue-json', str(queue), '--source', str(source), '--repo-root', str(root), '--shared-root', str(root), '--workers', '1'])
# The existing builder enforces completion hashes, live-city and prior-verdict exclusions.
import importlib.util
spec = importlib.util.spec_from_file_location('qualification_queue', root / 'scripts/build-qualification-queue.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
codes = {str(record['city']['cityCode']) for record in json.loads(queue.read_text())['records']}
report = json.loads((root / 'frontend/data/parcel-coverage-report.json').read_text())
excluded = {str(int(city['wupCityCode'])) for city in report.get('cities', []) if city.get('appCityIds') and city.get('wupCityCode')}
for previous in ('modesto-qualification-queue.json', 'india-qualification-queue.json'):
    excluded.update(str(row['cityCode']) for row in json.loads((work / previous).read_text())['records'])
excluded.update(builder.judged_codes(root / builder.OUTCOMES))
bulk_queue = work / 'bulk-qualification-queue.json'
if not bulk_queue.exists():
    records = builder.build(root, codes=codes, live=excluded)
    bulk_queue.write_text(json.dumps({'schemaVersion': 1, 'frozenAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pointOrder': 'latitude-longitude', 'basis': 'New hash-verified receipts from the resumed provider queue, excluding pilot and already judged cities.', 'records': records}, ensure_ascii=False, indent=2) + '\n')
records = json.loads(bulk_queue.read_text())['records']
state['bulkQualificationCities'] = len(records)
save()
if records:
    step('bulk-direct-qualification', qualification + ['--queue', str(bulk_queue), '--state-dir', str(work / 'bulk-qualification'), '--direct-only'])
# Export actual terminal verdicts; local implementation exceptions remain needs-llm.
spec = importlib.util.spec_from_file_location('qualification_outcomes', root / 'scripts/export-qualification-outcomes.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
state_dirs = [work / 'india-pilot-qualification']
if records:
    state_dirs.append(work / 'bulk-qualification')
outcomes = exporter.collect(state_dirs)
if outcomes:
    target = root / 'world-parcels/research/qualification-outcomes/resume-provider-2026-10-18.json'
    counts = dict(collections.Counter(row['outcome'] for row in outcomes))
    target.write_text(json.dumps({'schemaVersion': 1, 'basis': 'Resumed provider qualification: schema-2 gate evidence, with implementation exceptions kept pending.', 'pointOrder': 'latitude-longitude', 'counts': counts, 'cities': outcomes}, ensure_ascii=False, indent=1) + '\n')
    state['terminalCounts'] = counts
qualification_counts = collections.Counter()
for directory in state_dirs:
    saved = json.loads((directory / 'state.json').read_text())
    qualification_counts.update(row['status'] for row in saved.get('cities', {}).values())
state['qualificationCounts'] = dict(qualification_counts)
state['status'] = 'complete-with-exceptions' if any(qualification_counts.get(key) for key in ('failed', 'needs-llm', 'held', 'resource-held')) else 'complete-awaiting-review'
save()
print(state['updatedAt'], state['status'], dict(qualification_counts), flush=True)
