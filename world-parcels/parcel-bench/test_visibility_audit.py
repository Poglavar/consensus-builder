"""Tests for visibility_audit.py: seeded stable sampling, the pixel transform of outlines, per-class recall from
recorded matches, and the labelling server's endpoints against a sample of the real dataset when present."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from shapely.geometry import Polygon

import visibility_audit as audit

HERE = Path(__file__).resolve().parent
DATASET = Path(os.environ.get('PARCEL_HR_DATASET', HERE / 'output' / 'pool' / 'hr-pool-v1' / 'dataset'))


class PureTests(unittest.TestCase):
    def test_sample_is_seeded_stable_and_without_replacement(self):
        rows = [(f't{i % 3}', f'r{i}', None, None) for i in range(40)]
        first = audit.draw_sample(rows, 10, 0)
        self.assertEqual(first, audit.draw_sample(list(reversed(rows)), 10, 0))
        self.assertEqual(len(set(first)), 10)
        self.assertEqual(first, sorted(first))
        self.assertNotEqual(first, audit.draw_sample(rows, 10, 1))
        self.assertEqual(len(audit.draw_sample(rows, 100, 0)), 40)

    def test_outline_pixels_put_the_north_west_corner_at_the_origin(self):
        square = Polygon([(100, 200), (110, 200), (110, 190), (100, 190)])
        rings = audit.outline_pixels(square, (100, 190, 120, 210), 200)
        self.assertEqual(rings[0][0], [0.0, 100.0])
        self.assertEqual(rings[0][1], [100.0, 100.0])
        self.assertEqual(rings[0][2], [100.0, 200.0])

    def test_per_class_recall_counts_only_labelled_references(self):
        sample = {'sample': [{'tile': 'a', 'reference': '1', 'label': 'strong'},
                             {'tile': 'a', 'reference': '2', 'label': 'strong'},
                             {'tile': 'b', 'reference': '3', 'label': 'weak'},
                             {'tile': 'b', 'reference': '4'}]}
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'a.score.json').write_text(json.dumps({'tile': 'a', 'matches': [{'reference': '1'}]}))
            (Path(directory) / 'b.score.json').write_text(json.dumps({'tile': 'b', 'matches': [{'reference': '4'}]}))
            classes = audit.per_class_recall(sample, [directory])[directory]
        self.assertEqual(classes['strong'], {'references': 2, 'matched': 1, 'recall': 0.5})
        self.assertEqual(classes['weak'], {'references': 1, 'matched': 0, 'recall': 0.0})
        self.assertNotIn('partial', classes)


@unittest.skipUnless((DATASET / 'manifest.json').exists(), 'merged HR dataset not present')
class ServerTests(unittest.TestCase):
    def test_sample_then_label_through_the_server(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'audit.json'
            manifest = HERE / 'manifests' / 'split-v1.json'
            audit.main(['sample', '--manifest', str(manifest), '--dataset', str(DATASET), '--count', '5', '--output', str(path)])
            data = json.loads(path.read_text())
            self.assertEqual((data['benchmark'], len(data['sample'])), ('split-v1', 5))
            with self.assertRaises(SystemExit):     # never silently redraws a file that may hold labels
                audit.main(['sample', '--manifest', str(manifest), '--dataset', str(DATASET), '--output', str(path)])
            rows = audit.selection_references(json.loads(manifest.read_text()), DATASET)
            audit.Handler.audit_path, audit.Handler.dataset = path, DATASET
            audit.Handler.geometries = {(t, r): (g, b) for t, r, g, b in rows}
            audit.Handler.samples = {s['id']: s for s in json.loads((DATASET / 'manifest.json').read_text())['samples']}
            server = ThreadingHTTPServer(('127.0.0.1', 0), audit.Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = f'http://127.0.0.1:{server.server_address[1]}'
            try:
                with urllib.request.urlopen(base + '/audit') as response:
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    items = json.loads(response.read())['items']
                self.assertEqual(len(items), 5)
                self.assertTrue(all(item['size'] == 1024 and item['rings'] for item in items))
                with urllib.request.urlopen(base + '/image/' + items[0]['tile']) as response:
                    self.assertEqual(response.headers['Content-Type'], 'image/jpeg')
                post = lambda body: urllib.request.urlopen(urllib.request.Request(
                    base + '/label', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}))
                item = {'index': 2, 'tile': items[2]['tile'], 'reference': items[2]['reference']}
                with post(dict(item, label='partial')) as response:
                    self.assertEqual(json.loads(response.read())['labelled'], 1)
                self.assertEqual(json.loads(path.read_text())['sample'][2]['label'], 'partial')
                with self.assertRaises(urllib.error.HTTPError) as bad:
                    post(dict(item, label='visible'))
                self.assertEqual(bad.exception.code, 400)
                with self.assertRaises(urllib.error.HTTPError) as stale:
                    post(dict(item, index=3, label='weak'))
                self.assertEqual(stale.exception.code, 409)
                with post(dict(item, label=None)):
                    pass
                self.assertNotIn('label', json.loads(path.read_text())['sample'][2])
            finally:
                server.shutdown(); server.server_close()


if __name__ == '__main__':
    unittest.main()
