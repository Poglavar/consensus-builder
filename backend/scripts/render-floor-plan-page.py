#!/usr/bin/env python3
"""Render one immutable source page for vision and optional vector/source QA overlays."""
import argparse
import json
import subprocess
import tempfile
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def render(source, output, page=1, grid=False):
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
            # Stay below the vision provider's rescaling threshold, preserving labelled pixel positions.
            factor = min(1, 1568 / max(image.size), math.sqrt(1_050_000 / (image.width * image.height)))
            image = image.resize((round(image.width * factor), round(image.height * factor)))
            if grid:
                draw = ImageDraw.Draw(image, 'RGBA')
                font = ImageFont.load_default(size=12)
                for x in range(0, image.width, 100):
                    draw.line([(x, 0), (x, image.height)], fill=(0, 155, 220, 65), width=1)
                for y in range(0, image.height, 100):
                    draw.line([(0, y), (image.width, y)], fill=(0, 155, 220, 65), width=1)
                    for x in range(0, image.width, 100):
                        text = f'{x},{y}'
                        box = draw.textbbox((x+2, y+2), text, font=font)
                        draw.rectangle(box, fill=(255, 255, 255, 225))
                        draw.text((x+2, y+2), text, fill=(0, 120, 190, 255), font=font)
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
    parser.add_argument('--grid', action='store_true')
    args = parser.parse_args()
    if args.overlay_model:
        overlay(args.source, args.overlay_model, args.output)
    else:
        if args.page < 1:
            parser.error('--page must be positive')
        print(json.dumps(render(args.source, args.output, args.page, args.grid)))
