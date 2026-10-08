"""Regression tests for deterministic pixel-coordinate evidence extraction."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'extract-floor-plan-evidence.py'
spec = importlib.util.spec_from_file_location('floor_plan_evidence', SCRIPT)
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class FloorPlanEvidence(unittest.TestCase):
    def run_image(self, image):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        image_path = root / 'source.png'
        json_path = root / 'evidence.json'
        annotation_path = root / 'annotation.png'
        image.save(image_path)
        summary = evidence.extract_evidence(image_path, json_path, annotation_path)
        with Image.open(annotation_path) as annotation:
            annotation.load()
            annotation_copy = annotation.copy()
        return summary, json.loads(json_path.read_text()), annotation_copy

    def test_extracts_stable_thick_wall_candidates_and_annotation(self):
        image = Image.new('RGB', (500, 400), 'white')
        draw = ImageDraw.Draw(image)
        draw.line((80, 70, 400, 70), fill='black', width=7)
        draw.line((80, 70, 80, 300), fill='black', width=7)
        summary, result, annotated = self.run_image(image)
        self.assertEqual(summary['wallCandidateCount'], 2)
        self.assertEqual([w['id'] for w in result['wallCandidates']], ['W1', 'W2'])
        self.assertTrue(all(w['widthPx'] >= 5 for w in result['wallCandidates']))
        self.assertEqual(result['widthPx'], 500)
        self.assertEqual(result['candidateFramePx'], [73, 63, 332, 242])
        self.assertLessEqual(max(annotated.size), 1568)
        self.assertLessEqual(annotated.width * annotated.height, 1_050_000)

    def test_door_gap_stays_two_distinct_wall_sections(self):
        image = Image.new('RGB', (400, 240), 'white')
        ImageDraw.Draw(image).line((40, 100, 160, 100), fill='black', width=6)
        ImageDraw.Draw(image).line((205, 100, 360, 100), fill='black', width=6)
        _, result, _ = self.run_image(image)
        horizontal = [w for w in result['wallCandidates'] if abs(w['a'][1]-w['b'][1]) < 1]
        self.assertEqual(len(horizontal), 2)
        self.assertLess(horizontal[0]['b'][0], horizontal[1]['a'][0])

    def test_blank_photo_like_image_is_explicitly_inconclusive(self):
        image = Image.new('RGB', (320, 200), (120, 140, 160))
        _, result, _ = self.run_image(image)
        self.assertEqual(result['wallCandidates'], [])
        self.assertTrue(any('inconclusive' in issue for issue in result['issues']))

    def test_alternating_scale_bar_returns_full_endpoints_and_intervals(self):
        image = Image.new('RGB', (500, 220), 'white')
        draw = ImageDraw.Draw(image)
        start, y, bar = 112, 150, 32
        for i in range(5):
            x = start + i * bar * 2
            draw.rectangle((x, y, x+bar-1, y+2), fill='black')
        _, result, _ = self.run_image(image)
        self.assertEqual(len(result['scaleCandidates']), 1)
        candidate = result['scaleCandidates'][0]
        self.assertEqual(candidate['a'], [112, 151])
        self.assertEqual(candidate['b'], [400-1, 151])
        self.assertEqual(candidate['intervals'], 9)

    def test_page_rule_is_excluded_by_extreme_aspect_ratio(self):
        image = Image.new('RGB', (800, 400), 'white')
        ImageDraw.Draw(image).line((20, 200, 780, 200), fill='black', width=1)
        _, result, _ = self.run_image(image)
        self.assertEqual(result['wallCandidates'], [])

    def test_annotation_mode_draws_root_opening_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / 'source.png'
            evidence_path = root / 'evidence.json'
            output_path = root / 'annotated.png'
            Image.new('RGB', (200, 120), 'white').save(image_path)
            evidence_path.write_text(json.dumps({'widthPx': 200, 'heightPx': 120,
                'wallCandidates': [{'id': 'W1', 'a': [20, 50], 'b': [180, 50], 'widthPx': 6}],
                'openingCandidates': [{'id': 'G7', 'a': [90, 50], 'b': [110, 50], 'widthPx': 2}],
                'scaleCandidates': [{'id': 'S1', 'a': [10, 115], 'b': [80, 115], 'intervals': 5}],
                'outlineCorners': [[20, 30], [180, 30], [180, 70], [20, 70]]}))
            run = subprocess.run([sys.executable, str(SCRIPT), str(image_path), '--annotate-evidence',
                str(evidence_path), '--annotation', str(output_path), '--scale-annotation',
                str(root / 'scale-strips.png')], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(run.stdout)['openingCandidateCount'], 1)
            result = json.loads(run.stdout)
            self.assertEqual(result['scaleStripIds'], ['S1'])
            self.assertEqual(result['scaleStrips'][0]['sourceCropPx'], [0, 91, 111, 29])
            with Image.open(output_path) as annotated:
                pixels = list(annotated.convert('RGB').get_flattened_data())
                self.assertGreater(annotated.width / annotated.height, 2.0)
                self.assertTrue(any(pixel[0] > 220 and pixel[1] > 70 and pixel[1] < 190 and pixel[2] < 30
                                    for pixel in pixels))
                self.assertTrue(any(pixel[1] > 100 and pixel[0] < 40 and pixel[2] < 40 for pixel in pixels))
                self.assertFalse(any(pixel[2] > 200 and pixel[0] < 40 and pixel[1] < 100 for pixel in pixels))

    def test_scale_strips_preserve_candidate_order_provenance_and_report_truncation(self):
        image = Image.new('RGB', (500, 400), 'white')
        scales = [{'id': f'S{i}', 'a': [100, 40+i*30], 'b': [180, 40+i*30]} for i in range(1, 10)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'scales.png'
            result = evidence.annotate_scale_strips(image, scales, path)
            self.assertEqual(result['scaleStripIds'], [f'S{i}' for i in range(1, 9)])
            self.assertEqual(result['scaleStrips'][0]['sourceCropPx'], [70, 46, 141, 49])
            self.assertEqual(result['scaleStrips'][1]['sourceCropPx'], [70, 76, 141, 49])
            self.assertTrue(any('truncated' in issue for issue in result['issues']))
            with Image.open(path) as strips:
                self.assertLessEqual(max(strips.size), 1568)
                self.assertLessEqual(strips.width*strips.height, 1_050_000)


if __name__ == '__main__':
    unittest.main()
