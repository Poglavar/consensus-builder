// Public landing activity: normalization and links shared by the browser and fast tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldActivityModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const TYPES = ['create', 'execute', 'accept', 'cancel', 'createMarket', 'resolve', 'donate', 'pledge', 'fulfillPledge', 'claim'];
    function proposalTypeKey(event = {}) {
        const goal = typeof event.proposalType === 'string' ? event.proposalType.trim() : '';
        const primary = typeof event.proposalPrimaryType === 'string' ? event.proposalPrimaryType.trim() : '';
        if (goal.toLowerCase() === 'road-track' && ['road', 'track'].includes(primary.toLowerCase())) return primary.toLowerCase();
        const key = goal || primary || 'other';
        if (key === 'parcelBased') return key;
        return key.toLowerCase().replace(/[\s_]+/g, '-');
    }
    function prepare(events, limit = 12) {
        const seen = new Set();
        return (Array.isArray(events) ? events : []).flatMap(event => {
            if (!event || event.ok === false || event.source === 'simulation' || !TYPES.includes(event.action?.type)) return [];
            const proposalId = event.action.proposalId || (event.entity?.type === 'proposal' && event.entity.id);
            const date = Date.parse(event.occurredAt);
            if (!proposalId || !Number.isFinite(date) || !event.id || seen.has(event.id)) return [];
            seen.add(event.id);
            const query = new URLSearchParams({ focusProposal: String(proposalId) });
            if (event.cityId) query.set('city', event.cityId);
            const location = event.location;
            const point = location && typeof location.lat === 'number' && typeof location.lon === 'number'
                && Number.isFinite(location.lat) && Number.isFinite(location.lon)
                && Math.abs(location.lat) <= 90 && Math.abs(location.lon) <= 180 ? { lat: location.lat, lon: location.lon } : null;
            return [{ cityId: event.cityId || null, location: point, id: String(event.id), type: event.action.type, proposalId: String(proposalId),
                proposalType: typeof event.proposalType === 'string' && event.proposalType.trim() ? event.proposalType.trim() : null,
                proposalPrimaryType: typeof event.proposalPrimaryType === 'string' && event.proposalPrimaryType.trim() ? event.proposalPrimaryType.trim() : null,
                subject: event.proposalName || String(proposalId), date, href: '/?' + query }];
        }).sort((a, b) => b.date - a.date).slice(0, Math.max(0, Math.min(30, limit)));
    }
    function locationOf(event, { city, coverage } = {}) {
        const point = event.location;
        const known = city && city(event.cityId);
        if (known && (!point || distanceKm(point, known) <= 25)) return { kind: 'city', name: known.name };
        if (point && coverage) {
            const place = coverage.nameAt(point.lat, point.lon, 16);
            if (place.name && ['city', 'country'].includes(place.kind)) return { kind: place.kind === 'city' ? 'near' : 'country', name: place.name, cc: place.cc || null };
        }
        return { kind: 'unknown', name: '' };
    }
    function distanceKm(a, b) {
        const rad = Math.PI / 180;
        const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
            + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
        return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return { TYPES, prepare, locationOf, proposalTypeKey };
});
