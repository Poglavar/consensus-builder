// Read-only viewport envelopes reuse the parcel-study evidence and dimensional evaluator.
// Each parcel yields one outer bound plus the configurations (housing types) it may be built as.
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { sourcesFor } from './sources.js';
import { STUDY_MAX_PARCEL_M2, asPolygonParcel, assembleParcelStudy, formsLand, parcelRecords, parcelZones, readStudyZoning, studyParcelSource, withScenarioSource, zoneLots } from './parcel-study.js';
import { runtimeParcelSource } from '../parcels/sources.js';
import { validateBounds } from '../parcels/source-contract.js';
import { configurationTreatments } from './providers/atlas.js';
import { edgeStanding, streetWidthAcross } from './street-width.js';
import { addCorridorStreets, composeGovernmentLots, corridor, expandBounds, keepsGovernmentLot, plotRecord, plotReference, replaceCadastre, touches as intersects, validatePlanPlots } from './plan-plots.js';
const require = createRequire(import.meta.url);
const core = require('../../frontend/js/planning/parcel-assessment.js');
const plots = require('../../frontend/js/proposals/site-plots.js');
const fail = (code, status = 422) => { throw Object.assign(new Error(code), { code, status }); };
const knownReasons = ['overlapping-parcel-identities', 'use-prohibited', 'use-not-recorded', 'status-not-configurable', 'missing-direct-height', 'empty-supported-bound',
    'unsupported-parcel-shape', 'study-multiple-zoning-areas', 'study-zoning-missing', 'envelope-geometry-error', 'plan-plot-source-conflict'];

export function parcelOverlapProblems(records, geometryOps = turf) {
    const problems = new Map();
    for (let a = 0; a < records.length; a++) for (let b = a + 1; b < records.length; b++) {
        if (!intersects(records[a].bbox, records[b].bbox)) continue;
        try {
            const overlap = geometryOps.intersect(records[a].parcel, records[b].parcel);
            if (overlap && geometryOps.area(overlap) > 0.01) {
                for (const index of [a, b]) if (!problems.has(records[index].parcel.id)) {
                    problems.set(records[index].parcel.id, 'overlapping-parcel-identities');
                }
            }
        } catch (_) {
            // Never repair source vertices or treat a failed intersection as proof of non-overlap.
            for (const index of [a, b]) problems.set(records[index].parcel.id, 'envelope-geometry-error');
        }
    }
    return problems;
}

const lotUnitsM2 = { acres: 4046.8564224, m2: 1, sqft: 0.09290304 };
// Whether the parcel reaches a housing type's recorded minimum lot. A platted lot below it is
// still drawn, flagged: the source records a minimum for new lots, not that this one is unbuildable.
export function lotAreaTest(parcelM2, constraints = []) {
    const lot = constraints.find(c => c.quantity === 'lotArea' && ['direct', 'literal'].includes(c.evidence) && Number.isFinite(c.value) && lotUnitsM2[c.unit]);
    const minimumM2 = lot ? lot.value * lotUnitsM2[lot.unit] : null;
    return { status: minimumM2 === null ? 'unknown' : parcelM2 + 0.01 >= minimumM2 ? 'pass' : 'fail', minimumM2, parcelM2 };
}

