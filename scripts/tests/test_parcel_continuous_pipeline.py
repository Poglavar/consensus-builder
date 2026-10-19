"""Targeted coordinator tests: independent lanes, recovery and stage ownership."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

LIB = Path(__file__).resolve().parents[1] / 'lib'
sys.path.insert(0, str(LIB))
import parcel_continuous_pipeline as pipeline
import parcel_discovery_coordination as coordination


class Harness:
    def __init__(self, root):
        self.root = self.state_dir = root
        self.args = SimpleNamespace(max_retries=2, workers=2, qualification_workers=2,
                                    once=False, poll_seconds=.01, grace_seconds=.1, with_adapters=True)
        self.state = {'cities': {}, 'usage': {}}
        self.discovery_claims = {}
        self.stop_requested = False
        self.pipeline_jobs = {}
        self.log = Mock()
        self.save_state = Mock()
        self._record_shared_learning = Mock()
        self._reviewed_city_receipt = lambda city, packet: {'valid': True}
        self._qualification_fingerprint = lambda city, saved: str(saved.get('fingerprint', 'same'))
        self._refresh_shared_runtime = lambda: {'generation': 'latest', 'codeGeneration': 'code-latest'}
        self._subscription_environment = lambda: {}
        self._queue_path = lambda: root / 'queue.json'

    def _city_entry(self, city):
        return self.state['cities'].setdefault(str(city['cityCode']), {'status': 'pending'})

    def _packet(self, city, cohort):
        return {'valid': self._city_entry(city).get('packetValid', False), 'errors': ['invalid']}

    def _skip_item(self, task, row, lane, reason):
        row['status'] = 'failed-skipped'


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runner = Harness(self.root)
        self.cities = [{'cityCode': i, 'name': f'City {i}'} for i in (1, 2, 3, 4)]
        for city in self.cities:
            self.runner._city_entry(city)
        self.pool = pipeline.ContinuousPipeline(self.runner, self.cities, self.root)

    def test_busy_qualification_does_not_block_research_or_review(self):
        self.pool.active['q'] = {'spec': {'cityCodes': ['1'], 'lane': 'qualification'}}
        self.runner.state['cities']['2'].update(status='research-complete', packetValid=True)
        self.assertEqual(self.pool._select('review', 3), [self.cities[1]])
        with patch.object(coordination, 'acquire', return_value={'token': 'claim'}):
            self.assertEqual(self.pool._select('research', 1), [self.cities[2]])

    def test_finished_packet_moves_to_review_without_another_research_call(self):
        self.runner.state['cities']['1']['packetValid'] = True
        with patch.object(coordination, 'acquire', return_value={'token': 'claim'}):
            self.pool._select('research', 1)
        self.assertEqual(self.runner.state['cities']['1']['status'], 'research-complete')
        self.assertIn(self.cities[0], self.pool._select('review', 3))

    def test_integrated_receipt_rechecks_only_when_fingerprint_changes(self):
        row = self.runner.state['cities']['1']
        row.update(status='reviewed', discoveryDecision='candidate', qualification={'status': 'integrated'})
        self.pool.validated.add(('1', 'same'))
        self.assertEqual(self.pool._select('qualification', 2), [])
        row['qualification']['fingerprint'] = 'changed'
        self.assertEqual(self.pool._select('qualification', 2), [self.cities[0]])

    def test_unfinished_workspace_owners_are_selected_before_fresh_candidates(self):
        for city in self.cities:
            self.runner._city_entry(city).update(status='reviewed-candidate', discoveryDecision='candidate',
                                                qualification={'status': 'integrated'})
        self.runner.state['cities']['3']['qualification']['status'] = 'running'
        self.runner.state['cities']['4']['qualification']['status'] = 'ready-isolated'
        self.assertEqual(self.pool._select('qualification', 2), self.cities[2:])

    def accept(self, lane, result):
        spec = {'lane': lane, 'cityCodes': ['1']}
        self.pool.pipeline['tasks']['task'] = {}
        directory = self.root / 'task'
        directory.mkdir(exist_ok=True)
        pipeline._write(directory / 'result.json', result)
        self.pool._accept('task', spec, directory)

    def test_review_merge_preserves_concurrent_qualification(self):
        row = self.runner.state['cities']['1']
        row['qualification'] = {'status': 'integrated'}
        self.accept('review', {'cities': {'1': {'status': 'reviewed', 'qualification': {'status': 'failed'}}}})
        self.assertEqual(row['qualification']['status'], 'integrated')
        self.assertEqual(row['status'], 'reviewed')

    def test_qualification_merge_preserves_review(self):
        row = self.runner.state['cities']['1']
        row.update(status='reviewed', discoveryDecision='candidate')
        self.accept('qualification', {'cities': {'1': {'status': 'pending', 'qualification': {'status': 'integrated'}}}})
        self.assertEqual(row['status'], 'reviewed')
        self.assertEqual(row['qualification']['status'], 'integrated')

    def test_crashing_stage_has_a_bounded_retry_limit(self):
        result = {'cities': {}, 'error': 'broken task'}
        self.accept('qualification', result)
        self.accept('qualification', result)
        self.assertEqual(self.runner.state['cities']['1']['qualification']['status'], 'failed')

    def test_failed_stage_cannot_validate_an_unchanged_integrated_result(self):
        saved = {'status': 'integrated', 'receiptSha256': 'receipt'}
        self.runner.state['cities']['1']['qualification'] = saved
        self.accept('qualification', {'cities': {'1': {'qualification': saved}}, 'error': 'slot recovery required'})
        self.assertEqual(self.pool.validated, set())

    def test_saved_result_is_validated_only_with_a_positive_stage_receipt(self):
        saved = {'status': 'integrated', 'receiptSha256': 'receipt'}
        self.accept('qualification', {'cities': {'1': {'qualification': saved}}})
        self.assertEqual(self.pool.validated, set())
        self.accept('qualification', {'cities': {'1': {'qualification': saved}},
                                      'validatedStages': [['1', 'receipt']]})
        self.assertEqual(self.pool.validated, {('1', 'same')})

    def test_interrupted_stage_retains_qualification_evidence(self):
        self.accept('qualification', {'cities': {'1': {'qualification': {'status': 'running', 'artifactRoot': 'saved'}}},
                                      'interrupted': True})
        self.assertEqual(self.runner.state['cities']['1']['qualification'],
                         {'status': 'ready-isolated', 'artifactRoot': 'saved'})
        self.runner._record_shared_learning.assert_not_called()

    def test_launch_passes_latest_runtime_to_fresh_interpreter(self):
        process = SimpleNamespace(pid=os.getpid())
        self.pool.popen = Mock(return_value=process)
        self.pool._start('review', [self.cities[0]])
        job = next(iter(self.pool.active.values()))
        self.addCleanup(job['out'].close)
        self.assertEqual(job['spec']['runtimeGeneration'], 'latest')
        self.assertIn('--pipeline-task', self.pool.popen.call_args.args[0])
        self.assertEqual(json.loads((job['directory'] / 'input.json').read_text())['codeGeneration'], 'code-latest')

    def test_recovery_refuses_a_live_previous_stage(self):
        directory = self.root / 'task'
        pipeline._write(directory / 'input.json', {'lane': 'review', 'cityCodes': ['1']})
        self.pool.pipeline['tasks']['task'] = {'status': 'running', 'directory': str(directory),
            'pid': os.getpid(), 'pidStartIdentity': coordination.pid_start_identity(os.getpid())}
        with self.assertRaisesRegex(RuntimeError, 'still alive'):
            self.pool.recover()

    def test_busy_external_claim_keeps_queue_pending(self):
        with patch.object(coordination, 'acquire', side_effect=coordination.ClaimBusy):
            self.assertEqual(self.pool._select('research', 2), [])
        self.assertTrue(self.pool.waiting_for_claim)


if __name__ == '__main__':
    unittest.main()


class SharedRunnerWriteTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('continuous_runner_test', LIB.parent / 'run-valhalla-parcel-research.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'job'
        self.shared = Path(self.temp.name) / 'shared'
        self.file = self.root / 'backend/parcels/adapter.js'
        self.file.parent.mkdir(parents=True)
        self.file.write_text('original')
        import parcel_shared_runtime as runtime
        self.runtime = runtime
        runtime.publish_runtime(self.shared, self.root)
        runtime.sync_runtime(self.shared, self.root)
        args = self.module.build_parser().parse_args(['--repo-root', str(self.root), '--shared-root', str(self.shared)])
        self.runner = self.module.Runner(args)
        self.runner.log = Mock()

    def test_success_publishes_adapter_for_the_next_task(self):
        original = self.runtime.current_runtime(self.shared)['generation']
        with self.runner._shared_write():
            self.file.write_text('updated adapter')
        current = self.runtime.current_runtime(self.shared)
        self.assertNotEqual(original, current['generation'])
        self.assertEqual(self.runner._refresh_shared_runtime()['generation'], current['generation'])
        self.assertFalse((self.root / 'tmp/parcel-shared-runtime/write-in-progress.json').exists())

    def test_failed_update_rolls_back_bytes_and_new_files(self):
        new = self.file.with_name('new.js')
        with self.assertRaisesRegex(RuntimeError, 'validation failed'):
            with self.runner._shared_write():
                self.file.write_text('bad update')
                new.write_text('unvalidated')
                raise RuntimeError('validation failed')
        self.assertEqual(self.file.read_text(), 'original')
        self.assertFalse(new.exists())
        self.assertTrue(self.runner.shared_write_rolled_back)

    def test_restart_recovers_a_dead_writers_unpublished_files(self):
        marker = self.root / 'tmp/parcel-shared-runtime/write-in-progress.json'
        pipeline._write(marker, {'pid': 99999999, 'pidStartIdentity': 'dead',
                                'beforePaths': self.runtime.runtime_paths(self.root)})
        self.file.write_text('interrupted update')
        new = self.file.with_name('new.js')
        new.write_text('interrupted new file')
        self.runner._refresh_shared_runtime()
        self.assertEqual(self.file.read_text(), 'original')
        self.assertFalse(new.exists())
        self.assertFalse(marker.exists())
