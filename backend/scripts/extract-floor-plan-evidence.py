#!/usr/bin/env python3
"""Find deterministic wall and alternating scale-bar candidates in a clean plan raster."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


MAX_CANDIDATES = 500
MAX_SCALE_STRIPS = 8
MAX_ANNOTATION_SIDE = 1568
MAX_ANNOTATION_AREA = 1_050_000


def components(mask, min_area=40):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    found = []
    for label in range(1, count):
        x, y, w, h, area = map(int, stats[label])
        if area >= min_area:
            found.append((x, y, w, h, area, labels[y:y+h, x:x+w] == label))
    return found


def axis_candidates(gray):
    dark = (gray < 150).astype(np.uint8) * 255
    candidates = []
    for orientation, kernel in [('H', (19, 3)), ('V', (3, 19))]:
        opened = cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, kernel))
        for x, y, w, h, area, component in components(opened):
            along, across = (w, h) if orientation == 'H' else (h, w)
            if across == 0 or along / across > 200:
                continue
            ys, xs = np.where(component)
            if not len(xs):
                continue
            if orientation == 'H':
                lo, hi = int(x + xs.min()), int(x + xs.max())
                mids, thicknesses = [], []
                for col in range(lo, hi + 1):
                    rows = np.flatnonzero(gray[max(0, y-2):min(gray.shape[0], y+h+2), col] < 150)
                    if len(rows):
                        mids.append(float(np.median(rows + max(0, y-2))))
                        thicknesses.append(float(rows.max() - rows.min() + 1))
                if len(mids) < max(3, int((hi-lo+1)*.5)):
                    continue
                center = float(np.median(mids)); thick = float(np.median(thicknesses))
                item = {'orientation': 'H', 'a': [lo, round(center, 2)], 'b': [hi, round(center, 2)],
                        'widthPx': round(thick, 2), 'bounds': [lo, int(y), hi, int(y+h-1)]}
            else:
                lo, hi = int(y + ys.min()), int(y + ys.max())
                mids, thicknesses = [], []
                for row in range(lo, hi + 1):
                    cols = np.flatnonzero(gray[row, max(0, x-2):min(gray.shape[1], x+w+2)] < 150)
                    if len(cols):
                        mids.append(float(np.median(cols + max(0, x-2))))
                        thicknesses.append(float(cols.max() - cols.min() + 1))
                if len(mids) < max(3, int((hi-lo+1)*.5)):
                    continue
                center = float(np.median(mids)); thick = float(np.median(thicknesses))
                item = {'orientation': 'V', 'a': [round(center, 2), lo], 'b': [round(center, 2), hi],
                        'widthPx': round(thick, 2), 'bounds': [int(x), lo, int(x+w-1), hi]}
            candidates.append(item)
    candidates.sort(key=lambda c: (c['orientation'], c['a'][1], c['a'][0], c['b'][1], c['b'][0]))
    return candidates


def scale_candidates(gray):
    pale = (gray < 225).astype(np.uint8) * 255
    opened = cv2.morphologyEx(pale, cv2.MORPH_OPEN,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (21, 1)))
    bars = []
    for x, y, w, h, area, _ in components(opened, min_area=8):
        if h <= 3 and w >= 8:
            bars.append((x, y + (h-1)/2, w))
    bars.sort(key=lambda b: (b[1], b[0]))
    groups = []
    used = set()
    for i, first in enumerate(bars):
        if i in used:
            continue
        group = [first]
        for j in range(i+1, len(bars)):
            bar = bars[j]
            prev = group[-1]
            if abs(bar[1]-first[1]) > 2:
                if bar[1] > first[1] + 2:
                    break
                continue
            gap = bar[0] - (prev[0] + prev[2])
            if (abs(bar[2]-first[2]) <= first[2]*.20 and
                    .75*first[2] <= gap <= 1.25*first[2]):
                group.append(bar)
        if len(group) >= 3:
            groups.append(group)
            used.update(bars.index(b) for b in group)
    results = []
    for group in groups:
        start = group[0][0]
        end = group[-1][0] + group[-1][2] - 1
        results.append({'a': [int(start), round(float(np.median([b[1] for b in group])), 2)],
                        'b': [int(end), round(float(np.median([b[1] for b in group])), 2)],
                        'intervals': len(group)*2-1})
    # Equal endpoints from overlapping runs are one candidate.
    unique = {}
    for item in results:
        unique[(item['a'][0], item['a'][1], item['b'][0], item['b'][1])] = item
    return list(unique.values())


def extract_evidence(image_path, evidence_path, annotation_path, scale_annotation_path=None):
    source = Image.open(image_path).convert('RGB')
    rgb = np.asarray(source)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    height, width = gray.shape
    photo_like = float(np.mean(gray < 150)) > .25
    walls = [] if photo_like else axis_candidates(gray)
    scales = [] if photo_like else scale_candidates(gray)
    truncated = len(walls) > MAX_CANDIDATES
    walls = walls[:MAX_CANDIDATES]
    for i, candidate in enumerate(walls, 1):
        candidate['id'] = f'W{i}'
        del candidate['orientation'], candidate['bounds']
    for i, candidate in enumerate(scales, 1):
        candidate['id'] = f'S{i}'
    issues = []
    if photo_like:
        issues.append('Raster is photo-like or broadly dark; candidate extraction is inconclusive.')
    if truncated:
        issues.append(f'Wall candidates truncated to {MAX_CANDIDATES}.')
    if not walls:
        issues.append('No confident orthogonal wall candidates were found; evidence is inconclusive.')
    evidence = {'version': 'floor-plan-evidence-v1', 'widthPx': width, 'heightPx': height,
                'wallCandidates': walls, 'scaleCandidates': scales, 'issues': issues,
                'candidateFramePx': candidate_frame(walls, width, height)}
    Path(evidence_path).write_text(json.dumps(evidence, separators=(',', ':')) + '\n', encoding='utf8')
    annotate(source, walls, scales, annotation_path)
    summary = {'widthPx': width, 'heightPx': height, 'wallCandidateCount': len(walls),
            'scaleCandidateCount': len(scales), 'truncated': truncated, 'issues': issues,
            'evidencePath': str(evidence_path), 'annotationPath': str(annotation_path)}
    if scale_annotation_path:
        extra = annotate_scale_strips(source, scales, scale_annotation_path)
        summary.update(scaleAnnotationPath=extra['path'], scaleStrips=extra['scaleStrips'])
        summary['issues'].extend(extra['issues'])
    return summary


def annotate_scale_strips(source, scales, path):
    """Make separately labeled source crops so scale IDs need no page-coordinate guessing."""
    strips = []
    for scale in scales[:MAX_SCALE_STRIPS]:
        x0 = max(0, int(np.floor(min(scale['a'][0], scale['b'][0]) - 30)))
        y0 = max(0, int(np.floor(min(scale['a'][1], scale['b'][1]) - 24)))
        x1 = min(source.width, int(np.ceil(max(scale['a'][0], scale['b'][0]) + 30)) + 1)
        y1 = min(source.height, int(np.ceil(max(scale['a'][1], scale['b'][1]) + 24)) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        strips.append({'id': scale['id'], 'crop': source.crop((x0, y0, x1, y1)),
                       'sourceCropPx': [x0, y0, x1-x0, y1-y0]})
    if not strips:
        Image.new('RGB', (1, 1), 'white').save(path)
        return {'path': str(path), 'scaleStripIds': [], 'scaleStrips': [], 'issues': []}
    # Enlarge the source details twice, then reduce only as needed to fit output caps.
    widths = [s['crop'].width * 2 for s in strips]
    heights = [s['crop'].height * 2 + 30 for s in strips]
    base_width, base_height = max(widths), sum(heights)
    factor = min(1.0, MAX_ANNOTATION_SIDE/max(base_width, base_height),
                 (MAX_ANNOTATION_AREA/(base_width*base_height))**.5)
    resized = []
    for strip in strips:
        width = max(1, round(strip['crop'].width*2*factor))
        height = max(1, round(strip['crop'].height*2*factor))
        resized.append(strip['crop'].resize((width, height), Image.Resampling.LANCZOS))
    band = 22
    output_width = max(image.width for image in resized)
    output_height = sum(image.height + band for image in resized)
    # The added fixed-size label bands still obey the hard canvas caps.
    if output_width*output_height > MAX_ANNOTATION_AREA or max(output_width, output_height) > MAX_ANNOTATION_SIDE:
        fit = min(MAX_ANNOTATION_SIDE/max(output_width, output_height),
                  (MAX_ANNOTATION_AREA/(output_width*output_height))**.5)
        resized = [im.resize((max(1,round(im.width*fit)),max(1,round(im.height*fit))), Image.Resampling.LANCZOS) for im in resized]
        band = max(16, round(band*fit))
        output_width = max(im.width for im in resized)
        output_height = sum(im.height+band for im in resized)
    canvas = Image.new('RGB', (output_width, output_height), 'white')
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype('DejaVuSans.ttf', size=16)
    except OSError:
        font = ImageFont.load_default(size=16)
    y = 0
    metadata = []
    for strip, crop in zip(strips, resized):
        draw.text((6, y+2), strip['id'], fill=(0, 70, 210), font=font)
        y += band
        canvas.paste(crop, (0, y))
        y += crop.height
        metadata.append({'id': strip['id'], 'sourceCropPx': strip['sourceCropPx']})
    canvas.save(path)
    issues = []
    if len(scales) > MAX_SCALE_STRIPS:
        issues.append(f'Scale annotation strips truncated to {MAX_SCALE_STRIPS} of {len(scales)} candidates.')
    return {'path': str(path), 'scaleStripIds': [s['id'] for s in strips],
            'scaleStrips': metadata, 'issues': issues, 'sizePx': list(canvas.size)}


def candidate_frame(walls, width, height):
    if not walls:
        return [0, 0, width, height]
    halfwidths = [float(wall.get('widthPx', 0))/2 for wall in walls]
    left = min(min(w['a'][0], w['b'][0])-pad for w, pad in zip(walls, halfwidths))
    top = min(min(w['a'][1], w['b'][1])-pad for w, pad in zip(walls, halfwidths))
    right = max(max(w['a'][0], w['b'][0])+pad for w, pad in zip(walls, halfwidths))
    bottom = max(max(w['a'][1], w['b'][1])+pad for w, pad in zip(walls, halfwidths))
    x0, y0 = max(0, int(np.floor(left))), max(0, int(np.floor(top)))
    x1, y1 = min(width, int(np.ceil(right))+1), min(height, int(np.ceil(bottom))+1)
    return [x0, y0, max(0, x1-x0), max(0, y1-y0)]


def annotate(source, walls, scales, path, opening_candidates=None, outline_corners=None):
    opening_candidates = opening_candidates or []
    outline_corners = outline_corners or []
    geometry_boxes = []
    for wall in walls:
        pad = float(wall.get('widthPx', 0))/2
        geometry_boxes.append((min(wall['a'][0], wall['b'][0])-pad, min(wall['a'][1], wall['b'][1])-pad,
                                 max(wall['a'][0], wall['b'][0])+pad, max(wall['a'][1], wall['b'][1])+pad))
    for item in opening_candidates:
        geometry_boxes.append((min(item['a'][0], item['b'][0]), min(item['a'][1], item['b'][1]),
                              max(item['a'][0], item['b'][0]), max(item['a'][1], item['b'][1])))
    if outline_corners:
        geometry_boxes.extend((point[0], point[1], point[0], point[1]) for point in outline_corners)
    # Scale bars can be far from the drawing. Include them only as a fallback when
    # there is no wall/opening geometry to frame.
    boxes = geometry_boxes or [(min(s['a'][0], s['b'][0]), min(s['a'][1], s['b'][1]),
                                max(s['a'][0], s['b'][0]), max(s['a'][1], s['b'][1])) for s in scales]
    if boxes:
        pad = 24
        left = max(0, int(min(b[0] for b in boxes)-pad)); top = max(0, int(min(b[1] for b in boxes)-pad))
        right = min(source.width, int(max(b[2] for b in boxes)+pad+1)); bottom = min(source.height, int(max(b[3] for b in boxes)+pad+1))
    else:
        left, top, right, bottom = 0, 0, source.width, source.height
    crop = source.crop((left, top, right, bottom))
    # Enlarge for model readability, with both long-edge and area bounds.
    scale_factor = min(2.0, 1568/max(crop.size), (1_050_000/(crop.width*crop.height))**.5)
    if abs(scale_factor-1) > 1e-6:
        crop = crop.resize((max(1, round(crop.width*scale_factor)), max(1, round(crop.height*scale_factor))), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(crop)
    try:
        font = ImageFont.truetype('DejaVuSans.ttf', size=16)
    except OSError:
        font = ImageFont.load_default(size=16)
    def local(point):
        return ((point[0]-left)*scale_factor, (point[1]-top)*scale_factor)
    for wall in walls:
        a, b = local(wall['a']), local(wall['b'])
        draw.line((a, b), fill=(255, 0, 180), width=2)
        mid = ((a[0]+b[0])/2+4, (a[1]+b[1])/2+4)
        draw.text(mid, wall['id'], fill=(255, 0, 180), font=font, stroke_width=1, stroke_fill='white')
    def intersects(item):
        x0, y0 = item['a']; x1, y1 = item['b']
        return not (max(x0, x1) < left or min(x0, x1) > right or
                    max(y0, y1) < top or min(y0, y1) > bottom)
    for item in scales:
        if not intersects(item):
            continue
        a, b = local(item['a']), local(item['b'])
        draw.line((a, b), fill=(0, 120, 255), width=2)
        draw.text((a[0]+3, a[1]+3), item['id'], fill=(0, 80, 255), font=font, stroke_width=1, stroke_fill='white')
    for gap in opening_candidates:
        a, b = local(gap['a']), local(gap['b'])
        draw.line((a, b), fill=(255, 145, 0), width=2)
        mid = ((a[0]+b[0])/2+4, (a[1]+b[1])/2+4)
        draw.text(mid, gap['id'], fill=(230, 110, 0), font=font, stroke_width=1, stroke_fill='white')
    for i, point in enumerate(outline_corners[:4]):
        p = local(point)
        draw.ellipse((p[0]-3, p[1]-3, p[0]+3, p[1]+3), fill=(0, 150, 0), outline='white')
        draw.text((p[0]+5, p[1]+5), f'F{i}', fill=(0, 130, 0), font=font, stroke_width=1, stroke_fill='white')
    draw.text((4, 4), f'CANDIDATE CROP; coordinates refer to source image [{left},{top}]',
              fill=(0, 0, 0), font=font, stroke_width=1, stroke_fill='white')
    crop.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', help='clean rendered source PNG')
    parser.add_argument('--evidence', help='output evidence JSON path for normal extraction')
    parser.add_argument('--annotation', required=True, help='output annotated candidate crop PNG')
    parser.add_argument('--annotate-evidence', help='render annotations from an existing evidence JSON')
    parser.add_argument('--scale-annotation', help='optional compact, labeled scale-candidate source strips PNG')
    args = parser.parse_args()
    if args.annotate_evidence:
        source = Image.open(args.image).convert('RGB')
        data = json.loads(Path(args.annotate_evidence).read_text(encoding='utf8'))
        if [source.width, source.height] != [data.get('widthPx'), data.get('heightPx')]:
            parser.error('annotation image dimensions do not match evidence JSON')
        annotate(source, data.get('wallCandidates', []), data.get('scaleCandidates', []), args.annotation,
                 data.get('openingCandidates', []), data.get('outlineCorners', []))
        summary = {'annotationPath': args.annotation, 'wallCandidateCount': len(data.get('wallCandidates', [])),
                   'openingCandidateCount': len(data.get('openingCandidates', [])), 'mode': 'annotate-evidence'}
        if args.scale_annotation:
            extra = annotate_scale_strips(source, data.get('scaleCandidates', []), args.scale_annotation)
            summary.update(scaleAnnotationPath=extra['path'], scaleStripIds=extra['scaleStripIds'],
                           scaleStrips=extra['scaleStrips'], issues=extra['issues'])
    else:
        if not args.evidence:
            parser.error('--evidence is required unless --annotate-evidence is provided')
        summary = extract_evidence(args.image, args.evidence, args.annotation, args.scale_annotation)
    print(json.dumps(summary, separators=(',', ':')))


if __name__ == '__main__':
    main()