const LENGTH_M = { m: 1, ft: 0.3048 }, SETBACKS = ['frontSetback', 'sideSetback', 'rearSetback'];
const metres = constraint => core.constraintValue(constraint, LENGTH_M);
const trimmed = bound => ({ geometry: bound.geometry, areaM2: bound.areaM2, heightM: bound.heightM, interpretations: bound.interpretations, edges: bound.edges });
// A yard that starts above the ground (`fromHeightM` on a setback constraint: a side yard from
// the second floor, a street-wall setback above the facade height) makes the bound a stack of
// tiers: from each level up, the deepest yard of each role that has started applies. Without
// such a yard the bound is the evaluator's single prism.
export function tieredBound(context, frontEdge, geometryOps = turf) {
    const constraints = context.source.constraints || [];
    const heightM = constraints.filter(c => c.quantity === 'height').map(metres).find(Number.isFinite) ?? null;
    const starts = constraints.filter(c => SETBACKS.includes(c.quantity) && Number.isFinite(c.fromHeightM) && c.fromHeightM > 0
        && (heightM === null || c.fromHeightM < heightM)).map(c => c.fromHeightM);
    const levels = [0, ...new Set(starts)].sort((a, b) => a - b);
    const derive = source => Number.isInteger(frontEdge)
        ? { ...core.derive({ ...context, source }, frontEdge, geometryOps), interpretations: 1, edges: [frontEdge] }
        : core.unorientedEnvelope({ ...context, source }, geometryOps);
    if (levels.length === 1) { const bound = derive(context.source); return [{ baseM: 0, topM: bound.heightM, ...trimmed(bound) }]; }
    return levels.map((baseM, i) => {
        const active = SETBACKS.flatMap(quantity => {
            const started = constraints.filter(c => c.quantity === quantity && (c.fromHeightM ?? 0) <= baseM && metres(c) !== null);
            return started.length ? [started.reduce((deepest, c) => metres(c) > metres(deepest) ? c : deepest)] : [];
        });
        const bound = derive({ ...context.source, constraints: [...constraints.filter(c => !SETBACKS.includes(c.quantity)), ...active] });
        return { baseM, topM: levels[i + 1] ?? bound.heightM, ...trimmed(bound) };
    });
}
// The floor area a stack of tiers holds for a storey count: each storey takes the tier its top reaches.
export function floorAreaM2(tiers, storeys, heightM) {
    if (!Number.isInteger(storeys) || storeys <= 0 || !(heightM > 0) || !tiers.length) return null;
    const storeyM = heightM / storeys;
    let total = 0;
    for (let k = 1; k <= storeys; k++) {
        const top = k * storeyM, tier = [...tiers].reverse().find(entry => entry.baseM < top - 1e-6) || tiers[0];
        total += tier.geometry ? tier.areaM2 : 0;
    }
    return total;
}

// One configuration per usable housing type. A configuration without a supported height or
// without space inside its supported setbacks is listed with its reason, never drawn.
export function parcelConfigurations(baseContext, scenarios, zonesByScenario, geometryOps = turf, frontEdge = null) {
    const configurations = [], excluded = {};
    let parcelM2 = null;
    const parcelArea = () => parcelM2 ??= geometryOps.area(baseContext.parcel);
    for (const scenario of scenarios) {
        const context = withScenarioSource(baseContext, zonesByScenario[scenario]);
        const treatment = context?.source.assessment.status || null;
        if (!context || !configurationTreatments.includes(treatment)) { excluded[scenario] = treatment || 'unrecorded'; continue; }
        let tiers, unavailableReason = null;
        try { tiers = tieredBound(context, frontEdge, geometryOps); }
        catch (error) { unavailableReason = error.message === 'unsupported-parcel-shape' ? error.message : 'envelope-geometry-error'; }
        const bound = tiers?.[0];
        if (!unavailableReason && (bound.heightM === null || bound.heightM <= 0)) unavailableReason = 'missing-direct-height';
        else if (!unavailableReason && !bound.geometry) unavailableReason = 'empty-supported-bound';
        const storeys = context.source.constraints?.find(c => c.quantity === 'storeys' && Number.isInteger(c.value))?.value ?? null;
        configurations.push({ id: scenario, treatment, unavailableReason,
            volumes: unavailableReason ? [] : tiers.filter(tier => tier.geometry && tier.topM > tier.baseM)
                .map((tier, i) => ({ id: i === 0 ? `${scenario}:bound` : `${scenario}:tier-${i}`, geometry: tier.geometry, baseM: tier.baseM, topM: tier.topM })),
            metrics: unavailableReason ? { footprintM2: null, heightM: null, floorAreaM2: null }
                : { footprintM2: bound.areaM2, heightM: bound.heightM, floorAreaM2: storeys ? floorAreaM2(tiers, storeys, bound.heightM) : null },
            // A configuration the project must opt into (an incentive) says so; the map shows it only when asked.
            ...(context.source.assessment.condition ? { condition: context.source.assessment.condition } : {}),
            edgeInterpretations: bound?.interpretations ?? 0, frontEdges: bound?.edges, constraints: context.source.constraints,
            lotArea: lotAreaTest(parcelArea(), context.source.constraints), sourceReference: context.sourceReference });
    }
    const frontEdges = configurations.find(configuration => configuration.frontEdges)?.frontEdges || [];
    for (const configuration of configurations) delete configuration.frontEdges;
    return { configurations, excluded, frontEdges };
}

