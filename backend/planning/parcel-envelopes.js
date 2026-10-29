// Read-only viewport envelopes reuse the parcel-study evidence and dimensional evaluator.
// Each parcel yields one outer bound plus the configurations (housing types) it may be built as.
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { sourcesFor } from './sources.js';
import { assembleParcelStudy, parcelRecords, parcelZones, readStudyZoning, studyParcelSource, withScenarioSource } from './parcel-study.js';
import { runtimeParcelSource } from '../parcels/sources.js';
import { validateBounds } from '../parcels/source-contract.js';
import { configurationTreatments } from './providers/atlas.js';
import { streetWidthAcross } from './street-width.js';
const require = createRequire(import.meta.url);
const core = require('../../frontend/js/planning/parcel-assessment.js');
const plots = require('../../frontend/js/proposals/site-plots.js');
const fail = (code, status = 422) => { throw Object.assign(new Error(code), { code, status }); };
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const knownReasons = ['overlapping-parcel-identities', 'use-prohibited', 'use-not-recorded', 'status-not-configurable', 'missing-direct-height', 'empty-supported-bound',
    'unsupported-parcel-shape', 'study-multiple-zoning-areas', 'study-zoning-missing', 'envelope-geometry-error'];

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
const metres = c => ['direct', 'literal'].includes(c.evidence) && Number.isFinite(c.value) && c.value >= 0 && LENGTH_M[c.unit] ? c.value * LENGTH_M[c.unit] : null;
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

// One configuration per usable housing type. A configuration without a direct height or
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
const OBSTACLE_MARGIN_M = 45;
function expand([w, s, e, n], marginM) {
    const dLat = marginM / 111320, dLng = dLat / Math.cos((s + n) / 2 * Math.PI / 180);
    return [w - dLng, s - dLat, e + dLng, n + dLat];
}

