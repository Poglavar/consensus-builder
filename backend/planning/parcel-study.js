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

export async function loadParcelStudy(query, { sources, parcelProvider = descriptor => runtimeParcelSource(descriptor) } = {}) {
    const provider = sourcesFor(query, sources)[0];
    if (!query.source || !provider?.descriptor.parcelSourceId || provider.descriptor.parcelStudy !== 'direct-dimensions.v1') fail('study-unavailable');
    const descriptor = resolveParcelSourceDescriptor(provider.descriptor.parcelSourceId);
    if (!descriptor || descriptor.id.startsWith('custom.')) fail('study-parcel-source-unavailable');
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
    const parcel = parcels[0], bbox = turf.bbox(parcel);
    if (turf.area(parcel) > 1000000 || parcel.geometry.type !== 'Polygon') fail('unsupported-parcel-shape');
    const answer = await provider.query(null, { ...query, bbox, limit: 200 });
    if (answer.nextAfter != null || answer.omitted) fail('study-zoning-incomplete');
    // Viewport clipping is a display projection, never the geometry used to prove parcel coverage.
    const records = (await Promise.all(answer.items.map(item => provider.record(null,
        { recordId: item.source.recordId, scenario: query.scenario })))).flat();
    const overlaps = records.filter(item => {
        const intersection = turf.intersect(parcel, turf.feature(item.site));
        return intersection && turf.area(intersection) > 0.01;
    });
    if (overlaps.length !== 1) fail(overlaps.length ? 'study-multiple-zoning-areas' : 'study-zoning-missing');
    const source = overlaps[0];
    const uncovered = turf.difference(parcel, turf.feature(source.site));
    const covered = turf.intersect(parcel, turf.feature(source.site));
    if (!covered) fail('study-zoning-missing');
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
