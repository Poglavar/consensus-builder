// A unit address uses a source building or an immutable published design building.
(function (root, factory) {
    const api = factory(root.__consentSha256 || (typeof module === 'object' && require('../vendor/noble-hashes-1.8.0/sha256.js')));
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BuildingUnitLinks = api;
})(typeof window !== 'undefined' ? window : globalThis, function (sha256) {
    'use strict';
    const pack = parts => parts.map(part => encodeURIComponent(part)).join('::');
    const nativeBuilding = (city, source, id) => city && source && id != null && id !== ''
        ? pack([city, source, id]) : null;
    const designBuilding = (cid, id) => cid && id != null && id !== '' ? pack(['design', cid, id]) : null;

    function unitsForStorey(model, storey, layout) {
        const suggested = model.suggested === true;
        const regions = layout.architecture.apartmentRegions || [];
        return (storey.units || []).filter(unit => unit.kind === 'apartment').map((unit, index) => {
            const candidates = regions.filter(region => suggested ? `${region.id}-${storey.level}` === unit.id
                : region.id === unit.id || region.targetId === unit.id);
            const region = candidates.length === 1 ? candidates[0] : null;
            // Layout slots may be reused after a footprint, access scheme or partition changes.
            // Include the actual apartment geometry so the old address cannot open the new slot.
            const proof = suggested && region ? sha256.sha256Hex(JSON.stringify([
                model.registration.corners, storey.elevationM, region.polygons
            ])).slice(0, 24) : null;
            const key = suggested && !proof ? null : pack([storey.level, unit.id, ...(proof ? [proof] : [])]);
            return { key, id: unit.id, ordinal: index + 1, areaM2: unit.areaM2, regionId: region?.id ?? null };
        });
    }

    function read(search) {
        const params = new URLSearchParams(search);
        const building = params.get('xrayBuilding');
        return building ? { building, unit: params.get('unit') || null, openFloor: true } : null;
    }

    function link(base, mapShare, context, selection) {
        const { building, unit, designCid, suggested, access, center } = selection;
        const url = new URL(designCid ? `/designs/${designCid}` : '/', base);
        url.searchParams.set('xray', '1');
        url.searchParams.set('xrayBuilding', building);
        url.searchParams.set('unit', unit);
        if (designCid) url.searchParams.set('proposed', 'solid');
        else url.searchParams.set('existing', 'ghost');
        if (suggested) {
            url.searchParams.set('suggested', '1');
            if (!designCid) url.searchParams.set('suggestedExisting', '1');
            if (access !== 'auto') url.searchParams.set('access', access);
        }
        const [lng, lat] = center;
        return mapShare.link(url, { ...context, settings: null, rotate: false, mode: 'model', at: `${lat},${lng},19`,
            camera: { targetLat: lat, targetLng: lng, headingDeg: 0, pitchRad: -1.52, range: 95 } });
    }

    return { nativeBuilding, designBuilding, unitsForStorey, read, link };
});
