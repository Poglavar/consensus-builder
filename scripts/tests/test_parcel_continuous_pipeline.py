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
        finish = patch.object(pipeline, 'finish_city', return_value=False)
        self.finish_city = finish.start()
        self.addCleanup(finish.stop)

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

    def test_invalid_fingerprint_is_never_a_cached_qualification_skip(self):
        row = self.runner.state['cities']['1']
        row.update(status='reviewed', discoveryDecision='candidate', qualification={'status': 'integrated'})
        self.runner._qualification_fingerprint = lambda city, saved: None
        self.pool.validated.add(('1', None))
        self.assertEqual(self.pool._select('qualification', 1), [self.cities[0]])

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

    def test_workspace_block_does_not_exhaust_candidate_retries(self):
        self.runner.args.max_retries = 1
        block = {'cityCode': '1', 'reason': 'workspace preparation failed'}
        self.accept('qualification', {
            'cities': {'1': {'qualification': {'status': 'pending'}}},
            'error': 'workspace preparation failed', 'adapterStageBlocked': block})
        row = self.runner.state['cities']['1']
        self.assertEqual(row['qualification']['status'], 'pending')
        self.assertNotIn('pipelineFailures', row)
        self.assertEqual(self.runner.state['adapterStageBlocked'], block)

    def test_deferred_city_does_not_starve_other_candidates_and_resumes_when_inputs_return(self):
        for city in self.cities:
            self.runner._city_entry(city).update(status='reviewed-candidate', discoveryDecision='candidate',
                                                packetValid=True)
        deferred = self.runner.state['cities']['1']
        deferred['qualification'] = {'status': 'pending-inputs', 'summary': 'missing sample'}
        with patch.object(pipeline.source_stage, 'qualification_input_error', return_value='missing sample'):
            self.assertEqual(self.pool._select('qualification', 2), self.cities[1:3])
        self.assertEqual(deferred['qualification']['status'], 'pending-inputs')
        with patch.object(pipeline.source_stage, 'qualification_input_error', return_value=None):
            self.assertEqual(self.pool._select('qualification', 2), self.cities[:2])
        self.assertEqual(deferred['qualification']['status'], 'pending')

    def test_failed_stage_cannot_validate_an_unchanged_integrated_result(self):
        saved = {'status': 'integrated', 'receiptSha256': 'receipt'}
        self.runner.state['cities']['1']['qualification'] = saved
        self.accept('qualification', {'cities': {'1': {'qualification': saved}}, 'error': 'slot recovery required'})
        self.assertEqual(self.pool.validated, set())
        self.runner._record_shared_learning.assert_not_called()

    def test_saved_result_is_validated_only_with_a_positive_stage_receipt(self):
        saved = {'status': 'integrated', 'receiptSha256': 'receipt'}
        self.accept('qualification', {'cities': {'1': {'qualification': saved}}})
        self.assertEqual(self.pool.validated, set())
        self.accept('qualification', {'cities': {'1': {'qualification': saved}},
                                      'validatedStages': [['1', 'receipt']]})
        self.assertEqual(self.pool.validated, {('1', 'same')})

    def test_positive_stage_receipt_cannot_cache_an_invalid_fingerprint(self):
        saved = {'status': 'integrated', 'receiptSha256': 'receipt'}
        self.runner._qualification_fingerprint = lambda city, stage: None
        self.accept('qualification', {'cities': {'1': {'qualification': saved}},
                                      'validatedStages': [['1', 'receipt']]})
        self.assertEqual(self.pool.validated, set())

    def test_dispatch_discards_histories_and_keeps_only_live_qualification(self):
        row = self.runner.state['cities']['1']
        row.update(qualification={'status': 'running', 'isolation': {'workspace': {'baseSnapshot': {'live.js': 'live'}}}},
                   qualificationHistory=[{'isolation': {'workspace': {'baseSnapshot': {'old.js': 'old'}}}}])
        self.pool.popen = Mock(return_value=SimpleNamespace(pid=os.getpid()))
        self.pool._start('qualification', [self.cities[0]])
        job = next(iter(self.pool.active.values()))
        self.addCleanup(job['out'].close)
        dispatched = json.loads((job['directory'] / 'input.json').read_text())['state']['cities']['1']
        self.assertNotIn('qualificationHistory', dispatched)
        self.assertEqual(dispatched['qualification']['isolation']['workspace']['baseSnapshot'], {'live.js': 'live'})
        self.assertFalse((self.root / 'qualification-workspaces/base-snapshots').exists())

    def test_completed_task_control_and_logs_are_deleted_after_acceptance(self):
        self.accept('review', {'cities': {'1': {'status': 'reviewed-rejected'}}})
        self.assertFalse((self.root / 'task').exists())
        self.assertNotIn('task', self.pool.pipeline['tasks'])
        self.finish_city.assert_called_once()

    def test_compacted_completed_city_is_never_researched_or_requalified(self):
        self.runner.state['cities']['1'].update(status='reviewed-candidate', discoveryDecision='candidate',
            qualification={'status': 'integrated'}, storageComplete=True)
        self.assertEqual(self.pool._select('qualification', 1), [])
        self.assertNotIn(self.cities[0], self.pool._select('research', 4))

    def test_interrupted_stage_retains_qualification_evidence(self):
        scratch = self.root / 'tmp/valhalla-parcel-research/1'
        scratch.mkdir(parents=True)
        (scratch / 'raw.zip').write_text('discard even on interruption')
        self.accept('qualification', {'cities': {'1': {'qualification': {'status': 'running', 'artifactRoot': 'saved'}}},
                                      'interrupted': True})
        self.assertEqual(self.runner.state['cities']['1']['qualification'],
                         {'status': 'ready-isolated', 'artifactRoot': 'saved'})
        self.runner._record_shared_learning.assert_not_called()
        self.assertFalse(scratch.exists())

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

    def test_selection_error_is_scoped_to_one_city(self):
        self.runner.state['cities']['1'].update(status='pending')
        self.runner.state['cities']['2'].update(status='pending')
        original = self.runner._packet
        def packet(city, cohort):
            if city['cityCode'] == 1:
                raise ValueError('bad packet')
            return {'valid': False, 'errors': ['invalid']}
        self.runner._packet = packet
        with patch.object(coordination, 'acquire', return_value={'token': 'claim'}):
            self.assertEqual(self.pool._select('research', 1), [self.cities[1]])
        self.assertTrue(self.runner.state['cities']['1']['storageError'])
        self.runner._packet = original

    def test_finish_cleanup_error_does_not_stop_other_city(self):
        self.pool.pipeline['tasks']['task'] = {}
        directory = self.root / 'task'
        directory.mkdir()
        pipeline._write(directory / 'result.json', {'cities': {'1': {}, '2': {} }})
        self.pool.by_code['1'] = self.cities[0]
        self.pool.by_code['2'] = self.cities[1]
        self.pool.pipeline['tasks']['task'] = {}
        with patch.object(pipeline, 'finish_city', side_effect=[RuntimeError('discard'), False]):
            self.pool._accept('task', {'lane': 'review', 'cityCodes': ['1', '2']}, directory)
        self.assertIn('finishCity', self.runner.state['cities']['1']['storageError'])
        self.assertNotIn('storageError', self.runner.state['cities']['2'])

    def test_non_object_stage_result_is_bounded_failure(self):
        self.pool.pipeline['tasks']['task'] = {}
        directory = self.root / 'task'
        directory.mkdir()
        pipeline._write(directory / 'result.json', [])
        self.pool.pipeline['tasks']['qualification'] = {}
        self.pool._accept('qualification', {'lane': 'qualification', 'cityCodes': ['1']}, directory)
        self.assertEqual(self.runner.state['cities']['1']['pipelineFailures']['qualification'], 1)

    def test_systemic_result_stops_pipeline(self):
        self.pool.pipeline['tasks']['task'] = {}
        directory = self.root / 'task'
        directory.mkdir()
        pipeline._write(directory / 'result.json', {'cities': {}, 'systemic': True, 'error': 'auth'})
        self.pool.pipeline['tasks']['research'] = {}
        self.pool._accept('research', {'lane': 'research', 'cityCodes': ['1']}, directory)
        self.assertTrue(self.runner.stop_requested)
        self.assertEqual(self.runner.state['systemicFailure'], 'auth')

    def test_review_selection_skips_one_broken_packet(self):
        for city in self.cities:
            self.runner._city_entry(city).update(status='research-complete', packetValid=True)
        def packet(city, cohort):
            if city['cityCode'] == 1:
                raise FileNotFoundError('missing city packet')
            return {'valid': True}
        self.runner._packet = packet
        self.assertEqual(self.pool._select('review', 1), [self.cities[1]])
        self.assertIn('selection', self.runner.state['cities']['1']['storageError'])

    def test_corrupt_result_and_non_object_checkpoint_are_bounded(self):
        for content in ('[', '[]', '{"cities":[]}'):
            with self.subTest(content=content):
                self.runner.state['cities']['1'].pop('qualification', None)
                self.runner.state['cities']['1'].pop('pipelineFailures', None)
                for _ in range(2):
                    directory = self.root / 'task'
                    directory.mkdir(exist_ok=True)
                    (directory / 'result.json').write_text(content)
                    self.pool.pipeline['tasks']['task'] = {}
                    self.pool._accept('task', {'lane': 'qualification', 'cityCodes': ['1']}, directory)
                self.assertEqual(self.runner.state['cities']['1']['qualification']['status'], 'failed')
        directory.mkdir(exist_ok=True)
        (directory / 'state.json').write_text('[]')
        self.pool.pipeline['tasks']['task'] = {}
        self.pool._accept('task', {'lane': 'qualification', 'cityCodes': ['1']}, directory)

    def test_missing_result_reaches_retry_limit_without_stalling_other_cities(self):
        for _ in range(2):
            directory = self.root / 'task'
            directory.mkdir(exist_ok=True)
            self.pool.pipeline['tasks']['task'] = {}
            self.pool._accept('task', {'lane': 'qualification', 'cityCodes': ['1']}, directory)
        self.assertEqual(self.runner.state['cities']['1']['qualification']['status'], 'failed')
        self.runner.state['cities']['2'].update(status='reviewed-candidate', discoveryDecision='candidate', packetValid=True)
        self.assertEqual(self.pool._select('qualification', 1), [self.cities[1]])

    def test_restart_with_bad_input_recovers_saved_cities(self):
        for content in ('[', '[]'):
            with self.subTest(content=content):
                directory = self.root / 'task'
                directory.mkdir(exist_ok=True)
                (directory / 'input.json').write_text(content)
                pipeline._write(directory / 'result.json', {'cities': {'1': {'status': 'reviewed-rejected'}}})
                self.pool.pipeline['tasks']['task'] = {'status': 'running', 'directory': str(directory),
                    'lane': 'review', 'cityCodes': ['1']}
                self.pool.recover()
                self.assertEqual(self.runner.state['cities']['1']['status'], 'reviewed-rejected')
                self.assertNotIn('task', self.pool.pipeline['tasks'])

    def test_scratch_failure_and_task_cleanup_failure_keep_diagnostics(self):
        with patch.object(pipeline, 'clear_city_downloads', side_effect=ValueError('unsafe scratch')), \
                patch.object(pipeline, 'task_finished', side_effect=PermissionError('protected task')):
            self.accept('review', {'cities': {'1': {'status': 'reviewed-rejected'}}})
        self.assertIn('scratchCleanup', self.runner.state['cities']['1']['storageError'])
        self.assertTrue((self.root / 'task').exists())
        self.assertEqual(self.runner.state['taskCleanupErrors']['task']['directory'], str(self.root / 'task'))
        self.assertIn('task', self.pool.pipeline['tasks'])

    def test_cleanup_failure_preserves_qualified_city_without_scheduling_more_llm(self):
        self.runner.state['cities']['1'].update(status='reviewed-candidate', discoveryDecision='candidate')
        with patch.object(pipeline, 'finish_city', side_effect=RuntimeError('private artifact retained')):
            self.accept('qualification', {'cities': {'1': {'qualification': {'status': 'integrated'}}}})
        row = self.runner.state['cities']['1']
        self.assertEqual(row['qualification']['status'], 'integrated')
        self.assertTrue(row['storageError'])
        self.assertEqual(self.pool._select('qualification', 1), [])
        self.assertIn('city:1:finishCity', self.runner.state['failedItems'])

    def test_held_city_artifacts_do_not_keep_an_exhausted_queue_spinning(self):
        for city in self.cities:
            self.runner._city_entry(city).update(status='research-complete', storageError={'selection': 'bad input'})
        self.pool.run()
        self.assertEqual(self.pool.active, {})

    def test_stale_candidate_receipt_returns_to_review(self):
        row = self.runner.state['cities']['1']
        row.update(status='reviewed-candidate', discoveryDecision='candidate', packetValid=True)
        self.runner._reviewed_city_receipt = lambda city, packet: None
        self.assertEqual(self.pool._select('qualification', 2), [])
        self.assertEqual(row['status'], 'research-complete')

    def test_last_retained_packet_is_reviewed_before_queue_completion(self):
        self.pool.cities = [self.cities[0]]
        self.runner.state['cities']['1']['packetValid'] = True
        launched = []
        def start(lane, cities):
            launched.append(lane)
            self.runner.stop_requested = True
        self.pool._start = start
        self.pool.run()
        self.assertEqual(launched, ['review'])

    def test_fresh_stage_records_failed_urls_instead_of_findings(self):
        class Child:
            def __init__(child, args):
                child.root = Path(args.repo_root)
                child.validated_stages = set()
                child.stop_requested = False
            def _configure_source_novelty(child, path): pass
            def request_stop(child, *args): pass
            def stop_children(child): pass
            def save_state(child): pipeline._write(child.state_path, child.state)
            def _city_entry(child, city): return child.state['cities'][str(city['cityCode'])]
            def _record_city_attempts(child, cities, cohort):
                child.state['cities']['1']['status'] = 'research-complete'
                return [], None, False
            def _record_shared_learning(child, city, lane, row):
                row['sharedFindings'] = {lane: 'finding-from-latest-stage-code'}
        control = self.root / 'child'
        spec = control / 'input.json'
        pipeline._write(spec, {'args': {'repo_root': str(self.root)}, 'lane': 'research',
                              'cities': [self.cities[0]], 'cityCodes': ['1'],
                              'cohortDir': str(self.root),
                              'state': {'queuePath': str(self.root / 'queue.json'), 'cities': {'1': {}}}})
        with patch.object(pipeline.signal, 'signal'), patch.object(pipeline, 'record_attempts') as recorded:
            self.assertEqual(pipeline.execute_task(Child, SimpleNamespace(pipeline_task=spec)), 0)
        result = json.loads((control / 'result.json').read_text())
        self.assertNotIn('sharedFindings', result['cities']['1'])
        recorded.assert_called_once()
        self.assertTrue((control / 'state.json').is_file())


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

    def test_bad_city_artifact_on_startup_does_not_abort_queue(self):
        queue = self.root / 'queue.json'
        queue.write_text('{}')
        cities = [{'cityCode': '42', 'rank': 1}, {'cityCode': '43', 'rank': 2}]
        self.runner._load_queue = lambda path: ({}, cities)
        self.runner._ensure_root_tasks = Mock()
        self.runner.discovery_workflow = lambda: True
        self.runner._city_entry = lambda city: self.runner.state.setdefault('cities', {}).setdefault(
            city['cityCode'], {'status': 'research-complete'})
        def packet(city, cohort):
            if city['cityCode'] == '42':
                raise ValueError('malformed city JSON')
            return {'valid': True}
        self.runner._packet = packet
        self.runner._reviewed_city_receipt = lambda *args: None
        with patch.object(pipeline.ContinuousPipeline, 'run', return_value=True):
            self.assertTrue(self.runner._process_queue(queue, once=False)[0])
        self.assertIn('startup-inputs', self.runner.state['cities']['42']['storageError'])
        self.assertNotIn('storageError', self.runner.state['cities']['43'])

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