export async function loadParcelEnvelopes(query, { sources, parcelProvider = descriptor => runtimeParcelSource(descriptor), streetProvider } = {}) {
    validateBounds(query.bbox, 0.5);
    const provider = sourcesFor(query, sources)[0];
    if (!query.source || !provider) fail('study-unavailable');
    const descriptor = studyParcelSource(provider, query.city);
    const parcels = await parcelProvider(descriptor).queryBounds(expand(query.bbox, OBSTACLE_MARGIN_M));
    if (parcels.complete !== true) fail('study-parcel-incomplete', 503);
    const obstacles = parcels.features.map(parcel => ({ id: parcel.id, geometry: parcel.geometry, bbox: turf.bbox(parcel) }));
    const inView = parcels.features.filter((parcel, index) => intersects(obstacles[index].bbox, query.bbox));
    // A work bound, not a secret: a dense zoom-18 view holds about 1,000 lots, which cost a few
    // seconds, most of it the upstream parcel read.
    if (inView.length > 1000) fail('envelope-area-too-large', 400);
    const records = inView.map(parcel => ({ parcel, bbox: turf.bbox(parcel) }));
    // Query zoning across full parcel outlines, not just the viewport (a corner can cross a zone).
    const fullBounds = records.length ? [Math.min(...records.map(r => r.bbox[0])), Math.min(...records.map(r => r.bbox[1])),
        Math.max(...records.map(r => r.bbox[2])), Math.max(...records.map(r => r.bbox[3]))] : query.bbox;
    const scenarios = provider.descriptor.scenarios || [provider.descriptor.scenario];
    const [zoneEntries, streets] = await Promise.all([
        Promise.all(scenarios.map(async scenario => [scenario, await readStudyZoning(provider, { ...query, scenario }, fullBounds)])),
        records.length ? readFrontageStreets(fullBounds, streetProvider) : null
    ]);
    const zonesByScenario = Object.fromEntries(zoneEntries);
    const streetsNearby = streetIndex(streets);
    const overlapProblems = parcelOverlapProblems(records);
    const items = [], unavailable = [];
    for (const { parcel } of records) {
        try {
            if (overlapProblems.has(parcel.id)) fail(overlapProblems.get(parcel.id));
            const frontage = parcelFrontage(parcel, streets, streetsNearby);
            const street = frontage.frontEdge === null ? { widthM: null, hits: [], reason: 'no-front-edge' } : streetWidthAcross(parcel, frontage.frontEdge, obstacles);
            // What the provider may ask of the lot: the floor area a candidate set of constraints leaves on it.
            const measure = constraints => {
                const tiers = tieredBound({ parcel, source: { constraints } }, frontage.frontEdge, turf);
                const storeys = constraints.find(c => c.quantity === 'storeys' && Number.isInteger(c.value))?.value ?? null;
                return { floorAreaM2: floorAreaM2(tiers, storeys, tiers[0].heightM), tiers };
            };
            const zones = provider.parcelRecords ? Object.fromEntries(await Promise.all(scenarios.map(async scenario =>
                [scenario, await parcelRecords(provider, parcel, zonesByScenario[scenario], { frontEdge: frontage.frontEdge, streetWidthM: street.widthM, measure })]))) : zonesByScenario;
            const scenarioZones = zones[scenarios[0]], found = parcelZones(parcel, scenarioZones);
            if (found.stacked) fail('study-multiple-zoning-areas');
            if (!found.major.length) fail('study-zoning-missing');
            const failures = [];
            // One envelope per zoning area that partitions the lot: the whole lot's bound, clipped to that part.
            for (const part of found.major) {
                try {
                    const recordId = part.source.source.recordId;
                    const context = assembleParcelStudy(parcel, descriptor, scenarioZones, { zone: recordId, zones: found });
                    const { configurations, excluded, frontEdges } = parcelConfigurations(context, scenarios, zones, turf, frontage.frontEdge);
                    const bound = outerBound(configurations);
                    if (!bound) fail(omissionReason(configurations, excluded));
                    const id = `envelope:${provider.descriptor.id}:${parcel.id}${found.major.length > 1 ? `~${recordId}` : ''}`;
                    items.push({ id, role: 'permitted', proposalId: null, parcelEnvelope: true,
                        title: `${context.source.title} · ${parcel.properties.parcelNumber}`,
                        source: { ...context.source.source, scenario: null, parcel: parcel.id }, site: bound.geometry, areas: [],
                        volumes: bound.tiers.map((tier, index) => ({ id: `${id}:bound${index ? `-${index}` : ''}`, geometry: tier.geometry, baseM: tier.baseM, topM: tier.topM,
                            ...(tier.condition ? { condition: tier.condition } : {}) })),
                        configurations: configurations.map(configuration => ({ ...configuration,
                            volumes: configuration.volumes.map(volume => ({ ...volume, id: `${id}:${volume.id}` })) })),
                        // Retain original lot lines and the edge interpretations used by the evaluator.
                        derivation: { parcel: parcel.geometry, covered: context.coveredGeometry, frontEdges },
                        spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
                        authority: { effect: 'unknown', applicability: 'unresolved' },
                        assessment: { meaning: 'outer-bound', status: 'unresolved', geometry: 'derived-parcel', constraints: 'partial', current: true },
                        // The height is what the rules grant; an incentive's extra height stands beside it with its condition.
                        metrics: { footprintM2: bound.areaM2, heightM: bound.grantedHeightM, ...(bound.heightM > (bound.grantedHeightM ?? 0)
                            ? { conditional: { heightM: bound.heightM, condition: [...new Set(bound.tiers.map(tier => tier.condition).filter(Boolean))].join('; ') } } : {}) },
                        constraints: [],
                        sourceEvidence: { zoningRecordId: recordId, parcelReference: context.parcelReference,
                            sourceCoverage: context.sourceCoverage, parts: found.major.length, frontEdge: frontage.frontEdge, frontage: frontage.evidence, streetWidth: street,
                            excludedConfigurations: excluded, envelopeMeaning: frontage.frontEdge === null
                                ? 'outer-bound-across-configurations-and-front-edge-interpretations' : 'outer-bound-across-configurations' } });
                } catch (error) {
                    if (error.status === 503) throw error;
                    failures.push(error.code || error.message);
                }
            }
            // A lot is unavailable only when none of its parts could be drawn.
            if (failures.length === found.major.length) fail(failures[0]);
        } catch (error) {
            // A failed upstream read is the whole request's failure, never one parcel's geometry problem.
            if (error.status === 503) throw error;
            const reason = knownReasons.includes(error.code || error.message) ? error.code || error.message : 'envelope-geometry-error';
            if (reason === 'envelope-geometry-error' && process.env.PLANNING_ENVELOPE_DEBUG) console.warn(`[${new Date().toISOString()}] [planning-envelopes] ${parcel.id}: ${error.stack || error.message}`);
            unavailable.push({ parcelId: parcel.id, reason });
        }
    }
    return { schemaVersion: 'planning-representations.v1', city: query.city, sources: [provider.descriptor], items,
        coverage: 'source-results', nextCursor: null, truncated: false, omitted: 0,
        summaries: [{ sourceId: provider.descriptor.id, cachedResults: records.length, withGeometry: items.length,
            withoutGeometry: unavailable.length, statuses: {} }], unavailable };
}
