#!/usr/bin/env python3
"""Run a plan of training runs on the GPU box in parallel lanes, with dependencies (a fine-tune waits for its
donor). Each run trains (layered/train.py), scores its own manifest's selection split, then any extra
evaluations (another city's selection split). Resumable and idempotent, judged by artifacts: a run whose
journal holds its last epoch's evaluation is not retrained, an evaluation whose pooled.json exists is not
redone, a half-trained run resumes from last.pt. Finished runs drop last.pt (best.pt stays) to save disk.
  queue_runner.py <plan.json> --runs runs/round2 --dataset data/dataset --lanes 4 [--extra '--workers 3 --eval-workers 4']
Without --run only the plan and its state print."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRAIN = HERE.parent / 'layered' / 'train.py'
DEFAULT_MANIFEST = HERE.parent / 'manifests' / 'zagreb-v1.json'


def log(message):
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {message}", flush=True)


def load_plan(path):
    plan = json.loads(Path(path).read_text())
    names = [run['name'] for run in plan['runs']]
    if len(names) != len(set(names)):
        raise ValueError('duplicate run names in plan')
    for run in plan['runs']:
        for parent in run.get('after', []):
            if parent not in names:
                raise ValueError(f"{run['name']} waits for unknown run {parent}")
    return plan


def expand(values, runs_dir, dataset):
    return [str(v).replace('{runs}', str(runs_dir)).replace('{dataset}', str(dataset)) for v in values]


def option(args, name):
    """Value of the last occurrence, as argparse reads it (so --extra can override the plan)."""
    positions = [i for i, arg in enumerate(args[:-1]) if arg == name]
    return args[positions[-1] + 1] if positions else None


def manifest_version(path):
    return json.loads(Path(path).read_text())['version']


def eval_dir(out, split, manifest, own_manifest):
    """Where train.py --evaluate-only writes: <split>-eval, suffixed with the manifest version when scoring
    against a manifest other than the one the run was trained for."""
    version = manifest_version(manifest)
    return out / (f'{split}-eval' if version == manifest_version(own_manifest) else f'{split}-eval-{version}')


def trained(out, epochs):
    """True when the journal holds the selection evaluation of the last epoch (train.py always evaluates it)."""
    journal = out / 'journal.jsonl'
    if not journal.exists():
        return False
    for line in reversed(journal.read_text().splitlines()):
        record = json.loads(line)
        if record.get('kind') == 'eval':
            return record['epoch'] == epochs - 1
    return False


def steps(run, runs_dir, dataset, extra):
    """The commands one run still needs, in order, each with the artifact that proves it done."""
    out = runs_dir / run['name']
    train_args = expand(run['train'], runs_dir, dataset)
    own_manifest = option(train_args, '--manifest') or str(DEFAULT_MANIFEST)   # train.py's default
    epochs = int(option(train_args + extra, '--epochs') or 20)
    base = [sys.executable, str(TRAIN), '--run', '--dataset', str(dataset), '--output', str(out)]
    shared = [arg for name in ('--manifest', '--pool') if option(train_args, name) for arg in (name, option(train_args, name))]
    todo = []
    if not trained(out, epochs):
        resume = ['--resume'] if (out / 'last.pt').exists() else []
        todo.append(('train', base + train_args + resume + extra, None))
    own = eval_dir(out, 'selection', own_manifest, own_manifest)
    if not (own / 'pooled.json').exists():
        todo.append(('selection', base + shared + ['--evaluate-only', '--split', 'selection'] + extra, own))
    for evaluation in run.get('evals', []):
        manifest = expand([evaluation['manifest']], runs_dir, dataset)[0]
        target = eval_dir(out, evaluation.get('split', 'selection'), manifest, own_manifest)
        if not (target / 'pooled.json').exists():
            todo.append((f"eval {manifest_version(manifest)}",
                         base + ['--manifest', manifest, '--evaluate-only', '--split', evaluation.get('split', 'selection')] + extra,
                         target))
    return todo


def complete(run, runs_dir, dataset, extra):
    return not steps(run, runs_dir, dataset, extra)


def ready(plan, done, running, failed):
    """Runs that may start now: not done, running or failed, every dependency done. Plan order is priority."""
    return [run for run in plan['runs'] if run['name'] not in done | running | failed
            and all(parent in done for parent in run.get('after', []))]


def blocked(plan, failed):
    """Runs that can never start because something they wait for (directly or not) failed."""
    lost, changed = set(failed), True
    while changed:
        changed = False
        for run in plan['runs']:
            if run['name'] not in lost and any(parent in lost for parent in run.get('after', [])):
                lost.add(run['name']); changed = True
    return lost - set(failed)


def execute(run, runs_dir, dataset, extra, keep_last):
    """Child process body: run the remaining steps of one run, stop at the first failure."""
    out = runs_dir / run['name']
    out.mkdir(parents=True, exist_ok=True)
    for label, command, _ in steps(run, runs_dir, dataset, extra):
        log(f"{run['name']}: {label}: {shlex.join(command[1:])}")
        rc = subprocess.run(command).returncode
        if rc:
            log(f"{run['name']}: {label} failed with {rc}")
            return rc
    if not keep_last and (out / 'last.pt').exists() and (out / 'best.pt').exists():
        (out / 'last.pt').unlink()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('plan', type=Path)
    parser.add_argument('--runs', type=Path, required=True, help='directory holding one sub-directory per run')
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--lanes', type=int, default=1)
    parser.add_argument('--extra', default='', help='arguments appended to every train.py call, e.g. workers')
    parser.add_argument('--only', help='comma-separated run names (dependencies are not pulled in)')
    parser.add_argument('--keep-last', action='store_true', help='keep last.pt of finished runs')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    plan = load_plan(args.plan)
    if args.only:
        wanted = set(args.only.split(','))
        plan['runs'] = [run for run in plan['runs'] if run['name'] in wanted]
    extra = shlex.split(args.extra)
    done = {run['name'] for run in plan['runs'] if complete(run, args.runs, args.dataset, extra)}
    total = len(plan['runs'])
    log(f"plan {plan.get('name', args.plan.stem)}: {total} runs, {len(done)} already complete"
        + (f" (skipped: {', '.join(sorted(done))})" if done else '') + f", {args.lanes} lanes")
    if not args.run:
        for run in plan['runs']:
            pending = [label for label, _, _ in steps(run, args.runs, args.dataset, extra)]
            print(f"  {run['name']}: {'done' if not pending else ', '.join(pending)}"
                  + (f" (after {', '.join(run['after'])})" if run.get('after') else ''))
        print('dry run; pass --run')
        return 0
    running, failed, started, began = {}, set(), time.time(), {}
    while True:
        lost = blocked(plan, failed)
        for run in ready(plan, done, set(running.values()), failed | lost):
            if len(running) >= args.lanes:
                break
            out = args.runs / run['name']
            out.mkdir(parents=True, exist_ok=True)
            with (out / 'queue.log').open('a') as handle:
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '_execute', str(args.plan),
                                          run['name'], str(args.runs), str(args.dataset), args.extra,
                                          '1' if args.keep_last else '0'], stdout=handle, stderr=subprocess.STDOUT)
            running[child.pid] = run['name']
            began[run['name']] = time.time()
            log(f"start {run['name']} (pid {child.pid}); running {len(running)}, done {len(done)}/{total}")
        if not running:
            break
        pid, status = os.wait()       # blocks until any lane finishes
        if pid not in running:
            continue
        name = running.pop(pid)
        rc = os.waitstatus_to_exitcode(status)
        if rc == 0 and complete(next(r for r in plan['runs'] if r['name'] == name), args.runs, args.dataset, extra):
            done.add(name)
        else:
            failed.add(name)
        elapsed = time.time() - started
        remaining = total - len(done) - len(failed) - len(blocked(plan, failed))
        rate = elapsed / max(len(done), 1)
        log(f"{'done' if name in done else f'FAILED rc={rc}'} {name} in {(time.time() - began[name]) / 60:.1f} min; "
            f"{len(done)}/{total} done, {len(failed)} failed; ETA {rate * remaining / 60:.0f} min "
            f"(log {args.runs / name / 'queue.log'})")
    lost = blocked(plan, failed)
    log(f"finished: {len(done)}/{total} done, failed: {sorted(failed) or 'none'}, never started: {sorted(lost) or 'none'}; "
        f"{(time.time() - started) / 60:.0f} min")
    return 1 if failed or lost else 0


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '_execute':
        _, _, plan_path, name, runs_dir, dataset, extra, keep = sys.argv
        plan = load_plan(plan_path)
        run = next(r for r in plan['runs'] if r['name'] == name)
        sys.exit(execute(run, Path(runs_dir), Path(dataset), shlex.split(extra), keep == '1'))
    sys.exit(main())
