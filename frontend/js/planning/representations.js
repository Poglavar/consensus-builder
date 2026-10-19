// Project observed buildings and authored designs into the same inspection contract as sources.
// These projections never mutate the source record or manufacture missing heights/quantities.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningRepresentations = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const spatialReference = Object.freeze({ horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' });
    function volume(feature, id) {
        const p = feature?.properties || {};
        const height = finite(p.height_m) ? p.height_m : finite(p.height) ? p.height : null;
        const baseM = finite(p.base_elevation_m) ? p.base_elevation_m : 0;
        if (!['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type) || height === null || height <= 0) return null;
        return { id, geometry: feature.geometry, baseM, topM: baseM + height };
    }
    function built(feature, { key, city, footprintM2 = null } = {}) {
        if (!feature || !key || !city) return null;
        const id = `built:${city}:${key}`, p = feature.properties || {};
        const part = volume(feature, `${id}:volume`);
        return { id, role: 'existing', proposalId: null, title: p.name || String(key),
            site: feature.geometry || null, volumes: part ? [part] : [], spatialReference,
            source: { id: p.source || 'observed-buildings', recordId: String(key), city,
                label: p.source || p.dataset || null, version: p.version || null,
                observedAt: p.observed_at || null, parcel: p.parcelId || null },
            assessment: { meaning: 'observed-building', geometry: part ? 'available' : 'footprint-only',
                constraints: 'not-evaluated', status: p.__outcome || null },
            metrics: { floorAreaM2: finite(p.floor_area_m2) ? p.floor_area_m2 : null,
                footprintM2: finite(footprintM2) ? footprintM2 : null,
                heightM: finite(p.height_m) ? p.height_m : finite(p.height) ? p.height : null },
            constraints: [], sourceEvidence: p };
    }
    function observedMeshFeature(building, sourceFeature) {
        if (sourceFeature) return sourceFeature;
        const height = finite(building.z_min) && finite(building.z_max) && building.z_max > building.z_min
            ? building.z_max - building.z_min : null;
        return { type: 'Feature', geometry: building.floorModel?.footprint || null,
            properties: { ...building.properties, object_id: building.object_id, height_m: height } };
    }
    function proposed(proposal, { key, city, applied = false } = {}) {
        if (!proposal || !key) return null;
        const id = `proposed:${key}`;
        const volumes = (proposal.geometry?.buildings || []).map((feature, index) => volume(feature, `${id}:${index}`)).filter(Boolean);
        return { id, role: 'proposed', proposalId: String(key),
            title: proposal.name || proposal.title || String(key), site: proposal.site || null, volumes, spatialReference,
            source: { id: 'authored-proposal', recordId: String(key), city: proposal.city || city,
                version: proposal.updatedAt || proposal.createdAt || null, parcel: proposal.cadastreParcelIds?.[0] || null },
            assessment: { meaning: 'authored-design', geometry: volumes.length ? 'available' : 'not-available',
                constraints: 'not-evaluated', status: proposal.lifecycleStatus || null, applied },
            metrics: { floorAreaM2: null, heightM: volumes.length ? Math.max(...volumes.map(part => part.topM)) : null },
            constraints: [], sourceEvidence: { type: proposal.type, kind: proposal.kind,
                cadastreParcelIds: proposal.cadastreParcelIds, sourceReferences: proposal.sourceReferences || [] } };
    }
    return { built, proposed, volume, observedMeshFeature };
});
