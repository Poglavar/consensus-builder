// Assemble a read-only Atlas study from exact provider records; never accept client-supplied source geometry.
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { sourcesFor } from './sources.js';
import { sourceRevision } from './source-proposal.js';
import { resolveParcelSourceDescriptor, runtimeParcelSource } from '../parcels/sources.js';
const require = createRequire(import.meta.url);
const { reference } = require('../../frontend/js/planning/source-proposal.js');
const assessment = require('../../frontend/js/planning/parcel-assessment.js');
const fail = (code, status = 422) => { throw Object.assign(new Error(code), { code, status }); };
const componentBounds = new WeakMap();

// Citywide districts can contain thousands of disconnected polygons. Whole components whose
// boxes miss the full parcel cannot affect its coverage; retain every vertex of the others.
// This is only a calculation input. The study still exposes the complete source record.
function zoningNearParcel(geometry, bounds) {
    if (geometry.type !== 'MultiPolygon') return geometry;
    if (!componentBounds.has(geometry)) componentBounds.set(geometry, geometry.coordinates.map(coordinates =>
        ({ coordinates, bbox: turf.bbox(turf.polygon(coordinates)) })));
    const coordinates = componentBounds.get(geometry).filter(({ bbox }) =>
        bbox[0] <= bounds[2] && bbox[2] >= bounds[0] && bbox[1] <= bounds[3] && bbox[3] >= bounds[1])
        .map(component => component.coordinates);
    return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
}

export async function readStudyZoning(provider, query, bbox) {
    const answer = await provider.query(null, { ...query, bbox, limit: 200 });
    if (answer.nextAfter != null || answer.omitted) fail('study-zoning-incomplete');
    // Viewport clipping is a display projection, never the geometry used to prove parcel coverage.
    return (await Promise.all(answer.items.map(item => provider.record(null,
        { recordId: item.source.recordId, scenario: query.scenario, city: query.city })))).flat();
}

// A study uses only its explicitly pinned parcel provider. No city default is inferred.
export function studyParcelSource(provider, city) {
    if (provider?.descriptor.parcelStudy !== 'direct-dimensions.v1') fail('study-unavailable');
    const descriptor = provider.descriptor.parcelSourceId ? resolveParcelSourceDescriptor(provider.descriptor.parcelSourceId)
        : null;
    if (!descriptor || descriptor.id.startsWith('custom.')) fail('study-parcel-source-unavailable');
    return descriptor;
}

export async function loadParcelStudy(query, { sources, parcelProvider = descriptor => runtimeParcelSource(descriptor) } = {}) {
    const provider = sourcesFor(query, sources)[0];
    if (!query.source || !provider) fail('study-unavailable');
    const descriptor = studyParcelSource(provider, query.city);
    const adapter = parcelProvider(descriptor);
    let result;
    if (query.parcel) result = await adapter.queryIds([query.parcel]);
    else {
        const [lon, lat] = query.point, dy = 0.00001, dx = dy / Math.cos(lat * Math.PI / 180);
        result = await adapter.queryBounds([lon - dx, lat - dy, lon + dx, lat + dy]);
    }
    if (result.complete !== true) fail('study-parcel-incomplete', 503);
    const parcels = result.features.filter(feature => query.parcel ? feature.id === query.parcel
        : turf.booleanPointInPolygon(turf.point(query.point), feature));
    if (!parcels.length) fail('study-parcel-missing');
    if (parcels.length !== 1) fail('study-parcel-ambiguous');
    const parcel = parcels[0];
    return assembleParcelStudy(parcel, descriptor, await readStudyZoning(provider, query, turf.bbox(parcel)));
}

export function assembleParcelStudy(parcel, descriptor, records) {
    if (turf.area(parcel) > 1000000 || parcel.geometry.type !== 'Polygon') fail('unsupported-parcel-shape');
    const bounds = turf.bbox(parcel);
    const overlaps = records.flatMap(source => {
        const geometry = zoningNearParcel(source.site, bounds);
        const covered = geometry && turf.intersect(parcel, turf.feature(geometry));
        return covered && turf.area(covered) > 0.01 ? [{ source, geometry, covered }] : [];
    });
    if (overlaps.length !== 1) fail(overlaps.length ? 'study-multiple-zoning-areas' : 'study-zoning-missing');
    const { source, geometry, covered } = overlaps[0];
    const uncovered = turf.difference(parcel, turf.feature(geometry));
    const context = { schemaVersion: 'planning-parcel-study.v1', source, sourceReference: reference(source.proposal),
        parcel, parcelReference: { sourceId: descriptor.id, parcelId: parcel.id,
            revision: sourceRevision({ id: parcel.id, geometry: parcel.geometry }) },
        parcelSource: { id: descriptor.id, label: descriptor.name, url: descriptor.catalogueUrl || descriptor.endpoint },
        coveredGeometry: covered.geometry,
        sourceCoverage: { uncoveredM2: uncovered ? turf.area(uncovered) : 0, parcelAreaM2: turf.area(parcel) },
        frame: { horizontal: 'local-equirectangular', vertical: 'relative-ground', unit: 'm', maximumExtentM: 1000 } };
    // Fail explicitly on unsupported topology rather than silently simplifying the source parcel.
    try { assessment.derive(context, 0, turf); } catch (error) { fail(error.message); }
    return context;
}

// The same parcel and zoning area read under another housing type: only the source record
// (its constraints, treatment and reference) changes; geometry and coverage are shared.
export function withScenarioSource(context, records) {
    const source = records.find(item => item.source.recordId === context.source.source.recordId);
    return source ? { ...context, source, sourceReference: reference(source.proposal) } : null;
}
