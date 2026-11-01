// Typed construction adapters over the exact browser generators. Source parcels and corridor
// references are resolved by the caller; these functions never discover or fabricate source data.
import { appTurf as turf, intentDesign, intentEditing, constructorRuntime as runtime, corridorRuntime } from './mcp-geometry.js';
const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
const fail = (code, message, field, constraints) => { throw Object.assign(new Error(message), { code, field, constraints,
    next: { action: 'Correct the named construction parameters and retry.' } }); };
function number(value, fallback, field, min, max, integer = false) {
    const n = value ?? fallback;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail('invalid-construction-parameter', `${field} is outside its supported range.`, field, { minimum: min, maximum: max, ...(integer ? { integer: true } : {}) });
    return n;
}
function ruleKind(intent, fallback) {
    const kind = intent.ruleKind ?? fallback;
    if (!['max', 'range', 'exact'].includes(kind)) fail('invalid-rule', 'Choose max, range or exact.', 'ruleKind', { enum: ['max', 'range', 'exact'] });
    return kind;
}
function sourceParcels(parcels) {
    return parcels.map(entry => {
        const f = entry.feature || entry, id = f.id ?? f.properties?.parcelId;
        if (id == null || !f.geometry) fail('parcel-identity-required', 'Each source parcel needs its exact identity and polygon.', 'parcelIds', { required: true });
        return { feature: f, parcelId: String(id) };
    });
}
function siteOf(intent, parcels) {
    const site = intent.site || parcels.reduce((out, p) => out ? turf.union(out, p.feature) : p.feature, null)?.geometry;
    if (!site || !['Polygon', 'MultiPolygon'].includes(site.type) || !turf.area(feature(site)) || turf.area(feature(site)) > 1_000_000) fail('invalid-site', 'Supply a polygonal construction site of at most one square kilometre.', 'site', { maximumAreaM2: 1_000_000 });
    const bbox = turf.bbox(feature(site));
    if (bbox.some(n => !Number.isFinite(n)) || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -85 || bbox[3] > 85) fail('invalid-site', 'Construction site must use WGS84 coordinates.', 'site', { longitude: [-180, 180], latitude: [-85, 85] });
    return site;
}
function publish(intent, record) {
    return runtime.record.published({ ...record, title: intent.title, description: intent.description, author: intent.author,
        city: intent.city, toleranceM: intent.toleranceM, origin: intent.origin, createdAt: intent.authoredAt });
}
function station(intent, parcels) {
    const type = intent.stationType;
    if (!['bus', 'tram', 'underground', 'elevated'].includes(type)) fail('invalid-station-type', 'Choose a supported station type.', 'stationType', { enum: ['bus', 'tram', 'underground', 'elevated'] });
    if (!Array.isArray(intent.point) || intent.point.length !== 2 || !intent.point.every(n => typeof n === 'number' && Number.isFinite(n)) || Math.abs(intent.point[0]) > 180 || Math.abs(intent.point[1]) > 85) fail('invalid-station-point', 'Supply a WGS84 point.', 'point', { longitude: [-180, 180], latitude: [-85, 85] });
    if (intent.platformHeightM != null) number(intent.platformHeightM, 10, 'platformHeightM', 3, 40);
    // The placement engine tests standing proposals. Resolved immutable design references are
    // candidate alignments for this private design, not assertions that those corridors are applied.
    const proposals = (intent.corridors || []).map(row => ({ proposalId: row.cid,
        roadProposal: { definition: corridorRuntime.osm.toView((row.content || row.design || row).roadProposal?.definition) }, applied: true }));
    const placed = runtime.stations.resolvePlacementPreview(type, intent.point, { turfApi: turf, proposals, referenceAlignments: [],
        currentPlatformHeightM: intent.platformHeightM ?? 10, parcelEntries: parcels.map(p => p.feature), maxDistanceM: 24 });
    if (!placed?.valid) fail('station-alignment-required', 'Choose a compatible corridor within 24 metres of the station point.', 'corridors', { required: true, maximumSnapDistanceM: 24 });
    const structureProposal = runtime.stations.buildEditedStationStructure({ kind: 'station', stationType: type,
        center: placed.center, bearing: placed.bearing, platformHeightM: placed.platformHeightM,
        attachment: placed.alignment, blockName: null }, {}, turf, parcels.map(p => p.feature));
    return publish(intent, { goal: 'station', site: structureProposal.geometry, geometry: null, structureProposal });
}
export function buildTypedDesign(intent, { parcels = [] } = {}) {
    const entries = sourceParcels(parcels);
    if (intent.kind === 'station') return station(intent, entries);
    if (intent.kind === 'track') return intentDesign.build(intent, { turf });
    const typology = intent.typology || 'freeform';
    if (!['freeform', 'block', 'row', 'detached'].includes(typology)) fail('invalid-typology', 'Choose a supported building typology.', 'typology', { enum: ['freeform', 'block', 'row', 'detached'] });
    const site = siteOf(intent, entries);
    // Without an explicit seed each site gets its own stable variation, as the editor rolls a fresh one;
    // a constant default would give every agent-drafted rule the same example heights.
    const seed = number(intent.seed, runtime.rules.hashSeed(JSON.stringify(site)), 'seed', 0, 0xffffffff, true);
    const floorHeightM = number(intent.floorHeightM, typology === 'block' ? 3.5 : 3, 'floorHeightM', 0.5, 20);
    const defaultHeight = typology === 'block' ? 17.5 : typology === 'row' ? 12 : typology === 'detached' ? 15 : 10;
    const height = number(intent.height, intent.floors != null ? intent.floors * floorHeightM : defaultHeight, 'height', 0.5, 800);
    const floors = number(intent.floors, Math.max(1, Math.floor(height / floorHeightM)), 'floors', 1, 200, true);
    if (typology === 'freeform') {
        let footprint = intent.footprint;
        const explicitFootprint = Boolean(footprint);
        const rotation = number(intent.rotationDegrees, 0, 'rotationDegrees', -360, 360);
        if (!footprint && intent.coverage == null) {
            const [lng, lat] = turf.pointOnFeature(feature(site)).geometry.coordinates;
            const ring = runtime.singleBuilding.buildRectangleRing({ lng, lat }, {
                widthM: number(intent.depthM, 20, 'depthM', 1, 1000), lengthM: number(intent.lengthM, 20, 'lengthM', 1, 1000), rotationDeg: rotation
            });
            footprint = { type: 'Polygon', coordinates: [ring] };
        }
        if (explicitFootprint && rotation) footprint = runtime.singleBuilding.rotateGeometry(footprint, rotation);
        const design = intentDesign.build({ ...intent, kind: 'building', site, footprint, floors, height }, { turf });
        if (intent.offsetEastM != null || intent.offsetNorthM != null) design.geometry.buildings[0] = intentEditing.transform(design.geometry.buildings[0], {
            eastM: number(intent.offsetEastM, 0, 'offsetEastM', -1000, 1000), northM: number(intent.offsetNorthM, 0, 'offsetNorthM', -1000, 1000) });
        design.geometry.buildings[0].properties.rotation = rotation;
        design.geometry.buildings[0].properties.footprintMode = 'polygon';
        design.buildingProposal.parameters.rotation = rotation;
        return runtime.record.published({ ...design, goal: 'single', createdAt: design.authoredAt });
    }
    if (typology === 'row' && entries.length && new Set(entries.map(entry => entry.parcelId)).size < 2) fail('row-needs-two-parcels', 'Row houses need at least two selected parcels.', 'parcelIds', { minItems: 2, unique: true });
    if (!entries.length && typology !== 'row') fail('parcel-source-required', 'Building rules need exact source parcels.', 'parcelIds', { minItems: 1 });
    const minPlotAreaM2 = number(intent.minPlotAreaM2, 50, 'minPlotAreaM2', 0, 1_000_000);
    // Balconies may stand out of the envelope by balconyDepthM; a pitched roof adds an attic on top.
    if (intent.roof != null && !['flat', 'pitched'].includes(intent.roof)) fail('invalid-roof', 'Choose a flat or pitched roof.', 'roof', { enum: ['flat', 'pitched'] });
    // The design's use is its rule's (building-use.js): a Block may leave it automatic (shops on the
    // ground floor from five storeys), a Row or Detached rule starts as housing.
    const ruleUse = intent.use == null ? null : runtime.use.normalize(String(intent.use));
    if (intent.use != null && !ruleUse) fail('invalid-use', `Choose a building use: ${runtime.use.USES.join(', ')}.`, 'use', { enum: runtime.use.USES });
    const extras = { balconyDepthM: number(intent.balconyDepthM, 0, 'balconyDepthM', 0, 5), roof: intent.roof,
        use: ruleUse || (typology === 'block' ? null : 'residential') };
    if (typology === 'detached') {
        // The optional limits, each within the range the app's rule keeps (PARCEL_LIMITS); coverage is
        // the same (0, 1] fraction as a freeform design's.
        const limits = {};
        const limitFields = { frontSetbackM: 'frontSetbackM', rearSetbackM: 'rearSetbackM', setbackHeightRatio: 'setbackHeightRatio', maxHeightM: 'maxHeightM',
            minFrontageM: 'minFrontageM', coverage: 'maxCoverage', minNaturalGround: 'minNaturalGround', maxFloorAreaRatio: 'maxFloorAreaRatio', maxFootprintAreaM2: 'maxFootprintAreaM2' };
        for (const [field, key] of Object.entries(limitFields)) {
            if (intent[field] == null) continue;
            const [min, max] = runtime.rules.PARCEL_LIMITS[key];
            limits[key] = number(intent[field], null, field, min, max);
        }
        const rule = runtime.rules.normalizeParcelRule({ typology: 'parcelBased', kind: ruleKind(intent, 'max'), maxFloors: floors,
            floorHeightM, minDistance: number(intent.setbackM, 3, 'setbackM', 0, 50), minFloors: number(intent.minFloors, 0, 'minFloors', 0, floors, true),
            minFootprintAreaM2: number(intent.minFootprintAreaM2, 0, 'minFootprintAreaM2', 0, 1_000_000), minPlotAreaM2, ...limits, ...extras });
        // Front and rear yards are measured from the edge facing a street (the caller reads the
        // streets around the site); without them each plot's longest edge is its front, as in the app.
        const streets = Array.isArray(intent.streets) ? intent.streets : [];
        const buildings = [], excluded = [];
        for (const [index, entry] of entries.entries()) {
            const outcome = runtime.rules.evaluateParcel(entry.feature, rule, { turf, largestPolygon: runtime.footprints.toSingleLargestPolygon, streets });
            if (!outcome.envelope) { excluded.push({ parcelId: entry.parcelId, status: outcome.status }); continue; }
            outcome.envelope.properties = { ...outcome.envelope.properties, type: 'proposedParcelBasedBuilding', parcelId: entry.parcelId,
                urbanRule: rule, variationSeed: runtime.rules.hashSeed(seed, entry.parcelId), buildingIndex: index };
            buildings.push(outcome.envelope);
        }
        if (!buildings.length) fail('building-rule-no-room', 'No source parcel can satisfy this detached rule.', 'setbackM', { excluded });
        return publish(intent, { goal: 'parcelBased', site, buildingProposal: { typologyType: 'parcelBased', parameters: { ...rule, rule, seed } }, geometry: { buildings } });
    }
    const rule = runtime.rules.normalizeBlockRule({ typology: typology === 'row' ? 'row' : 'block', kind: ruleKind(intent, 'exact'),
        maxHeightM: height, minHeightM: number(intent.minHeightM, 0, 'minHeightM', 0, height),
        minDepthM: number(intent.minDepthM, 0, 'minDepthM', 0, 50), floorHeightM, minPlotAreaM2, ...extras });
    let depth = number(intent.depthM, typology === 'row' ? 10 : 15, 'depthM', 1, 1000);
    let massing, parameters;
    if (typology === 'row') {
        const rowParcels = entries.length ? entries.map(p => p.feature) : runtime.sitePlots.cutPlots(site, {
            plotWidthM: runtime.sitePlots.ROW_PLOT_WIDTH_M, turf
        });
        if (rowParcels.length < 2) fail('row-needs-two-plots', 'The site needs at least two row plots.', 'outline', { minItems: 2 });
        const block = { site: feature(site), parcels: rowParcels.map(p => ({ feature: p })) };
        const initial = { lengthM: 40, depthM: 10, height };
        const sizing = runtime.buildingRules.createRowPlacement(initial);
        const dimensions = intent.lengthM == null || intent.depthM == null ? sizing.calculate(block) : null;
        depth = number(intent.depthM, dimensions?.maxLength / 2, 'depthM', 1, 1000);
        const settings = { lengthM: number(intent.lengthM, dimensions?.maxLength, 'lengthM', 1, 1000), depthM: depth,
            chamferM: number(intent.chamferM, 0, 'chamferM', 0, 50), offsetEastM: number(intent.offsetEastM, 0, 'offsetEastM', -1000, 1000),
            offsetNorthM: number(intent.offsetNorthM, 0, 'offsetNorthM', -1000, 1000), rotationRadians: number(intent.rotationDegrees, 0, 'rotationDegrees', -360, 360) * Math.PI / 180, height };
        let placed;
        if (intent.offsetEastM != null || intent.offsetNorthM != null || intent.rotationDegrees != null) {
            const generated = runtime.buildingRules.rowFootprint(block, settings, { turf });
            placed = generated && { feature: generated.feature, offsetX: settings.offsetEastM, offsetY: settings.offsetNorthM, rotation: settings.rotationRadians };
        } else placed = runtime.buildingRules.createRowPlacement(settings).place(block, { rotation: settings.rotationRadians });
        massing = placed?.feature;
        if (!massing || !runtime.singleBuilding.footprintWithinBoundary(massing, feature(site), turf)) fail('row-no-room', 'The requested row does not fit the site; revise dimensions or offsets.', 'lengthM', { withinSite: true });
        settings.offsetEastM = placed.offsetX; settings.offsetNorthM = placed.offsetY; settings.rotationRadians = placed.rotation;
        parameters = { typology: 'row', length: settings.lengthM, width: depth, height, chamfer: settings.chamferM,
            offsetX: settings.offsetEastM, offsetY: settings.offsetNorthM, rotation: settings.rotationRadians, rule, seed, manualMode: false };
    } else {
        const setback = number(intent.setbackM, 2, 'setbackM', 0, 50), simplifyM = number(intent.simplifyM, 0, 'simplifyM', 0, 50);
        const shape = runtime.footprints.toSingleLargestPolygon(feature(site));
        if (!shape || site.type !== 'Polygon') fail('block-site-disconnected', 'Use one connected Polygon for each Block.', 'site', { type: 'Polygon' });
        const ring = runtime.buildingRules.blockRingOutline(shape, shape, { setback, width: depth, simplifyM });
        if (!ring?.outer) fail('block-no-room', 'No Block fits the requested setback.', 'setbackM', { withinSite: true });
        const positions = field => {
            const values = intent[field] || [];
            if (!Array.isArray(values) || values.length > 10 || values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) fail('invalid-block-controls', 'Use up to ten fractions from 0 to 1 along the outer ring.', field, { maximumItems: 10, minimum: 0, maximum: 1 });
            return [...values];
        };
        const gapPositions = positions('gapPositions'), wingPositions = positions('wingPositions');
        const gapWidthM = number(intent.gapWidthM, 5, 'gapWidthM', 1, 20), wingLengthM = number(intent.wingLengthM, 10, 'wingLengthM', 10, 200);
        const chamferM = number(intent.chamferM, 0, 'chamferM', 0, 50);
        if (!ring.inner && (gapPositions.length || wingPositions.length)) fail('block-courtyard-required', 'The courtyard collapsed; reduce the Block depth before adding gaps or wings.', 'depthM', { courtyardRequired: true });
        massing = runtime.buildingRules.blockMassingFromRing(ring, shape, { width: ring.widthAchieved, setback, simplifyM, height, chamferM, gapPositions, gapWidthM, wingPositions, wingLengthM });
        parameters = { typology: 'block', height, width: ring.widthAchieved, setback, simplifyM, chamfer: chamferM,
            gaps: gapPositions, gapWidth: massing.properties.gapWidth ?? gapWidthM, wings: wingPositions, wingLength: wingLengthM, rule, seed };
    }
    massing = runtime.rules.massingWithRule(massing, rule, seed, { turf });
    // The site-first Row editor saves the continuous massing, using synthetic plots for sizing;
    // splitting it into tiny synthetic pieces would wrongly exclude valid small buildings.
    const split = typology === 'row' && !entries.length ? { pieces: [massing] }
        : runtime.rules.splitMassingByParcels(massing, entries, rule, seed, { turf, largestPolygon: runtime.footprints.toSingleLargestPolygon });
    if (!split.pieces.length) fail('building-rule-no-room', 'No source parcel can satisfy this building rule.', 'parcelIds', { excluded: split.excluded });
    return publish(intent, { goal: typology === 'row' ? 'row' : 'buildings', site, buildingProposal: { typologyType: typology === 'row' ? 'row' : 'block', parameters },
        geometry: { buildings: split.pieces, ruleMassing: massing } });
}

