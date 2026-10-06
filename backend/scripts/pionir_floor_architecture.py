"""Recover architectural solids from Pionir's CAD insets, with explicit inferred heights.

The input is reviewed PDF vector geometry. Closed narrow CAD regions define walls;
quarter-circle symbols locate operable openings; repeated tread lines locate stairs.
No room is inferred from furniture strokes, and the original vectors remain evidence.
Requires PyMuPDF and Shapely 2.x.
"""
import math
from statistics import median
import pymupdf as pdf
from shapely.geometry import Point, LineString, Polygon, box
from shapely.ops import unary_union, polygonize
from shapely import set_precision


def pieces(geometry, kind):
    if geometry.is_empty:
        return []
    if geometry.geom_type == kind:
        return [geometry]
    return [part for child in getattr(geometry, 'geoms', []) for part in pieces(child, kind)]


def add(a, b, scale=1):
    return (a[0] + b[0] * scale, a[1] + b[1] * scale)


def unit(a, b):
    length = math.dist(a, b)
    return ((b[0] - a[0]) / length, (b[1] - a[1]) / length)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def strip(a, b, width):
    direction = unit(a, b)
    normal = (-direction[1], direction[0])
    return Polygon([add(a, normal, width / 2), add(b, normal, width / 2),
                    add(b, normal, -width / 2), add(a, normal, -width / 2)])


