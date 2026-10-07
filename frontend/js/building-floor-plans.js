// Pure validation and registration geometry for georeferenced architectural floor models.
(function (global) {
    'use strict';
    const SCHEMA = 'consensus-builder.building-floor-plans.v2';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const error = (path, message) => `${path}: ${message}`;
    function httpUrl(value) {
        if (typeof value !== 'string') return false;
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) { return false; }
    }
    const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

    // Reconstruction sources retain their native stable identifiers. Prefix numeric
    // provider ids so a cadastral id cannot collide with a permit-layer id.
    function buildingSourceId(feature) {
        const properties = feature?.properties;
        for (const [field, prefix] of [['sourceFeatureId', ''], ['dguBuildingId', 'dgu-building:'], ['sourceLayerId', 'source-layer:']]) {
            const value = properties?.[field];
            if ((typeof value === 'string' && value.trim()) || (finite(value) && Number.isInteger(value))) {
                return prefix + String(value);
            }
        }
        return null;
    }

    // Return above-ground portions of a proxy building not covered by registered floor models.
    // Missing/invalid architectural heights are ignored conservatively; callers can keep the
    // ordinary proxy where evidence is absent. Underground intervals never cover the proxy.
    function uncoveredFloorBands(feature, totalHeight) {
        if (!feature?.properties?.floorPlans || !finite(totalHeight) || totalHeight <= 0) return [];
        const plans = feature.properties.floorPlans;
        const layouts = new Map((Array.isArray(plans.layouts) ? plans.layouts : []).map(layout => [layout.id, layout]));
        const covered = [];
        for (const floor of Array.isArray(plans.floors) ? plans.floors : []) {
            const base = floor?.elevationM;
            const architecture = layouts.get(floor?.layoutId)?.architecture;
            const wallHeight = architecture?.wallHeightM;
            const slabThickness = architecture?.slabThicknessM;
            if (!finite(base) || !finite(wallHeight) || !finite(slabThickness)) continue;
            const height = wallHeight + slabThickness;
            if (height <= 0) continue;
            const top = base + height;
            if (top <= 0 || base >= totalHeight) continue;
            const start = Math.max(0, base), end = Math.min(totalHeight, top);
            if (end > start) covered.push([start, end]);
        }
        if (!covered.length) return [{ baseM: 0, heightM: totalHeight }];
        covered.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const interval of covered) {
            const previous = merged.at(-1);
            if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
            else merged.push(interval);
        }
        const gaps = [];
        let cursor = 0;
        for (const [start, end] of merged) {
            if (start > cursor) gaps.push({ baseM: cursor, heightM: start - cursor });
            cursor = Math.max(cursor, end);
        }
        if (cursor < totalHeight) gaps.push({ baseM: cursor, heightM: totalHeight - cursor });
        return gaps;
    }

    function validateFloorPlans(data) {
        const errors = [];
        if (!data || typeof data !== 'object' || Array.isArray(data)) return ['floorPlans: must be an object'];
        if (data.schema !== SCHEMA) errors.push(error('floorPlans.schema', `must equal ${SCHEMA}`));
        const registration = data.registration, corners = registration && registration.corners;
        const validCorners = Array.isArray(corners) && corners.length === 4 && corners.every(c => Array.isArray(c) && c.length === 2 && finite(c[0]) && finite(c[1]) && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90);
        if (!validCorners) errors.push(error('floorPlans.registration.corners', 'must contain four finite [lng,lat] corners within WGS84 ranges'));
        else {
            const span = corners.reduce((max, c) => Math.max(max, ...corners.map(d => Math.hypot((c[0] - d[0]) * 111320 * Math.cos(c[1] * Math.PI / 180), (c[1] - d[1]) * 111320))), 0);
            const turns = corners.map((c, i) => orient(c, corners[(i + 1) % 4], corners[(i + 2) % 4]));
            if (!(span > 0) || !(turns.every(turn => turn > 0) || turns.every(turn => turn < 0))) {
                errors.push(error('floorPlans.registration.corners', 'must form a nondegenerate convex quadrilateral'));
            }
            if (span > 1000) errors.push(error('floorPlans.registration.corners', 'must span no more than 1 km'));
        }
        if (typeof registration?.basis !== 'string' || !registration.basis.trim()) errors.push(error('floorPlans.registration.basis', 'must be a non-empty string'));
        const layouts = data.layouts, layoutIds = new Set();
        if (!Array.isArray(layouts) || layouts.length > 100) errors.push(error('floorPlans.layouts', 'must be an array of at most 100 layouts'));
        else layouts.forEach((layout, li) => {
            const path = `floorPlans.layouts[${li}]`;
            if (!layout || typeof layout !== 'object' || typeof layout.id !== 'string' || !layout.id) errors.push(error(`${path}.id`, 'must be a non-empty string'));
            else if (layoutIds.has(layout.id)) errors.push(error(`${path}.id`, 'must be unique'));
            else layoutIds.add(layout.id);
            errors.push(...validateArchitecture(layout?.architecture, `${path}.architecture`));
            const source = layout?.source;
            if (!source || typeof source !== 'object') errors.push(error(`${path}.source`, 'is required'));
            else if (source.kind === 'generated') {
                // A generated layout's evidence is the generator and its parameters, not a document.
                // It can only appear inside a suggested model; the registry never stores one.
                if (typeof source.generator !== 'string' || !source.generator.trim()) errors.push(error(`${path}.source.generator`, 'must name the generator'));
                if (!source.parameters || typeof source.parameters !== 'object' || Array.isArray(source.parameters)) errors.push(error(`${path}.source.parameters`, 'must be an object'));
                if (data.suggested !== true) errors.push(error(`${path}.source.kind`, 'generated layouts require floorPlans.suggested = true'));
            } else {
                if (!httpUrl(source.url)) errors.push(error(`${path}.source.url`, 'must be a valid http(s) URL'));
                // Pages/crops describe PDF or image evidence. CAD, survey and authored sources
                // use the same architectural contract without pretending to be paginated PDFs.
                if (source.page !== undefined && (!Number.isInteger(source.page) || source.page < 1)) errors.push(error(`${path}.source.page`, 'must be a positive integer'));
                if (source.crop !== undefined && (!Array.isArray(source.crop) || source.crop.length !== 4 || source.crop.some(value => !finite(value)))) errors.push(error(`${path}.source.crop`, 'must contain four finite values'));
                if (typeof source.sha256 !== 'string' || !source.sha256) errors.push(error(`${path}.source.sha256`, 'must be a non-empty string'));
            }
        });
        const floors = data.floors, floorIds = new Set(), levels = new Set();
        if (!Array.isArray(floors)) errors.push(error('floorPlans.floors', 'must be an array'));
        else if (floors.length > 100) errors.push(error('floorPlans.floors', 'must contain at most 100 floors'));
        else floors.forEach((floor, fi) => {
            const path = `floorPlans.floors[${fi}]`;
            if (!floor || typeof floor !== 'object' || typeof floor.id !== 'string' || !floor.id || floorIds.has(floor.id)) errors.push(error(`${path}.id`, 'must be a unique non-empty string')); else floorIds.add(floor.id);
            if (!finite(floor?.level) || !Number.isInteger(floor.level) || levels.has(floor.level)) errors.push(error(`${path}.level`, 'must be a unique integer')); else levels.add(floor.level);
            if (!finite(floor?.elevationM)) errors.push(error(`${path}.elevationM`, 'must be finite'));
            if (!['documented', 'estimated'].includes(floor?.elevationBasis)) errors.push(error(`${path}.elevationBasis`, 'must be documented or estimated'));
            if (typeof floor?.layoutId !== 'string' || !layoutIds.has(floor.layoutId)) errors.push(error(`${path}.layoutId`, 'must reference a layout'));
            if (floor?.apartments !== undefined && !Array.isArray(floor.apartments)) errors.push(error(`${path}.apartments`, 'must be an array'));
            if (Array.isArray(floor?.apartments)) floor.apartments.forEach((apartment, ai) => {
                const apartmentPath = `${path}.apartments[${ai}]`;
                if (!apartment || typeof apartment.id !== 'string' || !apartment.id) {
                    errors.push(error(`${apartmentPath}.id`, 'must be a non-empty string'));
                }
                if (apartment?.areaM2 !== undefined && (!finite(apartment.areaM2) || apartment.areaM2 <= 0)) {
                    errors.push(error(`${apartmentPath}.areaM2`, 'must be a positive finite number'));
                }
                if (apartment?.url !== undefined && !httpUrl(apartment.url)) {
                    errors.push(error(`${apartmentPath}.url`, 'must be a valid http(s) URL'));
                }
            });
        });
        if (!errors.length) {
            const layoutSizes = new Map(layouts.map(layout => [layout.id, estimateArchitectureParts(layout.architecture)]));
            const count = floors.reduce((sum, floor) => sum + layoutSizes.get(floor.layoutId), 0);
            if (count > 50000) errors.push(error('floorPlans.floors', 'expanded model must not exceed 50000 solid parts'));
        }
        return errors;
    }

    const ARCHITECTURE_SCHEMA = 'consensus-builder.floor-architecture.v1';
    const uvPoint = p => Array.isArray(p) && p.length === 2 && p.every(v => finite(v) && v >= 0 && v <= 1);
    const bounded = (v, min, max) => finite(v) && v >= min && v <= max;
    const length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lerp = (a, b, t) => [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t];

    function validateArchitecture(model, path = 'architecture') {
        const errors = [];
        const fail = (field, message) => errors.push(error(`${path}.${field}`, message));
        if (!model || model.schema !== ARCHITECTURE_SCHEMA) return [error(path, `must use ${ARCHITECTURE_SCHEMA}`)];
        if (!Array.isArray(model.dimensionsM) || model.dimensionsM.length !== 2 || !model.dimensionsM.every(n => bounded(n, 1, 1000))) fail('dimensionsM', 'must contain two positive metric dimensions');
        if (!bounded(model.wallHeightM, 1, 12)) fail('wallHeightM', 'must be 1..12 metres');
        if (!bounded(model.slabThicknessM, .02, 1)) fail('slabThicknessM', 'must be .02..1 metres');
        let vertices = 0;
        for (const kind of ['walls', 'slabs', 'landings', 'platforms']) {
            const polygons = kind === 'platforms' ? (model.platforms || []).map(platform => platform?.rings) : model[kind];
            if (!Array.isArray(polygons)) { fail(kind, 'must be an array of polygons'); continue; }
            if (['walls', 'slabs'].includes(kind) && !polygons.length) fail(kind, 'must contain geometry');
            for (const [i, polygon] of polygons.entries()) {
                if (kind === 'platforms' && !bounded(model.platforms[i]?.elevationM, 0, 12)) fail(`${kind}[${i}]`, 'requires a finite elevation');
                if (!Array.isArray(polygon) || !polygon.length) { fail(`${kind}[${i}]`, 'must contain an outer ring'); continue; }
                for (const ring of polygon) {
                    if (!Array.isArray(ring) || ring.length < 3 || !ring.every(uvPoint)) {
                        fail(`${kind}[${i}]`, 'rings need at least three normalized points'); continue;
                    }
                    vertices += ring.length;
                    const area = ring.reduce((sum, p, j) => sum + p[0]*ring[(j+1)%ring.length][1] - p[1]*ring[(j+1)%ring.length][0], 0);
                    if (Math.abs(area) < 1e-12) fail(`${kind}[${i}]`, 'rings must have nonzero area');
                }
            }
        }
        if (vertices > 100000) fail('walls', 'layout must not exceed 100000 polygon vertices');
        for (const kind of ['openings', 'stairs', 'railings']) {
            if (!Array.isArray(model[kind]) || model[kind].length > 2000) { fail(kind, 'must contain at most 2000 elements'); continue; }
            for (const [i, item] of model[kind].entries()) {
                const key = `${kind}[${i}]`;
                if (!uvPoint(item?.a) || !uvPoint(item?.b) || length(item.a, item.b) < 1e-7) fail(key, 'requires distinct normalized endpoints');
                if (kind === 'openings') {
                    if (!['door', 'window', 'glazedDoor', 'slidingDoor'].includes(item?.kind)) fail(key, 'unknown opening kind');
                    if (!bounded(item?.depthM, .02, 1) || !bounded(item?.sillM, 0, model.wallHeightM) || !bounded(item?.heightM, .1, model.wallHeightM)
                        || item.sillM + item.heightM > model.wallHeightM + .001) fail(key, 'invalid opening dimensions');
                    if (item?.kind === 'door' && (!uvPoint(item.hinge) || !uvPoint(item.openTip) || length(item.hinge, item.openTip) < 1e-7)) fail(key, 'door requires its hinge and swung leaf endpoint');
                } else if (kind === 'stairs') {
                    if (!bounded(item?.widthM, .3, 5) || !Number.isInteger(item?.steps) || !bounded(item.steps, 1, 64)
                        || !bounded(item?.fromM, 0, 12) || !bounded(item?.toM, .1, 12) || item.toM <= item.fromM) fail(key, 'invalid stair dimensions');
                } else if (!bounded(item?.heightM, .5, 2)) fail(key, 'invalid railing height');
            }
        }
        return errors;
    }

    function estimateArchitectureParts(model) {
        const span = item => Math.hypot((item.b[0]-item.a[0])*model.dimensionsM[0], (item.b[1]-item.a[1])*model.dimensionsM[1]);
        return model.walls.length + model.slabs.length + model.landings.length + (model.platforms || []).length
            + model.openings.reduce((n,item) => n + 8 + Math.ceil(span(item)/1.4), 0)
            + model.stairs.reduce((n,item) => n + item.steps, 0)
            + model.railings.reduce((n,item) => n + 3 + Math.ceil(span(item)/1.15), 0);
    }

    // Parts are plain polygon prisms in projected XY and metre Z; Three.js only
    // triangulates these, shares their buffers, and applies each floor's elevation.
    function buildArchitectureParts(model, projectUv) {
        const [width, height] = model.dimensionsM;
        const metric = p => [p[0]*width, p[1]*height];
        const projectMetric = p => projectUv(p[0]/width, p[1]/height);
        const parts = [];
        function polygon(kind, rings, baseM, heightM) {
            if (heightM <= .001) return;
            parts.push({kind, rings, baseM, heightM});
        }
        function strip(kind, a, b, depthM, baseM, heightM) {
            const size = length(a, b);
            if (size < .001 || heightM <= .001) return;
            const nx = -(b[1]-a[1])/size*depthM/2, ny = (b[0]-a[0])/size*depthM/2;
            polygon(kind, [[[a[0]+nx,a[1]+ny], [b[0]+nx,b[1]+ny], [b[0]-nx,b[1]-ny], [a[0]-nx,a[1]-ny]].map(projectMetric)], baseM, heightM);
        }
        function sourcePolygons(kind, polygons, base, heightM) {
            polygons.forEach(rings => polygon(kind, rings.map(ring => ring.map(p => projectUv(p[0],p[1]))), base, heightM));
        }
        sourcePolygons('wall', model.walls, 0, model.wallHeightM);
        sourcePolygons('slab', model.slabs, -model.slabThicknessM, model.slabThicknessM);
        const halfStorey = (model.wallHeightM + model.slabThicknessM) / 2;
        sourcePolygons('stair', model.landings, halfStorey - model.slabThicknessM, model.slabThicknessM);
        for (const platform of model.platforms || []) {
            sourcePolygons('stair', [platform.rings], platform.elevationM - model.slabThicknessM, model.slabThicknessM);
        }
        for (const opening of model.openings) {
            const a = metric(opening.a), b = metric(opening.b), size = length(a, b);
            const {depthM, sillM, heightM} = opening;
            const frame = Math.min(.055, size/4);
            strip('wall', a, b, depthM, 0, sillM);
            strip('wall', a, b, depthM, sillM+heightM, model.wallHeightM-sillM-heightM);
            strip('frame', a, lerp(a,b,frame/size), depthM+.015, sillM, heightM);
            strip('frame', lerp(a,b,1-frame/size), b, depthM+.015, sillM, heightM);
            strip('frame', a, b, depthM+.015, sillM+heightM-frame, frame);
            if (opening.kind === 'door') {
                strip('door', metric(opening.hinge), metric(opening.openTip), .04, .015, heightM-.07);
            } else if (opening.kind === 'slidingDoor') {
                // Two closed lift leaves preserve the shaft opening without inventing a swing.
                strip('door', lerp(a,b,frame/size), lerp(a,b,.497), .045, sillM, heightM-frame);
                strip('door', lerp(a,b,.503), lerp(a,b,1-frame/size), .045, sillM, heightM-frame);
            } else {
                strip('frame', a, b, depthM+.015, sillM, frame);
                strip('glass', lerp(a,b,frame/size), lerp(a,b,1-frame/size), .018, sillM+frame, heightM-frame*2);
                const panes = Math.ceil(size/1.4);
                for (let pane=1; pane<panes; pane++) {
                    const centre = pane/panes;
                    strip('frame', lerp(a,b,centre-frame/(2*size)), lerp(a,b,centre+frame/(2*size)), depthM*.6, sillM, heightM);
                }
            }
        }
        for (const stair of model.stairs) {
            const a=metric(stair.a), b=metric(stair.b);
            const rise=(stair.toM-stair.fromM)/stair.steps;
            for (let step=0; step<stair.steps; step++) {
                // A 15 cm waist supports each tread without filling the stairwell.
                strip('stair', lerp(a,b,step/stair.steps), lerp(a,b,(step+1)/stair.steps), stair.widthM,
                    stair.fromM+step*rise-.15, rise+.15);
            }
        }
        for (const rail of model.railings) {
            const a=metric(rail.a), b=metric(rail.b), size=length(a,b);
            strip('railing',a,b,.055,rail.heightM-.055,.055);
            strip('railing',a,b,.035,rail.heightM*.5,.035);
            const posts=Math.ceil(size/1.15);
            for (let post=0; post<=posts; post++) {
                const centre=lerp(a,b,post/posts), direction=[(b[0]-a[0])/size,(b[1]-a[1])/size];
                strip('railing', [centre[0]-.025*direction[0],centre[1]-.025*direction[1]], [centre[0]+.025*direction[0],centre[1]+.025*direction[1]], .05,0,rail.heightM);
            }
        }
        return parts;
    }

    function buildFloorPlanGeometry(feature, project) {
        const plans = feature?.properties?.floorPlans;
        if (plans == null) return [];
        const errors = validateFloorPlans(plans);
        if (errors.length) throw new Error(`Invalid floorPlans: ${errors.join('; ')}`);
        if (typeof project !== 'function') throw new Error('buildFloorPlanGeometry requires a project(lng, lat) function');
        const c = plans.registration.corners;
        const interpolate = (u, v) => {
            const lng = (1-u)*(1-v)*c[0][0] + u*(1-v)*c[1][0] + u*v*c[2][0] + (1-u)*v*c[3][0];
            const lat = (1-u)*(1-v)*c[0][1] + u*(1-v)*c[1][1] + u*v*c[2][1] + (1-u)*v*c[3][1];
            const point = project(lng, lat);
            if (!Array.isArray(point) || point.length !== 2 || !point.every(finite)) throw new Error('Projection must return finite [x,y] coordinates');
            return point;
        };
        const layouts = new Map(plans.layouts.map(layout => [layout.id, {
            source: layout.source, parts: buildArchitectureParts(layout.architecture, interpolate)
        }]));
        return plans.floors.map(floor => ({
            id: floor.id, level: floor.level, layoutId: floor.layoutId,
            elevationM: floor.elevationM, elevationBasis: floor.elevationBasis,
            parts: layouts.get(floor.layoutId).parts,
            apartmentCount: (floor.apartments || []).length,
            sourceUrl: floor.source?.url || layouts.get(floor.layoutId).source.url
        }));
    }
    // Refresh presentation data on already materialized buildings without replaying
    // the proposal or changing any footprint, authored record or lifecycle state.
    function refreshRegisteredFloorPlans(buildings, sources) {
        const byId = new Map();
        for (const source of sources || []) {
            const id = buildingSourceId(source);
            if (!id || !source.properties.floorPlans) continue;
            if (byId.has(id)) byId.set(id, null); // Ambiguous evidence cannot own a model.
            else byId.set(id, source);
        }
        const checked = new Set();
        let changed = 0;
        const result = buildings.map(building => {
            const source = byId.get(buildingSourceId(building));
            if (!source || building.geometry?.type !== source.geometry?.type
                || JSON.stringify(building.geometry?.coordinates) !== JSON.stringify(source.geometry?.coordinates)) return building;
            const plans = source.properties.floorPlans;
            if (!checked.has(plans)) {
                const errors = validateFloorPlans(plans);
                if (errors.length) throw new Error(`Invalid floor model: ${errors.join('; ')}`);
                checked.add(plans);
            }
            if (JSON.stringify(building.properties.floorPlans) === JSON.stringify(plans)) return building;
            changed++;
            return { ...building, properties: { ...building.properties, floorPlans: structuredClone(plans) } };
        });
        return { buildings: result, changed };
    }

    function buildLocalUnitParts(architecture) {
        const errors = validateArchitecture(architecture);
        if (errors.length) throw new Error(errors.join('; '));
        const [width,depth] = architecture.dimensionsM;
        return buildArchitectureParts(architecture, (u,v) => [u*width,(1-v)*depth]);
    }

    // The bilinear map from a model's unit square to the ground, as the renderer applies it.
    function registrationToLngLat(plans) {
        const c = plans.registration.corners;
        return (u, v) => [
            (1-u)*(1-v)*c[0][0] + u*(1-v)*c[1][0] + u*v*c[2][0] + (1-u)*v*c[3][0],
            (1-u)*(1-v)*c[0][1] + u*(1-v)*c[1][1] + u*v*c[2][1] + (1-u)*v*c[3][1]
        ];
    }

    // One floor of a model as plain WGS84 GeoJSON for 2D maps and thumbnails: wall and slab
    // polygons, opening and stair runs as lines, each tagged with its kind. No Three.js, no DOM.
    function floorPlanToGeoJSON(plans, level) {
        const errors = validateFloorPlans(plans);
        if (errors.length) throw new Error(`Invalid floorPlans: ${errors.join('; ')}`);
        const floor = plans.floors.find(entry => entry.level === level);
        if (!floor) return { type: 'FeatureCollection', features: [] };
        const layout = plans.layouts.find(entry => entry.id === floor.layoutId);
        const toLngLat = registrationToLngLat(plans);
        const ring = points => points.map(p => toLngLat(p[0], p[1])).concat([toLngLat(points[0][0], points[0][1])]);
        const features = [];
        const polygonFeatures = (kind, polygons) => polygons.forEach(rings => features.push({
            type: 'Feature', properties: { kind, level, suggested: plans.suggested === true },
            geometry: { type: 'Polygon', coordinates: rings.map(ring) }
        }));
        const lineFeatures = (kind, items, extra = () => ({})) => items.forEach(item => features.push({
            type: 'Feature', properties: { kind, level, suggested: plans.suggested === true, ...extra(item) },
            geometry: { type: 'LineString', coordinates: [toLngLat(item.a[0], item.a[1]), toLngLat(item.b[0], item.b[1])] }
        }));
        const architecture = layout.architecture;
        polygonFeatures('slab', architecture.slabs);
        polygonFeatures('wall', architecture.walls);
        polygonFeatures('landing', architecture.landings);
        lineFeatures('opening', architecture.openings, item => ({ opening: item.kind }));
        lineFeatures('stair', architecture.stairs, item => ({ steps: item.steps }));
        lineFeatures('railing', architecture.railings);
        return { type: 'FeatureCollection', features };
    }
    const api = { buildLocalUnitParts, SCHEMA, ARCHITECTURE_SCHEMA, buildingSourceId, uncoveredFloorBands, validateArchitecture, validateFloorPlans, buildFloorPlanGeometry, refreshRegisteredFloorPlans, registrationToLngLat, floorPlanToGeoJSON };
    global.__buildingFloorPlans = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