// Granular edits must retain authored track targets and re-check the actual edited stretches.
export function validateTrackDesign(design, original) {
    if (!design?.roadProposal) return;
    const definition = design.roadProposal.definition;
    const view = corridorRuntime.osm.toView(definition);
    const previous = original?.roadProposal?.definition?.metadata;
    const metadata = view.metadata || {};
    const tracks = (view.profile?.strips || []).some(strip => strip.type === 'rail')
        || Object.values(view.segmentProfiles || {}).some(profile => profile.strips?.some(strip => strip.type === 'rail'));
    if (previous?.trackMinRadius != null && (!tracks || metadata.trackMinRadius == null || metadata.trackSpeed == null)) {
        fail('track-constraints-required', 'Retain the authored track speed and radius targets when editing a track.', 'roadProposal.definition.metadata', { required: ['trackSpeed', 'trackMinRadius'] });
    }
    if (!tracks) return;
    const speed = metadata.trackSpeed;
    if (![50, 80, 120, 160, 200, 250].includes(speed)) fail('invalid-track-speed', 'Choose a supported track design speed.', 'roadProposal.definition.metadata.trackSpeed', { enum: [50, 80, 120, 160, 200, 250] });
    const minimum = metadata.trackMinRadius;
    const target = corridorRuntime.geometry.getMinCurvatureRadius(speed);
    if (typeof minimum !== 'number' || !Number.isFinite(minimum) || minimum < target || minimum > 100000) fail('invalid-track-radius', 'The minimum track radius must meet its speed target.', 'roadProposal.definition.metadata.trackMinRadius', { minimum: target, maximum: 100000 });
    const segments = view.segments || view.points || [];
    const violations = corridorRuntime.geometry.measureCorridorCurvature(segments, minimum);
    if (violations.length) fail('track-curvature-constraint', 'Edited track bends violate the authored minimum radius.', 'roadProposal.definition.osm', { minimumRadiusM: minimum, violations });
}