def read_cad(path, source, gray, scale):
    crop = pdf.Rect(source['crop'])
    width, height = crop.width * scale, crop.height * scale
    frame = box(0, 0, width, height)
    lines, closed, arcs, arrows = [], [], [], []
    with pdf.open(path) as doc:
        page = doc[source['page'] - 1]
        def point(value):
            p = value * page.rotation_matrix
            return (round((p.x - crop.x0) * scale, 3), round((p.y - crop.y0) * scale, 3))
        for drawing in page.get_drawings():
            bounds = drawing['rect'] * page.rotation_matrix
            if (drawing['type'] != 's' or not drawing['color']
                    or any(abs(c - gray) > .005 for c in drawing['color'])
                    or bounds.x1 < crop.x0 or bounds.x0 > crop.x1
                    or bounds.y1 < crop.y0 or bounds.y0 > crop.y1):
                continue
            items = drawing['items']
            straight, curved = [], []
            for item in items:
                if item[0] == 'l':
                    straight.append((point(item[1]), point(item[2])))
                elif item[0] == 're':
                    r = item[1]
                    pts = [r.tl, r.tr, r.br, r.bl, r.tl]
                    straight.extend((point(a), point(b)) for a, b in zip(pts, pts[1:]))
                elif item[0] == 'qu':
                    q = item[1]
                    pts = [q.ul, q.ur, q.lr, q.ll, q.ul]
                    straight.extend((point(a), point(b)) for a, b in zip(pts, pts[1:]))
                elif item[0] == 'c':
                    control = [point(p) for p in item[1:]]
                    pts = []
                    for i in range(17):
                        t = i / 16
                        weights = [(1-t)**3, 3*t*(1-t)**2, 3*t*t*(1-t), t**3]
                        pts.append(tuple(sum(control[j][axis] * weights[j] for j in range(4)) for axis in [0, 1]))
                    curved.extend(zip(pts, pts[1:]))
            for a, b in straight + curved:
                if a != b:
                    lines.extend(pieces(LineString([a, b]).intersection(frame), 'LineString'))
            if not curved and straight:
                network = unary_union([LineString([a, b]) for a, b in straight if a != b])
                closed.extend(p for poly in polygonize(network)
                              for p in pieces(poly.intersection(frame), 'Polygon') if p.area > .01)
            # A source door/casement swing is a quarter-circle bounded by two short tangents.
            if tuple(i[0] for i in items) == ('l', 'c', 'l'):
                a, b = point(items[0][1]), point(items[-1][2])
                rx, ry = abs(a[0] - b[0]), abs(a[1] - b[1])
                if .38 <= rx <= 1.6 and abs(rx - ry) < .05:
                    c = [point(p) for p in items[1][1:]]
                    mid = tuple((c[0][i] + 3*c[1][i] + 3*c[2][i] + c[3][i]) / 8 for i in [0, 1])
                    hinge = max([(a[0], b[1]), (b[0], a[1])], key=lambda h: math.dist(h, mid))
                    if frame.covers(Point(hinge)):
                        arcs.append({'hinge': hinge, 'ends': [a, b], 'radius': (rx + ry) / 2})
            if source.get('standaloneSwingArcs') and len(items) == 1 and items[0][0] == 'c':
                c = [point(p) for p in items[0][1:]]
                a,b = c[0],c[-1]
                rx,ry = abs(a[0]-b[0]),abs(a[1]-b[1])
                if .38 <= rx <= 1.6 and abs(rx-ry) < .05:
                    mid = tuple((c[0][i]+3*c[1][i]+3*c[2][i]+c[3][i])/8 for i in [0,1])
                    hinge = max([(a[0],b[1]),(b[0],a[1])],key=lambda h: math.dist(h,mid))
                    arcs.append({'hinge':hinge,'ends':[a,b],'radius':(rx+ry)/2})
            # C1 exports circular swings as short polylines instead of Beziers.
            if 4 <= len(items) <= 24 and all(item[0] == 'l' for item in items):
                pts = [point(items[0][1])] + [point(item[2]) for item in items]
                continuous = all(math.dist(point(a[2]), point(b[1])) < .004 for a,b in zip(items,items[1:]))
                a,b = pts[0],pts[-1]
                rx,ry = abs(a[0]-b[0]),abs(a[1]-b[1])
                if continuous and .38 <= rx <= 1.6 and abs(rx-ry)<.05:
                    hinge = max([(a[0],b[1]),(b[0],a[1])],key=lambda h:math.dist(h,pts[len(pts)//2]))
                    radius = (rx+ry)/2
                    if all(abs(math.dist(hinge,p)-radius)<.055 for p in pts):
                        arcs.append({'hinge':hinge,'ends':[a,b],'radius':radius})
            # An arrow may share a path with the small marker at the shaft's tail.
            if len(items) >= 2 and items[0][0] == 'qu':
                shafts = [item for item in items[1:] if item[0] == 'l']
                if not shafts:
                    continue
                shaft = max(shafts,key=lambda item:math.dist(point(item[1]),point(item[2])))
                near, tail = point(shaft[1]), point(shaft[2])
                if 1 <= math.dist(near, tail) <= 5:
                    arrows.append((tail, near))
    # Reviewed runs without printed arrows are explicit authoring annotations in
    # the source manifest; repeated source tread lines still determine their shape.
    for axis in source.get('reviewedStairAxes', []):
        arrows.append(tuple((p[0]*width,p[1]*height) for p in [axis['a'],axis['b']]))
    if source.get('wallExtraction') == 'orthogonal-network':
        # Some CAD exporters split one wall contour across many PDF paths. Join
        # only straight orthogonal segments, excluding curved door/fixture strokes.
        orthogonal = [line for line in lines if len(line.coords) == 2 and line.length > .01
                      and (abs(line.coords[0][0]-line.coords[-1][0]) < .001
                           or abs(line.coords[0][1]-line.coords[-1][1]) < .001)]
        network = unary_union([set_precision(line, .005) for line in orthogonal])
        closed = [p for p in polygonize(network) if p.area > .01]
    # Repeated source paths sometimes retrace an edge; union removes those duplicates.
    return width, height, frame, lines, closed, arcs, arrows


def find_stairs(lines, arrows, storey_height):
    def flight_at(tail, tip):
        direction = unit(tail, tip)
        normal = (-direction[1], direction[0])
        length = math.dist(tail, tip)
        treads = []
        for line in lines:
            a, b = line.coords[0], line.coords[-1]
            if not .65 <= math.dist(a, b) <= 3:
                continue
            relative_a = (a[0]-tail[0], a[1]-tail[1])
            relative_b = (b[0]-tail[0], b[1]-tail[1])
            along_a, along_b = dot(relative_a, direction), dot(relative_b, direction)
            across = sorted([dot(relative_a, normal), dot(relative_b, normal)])
            if abs(along_a - along_b) < .008 and -.4 <= along_a <= length + .4 and across[0] < -.2 and across[1] > .2:
                treads.append((along_a, across[0], across[1]))
        locations = []
        for location in sorted(set(round(t[0], 2) for t in treads)):
            # Two nosing strokes belong to one tread, not two risers.
            if not locations or location - locations[-1] > .09:
                locations.append(location)
        if len(locations) < 5:
            return None
        widths = [t[2] - t[1] for t in treads]
        # Centre on the measured tread endpoints, not on a slightly offset arrow.
        offset = median([(t[1]+t[2])/2 for t in treads])
        centre = add(tail,normal,offset)
        return {'a':add(centre,direction,min(locations)), 'b':add(centre,direction,max(locations)),
                'widthM':round(median(widths),3), 'steps':len(locations), 'fromM':0, 'toM':storey_height/2}

    flights = [flight for tail,tip in arrows if (flight := flight_at(tail,tip))]
    flights.sort(key=lambda f: (round(f['a'][1], 1), round(f['a'][0], 1)))
    paired, landings, voids = set(), [], []
    def centre(f): return tuple((a+b)/2 for a,b in zip(f['a'],f['b']))
    for i, f in enumerate(flights):
        if i in paired:
            continue
        direction = unit(f['a'],f['b'])
        candidates = [(j,g) for j,g in enumerate(flights) if j not in paired and j != i
                      and dot(direction,unit(g['a'],g['b'])) < -.95 and math.dist(centre(f),centre(g)) < 4]
        if not candidates:
            # Ground-floor cut symbols sometimes replace the return-flight arrow.
            # Its repeated tread strokes still establish the adjoining geometry.
            normal = (-direction[1],direction[0])
            for sign in [-1,1]:
                shift = sign*(f['widthM']+.23)
                g = flight_at(add(f['b'],normal,shift),add(f['a'],normal,shift))
                if g and math.dist(centre(f),centre(g)) > f['widthM']*.8:
                    j=len(flights);flights.append(g);candidates.append((j,g));break
        if not candidates:
            # Entrances/service stairs can be a single flight. Preserve their measured
            # run and treads, with an explicitly estimated rise, instead of inventing a
            # return flight or forcing them to connect a complete storey.
            f['toM'] = round(f['steps'] * storey_height / 18, 3)
            paired.add(i)
            voids.append(strip(f['a'],f['b'],f['widthM']))
            continue
        j,g=min(candidates,key=lambda item:math.dist(f['b'],item[1]['a']))
        paired.update([i,j])
        f['fromM'],f['toM']=0,storey_height/2
        g['fromM'],g['toM']=storey_height/2,storey_height
        flight_polys=[strip(x['a'],x['b'],x['widthM']) for x in [f,g]]
        voids.append(unary_union(flight_polys).convex_hull)
        bridge=strip(f['b'],g['a'],.8)
        landings.append(bridge)
    return flights,landings,voids


def floor_outline(lines, frame):
    # Close sub-centimetre CAD joins, then fill the connected drawing's bounded interior.
    ink = unary_union(lines).buffer(.018, join_style='mitre')
    shells = [Polygon(p.exterior) for p in pieces(ink, 'Polygon')]
    merged = unary_union(shells).buffer(.04, join_style='mitre').buffer(-.058, join_style='mitre')
    outlines = [Polygon(p.exterior).intersection(frame) for p in pieces(merged, 'Polygon')]
    large = [p.simplify(.012, preserve_topology=True) for p in outlines if p.area > frame.area * .45]
    if len(large) != 1:
        raise ValueError(f'Expected one closed building outline, found {len(large)}; source review required')
    return large[0]


def interval_parts(geometry, axis):
    return sorted((min(p.coords[0][axis], p.coords[-1][axis]), max(p.coords[0][axis], p.coords[-1][axis]))
                  for p in pieces(geometry, 'LineString') if p.length > .025)


def gap_at(walls, hinge, end, outline):
    axis = 0 if abs(end[0] - hinge[0]) > abs(end[1] - hinge[1]) else 1
    across = 1 - axis
    plane = (hinge[across] + end[across]) / 2
    centre = (hinge[axis] + end[axis]) / 2
    low, high = outline.bounds[axis] - .2, outline.bounds[axis + 2] + .2
    def at(value):
        p = [0, 0]; p[axis] = value; p[across] = plane
        return tuple(p)
    runs = interval_parts(walls.buffer(.024, join_style='mitre').intersection(LineString([at(low), at(high)])), axis)
    before = [r[1] for r in runs if r[1] <= centre + .01]
    after = [r[0] for r in runs if r[0] >= centre - .01]
    if not before or not after:
        return None
    a, b = max(before), min(after)
    if b-a < .4 or b-a > 6.5 or not a-.1 <= hinge[axis] <= b+.1 or not a-.1 <= end[axis] <= b+.1:
        return None
    midpoint = Point(at((a+b)/2))
    # A facade opening runs parallel to its facade. Proximity to a perpendicular
    # side wall must not turn a nearby interior door into a wide window bank.
    border = list(outline.exterior.coords)
    parallel_edges = [LineString([p,q]) for p,q in zip(border,border[1:])
                      if abs(p[across]-q[across]) < .025 and abs(p[axis]-q[axis]) > .4]
    facade_distance = min((midpoint.distance(edge) for edge in parallel_edges),default=math.inf)
    exterior = facade_distance < 2.8
    if not exterior and b-a > 1.9:
        return None
    # Recover the jamb's depth from a perpendicular section just beyond either end.
    sections = []
    for location in [a-.08, b+.08]:
        p, q = list(at(location)), list(at(location))
        p[across] -= .65; q[across] += .65
        options = interval_parts(walls.intersection(LineString([p,q])), across)
        options = [r for r in options if r[0]-.08 <= plane <= r[1]+.08 and .07 <= r[1]-r[0] <= .65]
        if options:
            sections.append(min(options, key=lambda r: abs((r[0]+r[1])/2-plane)))
    depth = median([b-a for a,b in sections]) if sections else .18
    if sections:
        plane = median([(a+b)/2 for a,b in sections])
    # Undo the small join buffer so the frames meet the actual measured jamb faces.
    a, b = a-.024, b+.024
    return {'a': at(a), 'b': at(b), 'depthM': round(depth,3), 'axis':axis, 'exterior':exterior,
            'distance':facade_distance}


def find_openings(walls, arcs, outline, doors_only=False):
    banks = []
    for arc in arcs:
        options = []
        for end in arc['ends']:
            gap = gap_at(walls, arc['hinge'], end, outline)
            if gap and doors_only:
                if math.dist(gap['a'],gap['b']) > 2.4:
                    continue
                gap['exterior'] = False
            if gap:
                width = math.dist(gap['a'],gap['b'])
                # Interior openings fit the swing width; facade banks lie beside the outline.
                score = (gap['distance'] * .4 if gap['exterior'] else 0) + abs(width-arc['radius']) * (0.1 if gap['exterior'] else 1)
                options.append((score,gap,end))
        if not options:
            continue
        _, gap, end = min(options,key=lambda x:x[0])
        other = arc['ends'][1] if end == arc['ends'][0] else arc['ends'][0]
        match = next((g for g in banks if g['axis']==gap['axis']
                      and math.dist(g['a'],gap['a'])<.16 and math.dist(g['b'],gap['b'])<.16),None)
        if match is None:
            match = dict(gap, arcs=[]); banks.append(match)
        match['arcs'].append(dict(arc, closed=end, open=other))
    openings=[]
    for bank in banks:
        a,b=bank['a'],bank['b'];axis=bank['axis'];length=math.dist(a,b)
        direction=unit(a,b)
        if not bank['exterior']:
            arc=min(bank['arcs'],key=lambda d:abs(d['radius']-length))
            openings.append({'kind':'door','a':a,'b':b,'depthM':bank['depthM'], 'sillM':0,'heightM':2.1,
                             'hinge':arc['hinge'],'openTip':arc['open'],'basis':'CAD door swing; inferred head height'})
            continue
        # Operable facade leaves have actual swing symbols. Fixed glazing fills the rest
        # of the same measured jamb-to-jamb bank, with an explicitly assumed sill height.
        cuts=[]
        for arc in bank['arcs']:
            ends=sorted([arc['hinge'][axis]-a[axis],arc['closed'][axis]-a[axis]])
            lo,hi=max(0,ends[0]),min(length,ends[1])
            if hi-lo>.35:
                cuts.append((lo,hi,'glazedDoor' if arc['radius']>=.65 else 'window',arc))
        stops=sorted(set([0,length]+[v for lo,hi,_,_ in cuts for v in [lo,hi]]))
        for lo,hi in zip(stops,stops[1:]):
            if hi-lo<.065:continue
            active=[c for c in cuts if c[0]-.01 <= (lo+hi)/2 <= c[1]+.01]
            kind=active[0][2] if active else 'window'
            openings.append({'kind':kind,'a':add(a,direction,lo),'b':add(a,direction,hi),'depthM':bank['depthM'],
                             'sillM':0 if kind=='glazedDoor' else .85,'heightM':2.3 if kind=='glazedDoor' else 1.45,
                             'basis':'CAD facade bank and swing symbols; inferred glazing type, sill and head'})
    return openings


def extract_architecture(path, source, gray, scale, storey_height=3):
    width,height,frame,lines,closed,arcs,arrows=read_cad(path,source,gray,scale)
    if source.get('reviewedFloorOutline'):
        # An open outward door swing or dashed overhead balcony is not ground slab.
        # Reviewed outlines are normalized annotations of the same source drawing.
        outline=Polygon([(p[0]*width,p[1]*height) for p in source['reviewedFloorOutline']])
        if not outline.is_valid or not frame.buffer(.001).covers(outline):
            raise ValueError('Invalid reviewed floor outline')
    else:
        outline=floor_outline(lines,frame)
    stairs,landings,voids=find_stairs(lines,arrows,storey_height)
    if source.get('reviewedStairGeometry'):
        # Short winding runs and cut symbols need a reviewed source trace. Their
        # horizontal dimensions/treads are drawn; the rise divides the assumed storey.
        trace = source['reviewedStairGeometry']
        xy = lambda p: (p[0]*width,p[1]*height)
        stairs = (stairs if trace.get('append') else []) + [{**f,'a':xy(f['a']),'b':xy(f['b']),
                   'widthM':f['widthPdfPoints']*scale,
                   'fromM':f['riseFraction'][0]*storey_height,
                   'toM':f['riseFraction'][1]*storey_height} for f in trace['flights']]
        landings = (landings if trace.get('append') else []) + [Polygon([xy(p) for p in ring]) for ring in trace['landings']]
        voids = (voids if trace.get('append') else []) + [Polygon([xy(p) for p in ring]) for ring in trace['voids']]
    platform_heights = source.get('reviewedStairGeometry', {}).get('landingRiseFractions')
    stair_void=unary_union(voids)
    # Closed narrow regions are the drawn wall cross-sections. Stairs and tiny frame
    # symbols are classified separately instead of turning every stroke into a wall.
    candidates=[p for p in closed if .06 <= 2*p.area/p.length <= .5 and p.area>.035
                and (stair_void.is_empty or p.intersection(stair_void).area < p.area*.5)]
    walls=unary_union(candidates).buffer(.001,join_style='mitre').buffer(-.001,join_style='mitre')
    openings=find_openings(walls,arcs,outline,source.get('openingClassification') == 'doors-only')
    opening_shapes=[strip(o['a'],o['b'],o['depthM']+.06) for o in openings]
    if opening_shapes:
        walls=walls.difference(unary_union(opening_shapes))
    # Balcony rails follow uncovered outer edges; facade openings have their own frames.
    cover=unary_union([walls.buffer(.13)]+[p.buffer(.18) for p in opening_shapes])
    railing_lines=outline.boundary.difference(cover)
    railings=[]
    for line in pieces(railing_lines,'LineString'):
        coords=list(line.simplify(.035).coords)
        for a,b in zip(coords,coords[1:]):
            if math.dist(a,b)>.45:
                railings.append({'a':a,'b':b,'heightM':1.05})
    slab=outline.difference(stair_void)
    def uv(point):return [round(min(1,max(0,point[0]/width)),6),round(min(1,max(0,point[1]/height)),6)]
    def polygon_data(geometry):
        result=[]
        for p in pieces(geometry,'Polygon'):
            if p.area<.008:continue
            p=p.simplify(.003,preserve_topology=True)
            rings=[list(p.exterior.coords)[:-1]]+[list(r.coords)[:-1] for r in p.interiors]
            result.append([[uv(point) for point in ring] for ring in rings])
        return result
    def opening_data(o):return {**o,'a':uv(o['a']),'b':uv(o['b']),**({'hinge':uv(o['hinge']),'openTip':uv(o['openTip'])} if 'hinge' in o else {})}
    model={'schema':'consensus-builder.floor-architecture.v1','dimensionsM':[round(width,4),round(height,4)],
           'wallHeightM':storey_height-.2,'slabThicknessM':.2,
           'walls':polygon_data(walls),'slabs':polygon_data(slab),
           'openings':[opening_data(o) for o in openings],
           'stairs':[{**s,'a':uv(s['a']),'b':uv(s['b'])} for s in stairs],
           'landings':[] if platform_heights else polygon_data(unary_union(landings)),
           **({'platforms':[{'rings':polygon_data(p)[0], 'elevationM':fraction*storey_height}
                            for p,fraction in zip(landings,platform_heights)]} if platform_heights else {}),
           'railings':[{**r,'a':uv(r['a']),'b':uv(r['b'])} for r in railings],
           'inference':{'wallFootprints':'closed CAD outlines','openings':'CAD swing symbols and adjoining jambs',
                        'verticalDimensions':'estimated','glazingTypes':'inferred',
                        'stairRise':'paired flights split the storey; single flights use storey height / 18 per tread'},
           'quality':{'sourceSwingSymbols':len(arcs),'modelledOpenings':len(openings),
                      'wallAreaM2':round(walls.area,2),'floorAreaM2':round(outline.area,2)}}
    # Commercial open plans can have only a handful of connected wall networks.
    # Their area and openings matter more than an arbitrary polygon-component count.
    if len(model['walls'])<3 or walls.area < outline.area*.01 or len(model['openings'])<3:
        raise ValueError('Insufficient architectural geometry; source review required')
    return model
