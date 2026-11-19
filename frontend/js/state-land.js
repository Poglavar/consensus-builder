// State land layers: a cadastre's free state plots (land the state has formed for allocation) and
// land applications (plots drawn in applications for state land). Pure request building, coordinate
// projection and grant matching; js/state-land-layer.js fetches and draws. Kazakhstan's EGKN PKK
// publishes both as WFS views in its native 6-degree Gauss–Krüger grid (zone-prefixed easting).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StateLand = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const PKK_ENDPOINT = 'https://map.gov4c.kz/geoserver/wfs';
    const PKK_VIEWER = 'https://map.gov4c.kz/egkn/';
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 10;
    // The fields each view is read with; nothing else (names of officials, applicants) is requested.
    const VIEWS = Object.freeze({
        free: Object.freeze({ typename: 'egkn:freelands_view', fields: ['gid', 'id', 'usedesc_ru', 'create_time'] }),
        applications: Object.freeze({ typename: 'egkn:reqland_view', fields: ['gid', 'id', 'usedesc_ru', 'create_time', 'status_land_id'] }),
        registered: Object.freeze({ typename: 'egkn:u_view', fields: ['gid', 'kad_nomer', 'cdate'] })
    });
    // A free plot counts as granted when one parcel registered on or after the plot was listed covers
    // at least this share of it. Registration under a new number is the only trace a grant leaves.
    const GRANT_COVER = 0.9;

    // The city configuration's `stateLand` block: { provider: 'kazakhstan-pkk', relaySourceId,
    // districtId, zone }. The relay source is the city's PKK parcel source, the same provider.
    function normalizeConfig(value) {
        if (!value || value.provider !== 'kazakhstan-pkk') return null;
        const { relaySourceId, districtId, zone } = value;
        if (typeof relaySourceId !== 'string' || !relaySourceId || !Number.isSafeInteger(districtId) || districtId < 1
            || !Number.isSafeInteger(zone) || zone < 1 || zone > 60) return null;
        return Object.freeze({ provider: value.provider, relaySourceId, districtId, zone });
    }

    function projectionDefinition(zone) {
        return `+proj=tmerc +lat_0=0 +lon_0=${zone * 6 - 3} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs`;
    }

    // One WFS page of a view in the district, optionally limited to a native-grid bbox.
    function viewUrl(config, viewName, { startIndex = 0, bbox } = {}) {
        const view = VIEWS[viewName];
        if (!view) throw new Error(`Unknown state land view: ${viewName}`);
        const params = new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature', typename: view.typename,
            outputFormat: 'application/json', propertyname: [...view.fields, 'geom'].join(','),
            count: String(PAGE_SIZE), startIndex: String(startIndex), sortBy: 'gid',
            viewparams: `district_id:${config.districtId}`,
            ...(bbox ? { bbox: bbox.join(',') } : {})
        });
        return `${PKK_ENDPOINT}?${params}`;
    }

    // The provider through the backend relay, as a cacheable GET (backend/routes/parcel-provider-relay.js).
    function relayUrl(relayBase, config, providerUrl) {
        const query = new URLSearchParams({ url: providerUrl, referer: PKK_VIEWER, accept: 'application/json' });
        return `${String(relayBase).replace(/\/$/, '')}/parcel-provider-relay/${encodeURIComponent(config.relaySourceId)}?${query}`;
    }

    // Checks one page and says where the next starts, or null when the view is complete.
    function readPage(payload, startIndex) {
        const features = payload?.features;
        const matched = payload?.numberMatched ?? payload?.totalFeatures;
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(features) || !Number.isSafeInteger(matched)
            || matched < startIndex + features.length) {
            throw new Error('The cadastre returned an incomplete state land page.');
        }
        const next = startIndex + features.length;
        if (next < matched && !features.length) throw new Error('The cadastre ended a state land view early.');
        return { features, next: next < matched ? next : null };
    }

    function polygonsOf(geometry) {
        if (geometry?.type === 'Polygon') return [geometry.coordinates];
        if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
        return null;
    }

    // Planar area in the native metric grid; holes subtract.
    function planarArea(geometry) {
        let total = 0;
        for (const polygon of polygonsOf(geometry) || []) {
            polygon.forEach((ring, index) => {
                let twice = 0;
                for (let k = 0; k < ring.length - 1; k += 1) twice += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
                total += (index ? -1 : 1) * Math.abs(twice) / 2;
            });
        }
        return total;
    }

    function nativeBbox(geometry) {
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const polygon of polygonsOf(geometry) || []) for (const ring of polygon) for (const [x, y] of ring) {
            box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
            box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
        }
        return box.every(Number.isFinite) ? box : null;
    }

    // The calendar day a cadastre timestamp names, or null. Both views publish ISO timestamps.
    function dayOf(value) {
        if (typeof value !== 'string') return null;
        const match = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
        return match ? match[1] : null;
    }

    // Whether a free plot has since been registered: `intersectArea(a, b)` gives the planar overlap
    // of two native geometries. Returns { status: 'granted', parcelNumber, registeredOn } or { status: 'listed' }.
    function grantOf(plot, registered, intersectArea) {
        const area = planarArea(plot.geometry);
        const listedOn = dayOf(plot.properties?.create_time);
        if (!(area > 0) || !listedOn) return { status: 'listed' };
        let best = null;
        for (const parcel of registered) {
            const registeredOn = dayOf(parcel.properties?.cdate);
            if (!registeredOn || registeredOn < listedOn) continue;
            const overlap = intersectArea(plot.geometry, parcel.geometry);
            if (typeof overlap === 'number' && overlap >= GRANT_COVER * area && (!best || overlap > best.overlap)) {
                best = { overlap, parcelNumber: String(parcel.properties.kad_nomer ?? ''), registeredOn };
            }
        }
        return best ? { status: 'granted', parcelNumber: best.parcelNumber, registeredOn: best.registeredOn } : { status: 'listed' };
    }

    // A feature in WGS84 with only the fields the map shows. `project([x, y])` converts native metres.
    function toDisplayFeature(feature, kind, project, extra = {}) {
        const polygons = polygonsOf(feature?.geometry);
        if (!polygons) return null;
        const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(point => project([point[0], point[1]]))));
        const p = feature.properties || {};
        return {
            type: 'Feature',
            geometry: { type: 'MultiPolygon', coordinates },
            properties: {
                kind, gid: p.gid, id: p.id === undefined || p.id === null ? null : String(p.id),
                use: typeof p.usedesc_ru === 'string' && p.usedesc_ru.trim() ? p.usedesc_ru.trim() : null,
                listedOn: dayOf(p.create_time), ...extra
            }
        };
    }

    function summarize(features) {
        const counts = { free: 0, granted: 0, applications: 0 };
        for (const feature of features) {
            const { kind, status } = feature.properties;
            if (kind === 'application') counts.applications += 1;
            else if (status === 'granted') counts.granted += 1;
            else counts.free += 1;
        }
        return counts;
    }

    return Object.freeze({
        VIEWS, GRANT_COVER, PAGE_SIZE, MAX_PAGES, normalizeConfig, projectionDefinition, viewUrl, relayUrl,
        readPage, planarArea, nativeBbox, dayOf, grantOf, toDisplayFeature, summarize
    });
});
