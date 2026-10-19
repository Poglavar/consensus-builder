#!/usr/bin/env python3
"""Render image/geometry/probe review sheets for the frozen visible-division diagnostic."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from visible_division_study import ANNOTATION_SHA256, checked_file, digest

HERE = Path(__file__).resolve().parent
SIZE = 512
FONT = ImageFont.load_default(size=16)
SMALL = ImageFont.load_default(size=13)
COLORS = {'joined': '#ff5757', 'separated': '#7eff8c', 'uncovered': '#eeeeee', 'ambiguous': '#ff70ff'}


def panel(image, sample, collection=None, outcomes=None):
    result = image.convert('RGB').resize((SIZE, SIZE))
    draw = ImageDraw.Draw(result)
    x0, y0, x1, y1 = sample['bbox']
    if collection:
        for feature in collection['features']:
            geometry = feature['geometry']
            polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
            for polygon in polygons:
                for ring in polygon:
                    points = [((x - x0) / (x1 - x0) * SIZE, (y1 - y) / (y1 - y0) * SIZE) for x, y in ring]
                    draw.line(points, fill='#34d4ff', width=2)
    for probe in sample['probes']:
        color = '#ffe83b' if probe['relation'] == 'separate' else '#ffffff'
        if outcomes and probe['relation'] == 'separate':
            color = COLORS[outcomes[probe['id']]]
        points = [(probe[key][0] / sample['width'] * SIZE, probe[key][1] / sample['height'] * SIZE) for key in ('a', 'b')]
        draw.line(points, fill=color, width=3)
        for x, y in points:
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color, outline='black')
        draw.text((points[0][0] + 5, points[0][1] - 16), probe['id'], font=SMALL,
                  fill=color, stroke_width=1, stroke_fill='black')
    return result


def render(dataset, study, output):
    annotation_path = HERE / 'annotations/visible-divisions-v1.json'
    if digest(annotation_path) != ANNOTATION_SHA256:
        raise ValueError('annotation hash mismatch')
    annotations = json.loads(annotation_path.read_text())
    report = json.loads((study / 'report.json').read_text())
    if report['schema'] != 'visible-cell-partition-study-v1' or report['annotation_sha256'] != ANNOTATION_SHA256:
        raise ValueError('expected matching cell-partition report')
    rows = {(r['sample_id'], r['seed'], r['variant']): r for r in report['rows']}
    output.mkdir(parents=True, exist_ok=True)
    for sample in annotations['samples']:
        image_path = checked_file(dataset, sample['image'])
        if digest(image_path) != sample['image_sha256']:
            raise ValueError('review image hash mismatch')
        with Image.open(image_path) as source:
            sheet = Image.new('RGB', (1606, 1810), '#f4f4f4')
            draw = ImageDraw.Draw(sheet)
            draw.text((16, 12), f"{sample['id']} | Agent-draft physical/use divisions | Three baseline seeds", font=FONT, fill='black')
            draw.text((16, 38), 'Cyan: polygon edges. S probe lines: green separated, red joined, white uncovered, magenta ambiguous.', font=SMALL, fill='black')
            draw.text((16, 59), 'S: intended separation; C: white same-surface check. Local Croatian diagnostic; no ownership or target-village claim.', font=SMALL, fill='black')
            for seed in (1, 2, 3):
                y = 92 + (seed - 1) * 568
                draw.text((16, y), f'Seed {seed} | Raw imagery and frozen anchors', font=FONT, fill='black')
                sheet.paste(panel(source, sample), (16, y + 25))
                for column, variant in enumerate(('cell-120m2', 'cell-no-small-region-merge'), 1):
                    row = rows[(sample['id'], seed, variant)]
                    path = checked_file(study, row['polygons'])
                    if digest(path) != row['polygon_sha256']:
                        raise ValueError('review polygon hash mismatch')
                    geometry = json.loads(path.read_text())
                    outcomes = {p['id']: p['outcome'] for p in row['probes']}
                    x = 16 + column * 532
                    draw.text((x, y), f"{variant} | {row['geometry']['feature_count']} features", font=FONT, fill='black')
                    sheet.paste(panel(source, sample, geometry, outcomes), (x, y + 25))
                    captions = '; '.join(f"{p['id']} {p['outcome']}" for p in row['probes'])
                    draw.text((x, y + 541), captions, font=SMALL, fill='black')
            sheet.save(output / f"{sample['id']}.png")
    print(f'Rendered {len(annotations["samples"])} three-seed review sheets.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--study', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    render(args.dataset, args.study, args.output)


if __name__ == '__main__':
    main()
