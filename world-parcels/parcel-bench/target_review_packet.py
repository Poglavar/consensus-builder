#!/usr/bin/env python3
"""Fetch a small OAM review packet and render its unlabelled imagery; never run a model."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORDS = [
    ('magoanine-c', '66a799fd6fc2560001637543'),
    ('djonasse', '67c56b387cc97654af432cab'),
    ('mangochi', '6ac2e866a19ff675fdcf084c'),
    ('baniyataar', '6a7d3b3b782d06d7d0eb4d8d'),
]


def get(url, limit):
    request = urllib.request.Request(url, headers={'Accept': 'application/geo+json,image/png,*/*'})
    with urllib.request.urlopen(request, timeout=40) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('bounded fetch limit exceeded')
    return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch_previews(ROOT):
    rows = []
    for slug, ident in RECORDS:
        receipt = ROOT / (slug + '.json')
        if receipt.exists():
            row = json.loads(receipt.read_text())
            thumbnail = ROOT / row['thumbnail_file']
            if sha(thumbnail.read_bytes()) != row['thumbnail_sha256']:
                raise ValueError('cached preview changed')
        else:
            url = 'https://api.imagery.hotosm.org/stac/collections/openaerialmap/items/' + ident
            raw = get(url, 1_000_000)
            data = json.loads(raw)
            properties = data['properties']
            visual = data['assets']['visual']
            thumbnail_url = data['assets']['thumbnail']['href']
            image = get(thumbnail_url, 10_000_000)
            (ROOT / (slug + '.source.json')).write_bytes(raw)
            (ROOT / (slug + '.png')).write_bytes(image)
            row = {
                'id': slug,
                'item_id': ident,
                'item_url': url,
                'source_metadata_sha256': sha(raw),
                'bbox_wgs84': data['bbox'],
                'title': properties['title'],
                'acquisition_start': properties['start_datetime'],
                'acquisition_end': properties['end_datetime'],
                'source_gsd_m': properties['gsd'],
                'license': properties['license'],
                'producer': properties['oam:producer_name'],
                'attribution': 'Open Imagery Network contributors',
                'visual_url': visual['href'],
                'visual_bytes': visual.get('file:size'),
                'visual_crs': visual.get('proj:code'),
                'visual_bbox': visual.get('proj:bbox'),
                'thumbnail_url': thumbnail_url,
                'thumbnail_file': slug + '.png',
                'thumbnail_sha256': sha(image),
                'thumbnail_bytes': len(image),
                'fetched_at': datetime.now(timezone.utc).isoformat(),
                'review_status': 'pending-human-review',
            }
            (ROOT / (slug + '.json')).write_text(json.dumps(row, indent=2) + '\n')
        rows.append(row)
        print(slug, row['thumbnail_bytes'], row['source_gsd_m'], flush=True)
    manifest = {'schema': 'target-review-candidates-v1', 'records': rows}
    (ROOT / 'preview-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def fetch_windows(ROOT):
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds
    from PIL import Image

    CHOICES = [
        ('magoanine-c', 'west-houses', 0.22, 0.27),
        ('magoanine-c', 'east-growth-edge', 0.66, 0.62),
        ('djonasse', 'north-houses', 0.42, 0.35),
        ('djonasse', 'south-houses', 0.64, 0.65),
        ('baniyataar', 'houses-and-fields', 0.51, 0.5),
    ]
    records = {
        record['id']: record
        for record in json.loads((ROOT / 'preview-manifest.json').read_text())['records']
    }
    rows = []
    for source, name, fx, fy in CHOICES:
        ident = source + '-' + name
        receipt = ROOT / (ident + '.window.json')
        if receipt.exists():
            row = json.loads(receipt.read_text())
            image_path = ROOT / row['image']
            if hashlib.sha256(image_path.read_bytes()).hexdigest() != row['image_sha256']:
                raise ValueError('window hash mismatch')
            rows.append(row)
            continue

        record = records[source]
        with rasterio.Env(
            GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
            GDAL_HTTP_TIMEOUT='40',
            GDAL_HTTP_MAX_RETRY='1',
        ):
            with rasterio.open(record['visual_url']) as source_image:
                left, bottom, right, top = source_image.bounds
                center_x = left + fx * (right - left)
                center_y = top - fy * (top - bottom)
                bbox = [center_x - 76.8, center_y - 76.8,
                        center_x + 76.8, center_y + 76.8]
                window = from_bounds(*bbox, transform=source_image.transform)
                data = source_image.read(
                    [1, 2, 3],
                    window=window,
                    out_shape=(3, 1024, 1024),
                    resampling=Resampling.bilinear,
                )
                mask = source_image.dataset_mask(
                    window=window,
                    out_shape=(1024, 1024),
                    resampling=Resampling.nearest,
                )
                if data.dtype != np.uint8:
                    raise ValueError('expected uint8 RGB, refusing implicit tone conversion')
                image = Image.fromarray(np.moveaxis(data, 0, -1))
                path = ROOT / (ident + '.jpg')
                image.save(path, quality=95, subsampling=0)
                row = {
                    'id': ident,
                    'source_id': source,
                    'item_url': record['item_url'],
                    'image': path.name,
                    'image_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    'width': 1024,
                    'height': 1024,
                    'bbox': bbox,
                    'crs': str(source_image.crs),
                    'bbox_wgs84': list(transform_bounds(source_image.crs, 'EPSG:4326', *bbox)),
                    'source_window_pixels': [window.col_off, window.row_off, window.width, window.height],
                    'source_gsd_m': record['source_gsd_m'],
                    'output_pixel_spacing_m': 0.15,
                    'resampling': 'bilinear RGB; nearest mask',
                    'mask_valid_fraction': float((mask > 0).mean()),
                    'acquisition_start': record['acquisition_start'],
                    'acquisition_end': record['acquisition_end'],
                    'license': record['license'],
                    'attribution': record['attribution'],
                    'producer': record['producer'],
                    'review_status': 'pending-human-review',
                    'probes': [],
                    'fetched_at': datetime.now(timezone.utc).isoformat(),
                }
        receipt.write_text(json.dumps(row, indent=2) + '\n')
        rows.append(row)
        print(ident, 'valid', row['mask_valid_fraction'], flush=True)
    manifest = {
        'schema': 'target-review-windows-v1',
        'review_status': 'pending-human-review',
        'samples': rows,
    }
    (ROOT / 'windows.json').write_text(json.dumps(manifest, indent=2) + '\n')


def render(ROOT):
    from PIL import Image, ImageDraw, ImageFont

    manifest = json.loads((ROOT / 'windows.json').read_text())
    records = {
        record['id']: record
        for record in json.loads((ROOT / 'preview-manifest.json').read_text())['records']
    }
    cards = []
    sheet = Image.new('RGB', (1536, 1120), '#f8f8f8')
    draw = ImageDraw.Draw(sheet)
    for index, row in enumerate(manifest['samples']):
        image_path = ROOT / row['image']
        if sha(image_path.read_bytes()) != row['image_sha256']:
            raise ValueError('review image hash mismatch')
        x, y = (index % 3) * 512, (index // 3) * 560
        with Image.open(image_path) as image:
            sheet.paste(image.resize((500, 500)), (x + 6, y + 45))
        draw.text((x + 6, y + 8), row['id'], fill='black', font=ImageFont.load_default(size=17))
        record = records[row['source_id']]
        title = html.escape(row['id'])
        cards.append(
            f'<article><h2>{title}</h2><a href="{row["image"]}"><img src="{row["image"]}" alt="{title}"></a>'
            f'<p>153.6 m square; 1024 × 1024 pixels; output spacing 0.15 m. '
            f'Source GSD {row["source_gsd_m"]:.4f} m; acquisition {html.escape(row["acquisition_start"])} '
            f'to {html.escape(row["acquisition_end"])}.</p><p>{html.escape(record["producer"])}; '
            f'Open Imagery Network contributors; CC BY 4.0. '
            f'<a href="{row["item_url"]}">Official source</a> · '
            f'<a href="{row["id"]}.window.json">Crop receipt</a></p></article>'
        )
    draw.text((1030, 570), 'Pending human review', fill='black', font=ImageFont.load_default(size=24))
    draw.text((1030, 610), 'Five crops / three imagery records', fill='black', font=ImageFont.load_default(size=17))
    draw.text((1030, 645), 'Mozambique and Nepal', fill='black', font=ImageFont.load_default(size=17))
    draw.text((1030, 680), 'No model or cadastral overlays', fill='black', font=ImageFont.load_default(size=17))
    sheet.save(ROOT / 'windows-contact.png')
    page = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<title>Target imagery review packet</title>'
        '<style>body{font:17px/1.5 system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#18202c}'
        'img{width:100%;height:auto}article{margin:50px 0;border-top:1px solid #bbb}a{color:#0756ab}</style>'
        '<h1>Target imagery: pending human review</h1>'
        '<p>Five image-only crops from three OpenAerialMap records in Mozambique and Nepal. '
        'They show housing, gardens and partly undeveloped ground; they do not establish formal settlement classes '
        'or represent African and Asian villages generally. Nearby crops are not independent settlements.</p>'
        '<p>Before any prediction comparison: confirm suitability, mark visible physical/use divisions with two '
        'interior anchors that should stay separate, add same-surface checks, and record uncertain or obscured '
        'boundaries. Pixel coordinates use the full 1024 × 1024 image, origin top left. '
        'Do not infer ownership or a legal parcel boundary. Then freeze reviewed annotations and geographic roles.</p>'
        '<p><a href="windows.json">Unlabelled crop manifest</a> · '
        '<a href="windows-contact.png">Contact sheet</a> · '
        '<a href="preview-manifest.json">Source metadata</a></p>'
        '<p>Mangochi was screened out of this settlement packet because its preview showed agricultural ground '
        'without a clear housing cluster. No prediction, cadastral overlay, human sign-off or holdout designation '
        'is included.</p>'
        + ''.join(cards)
        + '</html>'
    )
    (ROOT / 'review.html').write_text(page)
    print(f'Rendered {len(cards)} unlabelled crop cards.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=HERE / 'output/target-review-v1')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--fetch', action='store_true')
    action.add_argument('--render', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.fetch:
        fetch_previews(args.output)
        fetch_windows(args.output)
    else:
        render(args.output)


if __name__ == '__main__':
    main()