// The outer bound is everything any configuration permits: joined footprints, tallest height,
// and between any two levels the ground some configuration's volume covers there. A level only
// configurations with a condition (an incentive's extra storeys) reach carries that condition;
// `grantedHeightM` is the top of what the unconditional ones permit.
export function outerBound(configurations, geometryOps = turf) {
    const volumes = configurations.flatMap(configuration => configuration.volumes.map(volume => ({ ...volume, condition: configuration.condition || null })));
    if (!volumes.length) return null;
    const union = list => list.map(volume => volume.geometry)
        .reduce((joined, next) => joined ? geometryOps.union(geometryOps.feature(joined), geometryOps.feature(next)).geometry : next, null);
    const geometry = union(volumes);
    const levels = [...new Set(volumes.flatMap(volume => [volume.baseM, volume.topM]))].sort((a, b) => a - b);
    // Grounds here are nested yard offsets of one lot: equal area and box means the same ground,
    // without a clipping pass per level.
    const sameGround = (a, b) => Math.abs(geometryOps.area(geometryOps.feature(a)) - geometryOps.area(geometryOps.feature(b))) < 0.01
        && geometryOps.bbox(a).every((value, i) => Math.abs(value - geometryOps.bbox(b)[i]) < 1e-9);
    const tiers = [];
    for (let i = 0; i < levels.length - 1; i++) {
        const baseM = levels[i], topM = levels[i + 1];
        const covering = volumes.filter(volume => volume.baseM <= baseM + 1e-6 && volume.topM >= topM - 1e-6);
        if (!covering.length) continue;
        const ground = union(covering), last = tiers.at(-1);
        const condition = covering.every(volume => volume.condition) ? [...new Set(covering.map(volume => volume.condition))].join('; ') : null;
        // Consecutive levels with the same ground and the same standing are one prism.
        if (last && last.topM === baseM && (last.condition ?? null) === condition && sameGround(last.geometry, ground)) last.topM = topM;
        else tiers.push({ baseM, topM, geometry: ground, ...(condition ? { condition } : {}) });
    }
    const granted = volumes.filter(volume => !volume.condition);
    return { geometry, heightM: Math.max(...volumes.map(volume => volume.topM)), grantedHeightM: granted.length ? Math.max(...granted.map(volume => volume.topM)) : null,
        areaM2: geometryOps.area(geometryOps.feature(geometry)), tiers };
}

