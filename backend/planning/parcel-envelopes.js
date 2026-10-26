// Read-only viewport envelopes reuse the parcel-study evidence and dimensional evaluator.
// Each parcel yields one outer bound plus the configurations (housing types) it may be built as.
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { sourcesFor } from './sources.js';
import { assembleParcelStudy, readStudyZoning, studyParcelSource, withScenarioSource } from './parcel-study.js';
import { runtimeParcelSource } from '../parcels/sources.js';
import { validateBounds } from '../parcels/source-contract.js';
import { configurationTreatments } from './providers/atlas.js';
const core = createRequire(import.meta.url)('../../frontend/js/planning/parcel-assessment.js');
const fail = (code, status = 422) => { throw Object.assign(new Error(code), { code, status }); };
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const knownReasons = ['overlapping-parcel-identities', 'use-prohibited', 'use-not-recorded', 'missing-direct-height', 'empty-supported-bound',
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

// One configuration per usable housing type. A configuration without a direct height or
// without space inside its supported setbacks is listed with its reason, never drawn.
export function parcelConfigurations(baseContext, scenarios, zonesByScenario, geometryOps = turf) {
    const configurations = [], excluded = {};
    let parcelM2 = null;
    const parcelArea = () => parcelM2 ??= geometryOps.area(baseContext.parcel);
    for (const scenario of scenarios) {
        const context = withScenarioSource(baseContext, zonesByScenario[scenario]);
        const treatment = context?.source.assessment.status || null;
        if (!context || !configurationTreatments.includes(treatment)) { excluded[scenario] = treatment || 'unrecorded'; continue; }
        let bound, unavailableReason = null;
        try { bound = core.unorientedEnvelope(context, geometryOps); }
        catch (error) { unavailableReason = error.message === 'unsupported-parcel-shape' ? error.message : 'envelope-geometry-error'; }
        if (!unavailableReason && (bound.heightM === null || bound.heightM <= 0)) unavailableReason = 'missing-direct-height';
        else if (!unavailableReason && !bound.geometry) unavailableReason = 'empty-supported-bound';
        configurations.push({ id: scenario, treatment, unavailableReason,
            volumes: unavailableReason ? [] : [{ id: `${scenario}:bound`, geometry: bound.geometry, baseM: 0, topM: bound.heightM }],
            metrics: unavailableReason ? { footprintM2: null, heightM: null } : { footprintM2: bound.areaM2, heightM: bound.heightM },
            edgeInterpretations: bound?.interpretations ?? 0, frontEdges: bound?.edges, constraints: context.source.constraints,
            lotArea: lotAreaTest(parcelArea(), context.source.constraints), sourceReference: context.sourceReference });
    }
    const frontEdges = configurations.find(configuration => configuration.frontEdges)?.frontEdges || [];
    for (const configuration of configurations) delete configuration.frontEdges;
    return { configurations, excluded, frontEdges };
}

// The outer bound is everything any configuration permits: joined footprints, tallest height.
export function outerBound(configurations, geometryOps = turf) {
    const drawable = configurations.filter(configuration => configuration.volumes.length);
    if (!drawable.length) return null;
    const geometry = drawable.map(configuration => configuration.volumes[0].geometry)
        .reduce((joined, next) => joined ? geometryOps.union(geometryOps.feature(joined), geometryOps.feature(next)).geometry : next, null);
    return { geometry, heightM: Math.max(...drawable.map(configuration => configuration.volumes[0].topM)),
        areaM2: geometryOps.area(geometryOps.feature(geometry)) };
}

function omissionReason(configurations, excluded) {
    if (!configurations.length) return Object.values(excluded).includes('prohibited') ? 'use-prohibited' : 'use-not-recorded';
    const reasons = configurations.map(configuration => configuration.unavailableReason);
    for (const reason of ['missing-direct-height', 'empty-supported-bound', 'unsupported-parcel-shape']) if (reasons.includes(reason)) return reason;
    return 'envelope-geometry-error';
}

export async function loadParcelEnvelopes(query, { sources, parcelProvider = descriptor => runtimeParcelSource(descriptor) } = {}) {
    validateBounds(query.bbox, 0.5);
    const provider = sourcesFor(query, sources)[0];
    if (!query.source || !provider) fail('study-unavailable');
    const descriptor = studyParcelSource(provider, query.city);
    const parcels = await parcelProvider(descriptor).queryBounds(query.bbox);
    if (parcels.complete !== true) fail('study-parcel-incomplete', 503);
    if (parcels.features.length > 400) fail('envelope-area-too-large', 400);
    const records = parcels.features.map(parcel => ({ parcel, bbox: turf.bbox(parcel) }));
    // Query zoning across full parcel outlines, not just the viewport (a corner can cross a zone).
    const fullBounds = records.length ? [Math.min(...records.map(r => r.bbox[0])), Math.min(...records.map(r => r.bbox[1])),
        Math.max(...records.map(r => r.bbox[2])), Math.max(...records.map(r => r.bbox[3]))] : query.bbox;
    const scenarios = provider.descriptor.scenarios || [provider.descriptor.scenario];
    const zonesByScenario = Object.fromEntries(await Promise.all(scenarios.map(async scenario =>
        [scenario, await readStudyZoning(provider, { ...query, scenario }, fullBounds)])));
    const overlapProblems = parcelOverlapProblems(records);
    const items = [], unavailable = [];
    for (const { parcel } of records) {
        try {
            if (overlapProblems.has(parcel.id)) fail(overlapProblems.get(parcel.id));
            const context = assembleParcelStudy(parcel, descriptor, zonesByScenario[scenarios[0]]);
            const { configurations, excluded, frontEdges } = parcelConfigurations(context, scenarios, zonesByScenario);
            const bound = outerBound(configurations);
            if (!bound) fail(omissionReason(configurations, excluded));
            const id = `envelope:${provider.descriptor.id}:${parcel.id}`;
            items.push({ id, role: 'permitted', proposalId: null, parcelEnvelope: true,
                title: `${context.source.title} · ${parcel.properties.parcelNumber}`,
                source: { ...context.source.source, scenario: null, parcel: parcel.id }, site: bound.geometry, areas: [],
                volumes: [{ id: `${id}:bound`, geometry: bound.geometry, baseM: 0, topM: bound.heightM }],
                configurations: configurations.map(configuration => ({ ...configuration,
                    volumes: configuration.volumes.map(volume => ({ ...volume, id: `${id}:${volume.id}` })) })),
                // Enough for a client to redraw one configuration on one assumed street side with the
                // shared evaluator: the original parcel, the zoning-covered part and the usable edges.
                derivation: { parcel: parcel.geometry, covered: context.coveredGeometry, frontEdges },
                spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
                authority: { effect: 'unknown', applicability: 'unresolved' },
                assessment: { meaning: 'outer-bound', status: 'unresolved', geometry: 'derived-parcel', constraints: 'partial', current: true },
                metrics: { footprintM2: bound.areaM2, heightM: bound.heightM }, constraints: [],
                sourceEvidence: { zoningRecordId: context.source.source.recordId, parcelReference: context.parcelReference,
                    sourceCoverage: context.sourceCoverage, frontEdge: null, excludedConfigurations: excluded,
                    envelopeMeaning: 'outer-bound-across-configurations-and-front-edge-interpretations' } });
        } catch (error) {
            const reason = knownReasons.includes(error.code || error.message) ? error.code || error.message : 'envelope-geometry-error';
            unavailable.push({ parcelId: parcel.id, reason });
        }
    }
    return { schemaVersion: 'planning-representations.v1', city: query.city, sources: [provider.descriptor], items,
        coverage: 'source-results', nextCursor: null, truncated: false, omitted: 0,
        summaries: [{ sourceId: provider.descriptor.id, cachedResults: records.length, withGeometry: items.length,
            withoutGeometry: unavailable.length, statuses: {} }], unavailable };
}
