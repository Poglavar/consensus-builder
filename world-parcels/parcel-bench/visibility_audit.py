#!/usr/bin/env python3
"""Visibility audit of a frozen benchmark's selection references: how much of each reference parcel's outline
appears supported by the imagery. Labels describe evidence, not an accuracy ceiling. Three steps:
  sample  draws a seeded random sample of selection references into manifests/<benchmark>-visibility.json
  serve   a local labelling page (127.0.0.1 only) that writes labels into that file as you go
  report  per-class recall of finished evaluations, from the matches their per-tile score files record
Classes are score.py's: strong (the whole outline follows something visible: wall, fence, hedge, kerb, building
edge, a change of surface or crop), partial (some sides visible), weak (almost none visible), uncertain (cannot
tell: shadow, blur, canopy). Labels key on (tile, reference id), the reference as score.py clips it to the tile."""
from __future__ import annotations

import argparse
import json
import os
import random
import statistics
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from shapely.geometry import box

import score

HERE = Path(__file__).resolve().parent
STATIC = HERE / 'visibility'
CLASSES = score.VISIBILITY_CLASSES
DEFINITIONS = {
    'strong': 'the whole outline follows something visible: wall, fence, hedge, kerb, building edge, a change of surface or crop',
    'partial': 'some sides of the outline are visible, others are not',
    'weak': 'almost none of the outline is visible: it crosses uniform ground, runs under canopy or through buildings',
    'uncertain': 'cannot tell: shadow, blur or the image itself hides it',
}


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, data):
    """Atomic: a crash mid-write never leaves a torn audit file."""
    temporary = Path(path).with_name(f'.{Path(path).name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(data, indent=1, sort_keys=True) + '\n')
    os.replace(temporary, path)


def selection_references(manifest, dataset):
    """Every selection reference as score.py sees it: (tile id, reference id, clipped geometry, tile bbox)."""
    samples = {s['id']: s for s in read_json(Path(dataset) / 'manifest.json')['samples']}
    rows = []
    for record in manifest['splits']['selection']['tiles']:
        bbox = [float(v) for v in record['bbox']]
        truth = read_json(Path(dataset) / samples[record['id']]['truth'])
        references, _ = score.load_features(truth, box(*bbox))
        rows += [(record['id'], fid, geom, bbox) for fid, geom, _ in references]
    return rows


def draw_sample(rows, count, seed):
    """Seeded uniform sample without replacement, in a stable order (tile, reference)."""
    keys = sorted((tile, ref) for tile, ref, _, _ in rows)
    chosen = random.Random(seed).sample(keys, min(count, len(keys)))
    return sorted(chosen)


def outline_pixels(geom, bbox, size):
    """Polygon rings in image pixels (origin top-left) for a square image of `size` pixels covering bbox."""
    x0, y0, x1, y1 = bbox
    sx, sy = size / (x1 - x0), size / (y1 - y0)
    polygons = getattr(geom, 'geoms', [geom])
    return [[[round((x - x0) * sx, 1), round((y1 - y) * sy, 1)] for x, y in ring.coords]
            for polygon in polygons for ring in [polygon.exterior, *polygon.interiors]]


def item_label(item):
    """A human label wins over the vision model's (visibility_label.py); None when neither exists."""
    return item.get('label') or (item.get('model_label') or {}).get('label')


def per_class_recall(audit, evaluations):
    """For each evaluation directory: matched share of the labelled references in each class, from the
    `matches` list of every <tile>.score.json. Unlabelled references do not count anywhere."""
    labels = {(item['tile'], item['reference']): item_label(item) for item in audit['sample'] if item_label(item)}
    report = {}
    for directory in evaluations:
        matched, evaluated = set(), set()
        for path in Path(directory).glob('*.score.json'):
            result = read_json(path)
            tile = result.get('tile') or path.name.removesuffix('.score.json')
            if tile in evaluated:
                raise ValueError(f'duplicate scored tile: {tile}')
            evaluated.add(tile)
            matched |= {(tile, match['reference']) for match in result.get('matches', [])}
        missing = {tile for tile, _ in labels} - evaluated
        if missing:
            raise ValueError(f'evaluation is missing {len(missing)} sampled tiles: {directory}')
        classes = {}
        for key, label in labels.items():
            entry = classes.setdefault(label, {'references': 0, 'matched': 0})
            entry['references'] += 1
            entry['matched'] += key in matched
        for entry in classes.values():
            entry['recall'] = entry['matched'] / entry['references']
        report[str(directory)] = classes
    return report


def sample_command(args):
    manifest = read_json(args.manifest)
    out = args.output or HERE / 'manifests' / f"{manifest['version']}-visibility.json"
    if out.exists() and not args.force:
        raise SystemExit(f'{out} exists (labels may be in it); pass --force to redraw')
    rows = selection_references(manifest, args.dataset)
    areas = {(tile, ref): geom.area for tile, ref, geom, _ in rows}
    chosen = draw_sample(rows, args.count, args.seed)
    write_json(out, {'benchmark': manifest['version'], 'split': 'selection', 'seed': args.seed,
                     'population': len(rows), 'classes': list(CLASSES), 'definitions': DEFINITIONS,
                     'created_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                     'sample': [{'tile': tile, 'reference': ref, 'area_m2': round(areas[tile, ref], 1)}
                                for tile, ref in chosen]})
    print(f'{len(chosen)} of {len(rows)} selection references sampled into {out}')