// Statuses that say nothing usable about the use; any other recorded status is a source
// decision (a handed-off instrument, a conservation regime) that yields no buildable height here.
// The height only a condition reaches, with that condition. It keeps the zone's condition code (which
// the app translates) only when the zone's condition is the one the bound reaches.
export function conditionalOf(bound, zone) {
    const condition = [...new Set(bound.tiers.map(tier => tier.condition).filter(Boolean))].join('; ');
    const code = zone?.metrics?.conditional?.condition === condition ? zone.metrics.conditional.conditionCode : null;
    return { heightM: bound.heightM, condition, ...(code ? { conditionCode: code } : {}) };
}
const silentStatuses = new Set(['unrecorded', 'nomention', 'overlay', 'unknown']);
function omissionReason(configurations, excluded) {
    if (!configurations.length) {
        const statuses = Object.values(excluded);
        if (statuses.includes('prohibited')) return 'use-prohibited';
        return statuses.every(status => !status || silentStatuses.has(status)) ? 'use-not-recorded' : 'status-not-configurable';
    }
    const reasons = configurations.map(configuration => configuration.unavailableReason);
    for (const reason of ['missing-direct-height', 'empty-supported-bound', 'unsupported-parcel-shape']) if (reasons.includes(reason)) return reason;
    return 'envelope-geometry-error';
}

// One cached source read covers the full parcels and the scorer's reach beyond their lot lines.
// Missing or partial streets cannot establish a preferred front; retain the unoriented bound.
async function readFrontageStreets(bounds, streetProvider) {
    if (!streetProvider) return null;
    const [w, s, e, n] = bounds, marginM = plots.FRONTAGE_STREET_MAX_DISTANCE_M + 5;
    const dLat = marginM / 111320, dLng = dLat / Math.cos((s + n) / 2 * Math.PI / 180);
    try {
        const data = await streetProvider.near([w - dLng, s - dLat, e + dLng, n + dLat]);
        return data?.type === 'FeatureCollection' && Array.isArray(data.features) && !data.partial && !data.truncated ? data : null;
    } catch (_) { return null; }
}

// Streets with their boxes, so each lot scores only the streets within frontage reach of it.
function streetIndex(streets) {
    return streets ? streets.features.map(feature => ({ feature, bbox: turf.bbox(feature) })) : null;
}
function parcelFrontage(parcel, streets, index) {
    if (!streets) return { frontEdge: null, evidence: { basis: 'unknown', reason: 'street-data-unavailable' } };
    const [w, s, e, n] = turf.bbox(parcel), marginM = plots.FRONTAGE_STREET_MAX_DISTANCE_M + 5;
    const dLat = marginM / 111320, dLng = dLat / Math.cos((s + n) / 2 * Math.PI / 180);
    const reach = [w - dLng, s - dLat, e + dLng, n + dLat];
    const nearby = index.filter(entry => intersects(entry.bbox, reach)).map(entry => entry.feature);
    const scores = plots.frontageScores(parcel, nearby, { turf }), best = scores[0];
    if (!best) return { frontEdge: null, evidence: { basis: 'unknown', reason: 'no-facing-street', source: streets.source } };
    return { frontEdge: best.index, evidence: { basis: 'street', source: streets.source, street: best.street,
        distanceM: best.distanceM, score: best.score, candidateEdges: scores.map(edge => edge.index) } };
}

// Lots a street's width beyond the view are read too, so a lot at the view's edge still finds the
// lot line across its street; only lots in the view get envelopes.
const asRecord = parcel => ({ parcel, bbox: turf.bbox(parcel) });
const obstacleOf = ({ parcel, bbox }) => ({ id: parcel.id, geometry: parcel.geometry, bbox });
const fullExtent = (initial, records) => records.reduce((box, { bbox }) => [Math.min(box[0], bbox[0]), Math.min(box[1], bbox[1]),
    Math.max(box[2], bbox[2]), Math.max(box[3], bbox[3])], initial);

