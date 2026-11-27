// A flat's one address, used by X-ray, links, offers, developer rounds and lens statements:
// building · storey level · flat number on that storey. The building is a source building
// (city::source::id) or an immutable published design building (design::cid::id).
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

    // `level::flat`: the storey level (0 at street level, negative below) and the flat's number on it.
    function apartmentUnitLocator(value) {
        const parts = locatorParts(value);
        if (parts.length !== 2 || !/^(?:0|-?[1-9]\d*)$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0]))
            || !/^[1-9]\d{0,3}$/.test(parts[1])) return null;
        return parts;
    }

    // The identity every use hashes: offers, apartment anchors, round listings and lens statements.
    function flatKey(building, unit) {
        if (!apartmentLocator(building) || !apartmentUnitLocator(unit)) throw new Error('A flat needs a building and a storey::flat address.');
        const [level, flat] = locatorParts(unit);
        return JSON.stringify(['flat/v1', building, Number(level), Number(flat)]);
    }
    const flatHash = (building, unit) => sha256.sha256Hex(flatKey(building, unit));

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
            // The flat keeps its number when an estimated layout is redrawn; the walls may move.
            return { key: pack([storey.level, index + 1]), id: unit.id, ordinal: index + 1, areaM2: unit.areaM2,
                rooms: unit.rooms ?? null, regionId: region?.id ?? null };
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
            suggested: !!offer.access, access: offer.access || 'auto', center: [lng, lat] });
    }

    return { nativeBuilding, designBuilding, unitsForStorey, read, link, offerLink, apartmentLocator, apartmentUnitLocator, apartmentLocation, flatKey, flatHash };
});
