// Pure authored edits shared with MCP. Object indices are scoped to an immutable design CID.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.IntentEditing = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const load = (name, path) => root[name] || (typeof require === 'function' ? require(path) : null);
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

    function buildings(record, change, turf) {
        const items = record.geometry?.buildings;
        if (!items?.length) fail('building-required', 'This design has no authored buildings to edit.');
        const index = change.buildingIndex;
        const dimensional = ['set_floors', 'set_height', 'set_use'].includes(change.type);
        // A Block's buildings are cut from one authored massing (geometry.ruleMassing). Their
        // height, floors and use move together, as the editor's slider moves them, and the massing
        // is re-stamped below; a footprint, removal or single-building edit would part them from it.
        if (record.geometry.ruleMassing && (!dimensional || index != null)) fail('coupled-building-geometry', 'This design also has a separate block massing. Edit the height, floors or use of all its buildings together, or edit or replace the whole design in its geometry editor.');
        if (index != null && (!Number.isInteger(index) || index < 0 || index >= items.length)) fail('building-not-found', 'Inspect this design revision and choose an existing building index.');
        const selected = index == null ? items : [items[index]];
        const shape = load('SingleBuildingGeometry', './single-building-geometry.js');
        const before = structuredClone(items);
        if (dimensional) {
            if (change.type === 'set_floors' && (!Number.isInteger(change.value) || change.value < 1 || change.value > 200)) fail('invalid-intent', 'Floors must be an integer from 1 to 200.');
            if (change.type === 'set_height' && (!finite(change.value) || change.value <= 0 || change.value > 800)) fail('invalid-intent', 'Height must be positive and at most 800 metres.');
            // One of the Freeform editor's uses (building-use.js), or a word naming one ('housing', 'offices').
            const use = change.type === 'set_use' ? load('BuildingUse', './building-use.js').normalize(change.value) : null;
            if (change.type === 'set_use' && !use) fail('invalid-intent', `Supply a building use: ${load('BuildingUse', './building-use.js').USES.join(', ')}.`);
            for (const building of selected) {
                const p = building.properties ||= {};
                if (change.type === 'set_use') p.use = use;
                else {
                    const floorHeight = change.floorHeightM ?? p.urbanRule?.floorHeightM
                        ?? (finite(p.height) && finite(p.floors) && p.floors > 0 ? p.height / p.floors : 3);
                    if (!finite(floorHeight) || floorHeight < 0.5 || floorHeight > 20) fail('invalid-intent', 'Supply a floorHeightM between 0.5 and 20.');
                    p.floors = change.type === 'set_floors' ? change.value : Math.max(1, Math.floor(change.value / floorHeight));
                    p.height = change.type === 'set_height' ? change.value : p.floors * floorHeight;
                    if (p.height > 800 || p.floors > 200) fail('invalid-intent', 'The resulting building exceeds the supported height or floor count.');
                    if (p.urbanRule) {
                        p.urbanRule = { ...p.urbanRule, floorHeightM: floorHeight, ...(p.urbanRule.typology === 'parcelBased'
                            ? { maxFloors: p.floors, minFloors: p.urbanRule.kind === 'exact' ? p.floors : Math.min(p.urbanRule.minFloors || 0, p.floors) }
                            : { maxHeightM: p.height, minHeightM: p.urbanRule.kind === 'exact' ? p.height : Math.min(p.urbanRule.minHeightM || 0, p.height) }) };
                        if (p.ruleProvenance) p.ruleProvenance.definition = structuredClone(p.urbanRule);
                    }
                }
            }
            const massing = record.geometry.ruleMassing;
            if (massing) {
                const lead = items[0].properties;
                if (change.type === 'set_use') massing.properties.use = use;
                else if (massing.properties?.urbanRule && lead.urbanRule) {
                    const rules = load('UrbanRuleVariation', './urban-rule-variation.js');
                    record.geometry.ruleMassing = rules.massingWithRule(massing, lead.urbanRule, massing.properties.variationSeed, { turf });
                    record.geometry.ruleMassing.properties.floors = lead.floors;
                }
            }
        } else if (change.type === 'remove_building') {
            if (index == null) fail('building-selection-required', 'Choose one buildingIndex to remove.');
            if (items.length === 1) fail('remove-design-instead', 'This is the last building. Remove the design from the plan instead.');
            items.splice(index, 1);
        } else if (change.type === 'rotate' || change.type === 'move') {
            if (change.type === 'rotate' && (!finite(change.degrees) || Math.abs(change.degrees) > 360)) fail('invalid-intent', 'Rotation must be between -360 and 360 degrees, positive counterclockwise.');
            if (change.type === 'move' && (![change.eastM, change.northM].every(finite) || Math.hypot(change.eastM, change.northM) > 100)) fail('invalid-intent', 'Move at most 100 metres using eastM and northM.');
            for (const building of selected) {
                if (change.type === 'rotate') building.geometry = shape.rotateGeometry(building.geometry, change.degrees);
                else {
                    const from = shape.geometryCenter(building.geometry), frame = load('__metricFrame', './metric-frame.js').frameFor([[from.lng, from.lat]]);
                    const at = frame.toMetric([from.lng, from.lat]), to = frame.toLngLat([at[0] + change.eastM, at[1] + change.northM]);
                    building.geometry = shape.moveGeometry(building.geometry, from, { lng: to[0], lat: to[1] });
                }
                if (!building.geometry || !shape.footprintWithinBoundary(building, feature(record.site), turf)) fail('building-outside-site', 'The edit moves the building outside its site. Reduce the move/rotation or author a larger site explicitly.');
                // The feature geometry is authoritative; editor placement metadata is no longer a generator recipe.
                for (const key of ['_corners', '_sideMidpoints', 'rotation', 'offsetX', 'offsetY']) delete building.properties?.[key];
            }
        } else fail('invalid-change', 'This change does not apply to a building.');
        const parameters = record.buildingProposal.parameters ||= {};
        if (items.length === 1 || index == null) {
            for (const key of ['floors', 'height', 'use']) {
                if (items.every(b => b.properties?.[key] === items[0].properties?.[key])) parameters[key] = items[0].properties?.[key] ?? null;
                else delete parameters[key];
            }
            const rule = items[0].properties?.urbanRule;
            if (rule && items.every(b => JSON.stringify(b.properties?.urbanRule) === JSON.stringify(rule))) parameters.rule = structuredClone(rule);
        } else for (const key of ['floors', 'height', 'use']) {
            if (!items.every(b => b.properties?.[key] === items[0].properties?.[key])) delete parameters[key];
        }
        if (!dimensional) {
            parameters.manualMode = true;
            for (const key of ['rotation', 'offsetX', 'offsetY']) delete parameters[key];
            // Restore the old footprint holes, then cut the revised footprints from exactly the
            // same authored surroundings. Decoration positions stay authored and are clipped on apply.
            const surface = record.geometry.surroundings;
            if (surface?.polygon) {
                let ground = before.reduce((out, building) => turf.union(out, building), feature(surface.polygon));
                for (const building of items) if (ground) ground = turf.difference(ground, building);
                record.geometry.surroundings = ground ? { ...surface, polygon: ground.geometry } : null;
            }
        }
    }

    function planting(record, change, turf) {
        const space = record.structureProposal;
        if (space?.kind !== 'park') fail('park-required', 'Select a park design for tree planting.');
        if (!Number.isInteger(change.count) || change.count < 0 || change.count > 500) fail('invalid-intent', 'Tree count must be an integer from 0 to 500.');
        if (change.type === 'add_trees' && !space.decorationDesign) fail('planting-unrecorded', 'This park has only browser-generated planting. Use set_tree_count to author an explicit total; its previous generated layout is not stored in this design.');
        const decorations = space.decorationDesign ||= { trees: [], paths: [], ponds: [], flowerbeds: [], benches: [], version: 2 };
        const existing = decorations.trees ||= [];
        const target = change.type === 'add_trees' ? existing.length + change.count : change.count;
        if (target > 500) fail('invalid-intent', 'Keep at most 500 authored trees per park.');
        const spacing = change.spacingM ?? 4;
        if (!finite(spacing) || spacing < 1 || spacing > 30) fail('invalid-intent', 'Tree spacing must be between 1 and 30 metres.');
        if (target < existing.length) existing.splice(target);
        const api = load('__parkPlanting', './park-planting.js');
        const [west, south, east, north] = turf.bbox(feature(space.geometry));
        // Low-discrepancy deterministic candidates; retries of the same edit give the same planting.
        const unit = (index, base) => { let n = index, x = 0, f = 1; while (n) { f /= base; x += f * (n % base); n = Math.floor(n / base); } return x; };
        const blocked = [...(decorations.ponds || []), ...(decorations.flowerbeds || [])].map(ring => turf.polygon([ring]));
        const paths = (decorations.paths || []).filter(line => line.length > 1).map(line => turf.lineString(line));
        for (let i = 1; i <= 20_000 && existing.length < target; i++) {
            const coordinate = [west + unit(i, 2) * (east - west), south + unit(i, 3) * (north - south)], point = turf.point(coordinate);
            if (!turf.booleanPointInPolygon(point, feature(space.geometry)) || blocked.some(p => turf.booleanPointInPolygon(point, p))) continue;
            if (paths.some(path => turf.pointToLineDistance(point, path, { units: 'meters' }) < 2)) continue;
            if (existing.some(tree => turf.distance(point, turf.point(api.treeCoordinate(tree)), { units: 'meters' }) < spacing)) continue;
            existing.push(api.treeOf(coordinate));
        }
        if (existing.length < target) fail('planting-no-room', `Only ${existing.length} trees fit with that spacing. Request fewer trees or reduce spacingM.`);
    }

    function rowEnvelope(site, rule, turf) {
        const floors = rule.floors, floorHeightM = rule.floorHeightM ?? 3, setbackM = rule.setbackM ?? 3, depthM = rule.depthM ?? 10;
        if (!Number.isInteger(floors) || floors < 1 || floors > 200 || !finite(floorHeightM) || floorHeightM < 0.5 || floorHeightM > 20 || floors * floorHeightM > 800) fail('invalid-intent', 'Row rules need 1–200 floors and a valid floorHeightM.');
        if (!finite(setbackM) || setbackM < 0 || setbackM > 50 || !finite(depthM) || depthM < 3 || depthM > 50) fail('invalid-intent', 'Use setbackM 0–50 and row depthM 3–50 metres.');
        if (site.type !== 'Polygon') fail('row-site-disconnected', 'Draft a separate row rule on each connected plot.');
        const inside = setbackM ? turf.buffer(feature(site), -setbackM, { units: 'meters' }) : feature(site);
        if (!inside || inside.geometry.type !== 'Polygon' || turf.area(inside) < 20) fail('row-no-room', 'The plot has no usable row envelope after setbacks.');
        const frame = load('__metricFrame', './metric-frame.js').frameFor(site.coordinates[0]);
        const ring = inside.geometry.coordinates[0].map(p => frame.toMetric(p));
        let longest = [ring[0], ring[1]], length = 0;
        for (let i = 1; i < ring.length; i++) { const n = Math.hypot(ring[i][0] - ring[i-1][0], ring[i][1] - ring[i-1][1]); if (n > length) { length = n; longest = [ring[i-1], ring[i]]; } }
        const angle = Math.atan2(longest[1][1] - longest[0][1], longest[1][0] - longest[0][0]);
        const cos = Math.cos(angle), sin = Math.sin(angle), local = ring.map(([x,y]) => [x*cos+y*sin, -x*sin+y*cos]);
        const xs = local.map(p => p[0]), ys = local.map(p => p[1]), minX = Math.min(...xs), maxX = Math.max(...xs), midY = (Math.min(...ys)+Math.max(...ys))/2;
        const half = Math.min(depthM, Math.max(...ys)-Math.min(...ys))/2;
        const coords = [[minX,midY-half],[maxX,midY-half],[maxX,midY+half],[minX,midY+half],[minX,midY-half]].map(([x,y]) => frame.toLngLat([x*cos-y*sin,x*sin+y*cos]));
        const bar = turf.intersect(inside, turf.polygon([coords]));
        if (!bar || bar.geometry.type !== 'Polygon' || turf.area(bar) < 20) fail('row-no-room', 'No connected row fits this plot; choose an explicit footprint in the app.');
        bar.properties = { type: 'proposedRowHouse', floors, height: floors * floorHeightM, use: rule.use || 'residential' };
        const rules = load('UrbanRuleVariation', './urban-rule-variation.js');
        // A stable per-site seed unless the agent names one, so drafted rows do not all share one variation.
        const seed = Number.isInteger(rule.seed) && rule.seed >= 0 ? rule.seed >>> 0 : rules.hashSeed(JSON.stringify(site));
        return rules.massingWithRule(bar, { typology: 'row', kind: rule.kind || 'exact', maxHeightM: floors * floorHeightM, floorHeightM }, seed, { turf });
    }
    function transform(value, edit) {
        const out = structuredClone(value), geometry = out?.type === 'Feature' ? out.geometry : out;
        const coordinates = geometry?.coordinates || geometry;
        const points = [];
        const collect = list => {
            if (!Array.isArray(list)) fail('geometry-required', 'Transform a GeoJSON geometry, feature, coordinate or nested coordinate array.');
            if (typeof list[0] === 'number') {
                if (list.length < 2 || !list.every(finite) || Math.abs(list[0]) > 180 || Math.abs(list[1]) > 90) fail('invalid-geometry', 'Transform coordinates must be finite WGS84 positions.');
                points.push(list); return;
            }
            list.forEach(collect);
        };
        collect(coordinates);
        if (!points.length) fail('geometry-required', 'Geometry is empty.');
        const center = ['Polygon','MultiPolygon'].includes(geometry?.type) ? load('SingleBuildingGeometry', './single-building-geometry.js').geometryCenter(geometry) : null;
        const pivot = edit.pivot || (center ? [center.lng, center.lat] : [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length]);
        const east = edit.eastM ?? 0, north = edit.northM ?? 0, angle = (edit.degrees ?? 0) * Math.PI / 180, scale = edit.scale ?? 1;
        if (![east, north, angle, scale, ...pivot].every(finite) || pivot.length !== 2 || Math.hypot(east,north) > 100000 || scale < 0.01 || scale > 100) fail('invalid-transform', 'Use finite metres/degrees, a WGS84 pivot and scale 0.01–100; translation is bounded to 100 km.');
        const frame = load('__metricFrame', './metric-frame.js').frameFor([pivot]), origin = frame.toMetric(pivot);
        for (const point of points) {
            const xy = frame.toMetric(point), x = (xy[0]-origin[0])*scale, y = (xy[1]-origin[1])*scale;
            const p = frame.toLngLat([origin[0]+x*Math.cos(angle)-y*Math.sin(angle)+east,origin[1]+x*Math.sin(angle)+y*Math.cos(angle)+north]);
            point[0] = p[0]; point[1] = p[1];
        }
        return out;
    }

    function reconcile(record, original, edits, turf) {
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const touched = path => edits.some(e => e.op !== 'test' && (e.path === path || e.path.startsWith(path + '/') || path.startsWith(e.path + '/')));
        if (record.roadProposal?.definition?.osm) {
            const definition = record.roadProposal.definition, elements = definition.osm.elements;
            if (same(definition.osm, original.roadProposal?.definition?.osm)
                && ['polygon','constructionFrame'].some(key => !same(definition[key], original.roadProposal?.definition?.[key]))) fail('derived-road-footprint', 'The road footprint and construction frame are derived. Edit canonical OSM nodes and profiles to change the road shape.');
            // A road placed into a parcel holds that parcel (docs/road-in-parcel.md): its ground is
            // not edited, it is chosen by placing a new road.
            if (!same(definition.bound, original.roadProposal?.definition?.bound)) fail('bounded-road-site', 'A road in a parcel keeps its parcel. Draft a new road with that ground to change it.');
            if (!Array.isArray(elements) || !elements.length) fail('invalid-road', 'A canonical road needs OSM elements.');
            const keys = new Set(elements.map(e => `${e.type}:${e.id}`));
            if (keys.size !== elements.length) fail('invalid-road', 'OSM element identities must be unique within their type.');
            for (const element of elements) {
                if (!Number.isSafeInteger(element.id)) fail('invalid-road', 'OSM ids must be integers.');
                if (element.type === 'node' && (!finite(element.lon) || !finite(element.lat) || Math.abs(element.lon)>180 || Math.abs(element.lat)>85)) fail('invalid-road', 'A road node needs finite WGS84 coordinates.');
                if (element.type === 'way' && (!Array.isArray(element.nodes) || element.nodes.length < 2 || element.nodes.some(id => !keys.has(`node:${id}`)))) fail('invalid-road', 'Every road way needs at least two existing nodes.');
                if (element.type === 'relation' && (!Array.isArray(element.members) || element.members.some(m => !keys.has(`${m.type}:${m.ref}`)))) fail('invalid-road', 'Road relation members must exist.');
                if (!['node','way','relation'].includes(element.type)) fail('invalid-road', 'Unknown OSM element type.');
            }
            if (!same(definition, original.roadProposal?.definition)) {
                const osm = load('__corridorOsmForm', './corridor-osm-form.js');
                let view = osm.toView(definition);
                // A road in a parcel keeps its ground: its edges re-fill the room an edit leaves,
                // and an edit that moves it off the parcel or leaves its lanes too little room is refused.
                const fit = load('__corridorSiteFit', './proposals/corridor-site-fit.js');
                if (fit && fit.isBounded(view)) {
                    view = fit.refitBounded(view);
                    const before = original.roadProposal?.definition ? osm.toView(original.roadProposal.definition) : null;
                    const issue = fit.boundedRoadIssues(view, undefined, { before })[0];
                    if (issue) fail('bounded-road-refused', issue.code === 'core-too-wide'
                        ? `These lanes need ${issue.requiredM} m and the parcel leaves ${issue.availableM} m there. Choose fewer or narrower lanes.`
                        : 'A road in a parcel stays inside that parcel. Move the node back onto it.');
                }
                const material = load('__corridorFootprint', './corridor-footprint.js').materialize(view);
                record.roadProposal.definition = osm.toRecord({ ...view, polygon: material.polygon, constructionFrame: material.constructionFrame });
                record.site = material.polygon;
            }
        }
        // `paved`: the ground is paving (a square, paved building surroundings), the only ground a
        // tree pit can be cut into; parks and green surroundings stand on lawn. `ground`: the polygon
        // the decorations stand on, which a fenced area must stay inside.
        const validateDecorations = (decorations, { paved, ground = null }) => {
            const checkPoint = point => {
                if (!Array.isArray(point) || point.length < 2 || !point.every(finite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) fail('invalid-decoration', 'Authored decoration coordinates must be finite WGS84 positions.');
            };
            const visit = value => {
                if (Array.isArray(value)) { if (typeof value[0] === 'number') checkPoint(value); else value.forEach(visit); }
                else if (value && typeof value === 'object') { if (value.coordinate) checkPoint(value.coordinate); }
            };
            for (const value of Object.values(decorations || {})) visit(value);
            for (const key of ['trees','paths','ponds','flowerbeds','benches','fountains']) if (decorations?.[key] != null && !Array.isArray(decorations[key])) fail('invalid-decoration', `${key} must be an array.`);
            const planting = load('__parkPlanting', './park-planting.js');
            for (const tree of decorations?.trees || []) {
                const normalized = planting.treeOf(tree);
                if (!normalized || (!Array.isArray(tree) && (tree.kind !== normalized.kind || tree.heightM !== normalized.heightM))) fail('invalid-tree', 'Use a supported tree kind and a heightM within its range; inspect ugt://editing for the tree schema.');
                if (!Array.isArray(tree) && tree.pit != null && tree.pit !== normalized.pit) fail('invalid-tree', `A pavement tree's pit is one of ${planting.TREE_PITS.join(', ')}; omit pit for a tree without one.`);
                if (!Array.isArray(tree) && tree.pit != null && !paved) fail('invalid-tree', 'Only trees on paving (a square, paved surroundings) take a pit; this ground is green. Remove pit.');
            }
            for (const path of decorations?.paths || []) if (!Array.isArray(path) || path.length < 2) fail('invalid-decoration', 'A path needs at least two coordinates.');
            for (const ring of [...(decorations?.ponds || []), ...(decorations?.flowerbeds || [])]) {
                if (!Array.isArray(ring) || ring.length < 4 || !same(ring[0], ring.at(-1))) fail('invalid-decoration', 'Ponds and flowerbeds need closed rings with at least four coordinates.');
            }
            for (const bench of decorations?.benches || []) {
                checkPoint(bench.coordinate);
                if (!finite(bench.bearing)) fail('invalid-decoration', 'A bench needs a finite bearing in degrees.');
            }
            if (decorations?.enclosures != null) {
                if (!Array.isArray(decorations.enclosures)) fail('invalid-decoration', 'enclosures must be an array.');
                const enclosures = load('ParkEnclosures', './park-enclosures.js');
                for (const entry of decorations.enclosures) {
                    const issue = enclosures.enclosureIssue(entry, ground);
                    if (issue) fail(issue.code, issue.message);
                    if (entry.ring && ground && !entry.ring.every(point => { try { return turf.booleanPointInPolygon(point, feature(ground)); } catch (_) { return false; } })) {
                        fail('enclosure-outside', 'A fenced area must lie inside its park; leave out ring to fence the whole park.');
                    }
                }
            }
        };
        if (record.structureProposal) {
            const space = record.structureProposal;
            if (space.kind !== record.goal) fail('space-kind-mismatch', 'Keep goal and structureProposal.kind together.');
            if (!same(space.geometry, original.structureProposal?.geometry)) {
                if (same(record.site, original.site)) record.site = structuredClone(space.geometry);
                if (space.decorationDesign) space.decorationDesign = load('ProposalApplyStructures', './proposals/apply/structures.js')
                    .decorationsOnGround(space.decorationDesign, space.geometry, turf);
            }
            validateDecorations(space.decorationDesign, { paved: space.kind === 'square', ground: space.geometry });
        }
        if (record.buildingProposal) {
            const items = record.geometry?.buildings || [], oldItems = original.geometry?.buildings || [];
            if (!items.length && oldItems.length) fail('empty-building-design', 'Remove the design from the plan when removing its last building.');
            const parameters = record.buildingProposal.parameters ||= {}, oldParameters = original.buildingProposal?.parameters || {};
            const rules = load('UrbanRuleVariation', './urban-rule-variation.js');
            const changedShape = !same(items.map(b => b.geometry), oldItems.map(b => b.geometry));
            if (changedShape && original.geometry?.ruleMassing && !touched('/geometry/ruleMassing')) fail('coupled-building-geometry', 'This edit must explicitly update the separately authored geometry.ruleMassing too.');
            for (const key of ['width','length','rotation','offsetX','offsetY','setback','setbackM','coverage']) if (!same(parameters[key], oldParameters[key]) && !changedShape) fail('geometry-regeneration-required', `Changing ${key} also requires edited geometry; parameters alone do not move the drawing.`);
            for (let i=0; i<items.length; i++) {
                const p = items[i].properties ||= {}, old = oldItems[i]?.properties || {};
                const base = `/geometry/buildings/${i}/properties`;
                if (!same(parameters.rule, oldParameters.rule) && !touched(base + '/urbanRule')) {
                    if (parameters.rule) p.urbanRule = structuredClone(parameters.rule); else delete p.urbanRule;
                }
                const ruleChanged = !same(p.urbanRule, old.urbanRule);
                if (p.urbanRule && ruleChanged) {
                    const rule = p.urbanRule;
                    if (!['max','range','exact'].includes(rule.kind) || !['block','row','parcelBased'].includes(rule.typology)) fail('invalid-rule', 'Use a supported rule typology and max, range or exact kind.');
                    const normalized = rule.typology === 'parcelBased' ? rules.normalizeParcelRule(rule) : rules.normalizeBlockRule(rule);
                    for (const [key, value] of Object.entries(rule)) {
                        // Exact rules derive their minimum from the maximum; callers need not edit both.
                        if (rule.kind === 'exact' && ['minHeightM','minFloors'].includes(key)) continue;
                        if (!same(value, normalized[key])) fail('invalid-rule', `Rule field ${key} is unsupported or outside its valid range.`);
                    }
                    // A detached rule's yards and caps shape each plot's envelope, and a yard growing with
                    // height or a floor area ratio also decides its floors, so those edits need new geometry.
                    const shaping = ['minDistance','minPlotAreaM2','minPieceAreaM2'];
                    if (normalized.setbackHeightRatio > 0 || normalized.maxFloorAreaRatio > 0) shaping.push('maxFloors', 'floorHeightM');
                    for (const key of shaping) if (!same(normalized[key], old.urbanRule?.[key] ?? normalized[key]) && !changedShape) fail('geometry-regeneration-required', `Changing rule.${key} requires edited envelope geometry as well.`);
                    // A limit is absent when unset, so adding or removing one is a change too.
                    if (old.urbanRule) for (const key of Object.keys(rules.PARCEL_LIMITS)) if (!same(normalized[key], old.urbanRule[key]) && !changedShape) fail('geometry-regeneration-required', `Changing rule.${key} requires edited envelope geometry as well.`);
                    p.urbanRule = normalized;
                    // A detached envelope keeps the floors its plot was given (at most the rule's).
                    const parcelFloors = Math.min(normalized.maxFloors, finite(p.floors) && p.floors >= 1 && (normalized.setbackHeightRatio > 0 || normalized.maxFloorAreaRatio > 0) ? p.floors : normalized.maxFloors);
                    p.height = normalized.typology === 'parcelBased' ? parcelFloors * normalized.floorHeightM : normalized.maxHeightM;
                    p.floors = normalized.typology === 'parcelBased' ? parcelFloors : Math.max(1, Math.floor(p.height / normalized.floorHeightM));
                    delete p.minFootprint;
                    if (normalized.kind === 'range' && normalized.minDepthM > 0) {
                        const compelled = rules.buildToMinimum(record.geometry.ruleMassing || items[i], normalized.minDepthM, { turf });
                        const clipped = compelled && turf.intersect(compelled, items[i]);
                        if (clipped) p.minFootprint = clipped.geometry;
                    }
                }
                if (!same(parameters.height, oldParameters.height) && !touched(`/geometry/buildings/${i}/properties/height`)) p.height = parameters.height;
                if (!same(parameters.floors, oldParameters.floors) && !touched(`/geometry/buildings/${i}/properties/floors`)) p.floors = parameters.floors;
                if (!same(parameters.use, oldParameters.use) && !touched(base + '/use')) p.use = parameters.use;
                const floorHeight = p.urbanRule?.floorHeightM || old.urbanRule?.floorHeightM || (finite(old.height) && finite(old.floors) && old.floors > 0 ? old.height/old.floors
                    : finite(oldParameters.height) && finite(oldParameters.floors) && oldParameters.floors > 0 ? oldParameters.height/oldParameters.floors : 3);
                const heightChanged = !same(p.height, old.height), floorsChanged = !same(p.floors, old.floors);
                const explicitHeight = touched(`/geometry/buildings/${i}/properties/height`) || touched('/buildingProposal/parameters/height');
                const explicitFloors = touched(`/geometry/buildings/${i}/properties/floors`) || touched('/buildingProposal/parameters/floors');
                if (explicitHeight && !explicitFloors && finite(p.height)) p.floors = Math.max(1, Math.floor(p.height/floorHeight));
                if (explicitFloors && !explicitHeight && finite(p.floors)) p.height = p.floors*floorHeight;
                if ((p.height != null && (!finite(p.height) || p.height <= 0 || p.height > 800)) || (p.floors != null && (!Number.isInteger(p.floors) || p.floors < 1 || p.floors > 200))) fail('invalid-building-dimensions', 'Building heights and floor counts must be positive supported measurements.');
                if (p.urbanRule && (heightChanged || floorsChanged || ruleChanged)) {
                    if (p.urbanRule.typology === 'parcelBased') {
                        p.urbanRule.maxFloors = p.floors;
                        p.urbanRule.minFloors = p.urbanRule.kind === 'exact' ? p.floors : Math.min(p.urbanRule.minFloors || 0, p.floors);
                    } else {
                        p.urbanRule.maxHeightM = p.height;
                        p.urbanRule.minHeightM = p.urbanRule.kind === 'exact' ? p.height : Math.min(p.urbanRule.minHeightM || 0, p.height);
                    }
                    if (p.ruleProvenance) p.ruleProvenance.definition = structuredClone(p.urbanRule);
                }
                if (record.site && !load('SingleBuildingGeometry', './single-building-geometry.js').footprintWithinBoundary(items[i], feature(record.site), turf)) fail('building-outside-site', 'The edited footprint leaves its site. Update the authored site explicitly if that is intended.');
            }
            for (const key of ['height','floors','use']) if (items.length) {
                if (items[0].properties?.[key] != null && items.every(b => b.properties?.[key] === items[0].properties[key])) parameters[key] = items[0].properties[key];
                else delete parameters[key];
            }
            if (items.length && items[0].properties?.urbanRule && items.every(b => same(b.properties?.urbanRule, items[0].properties.urbanRule))) parameters.rule = structuredClone(items[0].properties.urbanRule);
            else if (items.length) delete parameters.rule;
            const massing = record.geometry?.ruleMassing;
            if (massing?.properties?.urbanRule && !same(parameters.rule, oldParameters.rule) && parameters.rule && !touched('/geometry/ruleMassing')) {
                record.geometry.ruleMassing = rules.massingWithRule(massing, parameters.rule, massing.properties.variationSeed, { turf });
                record.geometry.ruleMassing.properties.floors = parameters.floors;
            }
            if (changedShape && record.geometry.surroundings && !touched('/geometry/surroundings')) {
                const surface = record.geometry.surroundings;
                let ground = oldItems.reduce((out,b) => turf.union(out,b), feature(surface.polygon));
                for (const building of items) if (ground) ground = turf.difference(ground, building);
                record.geometry.surroundings = ground ? { ...surface, polygon: ground.geometry } : null;
            }
            if (record.geometry.landTake && record.geometry.surroundings) {
                const ground = load('BuildingGround', './building-ground.js');
                record.geometry.surroundings = ground.clipSurfaceToLandTake(record.geometry.surroundings, record.geometry.landTake, turf);
            }
            validateDecorations(record.geometry?.surroundings?.decorationDesign, { paved: record.geometry?.surroundings?.treatment !== 'green', ground: record.geometry?.surroundings?.polygon || null });
        }
    }
    return { buildings, planting, rowEnvelope, transform, reconcile };
});