// Lot-record adapters reuse their saved answers on unchanged land. They receive the same plot,
// street and neighbour geometry as the dimensional evaluator when the parcel fabric changes.
async function savedParcelEnvelopes(provider, pool, query, authored, streetProvider) {
    const items = [], unavailable = [];
    let after = null, stored, omitted = 0, count = 0;
    const replaced = new Set(authored.flatMap(plot => plot.cadastreParcelIds));
    do {
        const page = await provider.query(pool, { ...query, limit: 200, after });
        stored ??= page.summary;
        for (const item of page.items) if (!replaced.has(item.source?.parcel)) items.push(item);
        count += page.items.length + (page.omitted || 0);
        omitted += page.omitted || 0;
        after = page.nextAfter;
        if (count > 1000 || (after != null && count >= 1000)) fail('envelope-area-too-large', 400);
    } while (after != null);
    let summary;
    if (authored.length) {
        const live = authored.map(plotRecord);
        const extent = fullExtent(query.bbox, live);
        const [ground, baseStreets] = await Promise.all([provider.plotGround(pool, expandBounds(extent, 45), authored),
            readFrontageStreets(extent, streetProvider)]);
        if (ground.complete !== true) fail('study-parcel-incomplete', 503);
        const composition = replaceCadastre(ground.features.map(feature => feature.id ? feature : { ...feature, id: feature.properties.parcelId }), authored);
        summary = composition.summary;
        const remaining = composition.remaining.map(asRecord);
        const conflicts = parcelOverlapProblems([...remaining, ...live]);
        const buildable = live.filter(({ plot }) => !corridor(plot));
        const neighbours = [...remaining, ...buildable].map(obstacleOf);
        const streets = addCorridorStreets(baseStreets, live), index = streetIndex(streets);
        // A conflicting saved parcel is also unavailable. Its building footprint cannot settle a
        // parcel boundary dispute; use the cadastral read above, including results without massing.
        for (let i = items.length - 1; i >= 0; i--) {
            const id = items[i].source?.parcel;
            if (conflicts.has(id)) { items.splice(i, 1); unavailable.push({ parcelId: id, reason: conflicts.get(id) }); }
        }
        for (const { parcel, plot, bbox } of buildable) {
            if (!intersects(bbox, query.bbox)) continue;
            if (items.length + unavailable.length >= 1000) fail('envelope-area-too-large', 400);
            const reference = plotReference(plot);
            const frontage = parcelFrontage(parcel, streets, index);
            const result = conflicts.has(parcel.id) ? { reason: conflicts.get(parcel.id) }
                : await provider.evaluatePlot(pool, { city: query.city, scenario: query.scenario || provider.descriptor.scenario, parcel, plot,
                    frontage, obstacles: neighbours, streets, standing: () => edgeStanding(parcel, neighbours, streets) });
            if (!result.item) { unavailable.push({ parcelId: parcel.id, reason: result.reason, parcelReference: reference,
                ...(result.evidence ? { evidence: result.evidence } : {}) }); continue; }
            const item = result.item;
            items.push({ ...item, id: `envelope:${provider.descriptor.id}:${plot.id}`, source: { ...item.source, parcel: plot.id },
                derivation: { ...item.derivation, parcel: parcel.geometry },
                sourceEvidence: { ...item.sourceEvidence, parcelReference: reference, frontage: frontage.evidence } });
        }
    }
    return { schemaVersion: 'planning-representations.v1', city: query.city, sources: [provider.descriptor], items,
        coverage: 'source-results', nextCursor: null, truncated: false, omitted, unavailable,
        summaries: [{ ...stored, sourceId: provider.descriptor.id, ...(summary ? { planPlots: summary, withGeometry: items.length } : {}) }] };
}

