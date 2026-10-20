// Read-only viewport envelopes reuse the parcel-study evidence and dimensional evaluator.
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { sourcesFor } from './sources.js';
import { assembleParcelStudy, readStudyZoning } from './parcel-study.js';
import { resolveParcelSourceDescriptor, runtimeParcelSource } from '../parcels/sources.js';
import { validateBounds } from '../parcels/source-contract.js';
const core = createRequire(import.meta.url)('../../frontend/js/planning/parcel-assessment.js');
const fail = (code, status = 422) => { throw Object.assign(new Error(code), { code, status }); };
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

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

export async function loadParcelEnvelopes(query, { sources, parcelProvider = descriptor => runtimeParcelSource(descriptor) } = {}) {
    validateBounds(query.bbox, 0.5);
    const provider = sourcesFor(query, sources)[0];
    if (!query.source || provider?.descriptor.parcelStudy !== 'direct-dimensions.v1') fail('study-unavailable');
    const descriptor = resolveParcelSourceDescriptor(provider.descriptor.parcelSourceId);
    if (!descriptor || descriptor.id.startsWith('custom.')) fail('study-parcel-source-unavailable');
    const parcels = await parcelProvider(descriptor).queryBounds(query.bbox);
    if (parcels.complete !== true) fail('study-parcel-incomplete', 503);
    if (parcels.features.length > 400) fail('envelope-area-too-large', 400);
    const records = parcels.features.map(parcel => ({ parcel, bbox: turf.bbox(parcel) }));
    // Query zoning across full parcel outlines, not just the viewport (a corner can cross a zone).
    const fullBounds = records.length ? [Math.min(...records.map(r => r.bbox[0])), Math.min(...records.map(r => r.bbox[1])),
        Math.max(...records.map(r => r.bbox[2])), Math.max(...records.map(r => r.bbox[3]))] : query.bbox;
    const zones = await readStudyZoning(provider, query, fullBounds);
    const overlapProblems = parcelOverlapProblems(records);
    const items = [], unavailable = [];
    for (const { parcel } of records) {
        try {
            if (overlapProblems.has(parcel.id)) fail(overlapProblems.get(parcel.id));
            const context = assembleParcelStudy(parcel, descriptor, zones);
            if (context.source.assessment.status === 'prohibited') fail('use-prohibited');
            const bound = core.unorientedEnvelope(context, turf);
            if (bound.heightM === null || bound.heightM <= 0) fail('missing-direct-height');
            if (!bound.geometry) fail('empty-supported-bound');
            const id = `envelope:${provider.descriptor.id}:${parcel.id}:${query.scenario || provider.descriptor.scenario}`;
            items.push({ id, role: 'permitted', proposalId: null, parcelEnvelope: true,
                title: `${context.source.title} · ${parcel.properties.parcelNumber}`,
                source: { ...context.source.source, parcel: parcel.id }, site: bound.geometry, areas: [],
                volumes: [{ id: `${id}:bound`, geometry: bound.geometry, baseM: 0, topM: bound.heightM }],
                spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
                authority: { effect: 'unknown', applicability: 'unresolved' },
                assessment: { meaning: 'partial-envelope', status: 'unresolved', geometry: 'derived-parcel', constraints: 'partial', current: true },
                metrics: { footprintM2: bound.areaM2, heightM: bound.heightM }, constraints: context.source.constraints,
                sourceEvidence: { sourceReferences: [context.sourceReference], parcelReference: context.parcelReference,
                    sourceCoverage: context.sourceCoverage, frontEdge: null, edgeInterpretations: bound.interpretations,
                    envelopeMeaning: 'outer-bound-across-front-edge-interpretations' } });
        } catch (error) {
            const known = ['overlapping-parcel-identities', 'use-prohibited', 'missing-direct-height', 'empty-supported-bound',
                'unsupported-parcel-shape', 'study-multiple-zoning-areas', 'study-zoning-missing', 'envelope-geometry-error'];
            const reason = known.includes(error.code || error.message) ? error.code || error.message : 'envelope-geometry-error';
            unavailable.push({ parcelId: parcel.id, reason });
        }
    }
    return { schemaVersion: 'planning-representations.v1', city: query.city, sources: [provider.descriptor], items,
        coverage: 'source-results', nextCursor: null, truncated: false, omitted: 0,
        summaries: [{ sourceId: provider.descriptor.id, cachedResults: records.length, withGeometry: items.length,
            withoutGeometry: unavailable.length, statuses: {} }], unavailable };
}
