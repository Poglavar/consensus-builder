// proposals/counts.js — how many proposals there ARE, for the sidebar button.
//
// The list has three tabs (Local / Server / Blockchain), but they are three VIEWS of overlapping
// sets, not three sets: Blockchain is the minted subset of Local, and every uploaded local proposal
// is also a row on the server. Adding the tabs would count one proposal up to three times, so the
// button shows their UNION — the server's own total plus the local records that were never uploaded.
//
// Pure and DOM-free so node can test it; the browser gets window.__proposalCounts (UMD).

(function (global) {
    'use strict';

    /** Union of the three tabs.
        @param {Array<{onServer?: boolean}>} local  local records; onServer = has a server serial,
               so the server total already counts it (and a minted one is in here either way).
        @param {number|null} serverCount  the server's own total for this city; null/unknown means
               the server has not answered, and then local is all we honestly know. */
    function unionProposalCount(local, serverCount) {
        const list = Array.isArray(local) ? local : [];
        const total = (typeof serverCount === 'number' && Number.isFinite(serverCount) && serverCount >= 0)
            ? Math.floor(serverCount)
            : null;
        if (total === null) return list.length;
        return total + list.filter(entry => !(entry && entry.onServer)).length;
    }

    /** Je li serverski broj dovoljno star da ga vrijedi ponovno pitati.
        Nikad pitan (0/null) je uvijek zastario — inače bi prvi prikaz sekcije šutio. */
    function serverCountIsStale(refreshedAt, now, maxAgeMs) {
        if (typeof refreshedAt !== 'number' || !Number.isFinite(refreshedAt) || refreshedAt <= 0) return true;
        if (typeof now !== 'number' || !Number.isFinite(now)) return true;
        const maxAge = (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0) ? maxAgeMs : 0;
        return (now - refreshedAt) >= maxAge;
    }

    function summaryUpdatesAreaCount(query) {
        return typeof query !== 'string' || query.trim() === '';
    }

    function proposalIntersectsBounds(proposal, bounds) {
        if (!proposal || !bounds) return false;
        const { west, south, east, north } = bounds;
        const finite = value => typeof value === 'number' && Number.isFinite(value);
        if (![west, south, east, north].every(finite)) return false;
        const geometries = [proposal.geometry, proposal.site, proposal.data?.geometry,
            proposal.siteProposal?.geometry, proposal.structureProposal?.geometry,
            proposal.roadProposal?.geometry, proposal.roadProposal?.definition?.polygon,
            proposal.reparcellization?.polygons];
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        const visit = value => {
            if (!value) return;
            if (Array.isArray(value)) {
                if (value.length >= 2 && finite(value[0]) && finite(value[1])) {
                    const lon = value[0], lat = value[1];
                    if (lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) {
                        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
                        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
                        return;
                    }
                }
                value.forEach(visit);
                return;
            }
            if (typeof value !== 'object') return;
            if (value.type === 'Feature') return visit(value.geometry);
            if (value.type === 'FeatureCollection') return visit(value.features);
            if (value.type === 'GeometryCollection') return visit(value.geometries);
            if (value.coordinates) return visit(value.coordinates);
            if (value.geometry) return visit(value.geometry);
            if (value.features) return visit(value.features);
            if (value.polygon) return visit(value.polygon);
            if (value.polygons) return visit(value.polygons);
            for (const key of ['parcelGeometry', 'parcel', 'structureGeometry', 'structure', 'buildings', 'parcels']) {
                if (value[key]) visit(value[key]);
            }
            if (value.lat !== undefined && value.lon !== undefined) return visit([value.lon, value.lat]);
        };
        geometries.forEach(visit);
        if (minLon === Infinity && proposal.bounds) {
            const b = proposal.bounds;
            const values = Array.isArray(b) ? b : [b.west ?? b.minX ?? b.minLng, b.south ?? b.minY ?? b.minLat,
                b.east ?? b.maxX ?? b.maxLng, b.north ?? b.maxY ?? b.maxLat];
            if (values.length === 4 && values.every(finite) && values[0] <= values[2] && values[1] <= values[3]) {
                [minLon, minLat, maxLon, maxLat] = values;
            }
        }
        return minLon !== Infinity && maxLon >= west && minLon <= east && maxLat >= south && minLat <= north;
    }

    const api = { unionProposalCount, serverCountIsStale, summaryUpdatesAreaCount, proposalIntersectsBounds };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') global.__proposalCounts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