export async function loadParcelEnvelopes(query, { sources, parcelProvider = descriptor => runtimeParcelSource(descriptor), streetProvider, pool } = {}) {
    validateBounds(query.bbox, 0.5);
    const provider = sourcesFor(query, sources)[0];
    if (!query.source || !provider) fail('study-unavailable');
    const authored = validatePlanPlots(query.plots ?? [], query.bbox);
    if (provider.evaluatePlot) return savedParcelEnvelopes(provider, pool, query, authored, streetProvider);
    const descriptor = studyParcelSource(provider, query.city);
    const cadastre = parcelProvider(descriptor);
    const parcels = await cadastre.queryBounds(expandBounds(query.bbox, 45));
    if (parcels.complete !== true) fail('study-parcel-incomplete', 503);
    // Every outline below (frontage edge indices, derivation.parcel) is a Polygon's outer ring.
    const { remaining, summary } = replaceCadastre(parcels.features.map(asPolygonParcel), authored);
    const live = authored.map(plotRecord), buildingLots = live.filter(({ plot }) => !corridor(plot));
    const cadastral = remaining.map(asRecord);
    const all = [...cadastral, ...buildingLots].filter(lot => intersects(lot.bbox, query.bbox));
    // A lot over the study limit gets no envelope, so it must not widen the zoning read either: one
    // field kilometres across (common in Alatau) pulled hundreds of zones into every area, which
    // failed as study-zoning-incomplete for the whole view.
    // Query zoning across full parcel outlines, not just the viewport (a corner can cross a zone),
    // and across the viewport itself: a zoning area that is its own lot is found there, parcels or not.
    const fullBounds = fullExtent(query.bbox, all.filter(({ parcel }) => turf.area(parcel) <= STUDY_MAX_PARCEL_M2));
    const scenarios = provider.descriptor.scenarios || [provider.descriptor.scenario];
    const streetsRead = all.length ? readFrontageStreets(fullBounds, streetProvider) : null;
    const zoneEntries = await Promise.all(scenarios.map(async scenario => [scenario, await readStudyZoning(provider, { ...query, scenario }, fullBounds)]));
    const zonesByScenario = Object.fromEntries(zoneEntries);
    // The plan's own lots: its land-forming zoning areas, every one read as a neighbour across a
    // street and those in the view drawn.
    const planLots = zonesByScenario[scenarios[0]].filter(formsLand).flatMap(zoneLots);
    const { ground, conflicts, claimed } = composeGovernmentLots(planLots, live, query.source);
    const viewport = turf.bboxPolygon(query.bbox);
    const planInView = ground.filter(lot => {
        if (!intersects(lot.bbox, query.bbox)) return false;
        const inside = turf.intersect(lot.parcel, viewport);
        return inside && turf.area(inside) > 0.01;
    });
    if (planInView.length > 1000 || (!planLots.length && all.length > 1000)) fail('envelope-area-too-large', 400);
    const streets = addCorridorStreets(await (streetsRead || (planInView.length ? readFrontageStreets(fullBounds, streetProvider) : null)), live);
    const streetsNearby = streetIndex(streets);
    // Keep the original cadastral shape for a parcel regulated by several zones. Its land under a
    // government lot is already represented by that lot and cannot conflict with the layout on it.
    const overlapProblems = parcelOverlapProblems([...cadastral, ...live.filter(({ parcel }) => !claimed.has(parcel.id))]
        .filter(record => intersects(record.bbox, expandBounds(query.bbox, 45))));
    if (claimed.size) for (const [id, reason] of parcelOverlapProblems(live)) overlapProblems.set(id, reason);
    for (const [id, reason] of conflicts) overlapProblems.set(id, reason);
    const planObstacles = [...ground, ...buildingLots].map(obstacleOf);
    const obstacles = [...cadastral, ...buildingLots].map(obstacleOf);
    let standingNeighbours;
    const neighboursForStanding = () => {
        if (!provider.descriptor.parcelStanding || fullBounds.every((value, i) => value === query.bbox[i])) return obstacles;
        // The far edge of a large plot can lie outside this display cell. All Renovación lots and
        // scenarios in the request share one full-outline neighbour read when that happens.
        return standingNeighbours ??= cadastre.queryBounds(expandBounds(fullBounds, 45)).then(answer => {
            if (answer.complete !== true) fail('study-parcel-incomplete', 503);
            const all = replaceCadastre(answer.features.map(asPolygonParcel), authored);
            return [...all.remaining.map(asRecord), ...buildingLots].map(obstacleOf);
        });
    };
    const records = [...all, ...planInView];
    const items = [], unavailable = [];
    let evaluated = 0;
    for (const { parcel, zone = null, plot } of records) {
        // Each lot is CPU work on the API's one thread; yielding between lots lets other requests
        // (the parcel relay among them) answer while a large block is being drawn.
        await new Promise(resolve => setImmediate(resolve));
        try {
            // A parcel wholly under land-forming zoning areas gets no envelope: those areas stand for
            // its land. Where the provider reads its rules under the lot, the zones are known later.
            let found = provider.parcelRecords ? null : parcelZones(parcel, zonesByScenario[scenarios[0]]);
            const usesPart = part => !formsLand(part.source) || plot && !keepsGovernmentLot(plot, query.source, part.source.source.recordId);
            const replaced = () => !zone && found.major.length > 0 && !found.major.some(usesPart);
            if (found && replaced()) continue;
            if (++evaluated > 1000) fail('envelope-area-too-large', 400);
            if (overlapProblems.has(parcel.id)) fail(overlapProblems.get(parcel.id));
            if (turf.area(parcel) > STUDY_MAX_PARCEL_M2) fail('unsupported-parcel-shape');
            const frontage = parcelFrontage(parcel, streets, streetsNearby);
            const neighbours = zone || claimed.has(parcel.id) ? planObstacles : obstacles;
            const street = frontage.frontEdge === null ? { widthM: null, hits: [], reason: 'no-front-edge' }
                : streetWidthAcross(parcel, frontage.frontEdge, neighbours);
            let lotStanding;
            const standing = () => lotStanding ??= Promise.resolve(zone || claimed.has(parcel.id) ? planObstacles : neighboursForStanding()).then(ground =>
                ({ ...edgeStanding(parcel, ground, streets, { frontEdge: frontage.frontEdge }), cessionM2: plot?.cessionM2 ?? 0 }));
            // What the provider may ask of the lot: the floor area a candidate set of constraints leaves on it.
            const measure = constraints => {
                const tiers = tieredBound({ parcel, source: { constraints } }, frontage.frontEdge, turf);
                const storeys = constraints.find(c => c.quantity === 'storeys' && Number.isInteger(c.value))?.value ?? null;
                return { floorAreaM2: floorAreaM2(tiers, storeys, tiers[0].heightM), tiers };
            };
            const zones = provider.parcelRecords ? Object.fromEntries(await Promise.all(scenarios.map(async scenario =>
                [scenario, await parcelRecords(provider, parcel, zonesByScenario[scenario], { frontEdge: frontage.frontEdge, streetWidthM: street.widthM, measure, standing })]))) : zonesByScenario;
            const scenarioZones = zones[scenarios[0]];
            found ??= parcelZones(parcel, scenarioZones);
            if (replaced()) continue;
            if (found.stacked) fail('study-multiple-zoning-areas');
            // A plan lot is drawn under its own zoning area; a parcel under each part that keeps it.
            const parts = zone ? found.major.filter(part => part.source.source.recordId === zone) : found.major.filter(usesPart);
            if (!parts.length) fail('study-zoning-missing');
            const failures = [];
            // One envelope per zoning area that partitions the lot: the whole lot's bound, clipped to that part.
            for (const part of parts) {
                try {
                    const recordId = part.source.source.recordId;
                    const context = assembleParcelStudy(parcel, descriptor, scenarioZones, { zone: recordId, zones: found });
                    const { configurations, excluded, frontEdges } = parcelConfigurations(context, scenarios, zones, turf, frontage.frontEdge);
                    const bound = outerBound(configurations);
                    if (!bound) fail(omissionReason(configurations, excluded));
                    const id = `envelope:${provider.descriptor.id}:${parcel.id}${found.major.length > 1 ? `~${recordId}` : ''}`;
                    items.push({ id, role: 'permitted', proposalId: null, parcelEnvelope: true,
                        // Absent, the envelope stands on a parcel (docs/vocabulary.md, Land basis).
                        ...(zone ? { landBasis: 'zone' } : {}),
                        title: zone ? context.source.title : `${context.source.title} · ${parcel.properties.parcelNumber}`,
                        // The zone's use (docs/vocabulary.md, Permitted use), so the app names the envelope in the reader's language.
                        ...(context.source.use ? { use: context.source.use } : {}),
                        source: { ...context.source.source, scenario: null, ...(zone ? {} : { parcel: parcel.id }) }, site: bound.geometry, areas: [],
                        volumes: bound.tiers.map((tier, index) => ({ id: `${id}:bound${index ? `-${index}` : ''}`, geometry: tier.geometry, baseM: tier.baseM, topM: tier.topM,
                            ...(tier.condition ? { condition: tier.condition } : {}) })),
                        configurations: configurations.map(configuration => ({ ...configuration,
                            volumes: configuration.volumes.map(volume => ({ ...volume, id: `${id}:${volume.id}` })) })),
                        // Retain original lot lines and the edge interpretations used by the evaluator.
                        derivation: { parcel: parcel.geometry, covered: context.coveredGeometry, frontEdges },
                        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
                        authority: { effect: 'unknown', applicability: 'unresolved' },
                        assessment: { meaning: 'outer-bound', status: 'unresolved', geometry: zone ? 'derived-zone' : 'derived-parcel', constraints: 'partial', current: true },
                        // The height is what the rules grant; an incentive's extra height stands beside it with its condition.
                        metrics: { footprintM2: bound.areaM2, heightM: bound.grantedHeightM, ...(bound.heightM > (bound.grantedHeightM ?? 0)
                            ? { conditional: conditionalOf(bound, context.source) } : {}) },
                        constraints: [],
                        sourceEvidence: { zoningRecordId: recordId, parcelReference: plot ? plotReference(plot) : zone ? null : context.parcelReference,
                            ...(zone ? { planningArea: { source: query.source, recordId: zone, lotId: parcel.id } } : {}),
                            ...(context.source.sourceEvidence?.resultante ? { resultante: context.source.sourceEvidence.resultante } : {}),
                            sourceCoverage: context.sourceCoverage, parts: found.major.length, frontEdge: frontage.frontEdge, frontage: frontage.evidence, streetWidth: street,
                            excludedConfigurations: excluded, envelopeMeaning: frontage.frontEdge === null
                                ? 'outer-bound-across-configurations-and-front-edge-interpretations' : 'outer-bound-across-configurations' } });
                } catch (error) {
                    if (error.status === 503) throw error;
                    failures.push(error.code || error.message);
                }
            }
            // A lot is unavailable only when none of its parts could be drawn.
            if (failures.length === parts.length) fail(failures[0]);
        } catch (error) {
            // A failed upstream read is the whole request's failure, never one parcel's geometry problem.
            if (error.status === 503 || error.status === 400) throw error;
            const reason = knownReasons.includes(error.code || error.message) ? error.code || error.message : 'envelope-geometry-error';
            if (reason === 'envelope-geometry-error' && process.env.PLANNING_ENVELOPE_DEBUG) console.warn(`[${new Date().toISOString()}] [planning-envelopes] ${parcel.id}: ${error.stack || error.message}`);
            unavailable.push({ parcelId: parcel.id, reason });
        }
    }
    return { schemaVersion: 'planning-representations.v1', city: query.city, sources: [provider.descriptor], items,
        coverage: 'source-results', nextCursor: null, truncated: false, omitted: 0,
        summaries: [{ sourceId: provider.descriptor.id, cachedResults: evaluated, withGeometry: items.length,
            withoutGeometry: unavailable.length, statuses: {}, ...(authored.length ? { planPlots: summary } : {}) }], unavailable };
}
