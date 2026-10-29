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
    const records = await readStudyZoning(provider, query, turf.bbox(parcel));
    return assembleParcelStudy(parcel, descriptor, await parcelRecords(provider, parcel, records));
}

// A provider whose rules attach to the parcel rather than the zoning area (a front-yard map read
// under the lot) refines the area records for that parcel; the zoning identities stay the same.
export async function parcelRecords(provider, parcel, records) {
    return provider.parcelRecords ? provider.parcelRecords(parcel, records) : records;
}

// A zone under less than this share of the lot is boundary digitising noise: evidence, not a part.
export const MINOR_ZONE_SHARE = 0.02;
// The zoning areas under a parcel, largest first. Major zones are parts when they partition the
// lot; zones stacked over the same ground (an overlay, a duplicate record) leave its rules ambiguous.
const siteBounds = new WeakMap();
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function parcelZones(parcel, records) {
    const bounds = turf.bbox(parcel), parcelM2 = turf.area(parcel);
    const overlaps = records.flatMap(source => {
        // A zone whose box misses the lot cannot cover it; the box is computed once per record.
        if (!siteBounds.has(source.site)) siteBounds.set(source.site, turf.bbox(source.site));
        if (!boxesTouch(siteBounds.get(source.site), bounds)) return [];
        const geometry = zoningNearParcel(source.site, bounds);
        const covered = geometry && turf.intersect(parcel, turf.feature(geometry));
        const areaM2 = covered ? turf.area(covered) : 0;
        return areaM2 > 0.01 ? [{ source, geometry, covered, areaM2, share: areaM2 / parcelM2 }] : [];
    }).sort((a, b) => b.areaM2 - a.areaM2);
    const major = overlaps.filter(zone => zone.share >= MINOR_ZONE_SHARE), minor = overlaps.filter(zone => zone.share < MINOR_ZONE_SHARE);
    let stacked = false;
    for (let a = 0; a < major.length && !stacked; a++) for (let b = a + 1; b < major.length && !stacked; b++) {
        // A failed comparison is never evidence that two zones keep apart.
        let shared = null;
        try { shared = turf.intersect(major[a].covered, major[b].covered); } catch (_) { stacked = true; }
        if (shared && turf.area(shared) / parcelM2 >= MINOR_ZONE_SHARE) stacked = true;
    }
    return { overlaps, major, minor, stacked, parcelM2 };
}

// `zone` names the part to study on a lot that several zones partition; without it the dominant
// zone is studied, and two parts without a clear majority stay ambiguous for a single study.
export function assembleParcelStudy(parcel, descriptor, records, { zone = null, zones = parcelZones(parcel, records) } = {}) {
    if (turf.area(parcel) > 1000000 || parcel.geometry.type !== 'Polygon') fail('unsupported-parcel-shape');
    if (zones.stacked) fail('study-multiple-zoning-areas');
    let entry;
    if (zone !== null) entry = zones.major.find(item => item.source.source.recordId === zone);
    else if (zones.major.length > 1 && zones.major[0].share - zones.major[1].share < 0.1) fail('study-multiple-zoning-areas');
    else entry = zones.major[0];
    if (!entry) fail('study-zoning-missing');
    const { source, covered } = entry;
    let uncovered = parcel;
    for (const item of zones.overlaps) { if (!uncovered) break; uncovered = turf.difference(uncovered, turf.feature(item.geometry)); }
    const otherZones = zones.overlaps.filter(item => item !== entry).map(item => ({ recordId: item.source.source.recordId,
        areaM2: Math.round(item.areaM2 * 100) / 100, share: Math.round(item.share * 10000) / 10000, minor: item.share < MINOR_ZONE_SHARE }));
    const context = { schemaVersion: 'planning-parcel-study.v1', source, sourceReference: reference(source.proposal),
        parcel, parcelReference: { sourceId: descriptor.id, parcelId: parcel.id,
            revision: sourceRevision({ id: parcel.id, geometry: parcel.geometry }) },
        parcelSource: { id: descriptor.id, label: descriptor.name, url: descriptor.catalogueUrl || descriptor.endpoint },
        coveredGeometry: covered.geometry,
        sourceCoverage: { uncoveredM2: uncovered ? turf.area(uncovered) : 0, parcelAreaM2: zones.parcelM2,
            zoneM2: entry.areaM2, zoneShare: entry.share, otherZones },
        frame: { horizontal: 'local-equirectangular', vertical: 'relative-ground', unit: 'm', maximumExtentM: 1000 } };
    // Fail explicitly on unsupported topology rather than silently simplifying the source parcel.
    try { assessment.inspect(parcel.geometry); } catch (error) { fail(error.message); }
    return context;
}

// The same parcel and zoning area read under another housing type: only the source record
// (its constraints, treatment and reference) changes; geometry and coverage are shared.
export function withScenarioSource(context, records) {
    const source = records.find(item => item.source.recordId === context.source.source.recordId);
    return source ? { ...context, source, sourceReference: reference(source.proposal) } : null;
}
