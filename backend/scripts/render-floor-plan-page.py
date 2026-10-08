#!/usr/bin/env python3
"""Render one immutable source page for vision and optional vector/source QA overlays."""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw


def render(source, output, page=1):
    with tempfile.TemporaryDirectory(prefix='floor-plan-page-') as directory:
        with open(source, 'rb') as stream:
            is_pdf = stream.read(5) == b'%PDF-'
        if is_pdf:
            prefix = str(Path(directory) / 'page')
            subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-singlefile',
                            '-scale-to', '1568', '-png', str(source), prefix], check=True,
                           capture_output=True, timeout=90)
            source = prefix + '.png'
        elif page != 1:
            raise ValueError('A raster source has only one supported page')
        with Image.open(source) as original:
            if original.width * original.height > 50_000_000:
                raise ValueError('Source image exceeds 50 megapixels')
            image = original.convert('RGB')
            image.thumbnail((1568, 1568))
            image.save(output, 'PNG')
            return {'width': image.width, 'height': image.height}


def overlay(image_path, model_path, output):
    model = json.loads(Path(model_path).read_text())
    image = Image.open(image_path).convert('RGB')
    draw = ImageDraw.Draw(image)
    x, y, width, height = model['source']['framePx']
    def pixels(ring):
        return [(x + u * width, y + v * height) for u, v in ring]
    for polygon in model['architecture']['walls']:
        for ring in polygon:
            points = pixels(ring)
            draw.line(points + points[:1], fill=(220, 0, 170), width=2)
    for opening in model['architecture']['openings']:
        draw.line(pixels([opening['a'], opening['b']]), fill=(0, 100, 255), width=3)
    image.save(output, 'PNG')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--page', type=int, default=1)
    parser.add_argument('--overlay-model', type=Path)
    args = parser.parse_args()
    if args.overlay_model:
        overlay(args.source, args.overlay_model, args.output)
    else:
        if args.page < 1:
            parser.error('--page must be positive')
        print(json.dumps(render(args.source, args.output, args.page)))