class Handler(BaseHTTPRequestHandler):
    audit_path = None
    dataset = None
    geometries = {}
    samples = {}

    def image_size(self, tile):
        with Image.open(Path(self.dataset) / self.samples[tile]['image']) as image:
            if image.size[0] != image.size[1]:
                raise ValueError(f'{tile}: tile image is not square')
            return image.size[0]

    def send(self, code, body, kind='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *values):
        pass

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/index.html', '/audit.css', '/audit.js'):
            name = 'index.html' if path == '/' else path[1:]
            kinds = {'html': 'text/html', 'css': 'text/css', 'js': 'text/javascript'}
            return self.send(200, (STATIC / name).read_bytes(), kinds[name.rsplit('.', 1)[1]] + '; charset=utf-8')
        if path == '/audit':
            audit = read_json(self.audit_path)
            items = []
            for item in audit['sample']:
                geom, bbox = self.geometries[item['tile'], item['reference']]
                size = self.image_size(item['tile'])
                items.append(dict(item, rings=outline_pixels(geom, bbox, size), size=size))
            return self.send(200, {'benchmark': audit['benchmark'], 'classes': audit['classes'],
                                   'definitions': audit['definitions'], 'items': items})
        if path.startswith('/image/'):
            tile = path.removeprefix('/image/')
            sample = self.samples.get(tile)
            if sample is None:
                return self.send(404, {'error': 'unknown tile'})
            return self.send(200, (Path(self.dataset) / sample['image']).read_bytes(), 'image/jpeg')
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/label':
            return self.send(404, {'error': 'not found'})
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if body.get('label') not in (*CLASSES, None):
            return self.send(400, {'error': f"label must be one of {CLASSES}"})
        audit = read_json(self.audit_path)
        item = audit['sample'][int(body['index'])]
        if (item['tile'], item['reference']) != (body.get('tile'), body.get('reference')):
            return self.send(409, {'error': 'item mismatch; reload the page'})
        if body['label'] is None:
            item.pop('label', None); item.pop('labelled_at', None)
        else:
            item['label'] = body['label']
            item['labelled_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        write_json(self.audit_path, audit)
        done = sum(bool(i.get('label')) for i in audit['sample'])
        self.send(200, {'ok': True, 'labelled': done, 'total': len(audit['sample'])})


def serve_command(args):
    audit = read_json(args.audit)
    manifest = read_json(args.manifest)
    if manifest['version'] != audit['benchmark']:
        raise SystemExit(f"audit is for {audit['benchmark']}, manifest is {manifest['version']}")
    rows = selection_references(manifest, args.dataset)
    Handler.audit_path, Handler.dataset = Path(args.audit), Path(args.dataset)
    Handler.geometries = {(tile, ref): (geom, bbox) for tile, ref, geom, bbox in rows}
    Handler.samples = {s['id']: s for s in read_json(Path(args.dataset) / 'manifest.json')['samples']}
    missing = [i for i in audit['sample'] if (i['tile'], i['reference']) not in Handler.geometries]
    if missing:
        raise SystemExit(f'{len(missing)} sampled references no longer resolve, e.g. {missing[0]}')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    done = sum(bool(i.get('label')) for i in audit['sample'])
    print(f"labelling {audit['benchmark']}: {done}/{len(audit['sample'])} done; open http://localhost:{args.port}/ (Ctrl-C to stop)")
    server.serve_forever()


def report_command(args):
    audit = read_json(args.audit)
    labelled = [i for i in audit['sample'] if item_label(i)]
    shares = {c: sum(item_label(i) == c for i in labelled) for c in CLASSES}
    print(f"{audit['benchmark']}: {len(labelled)}/{len(audit['sample'])} labelled; "
          + ', '.join(f"{c} {n} ({n / max(len(labelled), 1):.0%})" for c, n in shares.items()))
    human = sum(bool(i.get('label')) for i in labelled)
    print(f"label sources: {human} human, {len(labelled) - human} model; "
          f"sampled from {audit.get('population', 'unknown')} selection reference instances (including clipped parcels)")
    print('Visibility classes are judgments about this imagery, not a measured accuracy ceiling. '
          'Aggregate image-edge differences do not validate individual labels.')
    ratios = {c: [i['edge']['ratio'] for i in labelled if item_label(i) == c and i.get('edge')] for c in CLASSES}
    print('image edge on the line vs beside it (visibility_label.py), median ratio per class: '
          + ', '.join(f"{c} {statistics.median(r):.2f} (n={len(r)})" for c, r in ratios.items() if r))
    for directory, classes in per_class_recall(audit, args.eval_dir).items():
        print(directory + ': ' + ', '.join(f"{c} recall {classes[c]['recall']:.2f} ({classes[c]['matched']}/{classes[c]['references']})"
                                           for c in CLASSES if c in classes))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    sampler = commands.add_parser('sample')
    sampler.add_argument('--manifest', type=Path, required=True)
    sampler.add_argument('--dataset', type=Path, required=True)
    sampler.add_argument('--count', type=int, default=150)
    sampler.add_argument('--seed', type=int, default=0)
    sampler.add_argument('--output', type=Path)
    sampler.add_argument('--force', action='store_true')
    server = commands.add_parser('serve')
    server.add_argument('--audit', type=Path, required=True)
    server.add_argument('--manifest', type=Path, required=True)
    server.add_argument('--dataset', type=Path, required=True)
    server.add_argument('--port', type=int, default=8765)
    reporter = commands.add_parser('report')
    reporter.add_argument('--audit', type=Path, required=True)
    reporter.add_argument('--eval-dir', type=Path, nargs='*', default=[])
    args = parser.parse_args(argv)
    {'sample': sample_command, 'serve': serve_command, 'report': report_command}[args.command](args)


if __name__ == '__main__':
    main()
