"""Focused integrity checks for the frozen RGB-normalization comparison."""
from __future__ import annotations

import json
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import normalization_analysis as analysis
from rgb_normalization import definition


class NormalizationAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.normalized = definition('pretrained', 'convnext_tiny')
        self.target = {'format': 1, 'size': 512, 'cap_m': 12.0, 'dilate_px': 1, 'margin_px': 2}
        self.plan = {
            'name': 'selection-v4-normalization',
            'rgb_normalization': self.normalized,
            'target_definition': self.target,
            'reference_recipe_hash': 'control-source-hash',
            'frozen_inputs': {
                'recipe_hash': 'candidate-source-hash',
                'manifests': {'zagreb-v2': 'zagreb-manifest-hash'},
                'dataset_manifest_sha256': 'dataset-hash',
            },
        }
        self.spec = {'name': 'zagreb-normalized-s1', 'train': [
            '--manifest', 'world-parcels/parcel-bench/manifests/zagreb-v2.json',
            '--seed', '1', '--epochs', '30', '--eval-every', '2', '--margin-px', '2',
            '--cap-m', '12', '--dilate-px', '1', '--resolution-aug-prob', '0',
            '--resolution-aug-max-gsd', '1.0', '--encoder', 'convnext_tiny', '--size', '512',
            '--recon-size', '256', '--batch', '6', '--lr', '0.0003', '--encoder-lr-scale', '0.3',
            '--osm-dropout', '0.2', '--thresholds', '0.3,0.5,0.7', '--interior-seeds', 'both',
            '--hard-barrier', 'off', '--rgb-normalization', 'pretrained',
        ]}
        self.expected_args = analysis.shared.expected_args(self.spec['train'])

    def _write_run(self, root: Path, *, candidate: bool):
        run = root / ('normalized' if candidate else 'raw-control')
        run.mkdir(parents=True)
        args = dict(self.expected_args)
        args['output'] = 'runs/normalized' if candidate else 'runs/raw-control'
        if not candidate:
            args.pop('rgb_normalization')
            args['margin_px'] = None  # the immutable historical controls omitted this flag
        best_config = 't0.3-seeds0-hard0'
        metrics = {'parcel_f1': .3, 'area_weighted_recall': .2, 'precision': .5}
        eval_record = {'kind': 'eval', 'epoch': 1, 'split': 'selection', 'best_config': best_config,
                       'configs': {best_config: metrics}}
        recipe = {
            'args': args,
            'recipe_hash': 'candidate-source-hash' if candidate else 'control-source-hash',
            'manifest_version': 'zagreb-v2', 'n_train': 1623,
            'manifest_sha256': 'zagreb-manifest-hash', 'dataset_sha256': 'dataset-hash',
            'train_tiles': ['train-a'], 'selection_tiles': ['select-a'],
            'exposure': {'training': ['train-a'], 'selection': ['select-a']},
            'reconstruction': {'method': 'frozen'}, 'init': None, 'pool': None, 'subset_seed': None,
        }
        result = {
            'recipe_hash': recipe['recipe_hash'], 'seed': 1, 'manifest_version': 'zagreb-v2',
            'n_train': 1623,
            'best': {'epoch': 1, 'config': best_config, 'parcel_f1': .3, 'metrics': metrics},
        }
        if candidate:
            recipe.update(rgb_normalization=self.normalized, target_definition=self.target)
            result.update(rgb_normalization=self.normalized, target_definition=self.target)
            eval_record['rgb_normalization'] = self.normalized
        (run / 'recipe.json').write_text(json.dumps(recipe))
        (run / 'results.json').write_text(json.dumps(result))
        (run / 'journal.jsonl').write_text(json.dumps(eval_record) + '\n')
        (run / 'best.pt').write_bytes(b'fixture checkpoint')
        if candidate:
            (run / 'last.pt').write_bytes(b'fixture checkpoint')
        return run

    def test_only_normalization_diff_allows_only_input_normalization_and_output_path(self):
        control = {'epochs': 30, 'seed': 1, 'lr': .0003, 'margin_px': None, 'output': 'raw'}
        candidate = {'epochs': 30, 'seed': 1, 'lr': .0003, 'margin_px': 2,
                     'rgb_normalization': 'pretrained', 'output': 'normalized'}
        self.assertTrue(analysis.only_normalization_diff(candidate, control))
        for changed in ('epochs', 'seed', 'lr', 'batch', 'osm_dropout'):
            with self.subTest(changed=changed):
                self.assertFalse(analysis.only_normalization_diff(
                    {**candidate, changed: 99}, control))

    def test_verify_training_accepts_paired_frozen_recipe_and_rejects_schedule_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            candidate = self._write_run(root, candidate=True)
            control = self._write_run(root, candidate=False)
            self.plan['runs'] = [self.spec]
            with patch.object(analysis.shared, 'verify_journal', return_value={'verified': True}):
                results, provenance = analysis.verify_training(
                    self.plan, candidate, control, self.spec, 1)
            self.assertEqual(results['candidate']['seed'], 1)
            self.assertIn('journal', provenance['candidate'])

            candidate_recipe = json.loads((candidate / 'recipe.json').read_text())
            candidate_recipe['args']['eval_every'] = 1
            (candidate / 'recipe.json').write_text(json.dumps(candidate_recipe))
            with patch.object(analysis.shared, 'verify_journal', return_value={'verified': True}):
                with self.assertRaisesRegex(ValueError, 'arguments differ beyond RGB normalization'):
                    analysis.verify_training(self.plan, candidate, control, self.spec, 1)

    def test_verify_training_rejects_candidate_normalization_metadata_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            candidate = self._write_run(root, candidate=True)
            control = self._write_run(root, candidate=False)
            self.plan['runs'] = [self.spec]
            result = json.loads((candidate / 'results.json').read_text())
            result['rgb_normalization'] = {**self.normalized, 'mean': [.2, .3, .4]}
            (candidate / 'results.json').write_text(json.dumps(result))
            with patch.object(analysis.shared, 'verify_journal', return_value={'verified': True}):
                with self.assertRaisesRegex(ValueError, 'RGB normalization differ'):
                    analysis.verify_training(self.plan, candidate, control, self.spec, 1)

    def _write_eval(self, run: Path, *, candidate=True, include_extra_config=False,
                    corrupt_pooled=False):
        run.mkdir(parents=True, exist_ok=True)
        directory = run / 'selection-eval'
        directory.mkdir(exist_ok=True)
        config = 't0.3-seeds0-hard0'
        metrics = {'parcel_f1': .5, 'precision': .75}
        configs = {config: metrics}
        if include_extra_config:
            configs['t0.5-seeds0-hard0'] = metrics
        summary = {'best_config': config, 'configs': configs}
        if candidate:
            summary.update(rgb_normalization=self.normalized, target_definition=self.target)
        counts = {'references': 4, 'matched': 2}
        parameters = {'iou': .5, 'tolerance_m': 2.0}
        tiles = ['tile-a', 'tile-b']
        pooled_counts = dict(counts)
        computed = {'tiles': tiles, 'parameters': parameters, 'counts': counts, 'metrics': metrics}
        pooled = dict(config=config, tiles=tiles, parameters=parameters,
                       counts=pooled_counts, metrics=metrics)
        if corrupt_pooled:
            pooled['counts']['matched'] = 3
        (directory / 'summary.json').write_text(json.dumps(summary))
        (directory / 'pooled.json').write_text(json.dumps(pooled))
        for tile in tiles:
            (directory / f'{tile}.score.json').write_text(json.dumps({'tile': tile}))
            (directory / f'{tile}.geojson').write_text('{}')
            (directory / f'{tile}.probabilities.npz').write_bytes(b'fixture')
        result = {'best': {'config': config, 'metrics': metrics}}
        return result, computed

    def test_verify_eval_uses_only_source_selected_config_and_rejects_repool_drift(self):
        tiles = [{'id': 'tile-a'}, {'id': 'tile-b'}]
        blocks = [['tile-a', 'tile-b']]
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp) / 'run'
            result, computed = self._write_eval(run, include_extra_config=True)
            with patch.object(analysis, 'selection_manifest', return_value=(tiles, blocks)):
                with self.assertRaisesRegex(ValueError, 'only source-selected config'):
                    analysis.verify_eval(self.plan, run, 'zagreb-v2', result, candidate=True)

            result, computed = self._write_eval(run, include_extra_config=False, corrupt_pooled=True)
            with patch.object(analysis, 'BENCH', Path(temp)), \
                    patch.object(analysis, 'selection_manifest', return_value=(tiles, blocks)), \
                    patch.object(analysis.shared, 'digest', return_value='fixture-hash'), \
                    patch.object(analysis.shared.score, 'pool', return_value=computed):
                with self.assertRaisesRegex(ValueError, 'pooled counts, parameters or tiles differ'):
                    analysis.verify_eval(self.plan, run, 'zagreb-v2', result, candidate=True)

    def test_verify_runtime_checks_npz_content_even_when_its_hash_is_refreshed(self):
        with tempfile.TemporaryDirectory() as temp:
            bench = Path(temp)
            runtime_dir = bench / 'output/runs/selection-v4-normalization-runtime'
            runtime_dir.mkdir(parents=True)
            plan_sha = 'frozen-plan-sha'
            runtime = {'critical_packages': {'torch': '2.x'},
                       'pretrained_file_sha256': 'pinned-weights-sha'}
            plan = {
                'name': 'selection-v4-normalization', 'runtime': runtime,
                'frozen_inputs': {'recipe_hash': 'recipe-sha',
                                  'dataset_manifest_sha256': 'dataset-sha'},
                'rgb_normalization': self.normalized, 'target_definition': self.target,
            }
            shape = (3, 512, 512)
            raw_rgb = np.empty(shape, dtype=np.float32)
            raw_rgb[0].fill(.25)
            raw_rgb[1].fill(.50)
            raw_rgb[2].fill(.75)
            osm = np.zeros(shape, dtype=np.uint8)
            osm[0, ::2, ::2] = 1
            boundary = np.zeros((512, 512), dtype=np.uint8)
            interior = np.zeros((512, 512), dtype=np.uint8)
            distance = np.zeros((512, 512), dtype=np.float16)
            mean = np.asarray(self.normalized['mean'], dtype=np.float32)[:, None, None]
            std = np.asarray(self.normalized['std'], dtype=np.float32)[:, None, None]
            normalized_rgb = (raw_rgb - mean) / std
            arrays = {
                'raw_rgb': raw_rgb, 'osm': osm, 'boundary': boundary, 'interior': interior,
                'distance': distance, 'target_definition': np.array(json.dumps(self.target, sort_keys=True)),
                'normalized_rgb': normalized_rgb, 'encoder_osm': osm.copy(),
            }
            cache_arrays = {
                key: hashlib.sha256(np.ascontiguousarray(arrays[name]).tobytes()).hexdigest()
                for key, name in (('image', 'raw_rgb'), ('osm', 'osm'), ('boundary', 'boundary'),
                                  ('interior', 'interior'), ('distance', 'distance'))
            }
            proof_path = runtime_dir / 'rgb-normalization-cache-proof.npz'

            def save_fixture():
                np.savez_compressed(proof_path, **arrays)
                return hashlib.sha256(proof_path.read_bytes()).hexdigest()

            proof = {
                'rgb_normalization': self.normalized,
                'rgb_matches_transform': True, 'osm_unchanged': True, 'cache_unchanged': True,
                'initial_parameters_identical': True, 'default_model_receives_raw_input': True,
                'finite_inference': True,
                'cache': {'target_definition': self.target,
                          'namespace': analysis.shared.cache_namespace(self.target),
                          'sha256': 'cache-npz-sha'},
                'cache_arrays': cache_arrays,
            }
            proof['proof_npz_sha256'] = save_fixture()
            payload = {
                'plan_sha256': plan_sha, 'runtime': runtime,
                'pretrained': {'sha256': runtime['pretrained_file_sha256']},
                'frozen_inputs': {'recipe_hash': 'recipe-sha',
                                  'dataset_manifest_sha256': 'dataset-sha'},
                'production_512_rgb_normalization_proof': proof,
            }
            preflight_path = runtime_dir / 'preflight.json'
            preflight_path.write_text(json.dumps(payload))

            with patch.object(analysis, 'BENCH', bench):
                analysis.verify_runtime(plan, plan_sha)

                arrays['normalized_rgb'] = arrays['normalized_rgb'].copy()
                arrays['normalized_rgb'][0, 0, 0] += .5
                proof['proof_npz_sha256'] = save_fixture()  # a refreshed hash must not mask bad content
                preflight_path.write_text(json.dumps(payload))
                with self.assertRaisesRegex(ValueError, 'does not match the frozen RGB transform'):
                    analysis.verify_runtime(plan, plan_sha)


if __name__ == '__main__':
    unittest.main()
