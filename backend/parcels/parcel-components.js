// Assembles complete native parcel groups while rejecting overlaps and changed references.
import { feature as geoFeature, union as polygonUnion, intersect, area } from '@turf/turf';
import { upstreamError, validateGeometry } from './source-contract.js';

// Reprojection can turn a shared edge into a microscopic sliver. One square centimetre
// accommodates numeric noise, not overlapping boundary versions (which must still fail).
const MAX_NUMERIC_PART_OVERLAP_M2 = 0.0001;

// Retain the established ArcGIS duplicate-component behavior for every source adapter.
export function retainParcel(byId, canonical, descriptor) {
    const previous = byId.get(canonical.id);
    if (!previous) { byId.set(canonical.id, canonical); return; }
    if (descriptor.partMatchFields?.some(field => previous.properties.sourceProperties[field] !== canonical.properties.sourceProperties[field])) {
        throw upstreamError('Parcel provider returned inconsistent administrative references for one parcel ID.');
    }
    if (JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry)) {
        if (descriptor.nativeGeometryMode !== 'parts') throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
        try {
            if (descriptor.disjointParts) {
                const overlap = intersect(geoFeature(previous.geometry), geoFeature(canonical.geometry));
                if (overlap && area(overlap) > MAX_NUMERIC_PART_OVERLAP_M2) throw new Error('Parcel components overlap.');
            }
            const merged = polygonUnion(geoFeature(previous.geometry), geoFeature(canonical.geometry));
            if (!merged || !validateGeometry(merged.geometry)) throw new Error('Invalid parcel union.');
            previous.geometry = merged.geometry;
        } catch (cause) { throw Object.assign(upstreamError('Parcel provider components could not form a valid complete parcel.'), { cause }); }
    }
    if (descriptor.nativeGeometryMode === 'parts') previous.properties.sourcePartCount += canonical.properties.sourcePartCount;
    else byId.set(canonical.id, canonical);
}
