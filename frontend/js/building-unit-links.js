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

    // BuildingUnitLinks.pack encodes each segment independently. Reject aliases for the same
    // selection so a camera change or an alternate spelling cannot list it twice in a round.
    function locatorParts(value) {
        if (typeof value !== 'string' || value.length > 1024) return [];
        try {
            const encoded = value.split('::');
            const parts = encoded.map(decodeURIComponent);
            return parts.every((part, i) => part && !/[\x00-\x1f\x7f]/.test(part) && encodeURIComponent(part) === encoded[i]) ? parts : [];
        } catch (_) { return []; }
    }

    function apartmentLocator(value) {
        const parts = locatorParts(value);
        if (parts.length !== 3 || (parts[0] === 'design' && !/^baf(?:krei|ybei)[a-z2-7]{52}$/.test(parts[1]))) return null;
        return parts;
    }

    function apartmentUnitLocator(value) {
        const parts = locatorParts(value);
        if (![2, 3].includes(parts.length) || !/^(?:0|-?[1-9]\d*)$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0]))) return null;
        return parts.length === 3 && !/^[a-f0-9]{24}$/.test(parts[2]) ? null : parts;
    }

    function apartmentLocation(at) {
        if (typeof at !== 'string' || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(at)) return false;
        const [lat, lng, zoom] = at.split(',').map(Number);
        return Math.abs(lat) <= 85.0511 && Math.abs(lng) <= 180 && zoom <= 24;
    }

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
        return apartmentLocator(building) ? { building, unit: params.get('unit') || null, openFloor: true } : null;
    }

    function link(base, mapShare, context, selection) {
        const { building, unit, suggested, access, center } = selection;
        const [source, revision] = locatorParts(building);
        const designCid = source === 'design' ? revision : null;
        const url = new URL(designCid ? `/designs/${designCid}` : '/', base);
        url.searchParams.set('xray', designCid ? 'proposed' : 'built');
        url.searchParams.set('xrayBuilding', building);
        url.searchParams.set('unit', unit);
        if (designCid) url.searchParams.set('proposed', 'solid');
        else url.searchParams.set('existing', 'ghost');
        if (suggested && access && access !== 'auto') url.searchParams.set('access', access);
        const [lng, lat] = center;
        return mapShare.link(url, { ...context, settings: null, rotate: false, mode: 'model', at: `${lat},${lng},19`,
            camera: { targetLat: lat, targetLng: lng, headingDeg: 0, pitchRad: -1.52, range: 95 } });
    }

    function offerLink(base, mapShare, context, offer) {
        const [lat, lng] = offer.at.split(',').map(Number);
        const [source] = offer.xrayBuilding.split('::');
        const city = source === 'design' ? context.city : decodeURIComponent(source);
        return link(base, mapShare, { ...context, city }, { building: offer.xrayBuilding, unit: offer.unit,
            suggested: offer.unit.split('::').length === 3,
            access: offer.access || 'auto', center: [lng, lat] });
    }

    return { nativeBuilding, designBuilding, unitsForStorey, read, link, offerLink, apartmentLocator, apartmentUnitLocator, apartmentLocation };
});
