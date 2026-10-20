"""Source-anchored private refinement; never changes the original model or response.

prepare polygonizes original architectural linework (no envelope/buffer); apply
uses a separately checkpointed semantic audit, and keeps all source wall solids.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parents[1] / 'logs/stanovanje-plus-ten-20261019'
LAYERS = {'input|nosiva_konstrukcija', 'input|nenosivi_zidovi',
          'input|prozori+balkonska_vrata', 'input|tanko+pogled'}


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def polygons(g):
    if g.geom_type == 'Polygon':
        return [g]
    return [p for child in getattr(g, 'geoms', []) for p in polygons(child)]


def rings(g):
    return [{'outer': list(p.exterior.coords)[:-1],
             'holes': [list(r.coords)[:-1] for r in p.interiors]} for p in polygons(g)]


def geometry(data):
    return unary_union([Polygon(p['outer'], p['holes']) for p in data])


def source_walls(evidence, reading):
    result = []
    for p in evidence['paths']:
        if p['id'] in reading['excludePathIds']:
            continue
        filled = p['layer'] in reading['wallFillLayers'] and p['fill'] != 'none'
        outlined = p['layer'] in reading['wallClosedOutlineLayers']
        if not filled and not outlined:
            continue
        for s in p['subpaths']:
            if len(s['points']) < 3 or not filled and not s['closed']:
                continue
            poly = Polygon(s['points'])
            if poly.is_valid and poly.area >= 1e-6:
                result.append(poly)
    return unary_union(result)


def floor_candidate(evidence, decimals):
    """Noded CAD network: close only explicit paths, with recorded quantization."""
    lines = []
    for p in evidence['paths']:
        if p['layer'] not in LAYERS:
            continue
        for s in p['subpaths']:
            pts = [(round(x, decimals), round(y, decimals)) for x, y in s['points']]
            if len(set(pts)) > 1:
                lines.append(LineString(pts + ([pts[0]] if s['closed'] else [])))
    return unary_union(list(polygonize(unary_union(lines))))


def door_candidates(evidence, tolerance=.04):
    """Match a drawn leaf to the two endpoints of its quarter-circle swing.

    A hinge lies at the leaf endpoint equidistant from both arc tips. The
    other leaf endpoint must coincide with one tip, and the whole sampled
    arc must have constant radius. No circle/door is inferred from furniture.
    """
    result, seen = [], set()
    for layer in ['input|vrata', 'input|prozori+balkonska_vrata']:
        subs = [(p['id'] + ':' + str(i), s) for p in evidence['paths'] if p['layer'] == layer
                for i, s in enumerate(p['subpaths'])]
        leaves = [(i, s['points']) for i, s in subs if not s['curved'] and len(s['points']) == 2]
        for arc_id, arc in subs:
            if not arc['curved'] or arc['closed'] or len(arc['points']) < 8:
                continue
            tips = [arc['points'][0], arc['points'][-1]]
            best = None
            for leaf_id, pts in leaves:
                for hinge, opened in [pts, pts[::-1]]:
                    radius = math.dist(hinge, opened)
                    if radius < .2:
                        continue
                    errors = [math.dist(opened, t) for t in tips]
                    if min(errors) > tolerance:
                        continue
                    closed = tips[1 if errors[0] < errors[1] else 0]
                    radial = max(abs(math.dist(hinge, p) - radius) for p in arc['points'])
                    u = [(opened[i] - hinge[i]) / radius for i in [0, 1]]
                    v = [(closed[i] - hinge[i]) / radius for i in [0, 1]]
                    if radial > tolerance or abs(sum(a*b for a, b in zip(u, v))) > .04:
                        continue
                    score = radial + min(errors)
                    if best is None or score < best[0]:
                        best = (score, leaf_id, hinge, closed, opened)
            if best:
                _, leaf_id, hinge, closed, opened = best
                # Leaf gives exact hinge; project closed tip to same radius and
                # orthogonal axis, removing only the CAD arc's <=.04 unit gap.
                dx, dy = opened[0]-hinge[0], opened[1]-hinge[1]
                options = [[hinge[0]-dy, hinge[1]+dx], [hinge[0]+dy, hinge[1]-dx]]
                closed = min(options, key=lambda q: math.dist(q, closed))
                key = tuple(round(x, 2) for p in [hinge, closed] for x in p)
                if key in seen:
                    continue
                seen.add(key)
                result.append({'id': 'D'+str(len(result)), 'kind': 'door' if layer == 'input|vrata' else 'glazedDoor',
                               'a': hinge, 'b': closed, 'hinge': hinge, 'openTip': opened,
                               'sourceSubpaths': [leaf_id, arc_id], 'evidence': 'Measured leaf and constant-radius quarter-circle in '+layer})
    return result


def window_candidates(evidence, m):
    result, seen = [], set()
    for p in evidence['paths']:
        if p['layer'] != 'input|prozori+balkonska_vrata':
            continue
        for i, s in enumerate(p['subpaths']):
            if not s['closed'] or s['curved'] or len(s['points']) < 4:
                continue
            poly = Polygon(s['points'])
            if not poly.is_valid or poly.area <= 0:
                continue
            rect = poly.minimum_rotated_rectangle
            pts = list(rect.exterior.coords)[:4]
            edges = [(math.dist(pts[j], pts[(j+1)%4]), j) for j in range(4)]
            width, j = min(edges)
            length = max(edges)[0]
            # A few facade panes are measured skew quadrilaterals rather than
            # rectangles. Their two short opposite edges establish the pane axis
            # directly; a bounding rectangle would reject or shift those panes.
            quad = list(poly.exterior.coords)[:-1]
            if len(quad) == 4:
                pts = quad
                width, j = min((math.dist(pts[k], pts[(k+1)%4]), k) for k in range(4))
                opposite = math.dist(pts[(j+2)%4], pts[(j+3)%4])
                length = min(math.dist(pts[(j+1)%4], pts[(j+2)%4]), math.dist(pts[(j+3)%4], pts[j]))
                if max(width, opposite)*m > .18 or length*m < .25 or length < max(width, opposite)*4 or max(width, opposite) > min(width, opposite)*2:
                    continue
            elif width*m > .18 or length*m < .25 or length < width*4 or poly.area/rect.area < .98:
                continue
            a = [(pts[j][k]+pts[(j+1)%4][k])/2 for k in [0, 1]]
            b = [(pts[(j+2)%4][k]+pts[(j+3)%4][k])/2 for k in [0, 1]]
            a,b = sorted([a,b])
            key = tuple(round(x, 3) for q in [a,b] for x in q)
            if key in seen:
                continue
            seen.add(key)
            result.append({'id': 'W'+str(len(result)), 'kind': 'window', 'a': a, 'b': b,
                           'sourceSubpaths': [p['id']+':'+str(i)],
                           'evidence': 'Axis between short-edge midpoints of measured thin glazing contour in input|prozori+balkonska_vrata'})
    return result


def preserve_candidate_ids(previous, current):
    """Semantic receipts refer to IDs: never renumber an existing source anchor."""
    known = {tuple(o['sourceSubpaths']): o['id'] for o in previous}
    next_id = {prefix: 1 + max([int(o['id'][1:]) for o in previous if o['id'].startswith(prefix)], default=-1) for prefix in ['D', 'W']}
    for o in current:
        key = tuple(o['sourceSubpaths'])
        if key in known:
            o['id'] = known[key]
        else:
            prefix = 'D' if 'hinge' in o else 'W'
            o['id'] = prefix + str(next_id[prefix]); next_id[prefix] += 1
    return current


def prepare(root, code):
    d = root/code
    e = json.loads((d/'evidence.json').read_text())
    old = json.loads((d/'response.json').read_text())['data']
    model = json.loads((d/'model.json').read_text())
    m = model['source']['metersPerSourceUnit']
    decimals = 1 if code == '10839im' else 2
    candidate = floor_candidate(e, decimals)
    # The selected three have a single evidenced outer silhouette. Do not
    # silently bridge distinct buildings or inset drawings.
    large = [p for p in polygons(candidate) if p.area*m*m > 2]
    if len(large) != 1:
        raise ValueError(f'{code}: {len(large)} detached floor components; needs explicit source-region selection')
    floor = large[0]
    walls = source_walls(e, old)
    floor = unary_union([floor, walls])
    cs = {'schema': 'stanovanje-plus.refinement-candidates.v1', 'code': code,
          'originalResponseSha256': hashlib.sha256((d/'response.json').read_bytes()).hexdigest(),
          'originalModelSha256': hashlib.sha256((d/'model.json').read_bytes()).hexdigest(),
          'floor': rings(floor), 'floorBasis': 'Polygonized source architectural line network, union original measured wall solids; no hull or buffer',
          'coordinateQuantizationSourceUnits': 10**-decimals,
          'maxCoordinateShiftM': math.sqrt(2)*(.5*10**-decimals)*m,
          'metersPerSourceUnit': m, 'originalScale': old['scale'],
          'openings': door_candidates(e)+window_candidates(e,m),
          'verticalCirculationContours': [{'id': p['id']+':'+str(i), 'points': s['points']}
              for p in e['paths'] if 'komunikacije_vertikalne' in p['layer'] and p['fill'] != 'none'
              for i,s in enumerate(p['subpaths']) if len(s['points'])>2],
          'sourceVertices': sorted({tuple(q) for p in e['paths'] if p['layer'] in LAYERS
                                    for s in p['subpaths'] for q in s['points']})}
    if (d/'refinement-candidates.json').exists():
        previous=json.loads((d/'refinement-candidates.json').read_text())
        cs['openings']=preserve_candidate_ids(previous['openings'],cs['openings'])
    write(d/'refinement-candidates.json',cs)
    # Overlay stays in source viewBox for visual side-by-side review and model audit.
    svg = (d/'source.svg').read_text().replace('style="mix-blend-mode:darken"','')
    overlay = ''
    for p in cs['floor']:
        pts=p['outer']; overlay += '<polygon points="'+' '.join(f'{x},{y}' for x,y in pts)+'" fill="#13b9a8" fill-opacity=".12" stroke="#009e8c" stroke-width=".18"/>'
    for o in cs['openings']:
        a,b=o['a'],o['b']; color='#c26424' if o['id'].startswith('D') else '#007ab5'
        overlay += f'<path d="M{a[0]} {a[1]}L{b[0]} {b[1]}" stroke="{color}" stroke-width=".3"/><text x="{(a[0]+b[0])/2}" y="{(a[1]+b[1])/2}" fill="{color}" font-size="1.5">{o["id"]}</text>'
    frame=json.loads((d/'frame.json').read_text())
    import re
    svg=re.sub('viewBox="[^"]+"','viewBox="'+' '.join(map(str,frame))+'"',svg)
    svg=re.sub('width="[^"]+"','width="2000"',svg,count=1)
    svg=re.sub('height="[^"]+"',f'height="{round(2000*frame[3]/frame[2])}"',svg,count=1)
    (d/'refinement-overlay.svg').write_text(svg.replace('</svg>',overlay+'</svg>'))
    print(code, 'prepared',len(cs['openings']),'openings',round(floor.area*m*m,2),'m2')


def apply(root, code):
    d=root/code
    cs=json.loads((d/'refinement-candidates.json').read_text())
    receipt=json.loads((d/'refinement-response.json').read_text()); audit=receipt['data']
    if audit['code'] != code or not audit['acceptFloor']:
        raise ValueError('Semantic audit rejected candidate floor')
    for filename,key in [('response.json','originalResponseSha256'),('model.json','originalModelSha256')]:
        if hashlib.sha256((d/filename).read_bytes()).hexdigest()!=cs[key]:
            raise ValueError('Original checkpoint changed: '+filename)
    e=json.loads((d/'evidence.json').read_text()); reading=json.loads((d/'response.json').read_text())['data']
    model=json.loads((d/'model.json').read_text()); m=cs['metersPerSourceUnit']
    floor=geometry(cs['floor']); walls=source_walls(e,reading)
    voids=[]
    # No freehand ungrounded voids: every vertex must identify a measured source
    # vertex within CAD line tolerance; walls may never be removed to fit one.
    vertices=cs['sourceVertices']
    for v in audit['voids']:
        snapped=[]
        for p in v['ring']:
            q=min(vertices,key=lambda q:math.dist(p,q))
            if math.dist(p,q)>.12:raise ValueError('Void vertex is not anchored to source linework')
            snapped.append(q)
        hole=Polygon(snapped)
        if not hole.is_valid or hole.area*m*m<.05:raise ValueError('Invalid void')
        if hole.intersection(walls).area*m*m>.03:raise ValueError('Void would remove genuine source wall material')
        if not floor.covers(hole):raise ValueError('Void outside floor')
        voids.append(hole)
    floor_envelope=floor
    if voids:floor=floor.difference(unary_union(voids))
    xmin,ymin,xmax,ymax=unary_union([floor,walls]).bounds; w,h=xmax-xmin,ymax-ymin
    def uv(p):return [round((p[0]-xmin)/w,8),round((p[1]-ymin)/h,8)]
    def norm(g):return [[[uv(q) for q in p['outer']]]+[ [uv(q) for q in ring] for ring in p['holes']] for p in rings(g)]
    rejected=set(audit['rejectOpeningIds']); available={o['id'] for o in cs['openings']}
    if not rejected<=available:raise ValueError('Unknown rejected opening')
    kinds={o['id']:o['kind'] for o in audit['openingKinds']}
    if not kinds.keys()<=available:raise ValueError('Unknown opening kind override')
    a=model['architecture']; openings=[]; omitted=[]
    for o in cs['openings']:
        if o['id'] in rejected:continue
        line=LineString([o['a'],o['b']]); length=line.length*m
        # Window material/jamb overlap is rejected, never fixed by deleting walls.
        interior=LineString([line.interpolate(.05,normalized=True),line.interpolate(.95,normalized=True)])
        overlap=interior.intersection(walls).length*m
        if overlap>.04:
            omitted.append({'id':o['id'],'reason':'source wall overlap','overlapM':round(overlap,4)});continue
        if not floor.buffer(.001/m).covers(line):
            omitted.append({'id':o['id'],'reason':'outside selected slab'});continue
        kind=kinds.get(o['id'],o['kind'])
        opening={'kind':kind,'a':uv(o['a']),'b':uv(o['b']),'depthM':.12,'sillM':.9 if kind=='window' else 0,'heightM':1.4 if kind=='window' else 2.1,'sourceCandidateId':o['id'],'sourceSubpaths':o['sourceSubpaths']}
        if kind=='door':
            if 'hinge' not in o:raise ValueError('No measured hinge for door override')
            opening.update(hinge=uv(o['hinge']),openTip=uv(o['openTip']))
        openings.append(opening)
    a.update(dimensionsM=[round(w*m,5),round(h*m,5)],walls=norm(walls),slabs=norm(floor),openings=openings,stairs=[])
    for s in audit['stairs']:
        # Flights retain an explicit semantic reading and estimated vertical rise.
        if not floor_envelope.covers(LineString([s['a'],s['b']])):raise ValueError('Stair flight outside floor')
        a['stairs'].append({k:s[k] for k in ['widthM','steps','fromM','toM']}|{'a':uv(s['a']),'b':uv(s['b'])})
    model['source'].update(sourceFrame=[xmin,ymin,w,h],sourceFootprint=rings(floor),footprintEvidence=cs['floorBasis'],refinementVoids=audit['voids'])
    # Preserve the raw audit as dated input evidence. Current model issues must
    # not claim that a successful apply or an expanded evidence crop is missing.
    current_issues=[issue for issue in audit['issues']
        if not ('uncut candidate fills' in issue.lower() and voids and a['stairs'])
        and not ('supplied crop' in issue.lower() and ('distal edge' in issue.lower() or 'distal boundary' in issue.lower()))]
    model['provenance'].update(processor='stanovanje-plus-private-refinement-v1',model=receipt['model'],effort='high',reviewStatus='semantic-audit-awaiting-visual-review',
        coverage='Source-derived exterior slab and measured wall/opening anchors with source-audited voids and observed stair flights; unresolved reconstruction limits are recorded in issues.',
        semanticAudit={'schema':audit['schema'],'coverage':audit['coverage'],'issues':audit['issues'],'receipt':'refinement-response.json'},
        evidenceCropBasis='Full original SVG floor extent; expanded evidence crop and prior audit crop recorded by refinement-render.json')
    model['issues']=current_issues+['Private local drawing: no verified geographic placement, orientation or elevation.', 'Printed source scale retained from original reading; vertical dimensions estimated.', f'Source line network quantized to {cs["coordinateQuantizationSourceUnits"]} source units (maximum coordinate shift {cs["maxCoordinateShiftM"]:.4f} m); original measured walls retained.', 'Balcony and stair railings, lift cabins and detailed landing transitions are not reconstructed.', 'Glazing layer coverage is partial where source symbols are open contours; no glazing is invented on thin-view balcony railing lines.', 'Room labels and inferred geographic metadata are not supplied.']
    model['accounting']={'original':model.get('accounting'),'refinement':{k:receipt.get(k) for k in ['model','usage','equivalentUsd','costUsd','ms','raw']}}
    model['extraction'].update(footprintAreaM2=round(floor.area*m*m,2),wallAreaM2=round(walls.area*m*m,2),wallFraction=round(walls.area/floor.area,4),wallPolygons=len(polygons(walls)),wallOutsideSlabFraction=round(walls.difference(floor).area/walls.area,8),sourceAnchoredOpenings=len(openings),doorCount=sum(o['kind']=='door' for o in openings),windowCount=sum(o['kind']=='window' for o in openings),refinementOmittedOpenings=omitted,refinementVoidCount=len(voids),stairs=len(a['stairs']))
    write(d/'model.refined.json',model)
    write(d/'refinement-geometry.json',{'code':code,'extraction':model['extraction'],'semanticAudit':audit,'originalResponseSha256':cs['originalResponseSha256'],'originalModelSha256':cs['originalModelSha256']})
    print(code,'applied',len(openings),'openings',len(voids),'voids',len(a['stairs']),'stairs','omitted',omitted)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','apply'])
    parser.add_argument('codes',nargs='+')
    parser.add_argument('--root',type=Path,default=ROOT)
    args=parser.parse_args()
    for code in args.codes:
        if code not in {s['code'] for s in json.loads((args.root/'selection.json').read_text())}:raise ValueError('Source outside original ten')
        (prepare if args.action=='prepare' else apply)(args.root,code)


if __name__=='__main__':main()
