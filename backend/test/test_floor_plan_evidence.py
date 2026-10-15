"""Regression tests for deterministic pixel-coordinate evidence extraction."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
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

    def test_connected_rectangular_walls_and_partition_keep_stroke_bands_separate(self):
        image = Image.new('L', (360, 280), 255)
        draw = ImageDraw.Draw(image)
        draw.rectangle((48, 48, 292, 212), fill=205)
        draw.line((40, 40, 300, 40), fill=0, width=8)
        draw.line((40, 40, 40, 220), fill=0, width=8)
        draw.line((300, 40, 300, 220), fill=0, width=8)
        draw.line((40, 220, 120, 220), fill=0, width=8)
        draw.line((200, 220, 300, 220), fill=0, width=8)
        draw.line((160, 40, 160, 155), fill=0, width=8)
        draw.line((160, 155, 260, 155), fill=0, width=8)

        walls = evidence.axis_candidates(np.array(image))
        horizontal = [wall for wall in walls if wall['orientation'] == 'H']
        vertical = [wall for wall in walls if wall['orientation'] == 'V']
        self.assertEqual(len(horizontal), 4)
        self.assertEqual(len(vertical), 3)
        self.assertTrue(all(6 <= wall['widthPx'] <= 10 for wall in walls))
        self.assertTrue(all((wall['b'][0] - wall['a'][0] + 1) / wall['widthPx'] >= 3
                            for wall in horizontal))
        bottom = sorted((wall for wall in horizontal if wall['a'][1] > 210), key=lambda wall: wall['a'][0])
        self.assertEqual(len(bottom), 2)
        self.assertLess(bottom[0]['b'][0], bottom[1]['a'][0])
        self.assertFalse(any(wall['a'][0] < 120 and wall['b'][0] > 200 for wall in bottom))

    def test_cross_hatched_strips_recover_source_width_and_preserve_door_gap(self):
        gray = np.full((260, 420), 255, dtype=np.uint8)
        yy, xx = np.indices(gray.shape)
        hatch = ((xx+yy) % 6 < 2) | ((xx-yy) % 6 < 2)
        boxes = [(40, 60, 170, 73), (220, 60, 380, 73), (40, 110, 53, 230)]
        for x0, y0, x1, y1 in boxes:
            patch = gray[y0:y1+1, x0:x1+1]
            patch[hatch[y0:y1+1, x0:x1+1]] = 0
            patch[[0, -1], :] = 0
            patch[:, [0, -1]] = 0
        walls = evidence.hatched_candidates(gray)
        self.assertEqual(len(walls), 3)
        self.assertTrue(all(12 <= wall['widthPx'] <= 16 for wall in walls))
        horizontal = [w for w in walls if w['orientation'] == 'H']
        self.assertEqual(len(horizontal), 2)
        self.assertLess(horizontal[0]['b'][0], 180)
        self.assertGreater(horizontal[1]['a'][0], 210)
        for wall in walls:
            x0, y0, x1, y1 = wall['bounds']
            self.assertTrue(any(abs(x0-a) <= 2 and abs(y0-b) <= 2 and
                                abs(x1-c) <= 2 and abs(y1-d) <= 2 for a,b,c,d in boxes))

    def test_grid_dimensions_and_furniture_do_not_add_hatched_candidates(self):
        image = Image.new('L', (480, 340), 255)
        draw = ImageDraw.Draw(image)
        for x in range(20, 181, 20):
            draw.line((x, 20, x, 180), fill=0)
        for y in range(20, 181, 20):
            draw.line((20, y, 180, y), fill=0)
        draw.line((20, 240, 450, 240), fill=0)
        for x in range(20, 451, 60):
            draw.line((x, 232, x, 248), fill=0)
        # Paired edges, crossed cupboard and a table with chairs.
        draw.rectangle((240, 30, 450, 100), outline=0, width=2)
        draw.line((240, 30, 450, 100), fill=0)
        draw.line((240, 100, 450, 30), fill=0)
        draw.rectangle((270, 140, 400, 200), outline=0, width=2)
        for x in (280, 340):
            draw.rectangle((x, 125, x+30, 145), outline=0, width=2)
            draw.rectangle((x, 195, x+30, 215), outline=0, width=2)
        self.assertEqual(evidence.hatched_candidates(np.array(image)), [])

    def test_combined_detector_keeps_solid_candidates_identical(self):
        image = Image.new('L', (400, 280), 255)
        draw = ImageDraw.Draw(image)
        draw.line((30, 40, 360, 40), fill=0, width=14)
        draw.line((30, 40, 30, 240), fill=0, width=14)
        draw.line((180, 40, 180, 180), fill=0, width=8)
        gray = np.array(image)
        self.assertEqual(evidence.hatched_candidates(gray), [])
        self.assertEqual(evidence.measured_candidates(gray), evidence.axis_candidates(gray))
        _, result, _ = self.run_image(image.convert('RGB'))
        self.assertEqual(result['version'], 'floor-plan-evidence-v3')

    def test_gray_room_fill_does_not_become_wall_candidate(self):
        image = Image.new('L', (320, 220), 255)
        ImageDraw.Draw(image).rectangle((40, 40, 280, 180), fill=190)
        self.assertEqual(evidence.axis_candidates(np.array(image)), [])

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
        self.assertEqual(result['scaleCandidates'], [])

    def test_connected_ticked_alternating_baseline_has_measured_endpoints(self):
        image = Image.new('RGB', (420, 240), 'white')
        draw = ImageDraw.Draw(image)
        start, y, interval, count = 50, 180, 60, 5
        draw.line((start, y, start+count*interval, y), fill=(205, 205, 205), width=2)
        for i in range(count):
            if i % 2 == 0:
                draw.line((start+i*interval, y, start+(i+1)*interval-1, y), fill='black', width=2)
        for i in range(count+1):
            x = start+i*interval
            draw.line((x, y-4, x, y), fill='black', width=1)
        _, result, _ = self.run_image(image)
        self.assertEqual(result['scaleCandidates'], [{'a': [50, 180.5], 'b': [350, 180.5],
                                                       'intervals': 5, 'id': 'S1'}])

    def test_connected_ticked_line_without_alternating_fill_is_detected_but_lone_wall_is_not(self):
        image = Image.new('RGB', (440, 260), 'white')
        draw = ImageDraw.Draw(image)
        draw.line((60, 190, 360, 190), fill=(200, 200, 200), width=1)
        for x in range(60, 361, 60):
            draw.line((x, 186, x, 190), fill='black', width=1)
        draw.line((20, 70, 410, 70), fill='black', width=6)
        _, result, _ = self.run_image(image)
        self.assertEqual(len(result['scaleCandidates']), 1)
        self.assertEqual(result['scaleCandidates'][0]['a'][0], 60)
        self.assertEqual(result['scaleCandidates'][0]['b'][0], 360)
        self.assertEqual(result['scaleCandidates'][0]['intervals'], 5)

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
                pixels = list(annotated.convert('RGB').getdata())
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
