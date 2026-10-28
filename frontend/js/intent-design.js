// Intent builders shared by node agents and browser previews. Geometry comes from the app's own
// corridor, layout and record modules; every input time and source geometry is supplied by the caller.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.IntentDesign = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const load = (name, path) => root[name] || (typeof require === 'function' ? require(path) : null);
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    const copy = value => structuredClone(value);
    const fail = message => { throw Object.assign(new Error(message), { code: 'invalid-intent', next: { action: 'Correct the intent using the tool schema.' } }); };
    function deps(given = {}) {
        return {
            turf: given.turf || root.turf,
            record: given.record || load('DesignRecord', './design-record.js'),
            profile: given.profile || (typeof require === 'function' ? require('./corridor-profile.js') : root),
            osm: given.osm || load('__corridorOsmForm', './corridor-osm-form.js'),
            footprint: given.footprint || load('__corridorFootprint', './corridor-footprint.js'),
            layouts: given.layouts || load('ParcelLayoutLayouts', './parcel-layout-layouts.js'),
            grid: given.grid || load('SchellingGrid', './parcels/schelling-grid.js'),
            validation: given.validation || load('ParcelLayoutValidation', './parcel-layout-validation.js'),
            corridorGeometry: given.corridorGeometry || load('CorridorGeometry', './corridor-geometry.js'),
            frame: given.frame || load('__metricFrame', './metric-frame.js')
        };
    }
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
    function polygon(geometry, d) {
        const shape = d.validation.polygon(geometry, d.turf);
        if (!shape) fail('Supply a valid WGS84 Polygon or MultiPolygon');
        const bounds = d.turf.bbox(shape);
        if (bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85 || bounds[3] > 85 || d.turf.area(shape) > 1_000_000) fail('Draft area must be within one square kilometre and latitudes ±85°');
        return shape.geometry;
    }
    // The side of the road the street's traffic keeps to: the city's, which the caller supplies
    // (mcp-drafts from the city's config), or the record's own on an edit.
    const drivingSideOf = intent => (intent.drivingSide === 'left' ? 'left' : 'right');
    function roadProfile(intent, d) {
        if (intent.lanes) {
            if (!intent.lanes.length || intent.lanes.length > 32 || intent.lanes.some(lane => !d.profile.CORRIDOR_LANE_TYPES[lane.type]
                || !finite(lane.width) || lane.width < 0.25 || lane.width > 20 || (lane.type === 'rail' && ![1000, 1435].includes(lane.gauge ?? 1435)))) fail('Supply 1–32 known lane types, each 0.25–20 metres wide');
            return d.profile.normalizeCorridorProfile({ strips: intent.lanes });
        }
        if (intent.kind === 'track') {
            if (![1000, 1435].includes(intent.gauge ?? 1435)) fail('Track gauge must be 1000 or 1435 millimetres');
            return d.profile.corridorDefaultTrackProfile(intent.gauge ?? 1435);
        }
        const tags = intent.preset === '2+2' ? { highway: 'primary', lanes: '4', sidewalk: 'both' }
            : intent.preset === '1+1 with cycle lanes' ? { highway: 'residential', lanes: '2', sidewalk: 'both', cycleway: 'lane' }
                : intent.preset === '1+1' || !intent.preset ? { highway: 'residential', lanes: '2', sidewalk: 'both' } : null;
        if (!tags) fail('Road preset must be 2+2, 1+1 or 1+1 with cycle lanes');
        return d.profile.corridorProfileFromOsmTags(tags, undefined, drivingSideOf(intent));
    }
    // A road placed into a parcel (docs/road-in-parcel.md): its land is the site, its streets are
    // read from the site's shape, and the lanes asked for (or the automatic ones) are fitted to each
    // street's width with pavements and verges to the edges. One connected site, one road.
    function buildBoundedRoad(intent, d) {
        const site = polygon(intent.site, d);
        const inSite = load('__roadInSite', './proposals/road-in-site.js');
        const fit = load('__corridorSiteFit', './proposals/corridor-site-fit.js');
        const core = (intent.lanes || intent.preset) ? fit.coreOf(roadProfile(intent, d)) : null;
        const plan = inSite.roadsInSite(site, { core: core && core.length ? core : null, turn: intent.turn === true, drivingSide: drivingSideOf(intent) });
        const issue = inSite.blocking(plan.issues)[0];
        if (issue) {
            const group = plan.groups.find(g => g.key === issue.key);
            fail(issue.code === 'not-a-grid' ? 'The site does not read as straight streets; supply points for this road instead'
                : issue.code === 'disconnected' ? 'Parts of the site do not connect as one street network; draft one road per part'
                    : issue.code === 'too-narrow' ? `A street of the site is ${issue.widthM} m wide, too narrow for a lane`
                        : `The lanes need ${group ? group.requiredM : '?'} m with their pavements; a street of the site is ${issue.widthM} m wide`);
        }
        if (plan.roads.length !== 1) fail(`The site has ${plan.roads.length} separate parts; draft one road per part`);
        const definition = inSite.boundedDefinition(plan.roads[0]);
        Object.assign(definition, { kind: 'road', tunnels: [], drivingSide: drivingSideOf(intent) });
        definition.metadata = { ...intent.metadata, mode: 'bounded', type: 'road', isRoad: true, isTrack: false, isCorridor: true };
        const material = d.footprint.materialize(definition);
        definition.polygon = material.polygon;
        definition.constructionFrame = material.constructionFrame;
        return { goal: 'road-track', site: material.polygon, geometry: null, roadProposal: { definition: d.osm.toRecord(definition) } };
    }
    function buildRoad(intent, d) {
        if (intent.bounded === true && intent.kind === 'road') return buildBoundedRoad(intent, d);
        if (!Array.isArray(intent.points) || intent.points.length < 2 || intent.points.length > 200
            || intent.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(finite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85)) fail('A road needs 2–200 WGS84 [longitude, latitude] points');
        let profile = roadProfile(intent, d);
        if (intent.width != null) {
            if (!finite(intent.width) || intent.width < 1 || intent.width > 100) fail('Road width must be 1–100 metres');
            const ratio = intent.width / d.profile.corridorProfileWidth(profile);
            profile.strips = profile.strips.map(lane => ({ ...lane, width: lane.width * ratio }));
        }
        profile = d.osm.profileAtMillimetre(profile);
        if (d.profile.corridorProfileWidth(profile) > 100) fail('Road cross-section must be at most 100 metres');
        const points = intent.points.map(([lng, lat]) => ({ lat, lng }));
        const definition = { kind: 'road', points: [points], segments: [points], segmentIds: ['intent-street'], profile, width: d.profile.corridorProfileWidth(profile), tunnels: [], drivingSide: drivingSideOf(intent) };
        if (profile.strips.some(lane => lane.type === 'rail')) {
            const speed = intent.speed ?? intent.trackSpeed ?? 120;
            if (![50, 80, 120, 160, 200, 250].includes(speed)) fail('Track speed must be 50, 80, 120, 160, 200 or 250 km/h');
            const target = d.corridorGeometry.getMinCurvatureRadius(speed);
            const minimum = intent.minimumRadiusM ?? intent.trackMinRadius ?? target;
            if (!finite(minimum) || minimum < target || minimum > 100000) fail('Track minimumRadiusM must meet the selected speed target and be at most 100000 metres');
            if (d.corridorGeometry.measureCorridorCurvature([points], minimum).length) fail('Track bends violate the authored minimum radius; revise points or the speed target');
            definition.metadata = { ...intent.metadata, type: 'track', isTrack: true, isRoad: false, isCorridor: true, trackSpeed: speed, trackMinRadius: minimum };
        } else if (intent.kind === 'track') fail('A track cross-section needs at least one rail lane');
        const material = d.footprint.materialize(definition);
        definition.polygon = material.polygon;
        definition.constructionFrame = material.constructionFrame;
        return { goal: 'road-track', site: material.polygon, geometry: null, roadProposal: { definition: d.osm.toRecord(definition) } };
    }
    function build(intent, given) {
        const d = deps(given);
        if (!d.turf) fail('Turf geometry is unavailable');
        const site = ['road', 'track'].includes(intent.kind) ? null : polygon(intent.site, d);
        let record;
        if (['road', 'track'].includes(intent.kind)) record = buildRoad(intent, d);
        else if (intent.kind === 'space') {
            if (!['park', 'square', 'lake'].includes(intent.spaceKind)) fail('Space kind must be park, square or lake');
            record = { goal: intent.spaceKind, site, structureProposal: { kind: intent.spaceKind, geometry: site } };
        } else if (intent.kind === 'building') {
            if (intent.floors == null && intent.height == null) fail('Specify floors or height');
            if (intent.floors != null && (!Number.isInteger(intent.floors) || intent.floors < 1 || intent.floors > 200)) fail('Floors must be an integer from 1 to 200');
            const height = intent.height ?? intent.floors * 3;
            if (!finite(height) || height <= 0 || height > 800) fail('Building height must be 0–800 metres');
            const floors = intent.floors ?? Math.max(1, Math.floor(height / 3));
            const coverage = intent.coverage ?? 0.5;
            if (!finite(coverage) || coverage <= 0 || coverage > 1) fail('Coverage must be in (0, 1]');
            const footprint = intent.footprint ? polygon(intent.footprint, d)
                : d.turf.intersect(feature(site), d.turf.transformScale(feature(site), Math.sqrt(coverage)))?.geometry;
            if (!footprint || d.turf.area(feature(footprint)) < 1) fail('The requested building has no measurable footprint');
            const use = intent.use || 'residential';
            record = { goal: 'buildings', site, buildingProposal: { typologyType: 'single', parameters: { typology: 'single', floors, height, use, rotation: 0 } },
                geometry: { buildings: [{ type: 'Feature', geometry: footprint, properties: { type: 'proposedBuildingSingle', floors, height, use, rotation: 0 } }] } };
        } else if (intent.kind === 'parcel-layout') {
            const center = d.turf.centroid(feature(site)).geometry.coordinates;
            const plots = intent.algorithm === 'equal'
                ? d.layouts.equalPlots(feature(site), intent.count ?? 4, 0, center, { turf: d.turf, computeFeatureArea: d.turf.area })
                : d.layouts.schellingPlots(feature(site), d.grid.planFor({ lat: center[1] }), intent.plotLevel ?? 3, { turf: d.turf, SchellingGrid: d.grid }).plots;
            const parcelLayout = { algorithm: intent.algorithm || 'schelling', poolSource: 'site', pool: site, plots, totalArea: d.turf.area(feature(site)), generatedAt: intent.authoredAt || null };
            const checked = d.validation.validate(parcelLayout, { turf: d.turf, site });
            if (!checked.valid) fail(checked.errors.map(e => e.message).join('; '));
            record = { goal: 'parcel-layout', site, parcelLayout };
        } else if (intent.kind === 'urban-rule') {
            if (!intent.rule || typeof intent.rule !== 'object') fail('An urban rule needs its parameters');
            record = { goal: 'urban-rule', site, buildingProposal: { typologyType: 'urban-rule', parameters: copy(intent.rule) } };
            if (intent.rule.typology === 'row') {
                const building = load('IntentEditing', './intent-editing.js').rowEnvelope(site, intent.rule, d.turf);
                record.goal = 'row';
                record.buildingProposal = { typologyType: 'row', parameters: { ...copy(intent.rule), height: building.properties.height, rule: building.properties.urbanRule, seed: building.properties.variationSeed, manualMode: true } };
                record.geometry = { buildings: [building] };
            }
        } else fail('Unknown design kind');
        if (intent.kind === 'space' && intent.spaceKind === 'park') load('IntentEditing', './intent-editing.js').planting(record,
            { type: 'set_tree_count', count: intent.treeCount ?? 0 }, d.turf);
        return d.record.published({ ...record, title: intent.title, description: intent.description, author: intent.author,
            city: intent.city, toleranceM: intent.toleranceM, origin: intent.origin, createdAt: intent.authoredAt });
    }
    function move(points, metres, toward, d) {
        if (!finite(metres) || metres < 0 || metres > 100) fail('Shift must be 0–100 metres');
        const angle = { north: 0, east: 90, south: 180, west: 270 }[toward];
        if (angle == null) fail('Use north, south, east or west');
        const frame = d.frame.frameFor(points), radians = angle * Math.PI / 180;
        return points.map(p => { const xy = frame.toMetric(p); return frame.toLngLat([xy[0] + Math.sin(radians) * metres, xy[1] + Math.cos(radians) * metres]); });
    }
    // A junction splits one authored street into stretches. Whole-street conveniences still act
    // on that continuous line; genuinely separate strokes or differing profiles need granular edits.
    function streetPoints(entries, d) {
        if (!entries.length) fail('The road has no street stretches');
        const base = d.footprint.baseStretchId(entries[0].segmentId);
        const profile = JSON.stringify(entries[0].profile);
        const points = [];
        for (const entry of entries) {
            if (entries.length > 1 && (!base || d.footprint.baseStretchId(entry.segmentId) !== base || JSON.stringify(entry.profile) !== profile)) {
                fail('Whole-street modifications require one continuous street with one cross-section; use granular road edits for this network');
            }
            if (points.length) {
                const last = points.at(-1), first = entry.points[0];
                if (Math.abs(last.lat - first.lat) > 1e-7 || Math.abs(last.lng - first.lng) > 1e-7) fail('The street stretches are not continuous; use granular road edits');
            }
            points.push(...entry.points.slice(points.length ? 1 : 0));
        }
        return points.map(p => [p.lng, p.lat]);
    }
    function modify(design, changes, given) {
        const d = deps(given), record = copy(design);
        for (const change of changes) {
            if (change.type === 'retitle') record.title = change.value;
            else if (change.type === 'redescribe') record.description = change.value;
            else if (record.roadProposal && d.osm.toView(record.roadProposal.definition).bound) {
                // A road in a parcel keeps its ground: only its lanes change, fitted again to every
                // street of the same site.
                const view = d.osm.toView(record.roadProposal.definition);
                if (change.type !== 'set_profile') fail('A road in a parcel keeps its parcel; change its lanes with set_profile');
                Object.assign(record, buildBoundedRoad({ ...change, kind: 'road', bounded: true, site: view.bound.site, drivingSide: view.drivingSide, metadata: view.metadata }, d));
            } else if (record.roadProposal) {
                const view = d.osm.toView(record.roadProposal.definition);
                const entries = d.profile.corridorSegmentEntries(view);
                let points = streetPoints(entries, d);
                let lanes = copy(view.profile.strips);
                const oldWidth = d.profile.corridorProfileWidth(view.profile);
                if (change.type === 'set_profile') lanes = roadProfile({ ...change, drivingSide: view.drivingSide }, d).strips;
                else if (change.type === 'shift') points = move(points, change.metres, change.toward, d);
                else if (['widen', 'add_lane', 'remove_lane'].includes(change.type)) {
                    // Positive normal is the first strip. Reject a compass side parallel to the street.
                    const frame = d.frame.frameFor(points), a = frame.toMetric(points[0]), b = frame.toMetric(points[points.length - 1]);
                    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
                    const cardinal = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] }[change.side];
                    const dot = cardinal ? (-dy * cardinal[0] + dx * cardinal[1]) / length : 0;
                    if (change.type !== 'remove_lane' && change.side !== 'both' && Math.abs(dot) < 0.5) fail('Choose a compass side across this street');
                    if (change.type === 'widen') {
                        if (!finite(change.metres) || change.metres <= 0 || oldWidth + change.metres > 100) fail('Widening must be positive and keep width at most 100 metres');
                        lanes = lanes.map(l => ({ ...l, width: l.width * (oldWidth + change.metres) / oldWidth }));
                        if (change.side !== 'both') {
                            const normal = dot > 0 ? [-dy / length, dx / length] : [dy / length, -dx / length];
                            points = points.map(p => { const xy = frame.toMetric(p); return frame.toLngLat([xy[0] + normal[0] * change.metres / 2, xy[1] + normal[1] * change.metres / 2]); });
                        }
                    } else if (change.type === 'add_lane') {
                        if (!d.profile.CORRIDOR_LANE_TYPES[change.kind]) fail('Unknown lane kind');
                        const lane = { type: change.kind, width: d.profile.corridorStandardWidth(change.kind) };
                        if (dot > 0) lanes.unshift(lane); else lanes.push(lane);
                    } else {
                        if (!Number.isInteger(change.index) || change.index < 0 || change.index >= lanes.length || lanes.length < 2) fail('Choose an existing lane index and retain at least one lane');
                        lanes.splice(change.index, 1);
                    }
                } else fail('This change does not apply to a road');
                const built = buildRoad({ points, lanes, drivingSide: view.drivingSide, metadata: view.metadata, trackSpeed: view.metadata?.trackSpeed, trackMinRadius: view.metadata?.trackMinRadius, ...(view.metadata?.isTrack ? { kind: 'track' } : {}) }, d);
                Object.assign(record, built);
            } else if (record.structureProposal && change.type === 'set_kind') {
                if (!['park', 'square', 'lake'].includes(change.value)) fail('Unknown space kind');
                record.goal = change.value; record.structureProposal.kind = change.value;
            } else if (record.structureProposal && ['add_trees', 'set_tree_count'].includes(change.type)) {
                load('IntentEditing', './intent-editing.js').planting(record, change, d.turf);
            } else if (record.geometry?.buildings && ['set_floors', 'set_height', 'set_use', 'rotate', 'move', 'remove_building'].includes(change.type)) {
                load('IntentEditing', './intent-editing.js').buildings(record, change, d.turf);
            } else fail('This typed change does not apply to this design');
        }
        return d.record.published({ ...record, createdAt: record.authoredAt });
    }
    return { build, modify, roadProfile };
});
